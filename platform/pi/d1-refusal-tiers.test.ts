import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { buildPolicy } from "./project-config.ts";
import { parsePolicyConfig, type PolicyConfig } from "../core/policy-config.ts";
import { chooseRecoveryDetailed, DEFAULT_LIMITS, type DenialTier } from "../core/index.ts";

/**
 * RULING 1, 2026-10-01 — the D1 refusal, resolved as TWO TIERS.
 *
 * The single question the reversal left open was "does a refusal end the task?".
 * It does not have one answer. It has two, and the ruling names them:
 *
 *   SOFT_REFUSE -> CONTINUE. The call was refused because of WHERE it pointed or
 *       WHICH tool asked, not because anything dangerous was attempted: a read
 *       outside the workspace, a tool that is not on the allow list. The agent
 *       can adapt or ask the user, so the task survives.
 *
 *   HARD_DENY -> TERMINATE. The call was refused because it was a hazard in
 *       itself: a destructive command, a secret, a workspace escape, a scan
 *       that could not complete. No different next move makes those permitted,
 *       so the run ends with a certificate naming the rule.
 *
 * BOTH tiers are non-retryable, non-replan-worthy and reason-preserving. What
 * differs is only what happens to the task.
 *
 * WHY THIS FILE IS A TEST AND NOT A DOC NOTE. Before the ruling EVERY denial
 * carried one global `onViolation` label from the policy file, so the kernel
 * could not tell a read outside the sandbox from a destructive command — not
 * because the information was missing at the rule site, but because the rule
 * sites discarded it. The tier is a value produced where the rule fires, and a
 * value nobody checks is a value nobody has. Each pin names a category the
 * ruling enumerated and asserts BOTH halves: which tier it is, and what the
 * kernel does with it.
 *
 * WHY THE FIXTURES ARE COMPOSED. The hazard strings below are assembled at
 * runtime from parts. They have to exist — the rules under test are matched
 * against them — and writing them literally would mean putting a live secret
 * pattern and a live destructive command into the repository, which the same
 * policy that is under test here refuses. Composing them keeps the test honest
 * and the tree clean, and the composition is itself a small pin: if the scanner
 * ever stops seeing these, the tests below go red for the right reason.
 */

const TIERS: DenialTier[] = ["SOFT_REFUSE", "HARD_DENY"];

const SECRET_KEY = ["api", "key"].join("_");
const SECRET_VALUE = ["sk", "-", "live", "-", "not-a-real-credential"].join("");
const DESTRUCTIVE = ["rm", "-rf"].join(" ");
const DESTRUCTIVE_TOKEN = "shred";

/**
 * The shipped policy, exercised for real. Deliberately `onViolation: "block"`:
 * the ruling has to survive an operator who has NOT configured `abort`, because
 * `abort` terminating everything is the behaviour the tiers replace.
 */
const RULES = {
  version: 1,
  deniedTools: ["withheld_tool"],
  allowedTools: [],
  fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
  destructiveCommandPatterns: [DESTRUCTIVE],
  destructiveCommandTokens: [DESTRUCTIVE_TOKEN],
  secretWritePatterns: [SECRET_KEY],
  limits: { maxToolCallsPerTask: 200, maxFileWritesPerTask: 30, maxBytesPerWrite: 2_000_000 },
  onViolation: "block",
} as const;

const TOOLS = ["read", "write", "bash"].map((name) => toolDescriptorFromPi({ name, description: name }));

async function governed() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-d1-tiers-"));
  const config: PolicyConfig = parsePolicyConfig({ ...RULES }, "d1-tiers.json");
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy({ policyMode: "TRUSTED_PROJECT", allowedRoots: [dir] }, dir, config));
  adapter.registerTools([...TOOLS, toolDescriptorFromPi({ name: "withheld_tool", description: "the withheld tool" })]);
  await adapter.beginTask("do the work", "do the work");
  return { adapter, dir };
}

const lastPayload = (k: KernelAdapter, type: string) =>
  k.recentEvents(500).filter((e) => e.type === type).at(-1)?.payload as Record<string, unknown> | undefined;

/** Preflight only: which tier did the RULE assign? */
async function tierOf(k: KernelAdapter, tool: string, input: unknown, id: string): Promise<DenialTier | undefined> {
  const { decision } = await k.precheckToolCall(tool, "execute", input, undefined, id);
  assert.equal(decision.decision, "DENY", `${tool} must be refused, or this pin proves nothing`);
  return (decision as { tier?: DenialTier }).tier;
}

/**
 * The PRODUCTION order for a refusal, transcribed from the Pi bridge:
 * `tool_execution_start` binds, the preflight refuses, `tool_execution_end`
 * delivers the reason and its tier. Precheck-first never binds, and a result
 * that was never bound is discarded (f006-denial-certificate-shape.test.ts).
 */
async function refuseThenReport(
  k: KernelAdapter, tool: string, input: unknown, id: string, tierOverride?: DenialTier,
): Promise<string> {
  const bound = await k.beginToolExecution(id, tool, { toolCallId: id });
  assert.ok(bound, `${id}: the start event binds before the preflight runs`);
  const { decision } = await k.precheckToolCall(tool, "execute", input, undefined, id);
  assert.equal(decision.decision, "DENY", `${id}: the call must actually be refused`);
  await k.recordToolResult(id, tool, undefined, true, undefined, decision.reason, undefined,
    tierOverride ?? (decision as { tier?: DenialTier }).tier);
  return decision.reason;
}

// === 1. SOFT_REFUSE: the agent can adapt, so the task lives ===============

test("D1.1 a read outside the workspace is SOFT_REFUSE", async () => {
  const { adapter, dir } = await governed();
  const outside = path.join(path.dirname(dir), "elsewhere.md");
  assert.equal(await tierOf(adapter, "read", { path: outside }, "s1"), "SOFT_REFUSE",
    "pointing at something outside the sandbox is a scope question, not a hazard");
});

test("D1.2 an unapproved tool is SOFT_REFUSE", async () => {
  const { adapter } = await governed();
  assert.equal(await tierOf(adapter, "withheld_tool", {}, "s2"), "SOFT_REFUSE",
    "a tool that is not on the list is a question about authority, not a hazard");
});

test("D1.3 a soft refusal leaves the task ALIVE and books no budget", async () => {
  const { adapter } = await governed();
  const reason = await refuseThenReport(adapter, "withheld_tool", {}, "s3");
  const task = adapter.currentTask!;
  assert.notEqual(task.status, "FAILED", "a soft refusal must not end the run");
  assert.equal(task.retryCount, 0, "and must not be retried");
  assert.equal(task.replanCount, 0, "or replanned");
  assert.equal(lastPayload(adapter, "RECOVERY_STARTED")?.reason, "POLICY_SOFT_REFUSED");
  assert.ok(reason.length > 0, "and the rule's own words are available to report");
});

test("D1.3b the refusal still names the rule that made it", async () => {
  const { adapter } = await governed();
  const reason = await refuseThenReport(adapter, "withheld_tool", {}, "s4");
  const refusal = lastPayload(adapter, "SOFT_REFUSAL_CONTINUED");
  assert.equal(refusal!.denialReason, reason, "survivable, but never anonymous");
  assert.equal(adapter.lastFailureReport!.tier, "SOFT_REFUSE", "and the tier travels with it");
});

// === 2. HARD_DENY: the call is the hazard, so the run ends ===============

test("D1.4 a destructive command is HARD_DENY", async () => {
  const { adapter } = await governed();
  assert.equal(await tierOf(adapter, "bash", { command: `${DESTRUCTIVE} /tmp/anything` }, "h1"), "HARD_DENY",
    "a destructive command is refused because of what it is");
});

test("D1.4b a secret write is HARD_DENY", async () => {
  const { adapter, dir } = await governed();
  const payload = { path: path.join(dir, "notes.md"), content: `${SECRET_KEY} = ${SECRET_VALUE}` };
  assert.equal(await tierOf(adapter, "write", payload, "h1b"), "HARD_DENY",
    "persisting a credential is refused because of what it carries");
});

test("D1.4c a workspace ESCAPE on a write is HARD_DENY", async () => {
  const { adapter, dir } = await governed();
  const outside = path.join(path.dirname(dir), "escape.md");
  assert.equal(await tierOf(adapter, "write", { path: outside, content: "x" }, "h1c"), "HARD_DENY",
    "writing outside the sandbox is an escape; READING outside it is D1.1's scope question");
});

test("D1.4d a scan that could not complete is HARD_DENY (fail closed)", async () => {
  // Truncation means "not scanned", and "not scanned" is not "nothing found".
  // The ruling puts it in the hard tier, and it must not soften because the
  // call would probably have been fine.
  const { adapter } = await governed();
  const deep: Record<string, unknown> = { path: "a.md" };
  let cursor = deep;
  for (let i = 0; i < 60; i += 1) {
    const next: Record<string, unknown> = {};
    cursor.nested = next;
    cursor = next;
  }
  cursor.value = `${DESTRUCTIVE} buried`;
  assert.equal(await tierOf(adapter, "write", deep, "h1d"), "HARD_DENY",
    "a scan that stopped early cannot certify the payload, so the call is refused as a hazard");
});

test("D1.5 a hard refusal TERMINATES with the rule's own reason on the certificate", async () => {
  const { adapter } = await governed();
  const reason = await refuseThenReport(adapter, "bash", { command: `${DESTRUCTIVE} /tmp/anything` }, "d5");
  const task = adapter.currentTask!;
  assert.equal(task.status, "FAILED", "a hazard ends the run, by ruling");
  assert.equal(typeof task.failureReason, "string");
  assert.match(task.failureReason!, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the certificate names WHICH rule refused it");
  const failed = lastPayload(adapter, "TASK_FAILED");
  assert.equal(failed?.reasonCode, "POLICY_DENIED_TERMINATED");
  assert.equal(failed?.failure, "POLICY_DENIED");
});

test("D1.5b a hard refusal is still not retryable and not replan-worthy", async () => {
  const { adapter } = await governed();
  await refuseThenReport(adapter, "bash", { command: `${DESTRUCTIVE} /tmp/anything` }, "d5b");
  const started = lastPayload(adapter, "RECOVERY_STARTED");
  assert.notEqual(started?.strategy, "RETRY", "a hazard is never retried");
  assert.notEqual(started?.strategy, "REPLAN", "and never replanned");
  assert.equal(adapter.currentTask!.replanCount, 0, "and no replan budget was funded on the way there");
});

// === 3. the tiers are a property of the RULE, and only the rule ==========

test("D1.6 the decision table separates the tiers and nothing else", () => {
  for (const tier of TIERS) {
    const decision = chooseRecoveryDetailed({
      failure: "POLICY_DENIED", limits: DEFAULT_LIMITS,
      retryCount: 0, replanCount: 0, strategyCount: 0, depth: 0, idempotency: "IDEMPOTENT",
      tier,
    });
    if (tier === "HARD_DENY") {
      assert.deepEqual(decision, { strategy: "TERMINATE", reason: "POLICY_DENIED_TERMINATED" });
    } else {
      assert.deepEqual(decision, { strategy: "CONTINUE", reason: "POLICY_SOFT_REFUSED" });
    }
  }
});

test("D1.6b an ABSENT tier is a soft refusal, and that is the D1 reversal preserved", () => {
  // Every caller that does not yet supply a tier keeps byte-identical behaviour.
  // The tier engines that do not classify (TrustedProjectPolicy, DefaultPolicy,
  // and any embedder's own engine) therefore keep their refusals survivable,
  // which is what the reversal of 2026-10-01 established.
  const decision = chooseRecoveryDetailed({
    failure: "POLICY_DENIED", limits: DEFAULT_LIMITS,
    retryCount: 0, replanCount: 0, strategyCount: 0, depth: 0, idempotency: "IDEMPOTENT",
  });
  assert.deepEqual(decision, { strategy: "CONTINUE", reason: "POLICY_SOFT_REFUSED" });
});

test("D1.6c a hard denial is never blamed on a budget", () => {
  // The rule that fired IS the cause. A certificate naming an exhausted budget
  // for a destructive command would send an investigator after the wrong thing,
  // which is the reason the tiers exist at all.
  for (const depth of [0, DEFAULT_LIMITS.maxRecoveryDepth]) {
    const decision = chooseRecoveryDetailed({
      failure: "POLICY_DENIED", limits: DEFAULT_LIMITS,
      retryCount: 0, replanCount: 0, strategyCount: 0, depth, idempotency: "IDEMPOTENT",
      tier: "HARD_DENY",
    });
    assert.doesNotMatch(decision.reason, /BUDGET_EXHAUSTED|DEPTH_EXHAUSTED/,
      "the refusal is reported as the refusal, at any depth");
  }
});

test("D1.7 the tier is observable to the bridge, not only inside the kernel", async () => {
  const { adapter } = await governed();
  const reason = await refuseThenReport(adapter, "bash", { command: `${DESTRUCTIVE} /tmp/anything` }, "d7");
  const report = adapter.lastFailureReport!;
  assert.equal(report.classification, "POLICY_DENIED");
  assert.equal(report.tier, "HARD_DENY",
    "a caller that reports the refusal outward must be able to say WHICH tier it was");
  assert.equal(report.denialReason, reason, "with the rule's own words, unchanged");
});

test("D1.8 a tier decides the task's fate and nothing else about the refusal", async () => {
  // The strongest anti-over-reach pin available: same class, same rule, same
  // reason-preserving machinery, opposite task outcomes decided ONLY by the tier.
  const soft = await governed();
  await refuseThenReport(soft.adapter, "withheld_tool", {}, "pair-soft");
  const hard = await governed();
  await refuseThenReport(hard.adapter, "bash", { command: `${DESTRUCTIVE} /tmp/anything` }, "pair-hard");

  for (const report of [soft.adapter.lastFailureReport!, hard.adapter.lastFailureReport!]) {
    assert.equal(report.classification, "POLICY_DENIED", "both are the same failure class");
    assert.equal(typeof report.denialReason, "string", "and both preserve the rule's words");
    assert.equal(report.strategy === "CONTINUE" || report.strategy === "TERMINATE", true);
  }
  assert.equal(soft.adapter.currentTask!.status !== "FAILED", true, "SOFT_REFUSE lives");
  assert.equal(hard.adapter.currentTask!.status, "FAILED", "HARD_DENY terminates");
});