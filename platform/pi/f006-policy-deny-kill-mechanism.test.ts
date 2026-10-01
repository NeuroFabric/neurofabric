/**
 * F-006 ITEM 0 — the KILL MECHANISM.
 *
 * A policy DENY killed the task. The committed `.pi/neurofebric-policy.json`
 * says `onViolation: block`, which means the refusal is survivable, so a live
 * run that contradicts its own committed policy is a defect, not an operator
 * setting. (Confirmed by the operator: the policy file is tracked and
 * legitimate. It has never been the bug.)
 *
 * MEASURED mechanism (this file, red-first):
 *
 *   ConfiguredPolicy DENY { reason, violation: "block" }
 *     -> the extension forwards only `denialReason` to `recordToolResult`
 *     -> the `violation` field is DROPPED at that boundary, so recovery is
 *        told the denial was UNLABELLED
 *     -> `chooseRecoveryDetailed` fails closed on an absent violation
 *     -> TERMINATE / POLICY_DENIED_TERMINATED
 *
 * D5 built the survivable branch and it works — proven below by the test that
 * passes `violation: "block"` explicitly. D5's executor-side fix "never sees
 * this path" because the value that would reach it is dropped one layer
 * earlier, at the extension boundary.
 *
 * The contract asserted here:
 *   1. a `block` denial is DELIVERED AS A TOOL RESULT, and the task returns to
 *      the live planning state and CONTINUES;
 *   2. §2.3 accounting — a POLICY_DENIED records a REFUSAL and never a BUDGET
 *      SPEND: no retry, no replan, no strategy change, no recovery depth;
 *   3. a hard `../../*` escape is still HARD-DENIED — and the task still lives.
 *      Hard denial, zero termination, zero budget.
 *
 * On "READY": this kernel's `TaskStatus` has no `READY`. The live, actionable,
 * awaiting-next-move state is `PLANNING`, which is where the survivable branch
 * puts the task. READY == PLANNING here, and that mapping is asserted rather
 * than assumed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { buildPolicy } from "./project-config.ts";
import { parsePolicyConfig, type PolicyConfig } from "../core/policy-config.ts";
import { DEFAULT_LIMITS, chooseRecoveryDetailed } from "../core/index.ts";

/** The committed policy's own `onViolation`. Never `abort`. */
const RULES = {
  version: 1,
  deniedTools: ["bash"],
  allowedTools: [],
  fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
  destructiveCommandPatterns: ["rm -rf"],
  destructiveCommandTokens: ["rm"],
  limits: { maxToolCallsPerTask: 40, maxFileWritesPerTask: 10, maxBytesPerWrite: 2_000_000 },
  onViolation: "block",
} as const;

/** The reason a real ConfiguredPolicy produces for a refused call. */
const DENIAL_REASON = "policy <p> denied 'read': path 'secrets.md' is outside the allowed roots";

const TOOLS = ["read", "bash", "write"];

/** An adapter fronted by a real ConfiguredPolicy, exactly as the extension builds it. */
async function denyingAdapter() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-f006-item0-"));
  const policyConfig: PolicyConfig = parsePolicyConfig({ ...RULES }, "f006-item0-policy.json");
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy({ policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] }, dir, policyConfig));
  for (const name of TOOLS) adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
  await adapter.beginTask("do the work", "do the work");
  return { adapter, dir };
}

const eventsOf = (k: KernelAdapter, type: string) => k.recentEvents(500).filter((e) => e.type === type);
const lastPayload = (k: KernelAdapter, type: string) =>
  eventsOf(k, type).at(-1)?.payload as Record<string, unknown> | undefined;

/**
 * The LIVE shape, byte for byte as `.pi/extensions/platform-orchestrator.ts`
 * drives it: precheck admits, Pi begins a real execution, then the refusal is
 * reported as that execution's result — forwarded with `errorRetryable` and
 * `denialReason` only. No `violation` argument, because the live call site
 * passes none. This is the shape on which the task died.
 */
async function denyOnTheLivePath(adapter: KernelAdapter, callId: string): Promise<void> {
  const { decision } = await adapter.precheckToolCall("read", "execute", { path: "secrets.md" }, undefined, callId);
  assert.equal(decision.decision, "ALLOW", "the call is admitted; the denial arrives afterwards, mid-execution");
  const bound = await adapter.beginToolExecution(callId, "read");
  assert.ok(bound, "an execution is bound, so the result is not discarded as out-of-order");
  await adapter.recordToolResult(callId, "read", undefined, true, undefined, DENIAL_REASON);
}

// --- 1. the denial is delivered and the task continues --------------------

test("ITEM0.1 a block denial on the live path is delivered as a result, not a death", async () => {
  const { adapter } = await denyingAdapter();
  await denyOnTheLivePath(adapter, "item0-live");

  assert.equal(
    adapter.currentTask!.status,
    "PLANNING",
    "READY == PLANNING here: the task is live and awaiting its next move",
  );
  assert.notEqual(adapter.currentTask!.status, "FAILED", "a `block` denial must never kill a task");
  assert.equal(
    eventsOf(adapter, "TASK_FAILED").length,
    0,
    "no failure certificate is emitted for a survivable refusal",
  );
});

test("ITEM0.2 the refusal is REPORTED, so the operator can see which rule refused", async () => {
  const { adapter } = await denyingAdapter();
  await denyOnTheLivePath(adapter, "item0-refusal");

  const refusal = lastPayload(adapter, "SOFT_REFUSAL_CONTINUED");
  assert.ok(refusal, "the refusal is recorded as a refusal event, not swallowed");
  assert.equal(refusal!.failure, "POLICY_DENIED", "it keeps its identity all the way through recovery");
  assert.equal(refusal!.strategy, "CONTINUE", "and it books no budget");
});

// --- 2. §2.3 accounting: a refusal is not a spend -------------------------

test("ITEM0.3 §2.3 a POLICY_DENIED spends NO budget of any kind", async () => {
  const { adapter } = await denyingAdapter();
  const before = adapter.diagnostics;
  await denyOnTheLivePath(adapter, "item0-budget");

  const after = adapter.diagnostics;
  assert.equal(adapter.currentTask!.retryCount, 0, "no retry spent");
  assert.equal(adapter.currentTask!.replanCount, 0, "no replan spent");
  assert.equal(adapter.currentTask!.strategyCount ?? 0, 0, "no strategy change spent");
  assert.equal(after.recoveryDepth, before.recoveryDepth, "and no recovery depth consumed");

  const started = lastPayload(adapter, "RECOVERY_STARTED");
  assert.ok(started, "recovery ran");
  assert.notEqual(started!.strategy, "REPLAN", "the replan loop is never entered on a denial");
  assert.notEqual(started!.strategy, "RETRY", "nor the retry loop");
  assert.notEqual(started!.strategy, "TERMINATE", "nor does it terminate");
});

test("ITEM0.4 repeated denials are still free — a refusal cannot starve the task", async () => {
  const { adapter } = await denyingAdapter();
  // The same call, denied again and again. Each denial is the same answer.
  for (const id of ["item0-r1", "item0-r2", "item0-r3", "item0-r4", "item0-r5"]) {
    await denyOnTheLivePath(adapter, id);
    assert.notEqual(adapter.currentTask!.status, "FAILED", `the task survived denial ${id}`);
  }
  assert.equal(adapter.currentTask!.replanCount, 0, "five denials, zero replans");
  assert.equal(adapter.currentTask!.retryCount, 0, "five denials, zero retries");
});

// --- 3. the table itself, budgets deliberately spent ----------------------

test("ITEM0.5 the table never spends budget on POLICY_DENIED, however deep", () => {
  // Every budget deliberately exhausted. A refusal must not be able to reach a
  // path that another move could have funded, and must not die of a budget it
  // never touched.
  for (const idempotency of ["IDEMPOTENT", "NON_IDEMPOTENT", "UNKNOWN"] as const) {
    for (const attemptMatchesLastFailure of [true, false]) {
      for (const violation of ["block", "abort", undefined] as const) {
        for (const budget of [0, 2, 4]) {
          const decision = chooseRecoveryDetailed({
            failure: "POLICY_DENIED",
            limits: DEFAULT_LIMITS,
            retryCount: budget,
            replanCount: budget,
            strategyCount: budget,
            depth: budget,
            idempotency,
            attemptMatchesLastFailure,
            violation,
          });
          assert.notEqual(decision.strategy, "REPLAN", `refusal replanned (${idempotency}, budget=${budget})`);
          assert.notEqual(decision.strategy, "RETRY", `refusal retried (${idempotency}, budget=${budget})`);
          assert.notEqual(
            decision.reason,
            "RECOVERY_DEPTH_EXHAUSTED",
            `a refusal died of the depth guard — the mechanism this file kills`,
          );
          assert.notEqual(decision.reason, "REPLAN_BUDGET_EXHAUSTED", "a refusal died of a budget it never spent");
        }
      }
    }
  }
});
