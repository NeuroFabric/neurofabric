import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { buildPolicy } from "./project-config.ts";
import { chooseRecoveryDetailed, type RecoveryLimits } from "../core/index.ts";

/**
 * D4B — recovery classification of ORDINARY command failures.
 *
 * THE DEFECT, REPRODUCED. An ordinary failure — a command that exited non-zero,
 * a path that was not there, a tool that simply failed — arrived at recovery as
 * `TOOL_FAILURE`. `TOOL_FAILURE` is not in `RETRY_ELIGIBLE`, so the decision
 * table went straight to the generic REPLAN tail. The replan budget is two. So:
 *
 *   failure 1 -> REPLAN (replanCount 1)
 *   failure 2 -> REPLAN (replanCount 2)
 *   failure 3 -> TERMINATE
 *
 * Three ordinary failures ended the task, before a single retry was offered.
 * The previous fix session was killed by exactly this. In product terms the app
 * dies the moment a user asks for something slightly unusual, and it dies with
 * a budget certificate that blames recovery rather than naming the cause.
 *
 * D4B's rule, in the order the owner set it:
 *
 *   R1  an ordinary failure gets the RETRY path FIRST
 *   R2  retries do NOT consume the replan budget
 *   R3  only after the retries are spent is a replan considered, and then
 *       escalation / termination with a STRUCTURED reason
 *   R4  D1's refusal semantics are untouched
 *   R5  the classification and the denial reason survive the whole path,
 *       including the external Pi execution-result path (see
 *       d4b-bridge-metadata.test.ts)
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT CLAIM. A RETRY here is not the kernel
 * re-running the command. `RETRY` advances the task to RETRYING and then back to
 * PLANNING, which hands control to whoever plans — the model, in production.
 * The kernel funds another turn; it does not blindly re-execute. That is why a
 * deterministic failure may be retried at all, and why the bounds below are the
 * real safety property: the run is still capped, and it is capped by counters
 * that name themselves.
 */

const LIMITS: RecoveryLimits = {
  maxToolRetries: 2,
  maxReplans: 2,
  maxStrategyChanges: 2,
  maxRecoveryDepth: 3,
  maxExecutionTimeMs: 1000,
};

/** Pi's own bash tools are `idempotency: UNKNOWN` (platform/pi/tool-adapter.ts). */
const BASH = toolDescriptorFromPi({ name: "bash", description: "run a command" });

async function trustedAdapter(): Promise<KernelAdapter> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-d4b-"));
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy({ policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] }, dir));
  adapter.registerTools([BASH, toolDescriptorFromPi({ name: "read", description: "read a file" })]);
  await adapter.beginTask("summarise the report", "summarise the report");
  return adapter;
}

const lastPayload = (adapter: KernelAdapter, type: string) =>
  adapter.recentEvents(500).filter((e) => e.type === type).at(-1)?.payload as Record<string, unknown> | undefined;

/**
 * Drive one ordinary command failure through the PRODUCTION sequence: preflight
 * (which is where the program name is captured), bind, then the failing result.
 *
 * `grep` is used because its "found nothing" exit code is already claimed by
 * BENIGN_NONZERO_EXIT; exit 2 for `grep` is a genuine error, so this cannot be
 * passing because of the benign-exit rule. The MISSING-PATH shape — no exit
 * status at all — is driven separately below, because that is the case the
 * bridge actually produces for a tool that is not a shell.
 */
async function failCommandOnce(adapter: KernelAdapter, callId: string, exitCode = 2): Promise<void> {
  const { decision } = await adapter.precheckToolCall("bash", "execute", { command: "grep -q needle haystack.txt" }, undefined, callId);
  assert.equal(decision.decision, "ALLOW", "the command itself must be allowed, so the failure is the tool's and not policy's");
  const bound = await adapter.beginToolExecution(callId, "bash", { toolCallId: callId });
  assert.ok(bound, "the execution must bind");
  await adapter.recordToolResult(callId, "bash", { output: `exit status ${exitCode}` }, true);
}

/** A tool that is not a shell: no exit status, no program name. A missing path. */
async function failMissingPathOnce(adapter: KernelAdapter, callId: string): Promise<void> {
  const { decision } = await adapter.precheckToolCall("read", "execute", { path: "does/not/exist.csv" }, undefined, callId);
  assert.equal(decision.decision, "ALLOW");
  const bound = await adapter.beginToolExecution(callId, "read", { toolCallId: callId });
  assert.ok(bound);
  await adapter.recordToolResult(callId, "read", { error: "ENOENT: no such file or directory" }, true);
}

/**
 * The PRODUCTION order, which is the only one a refusal survives:
 * `tool_execution_start` binds FIRST, the preflight denies afterwards, and the
 * result carries the reason in. Precheck-first never binds, and a result that
 * was never bound is discarded — see f006-denial-certificate-shape.test.ts.
 */
async function denyReadOnce(adapter: KernelAdapter, callId: string): Promise<string> {
  const bound = await adapter.beginToolExecution(callId, "read", { toolCallId: callId });
  assert.ok(bound, "the start event binds before the preflight runs");
  const { decision } = await adapter.precheckToolCall("read", "execute", { path: ".env" }, undefined, callId);
  assert.equal(decision.decision, "DENY", "the real policy must actually refuse this call");
  await adapter.recordToolResult(callId, "read", undefined, true, undefined, decision.reason);
  return decision.reason;
}

// --- T1: retry first, replan untouched ------------------------------------

test("T1.1 an ordinary command failure is RETRIED, not replanned", async () => {
  const adapter = await trustedAdapter();
  await failCommandOnce(adapter, "c1");

  const started = lastPayload(adapter, "RECOVERY_STARTED");
  assert.equal(started?.failure, "TOOL_FAILURE", "it classifies as an ordinary tool failure, which it is");
  assert.equal(started?.strategy, "RETRY", "R1: the RETRY path comes first, not the replan tail");
  assert.equal(typeof started?.reason, "string");

  const task = adapter.currentTask!;
  assert.equal(task.retryCount, 1, "the retry budget is what an ordinary failure spends");
  assert.equal(task.replanCount, 0, "R2: and it spends NO replan budget");
  assert.notEqual(task.status, "FAILED", "the task survives its first ordinary failure");
});

test("T1.2 a missing path is RETRIED and spends no replan budget either", async () => {
  const adapter = await trustedAdapter();
  await failMissingPathOnce(adapter, "c2");

  const task = adapter.currentTask!;
  assert.equal(lastPayload(adapter, "RECOVERY_STARTED")?.strategy, "RETRY", "no exit status is not a reason to skip the retry path");
  assert.equal(task.retryCount, 1);
  assert.equal(task.replanCount, 0);
});

test("T1.3 the retry budget is the ONLY budget an ordinary failure can reach first", () => {
  // The decision table is pinned here as well as through the adapter, so a
  // regression cannot hide behind adapter bookkeeping.
  for (const idempotency of ["IDEMPOTENT", "UNKNOWN"] as const) {
    assert.deepEqual(
      chooseRecoveryDetailed({
        failure: "TOOL_FAILURE", limits: LIMITS,
        retryCount: 0, replanCount: 0, depth: 0, idempotency,
      }),
      { strategy: "RETRY", reason: "TOOL_FAILURE_RETRY" },
      `a fresh ${idempotency} ordinary failure must be retried`,
    );
  }
});

// --- T2: retries exhausted -> replan -> structured terminal ---------------

test("T2.1 the retries are exhausted BEFORE any replan is considered", async () => {
  const adapter = await trustedAdapter();
  await failCommandOnce(adapter, "r1");
  await failCommandOnce(adapter, "r2");

  const task = adapter.currentTask!;
  assert.equal(task.retryCount, 2, `both retries are offered first (maxToolRetries=${LIMITS.maxToolRetries})`);
  assert.equal(task.replanCount, 0, "and not one of them touched the replan budget");
  assert.notEqual(task.status, "FAILED", "the task is still alive at this point");
});

test("T2.2 with the retries spent, a replan is taken within budget", async () => {
  const adapter = await trustedAdapter();
  await failCommandOnce(adapter, "r1");
  await failCommandOnce(adapter, "r2");
  await failCommandOnce(adapter, "r3");

  const task = adapter.currentTask!;
  assert.equal(task.retryCount, 2, "the retry budget is not overspent");
  assert.equal(task.replanCount, 1, "and only now is a replan funded");
  assert.notEqual(task.status, "FAILED", "a replan within budget is not a death");
});

test("T2.3 exhaustion TERMINATES with a structured reason, never a silent death", async () => {
  const adapter = await trustedAdapter();
  for (const id of ["x1", "x2", "x3", "x4"]) await failCommandOnce(adapter, id);

  const task = adapter.currentTask!;
  assert.equal(task.status, "FAILED", "the run is bounded and the bound is real");
  const reason = task.failureReason ?? "";
  assert.match(reason, /Recovery TERMINATE \[/, "a structured terminal certificate, not a bare status change");
  assert.match(reason, /failure=TOOL_FAILURE/, "naming the failure class");
  assert.match(reason, /retryCount=\d+\/2/, "naming the retry budget");
  assert.match(reason, /replanCount=\d+\/2/, "naming the replan budget");
  assert.match(reason, /recoveryDepth=\d+\/3/, "naming the depth budget");
  assert.doesNotMatch(reason, /undefined/, "no certificate may print an absent counter as undefined");

  // And the event stream says the same thing.
  const failed = lastPayload(adapter, "TASK_FAILED");
  assert.equal(failed?.strategy, "TERMINATE");
  assert.equal(typeof failed?.reasonCode, "string");
  assert.equal(failed?.failure, "TOOL_FAILURE");
});

test("T2.4 a tool that DECLARES itself non-idempotent is still not retried", () => {
  // The one guard D4B keeps. A blind repeat of a declared side-effecting call
  // is a different risk from a bounded extra turn at the planner, and nothing
  // about D4B is worth widening that.
  assert.deepEqual(
    chooseRecoveryDetailed({
      failure: "TOOL_FAILURE", limits: LIMITS,
      retryCount: 0, replanCount: 0, depth: 0, idempotency: "NON_IDEMPOTENT",
    }),
    { strategy: "ESCALATE", reason: "TOOL_FAILURE_NON_IDEMPOTENT_ESCALATED" },
  );
});

test("T2.5 the bounds hold for a NON-retryable tool too: it escalates without spending a retry", async () => {
  const decision = chooseRecoveryDetailed({
    failure: "TOOL_FAILURE", limits: LIMITS,
    retryCount: LIMITS.maxToolRetries, replanCount: 0, depth: 0, idempotency: "NON_IDEMPOTENT",
  });
  assert.equal(decision.strategy, "ESCALATE", "the declaration, not the retry budget, is what stops this retry");
});

// --- T3: D1 refusal semantics are untouched -------------------------------

test("T3.1 a policy denial spends no retry, no replan and no strategy budget", async () => {
  const adapter = await trustedAdapter();
  await denyReadOnce(adapter, "d1");

  const task = adapter.currentTask!;
  assert.equal(task.retryCount, 0, "a refusal is not a fault to be retried");
  assert.equal(task.replanCount, 0, "and not a fault to be replanned");
  assert.equal(task.strategyCount ?? 0, 0, "and it buys no strategy change");
  assert.notEqual(task.status, "FAILED", "D1 as ratified 2026-10-01: a refusal does not kill the task");
});

test("T3.2 a denial keeps its category and the policy's own words, and is not a TOOL_FAILURE", async () => {
  const adapter = await trustedAdapter();
  const reason = await denyReadOnce(adapter, "d2");

  const refusal = lastPayload(adapter, "SOFT_REFUSAL_CONTINUED");
  assert.ok(refusal, "the refusal is recorded, not swallowed");
  assert.equal(refusal!.failure, "POLICY_DENIED", "its own category, never collapsed into TOOL_FAILURE");
  assert.equal(refusal!.denialReason, reason, "carrying the policy's own words verbatim");

  // And D4B did not quietly widen the retry-first rule to denials.
  const started = lastPayload(adapter, "RECOVERY_STARTED");
  assert.notEqual(started?.strategy, "RETRY", "a refusal is never retried");
});

// --- T5: self-hosting — an ordinary-failure session survives -------------

test("T5.1 a session that keeps hitting ordinary failures is NOT killed", async () => {
  // This is the shape that killed the previous session: a run that keeps meeting
  // ordinary obstacles while still making progress. Recovery depth is a bound on
  // CONSECUTIVE rounds since the last success, so an ordinary failure between
  // two successes must cost nothing at all.
  const adapter = await trustedAdapter();
  for (let round = 1; round <= 3; round++) {
    await failCommandOnce(adapter, `loop-${round}-fail`);
    assert.notEqual(adapter.currentTask!.status, "FAILED", `round ${round}: an ordinary failure between successes must not kill the task`);
    const bound = await adapter.beginToolExecution(`loop-${round}-ok`, "bash", { toolCallId: `loop-${round}-ok` });
    assert.ok(bound, `round ${round}: the task still admits a call`);
    await adapter.recordToolResult(`loop-${round}-ok`, "bash", { output: "ok" }, false);
  }

  const task = adapter.currentTask!;
  // The retry fund is TASK-WIDE and holds two (T5.1c), so the third ordinary
  // failure in this task needs a replan even though progress was made in
  // between. What matters is that ONE replan carried three rounds to a
  // completed session. Before D4B the same session spent a replan per round and
  // died on the third, with the retry budget never touched at all.
  assert.equal(task.replanCount, 1, "three ordinary failures cost one replan, not three");
  const finished = await adapter.finishTask({});
  assert.equal(finished.status, "COMPLETED", "T5: the session completes instead of being killed");
});

test("T5.1b the consecutive burst survives one failure more than it used to, and dies on a reason", async () => {
  // The bounds are still real, and this is what they look like when they are
  // reached: four consecutive ordinary failures (two retries, one replan, then
  // the depth guard), a TERMINATE, and a certificate that names every budget.
  // Before D4B the same run died at the third failure with the retry budget
  // untouched — which is the fingerprint the fix exists to move.
  const adapter = await trustedAdapter();
  await failCommandOnce(adapter, "burst-1");
  await failCommandOnce(adapter, "burst-2");
  await failCommandOnce(adapter, "burst-3");
  assert.notEqual(adapter.currentTask!.status, "FAILED", "three consecutive ordinary failures no longer kill the task");
  assert.equal(adapter.currentTask!.retryCount, 2, "and the retries were actually offered, not skipped");
  assert.equal(adapter.currentTask!.replanCount, 1);

  await failCommandOnce(adapter, "burst-4");
  assert.equal(adapter.currentTask!.status, "FAILED", "the run is still bounded");
  assert.match(adapter.currentTask!.failureReason!, /Recovery TERMINATE \[/, "with a structured reason, not a bare status");
});

test("T5.1c the budgets are TASK-CUMULATIVE, and that residual is stated, not hidden", async () => {
  // `maxToolRetries` and `maxReplans` have always been task-wide bounds, not
  // per-attempt ones (see the RecoveryLimits docs). D4B does not change that,
  // and the consequence is worth pinning so nobody later reads "an ordinary
  // failure is now safe" as "an ordinary failure is now free": a long run that
  // meets more ordinary failures than the task-wide budgets allow still ends,
  // but it ends with a certificate naming the budget rather than a silent death.
  const adapter = await trustedAdapter();
  for (let round = 1; round <= 5; round++) {
    await failCommandOnce(adapter, `cumulative-${round}`);
    const bound = await adapter.beginToolExecution(`cumulative-${round}-ok`, "bash", { toolCallId: `cumulative-${round}-ok` });
    if (bound) await adapter.recordToolResult(`cumulative-${round}-ok`, "bash", { output: "ok" }, false);
  }
  assert.equal(adapter.currentTask!.status, "FAILED", "the task-wide budgets still bound the run");
  assert.match(adapter.currentTask!.failureReason!, /replanCount=2\/2|recoveryDepth=3\/3/,
    "and the certificate names which task-wide budget actually stopped it");
});

test("T5.2 progress between failures resets the consecutive-round bound", () => {
  // The mechanism T5.1 depends on, pinned directly: depth is measured from the
  // last success, so it is not a task-lifetime counter wearing a new name.
  const first = chooseRecoveryDetailed({
    failure: "TOOL_FAILURE", limits: LIMITS,
    retryCount: 0, replanCount: 0, depth: 0, idempotency: "UNKNOWN",
  });
  assert.equal(first.strategy, "RETRY");
  const afterDepthReset = chooseRecoveryDetailed({
    failure: "TOOL_FAILURE", limits: LIMITS,
    retryCount: 0, replanCount: 0, depth: 0, idempotency: "UNKNOWN",
  });
  assert.equal(afterDepthReset.strategy, "RETRY", "a reset depth buys the full retry path again");
});

test("T5.3 the adapter exposes the classification it acted on (R5, kernel half)", async () => {
  const adapter = await trustedAdapter();
  await failCommandOnce(adapter, "obs-1");
  const report = adapter.lastFailureReport;
  assert.ok(report, "the classification must be observable from OUTSIDE the adapter, or the trace cannot carry it");
  assert.equal(report!.classification, "TOOL_FAILURE");
  assert.equal(report!.strategy, "RETRY");
  assert.equal(report!.denialReason, undefined, "an ordinary failure names no rule, and does not borrow one");
});

test("T5.4 a denial's report carries the rule that refused it", async () => {
  const adapter = await trustedAdapter();
  const reason = await denyReadOnce(adapter, "obs-2");

  const report = adapter.lastFailureReport;
  assert.equal(report!.classification, "POLICY_DENIED", "attribution starts with the category");
  assert.equal(report!.denialReason, reason, "and it is only attributable with the policy's own words");
});