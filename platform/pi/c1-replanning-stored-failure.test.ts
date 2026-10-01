import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { buildPolicy } from "./project-config.ts";
import { parsePolicyConfig, type PolicyConfig } from "../core/policy-config.ts";
import { canTransition } from "../core/state-machine.ts";

/**
 * C1, CLOSED 2026-10-01 — the REPLANNING stored-failure echo.
 *
 * The question this file answers was an open design question, deliberately
 * unpinned, because the pin had to assert one of two answers and choosing
 * silently would have laundered an open question into settled law:
 *
 *   should a REPLANNING task replay a stored failure reason?
 *     yes — and the pin should be added
 *     no  — and it should refuse without replaying
 *
 * IT IS NOT A CHOICE. It is an invariant, and this file pins the invariant
 * rather than the preference.
 *
 *   `REFUSED_EXECUTION_STATES` contains REPLANNING, and
 *   `describeTerminalRefusal` (kernel-adapter.ts:780) is the only site of the
 *   three that replays a stored reason. So the question reduces to: CAN a
 *   REPLANNING task carry a `failureReason` at all?
 *
 * It cannot, and the reason is structural, not incidental:
 *
 *   1. `failureReason` is written in exactly one place — `advance()`, and only
 *      when the caller passes it. Every one of the eight call sites that passes
 *      it targets FAILED (supersession :693, policy abort :1036, recovery
 *      TERMINATE :1432, the legacy denial path :1754, the three `finishTask`
 *      kills :1782/:1800/:1817, and the unusable-stream kill :1854).
 *   2. FAILED is terminal and admits no outgoing transition
 *      (`state-machine.ts:17` — `FAILED: []`), and `transitionTask` throws on
 *      any transition out of a terminal state (:30). So a task that has a
 *      stored failure can never subsequently be REPLANNING.
 *   3. REPLANNING is entered only from the REPLAN branch of recovery
 *      (:1397) and is left again on the next line (:1398). It is a transient
 *      state inside one synchronous block, and that branch sets no
 *      failureReason.
 *
 * Therefore the replay branch is UNREACHABLE for REPLANNING. The code already
 * behaves as the "no" answer, and the "yes" answer describes a state the state
 * machine cannot produce. There is nothing to decide, which is why this file
 * pins reachability and not taste.
 *
 * WHAT IS DELIBERATELY NOT PINNED. The refusal text a REPLANNING task
 * receives today contains the words "the task terminated WITHOUT recording a
 * failureReason" (kernel-adapter.ts:795). For a REPLANNING task that is not
 * true — the task is live, which is the whole distinction the codebase draws
 * between `TERMINAL_TASK_STATES` and `REFUSED_EXECUTION_STATES` (:88-92). The
 * second clause of that sentence is accurate; the first is not.
 *
 * That wording is a filed defect (F006 §5 item 9), not a contract, so pinning
 * it here would make a known-wrong string permanent and break CI on the day it
 * is fixed. What is pinned below is the part that must survive any fix: the
 * refusal names REPLANNING, states the call was not evaluated, and never
 * presents a stored reason as this call's own verdict.
 */

const DENIAL_SITES = ["REPLANNING", "COMPLETED", "FAILED", "ESCALATED", "CANCELLED", "TIMEOUT"] as const;

async function adapterIn(status: string, failureReason?: string): Promise<KernelAdapter> {
  const adapter = new KernelAdapter();
  adapter.registerTools([toolDescriptorFromPi({ name: "read", description: "read" })]);
  await adapter.beginTask("probe", "probe");
  // Forced, not reached: the point of the file is that REPLANNING is not
  // reachable WITH a reason, so the two halves are constructed directly and
  // the precondition of each is asserted before its outcome.
  (adapter as unknown as { task: Record<string, unknown> }).task = {
    ...adapter.currentTask!,
    status,
    ...(failureReason === undefined ? {} : { failureReason }),
  };
  return adapter;
}

test("C1.1 a REPLANNING task cannot be produced with a stored failureReason", () => {
  // Premise 1: the states that CAN hold a stored reason are terminal.
  for (const terminal of ["COMPLETED", "FAILED", "ESCALATED", "CANCELLED", "TIMEOUT"] as const) {
    assert.equal(canTransition(terminal, "REPLANNING"), false,
      `a ${terminal} task is terminal and cannot become REPLANNING`);
  }
  // Premise 2: REPLANNING is entered from RECOVERING and leaves at once.
  assert.equal(canTransition("RECOVERING", "REPLANNING"), true,
    "REPLANNING is entered from the REPLAN branch of recovery");
  assert.equal(canTransition("REPLANNING", "PLANNING"), true,
    "and left again on the next line, so it is transient within one block");
  // The conclusion, which is the whole point: no path carries a reason into it.
  assert.equal(canTransition("FAILED", "REPLANNING"), false,
    "every site that writes a failureReason targets FAILED, so a task holding one can never be REPLANNING");
});

test("C1.2 a REPLANNING task refuses with no original failure to replay", async () => {
  const adapter = await adapterIn("REPLANNING");
  assert.equal(adapter.currentTask?.status, "REPLANNING", "precondition: the task is REPLANNING");
  assert.equal(adapter.currentTask?.failureReason, undefined,
    "precondition: and carries no stored reason — C1.1 says it cannot");

  const precheck = await adapter.precheckToolCall("read", "execute", { path: "x" }, undefined, "c1");
  assert.equal(precheck.decision.decision, "DENY", "a REPLANNING task accepts no further tool call");
  const reason = precheck.decision.reason ?? "";
  assert.match(reason, /Task is REPLANNING/, "the refusal names the state it refused in");
  assert.match(reason, /NOT evaluated/, "and says the call itself was never judged");
  assert.match(reason, /no original failure to replay/,
    "and says there is no stored reason — the only tail REPLANNING can ever produce");
  assert.doesNotMatch(reason, /ORIGINAL failure, recorded when the task terminated/,
    "the replay tail is unreachable for REPLANNING; see item 9 for the wording defect this sentence carries");
});

test("C1.3 the replay tail is still live where it should be — a FAILED task", async () => {
  // The guard against over-correcting. C1.1/C1.2 could be satisfied by
  // deleting the replay entirely, which would throw away the attribution the
  // refusal certificate exists to provide. This asserts the terminal case is
  // untouched.
  const adapter = await adapterIn("FAILED", "Recovery TERMINATE [REPLAN_BUDGET_EXHAUSTED]: replanCount=2/2");
  const precheck = await adapter.precheckToolCall("read", "execute", { path: "x" }, undefined, "c1");
  const reason = precheck.decision.reason ?? "";
  assert.match(reason, /ORIGINAL failure, recorded when the task terminated and unchanged since/,
    "a terminal task still replays its stored reason, labelled and attributed");
  assert.match(reason, /REPLAN_BUDGET_EXHAUSTED/, "and the counters come with it, so the certificate stays auditable");
  assert.match(reason, /NOT evaluated/, "and it is still not presented as this call's own verdict");
});

test("C1.4 every refusal-eligible state is covered by one of the two tails", async () => {
  // No state may fall through to a sentence that describes a task which never
  // existed. REPLANNING is the only non-terminal member of the set, and C1.2
  // covers it; the rest are terminal and covered by C1.3's shape.
  for (const status of DENIAL_SITES) {
    const adapter = await adapterIn(status, status === "REPLANNING" ? undefined : "stored reason");
    const precheck = await adapter.precheckToolCall("read", "execute", { path: "x" }, undefined, "c1");
    assert.equal(precheck.decision.decision, "DENY", `${status} refuses`);
    assert.match(precheck.decision.reason ?? "", /NOT evaluated/,
      `${status} names that the call was not evaluated`);
  }
});

/** The structured half of the same refusal: a trace consumer reads a field, not prose. */
const lastRefusalPayload = (k: KernelAdapter) =>
  k.recentEvents(500).filter((e) => e.type === "LIFECYCLE_REFUSED").at(-1)?.payload as
    Record<string, unknown> | undefined;

test("C1.5 the trace must not claim a replay it did not perform", async () => {
  // The prose tail and the trace payload are two surfaces carrying one fact.
  // C1.2 pins the sentence; this pins the structure, because a trace consumer
  // reads `replayed` and not English, and a payload claiming a replay that
  // never happened is the same defect in a field no assertion on prose catches.
  const adapter = await adapterIn("REPLANNING");
  assert.equal(adapter.currentTask?.failureReason, undefined,
    "precondition: no stored reason exists, so nothing could have been replayed");

  await adapter.precheckToolCall("read", "execute", { path: "x" }, undefined, "c1");
  const payload = lastRefusalPayload(adapter);
  assert.ok(payload, "precondition: the refusal must have been traced at all");
  assert.equal(payload.replayed, false, "the trace must not claim a replay");
  assert.equal(payload.originalFailureReason, null,
    "and must not invent one — null, not an empty string, because there was none");
  assert.equal(payload.evaluated, false, "and the call was still never evaluated");
  assert.equal(payload.taskStatus, "REPLANNING", "on the state that actually refused it");
});

/**
 * `abort`, not a delivered denial. Under the D1 reversal a denial no longer
 * ends a task, so a death produced by handing one to recovery would leave a
 * LIVE task and the log C1.6 walks would prove nothing. `abort` still ends a
 * task, at `precheckToolCall` -> `abortTask`, and the reason is the policy's
 * own words rather than one this file made up.
 */
const DEATH_RULES = {
  version: 1,
  deniedTools: ["withheld_tool"],
  allowedTools: [],
  fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
  destructiveCommandPatterns: [],
  destructiveCommandTokens: [],
  limits: { maxToolCallsPerTask: 40, maxFileWritesPerTask: 10, maxBytesPerWrite: 2_000_000 },
  onViolation: "abort",
} as const;

test("C1.6 only a FAILED task ever holds a stored failureReason", async () => {
  // The empirical counterpart to C1.1. C1.1 reads the state table and shows a
  // reason cannot survive into a live state; this walks what the kernel
  // ACTUALLY recorded and shows no transition ever writes one anywhere else. A
  // table can be edited into permitting it; a recorded log cannot be argued
  // with.
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-c1-"));
  const policyConfig: PolicyConfig = parsePolicyConfig({ ...DEATH_RULES }, "c1-policy.json");
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy({ policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] }, dir, policyConfig));
  for (const name of ["withheld_tool", "read"]) {
    adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
  }
  await adapter.beginTask("do the work", "do the work");

  const probe = await adapter.precheckToolCall("withheld_tool", "execute", {}, undefined, "probe");
  assert.equal(probe.decision.decision, "DENY", "precondition: the policy must actually deny the call");
  const denialReason = probe.decision.reason ?? "";
  await adapter.beginToolExecution("call-that-died", "withheld_tool", "execute");
  await adapter.recordToolResult("call-that-died", "withheld_tool", undefined, true, undefined, denialReason);
  assert.equal(adapter.currentTask?.status, "FAILED", "precondition: the task must really be dead");
  assert.ok((adapter.currentTask?.failureReason ?? "").length > 0,
    "precondition: and must really carry a stored reason, or the walk below examines nothing");

  const withReason = adapter.transitionLog.filter((entry) => entry.failureReason);
  assert.ok(withReason.length > 0, "precondition: the log must hold at least one recorded reason");
  for (const entry of withReason) {
    assert.equal(entry.to, "FAILED",
      `transition ${entry.from} -> ${entry.to} recorded a failureReason, but only FAILED may hold one`);
  }
  // And the permanence that makes the rule total rather than incidental.
  assert.equal(canTransition("FAILED", "REPLANNING"), false,
    "a task holding a reason is FAILED, and FAILED is where it stays");
});
