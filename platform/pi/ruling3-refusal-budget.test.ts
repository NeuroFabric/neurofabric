import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConfiguredPolicy } from "../core/configured-policy.ts";
import { parsePolicyConfig } from "../core/policy-config.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import type { PolicyRequest } from "../core/index.ts";

/**
 * RULING 3 (2026-10-01) — do refused calls consume the tool budget?
 *
 * THE QUESTION, AS PUT. A refusal costs no retry and no replan (D1), so an agent
 * that keeps proposing the same refused call is bounded by nothing at all —
 * unless the refusal itself spends budget. If it does not, the run can loop on
 * refusals forever, which is a liveness hole wearing the costume of a policy
 * control: the policy is refusing correctly and the task never ends.
 *
 * THE ANSWER, MEASURED: no. `ConfiguredPolicy.evaluate` returns the denial
 * BEFORE `counts.toolCalls += 1`, so a refused call is invisible to the budget
 * by construction. These pins state that as a FACT rather than relying on a
 * reader of the source to notice it, because a hole that is only visible by
 * reading is a hole that gets re-opened.
 *
 * WHAT IS DONE ABOUT IT. Not a new limit. Ruling 3 asks for the refusal repeats
 * to be wired to the EXISTING repeat-count telemetry, and for the ESCALATION to
 * the user to be the product layer's decision — because "how many times may the
 * agent ask before a human is consulted" is a product rule (PRODUCT.md's clarify
 * budget), not a kernel control. The kernel's whole obligation here is to make
 * the repeats COUNTABLE. That is what is pinned below.
 */

const SECRET = ["api", "key"].join("_");
const DESTRUCTIVE = ["r" + "m", "-r" + "f"].join(" ");

const RULES = {
  version: 1,
  deniedTools: ["withheld_tool"],
  allowedTools: [],
  fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
  destructiveCommandPatterns: [DESTRUCTIVE],
  destructiveCommandTokens: ["shred"],
  secretWritePatterns: [SECRET],
  limits: { maxToolCallsPerTask: 3, maxFileWritesPerTask: 2, maxBytesPerWrite: 2_000_000 },
  onViolation: "block",
} as const;

const bash = toolDescriptorFromPi({ name: "bash", description: "bash" });
const withheld = toolDescriptorFromPi({ name: "withheld_tool", description: "withheld" });

function request(taskId: string, tool: typeof bash, input: unknown, id: string): PolicyRequest {
  return { taskId, tool, operation: "execute", input, toolCallId: id } as PolicyRequest;
}

function policy(dir: string) {
  return new ConfiguredPolicy(parsePolicyConfig({ ...RULES }, "ruling3.json"), {
    mode: "TRUSTED_PROJECT",
    base: { evaluate: () => ({ decision: "ALLOW" as const }), evaluateWithApproval: async () => ({ decision: "ALLOW" as const }) },
    allowedRoots: [dir],
  });
}

test("R3.1 a refused call does NOT consume the tool-call budget - the hole, stated", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-r3-"));
  const p = policy(dir);
  // The budget is 3. Refuse five times.
  for (let i = 0; i < 5; i += 1) {
    const decision = p.evaluate(request("t1", withheld, {}, `call-${i}`));
    assert.equal(decision.decision, "DENY", `call ${i} must be refused`);
  }
  // An allowed call still sees a full budget: the five refusals cost nothing.
  const allowed = p.evaluate(request("t1", bash, { command: "ls" }, "ok-1"));
  assert.equal(allowed.decision, "ALLOW", "and the budget is untouched, so refusals really are free");
  const telemetry = p.toolBudget(request("t1", bash, { command: "ls" }, "ok-1"));
  assert.equal(telemetry?.used, 1, "one call used, not six");
  assert.equal(telemetry?.remaining, 2, "so the whole budget survives the refusals");
});

test("R3.2 the loop really is unbounded on refusals alone, which is why R3.3 exists", async () => {
  // The hole, at its worst: the same refused call, as many times as the caller
  // likes, spending nothing. This test is the evidence for R3.3 - if a future
  // change makes a refusal cost budget, this goes red and R3.3's answer needs
  // revisiting rather than silently doubling up.
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-r3b-"));
  const p = policy(dir);
  let refusals = 0;
  for (let i = 0; i < 25; i += 1) {
    if (p.evaluate(request("t1", withheld, {}, `loop-${i}`)).decision === "DENY") refusals += 1;
  }
  assert.equal(refusals, 25, "twenty-five refusals, one budget, still a full budget");
  assert.equal(p.toolBudget(request("t1", bash, { command: "ls" }, "probe"))?.remaining, 3);
});

test("R3.3 refusal REPEATS are countable, on the existing telemetry", async () => {
  // The fix's whole contract: the kernel makes the repeats visible, and the
  // product layer decides when a human is asked. No new limit, no new scanner -
  // the same `callRepeats` map the allowed-call telemetry already used, now
  // counting refusals as well.
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-r3c-"));
  const p = policy(dir);
  for (let i = 0; i < 4; i += 1) p.evaluate(request("t1", withheld, {}, "same-call"));
  const repeats = p.toolBudget(request("t1", withheld, {}, "same-call"))?.repeatCount;
  assert.equal(
    repeats, 4,
    "the same refused call is counted four times, so 'the agent is looping' is a number and not an impression",
  );
});

test("R3.4 the repeat count is per (tool, input) and per task, never global", async () => {
  // A count that leaked across calls would escalate the agent for two unrelated
  // refusals, and a count that leaked across tasks would punish a new turn for
  // the previous turn's loop.
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-r3d-"));
  const p = policy(dir);
  p.evaluate(request("t1", withheld, { a: 1 }, "x"));
  p.evaluate(request("t1", withheld, { a: 1 }, "x"));
  p.evaluate(request("t1", withheld, { a: 2 }, "y"));

  assert.equal(p.toolBudget(request("t1", withheld, { a: 1 }, "x"))?.repeatCount, 2,
    "the identical refusal is counted twice");
  assert.equal(p.toolBudget(request("t1", withheld, { a: 2 }, "y"))?.repeatCount, 1,
    "a DIFFERENT refused call starts at one, even in the same task");
  // One refusal of its own in the newer task. The count is materialised by a
  // refusal, so querying a task that has never been refused correctly answers
  // "nothing known" rather than "three" - which is itself the isolation claim.
  p.evaluate(request("t2", withheld, { a: 1 }, "x"));
  assert.equal(p.toolBudget(request("t2", withheld, { a: 1 }, "x"))?.repeatCount, 1,
    "a newer task inherits nothing: its first refusal is its own");
});

test("R3.5 a refused call still costs the refusal itself no retry and no replan", async () => {
  // The ruling's two halves must not fight. Refusals become countable WITHOUT
  // becoming expensive: a refusal that charged a budget could exhaust it purely
  // by being refused, which is the benign-exit defect wearing a different hat.
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-r3e-"));
  const p = policy(dir);
  p.evaluate(request("t1", withheld, {}, "soft-1"));
  const telemetry = p.toolBudget(request("t1", withheld, {}, "soft-1"));
  assert.equal(telemetry?.repeatCount, 1, "countable");
  assert.equal(p.evaluate(request("t1", bash, { command: "ls" }, "ok")).decision, "ALLOW",
    "and the budget for real work is entirely intact");
});