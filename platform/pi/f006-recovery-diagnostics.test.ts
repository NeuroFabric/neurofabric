import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import {
  DEFAULT_LIMITS,
  chooseRecovery,
  chooseRecoveryDetailed,
  classifyFailure,
  describeTerminalRecovery,
  type RecoveryLimits,
} from "../core/index.ts";
import { CoreError } from "../core/errors.ts";

/**
 * F-006: structured recovery diagnostics.
 *
 * The original finding hypothesised that `maxStepRetries=1` / `maxToolRetries=2`
 * were exhausted by two failed edits. Investigation disproved that: a tool
 * failure reached recovery as a plain `Error`, `classifyFailure` collapsed it to
 * `UNKNOWN`, `UNKNOWN` is not retry-eligible, and control fell through to the
 * generic REPLAN tail until `maxReplans`/`maxRecoveryDepth` were spent.
 *
 * These tests pin the corrected behaviour and the diagnostics that make the
 * next occurrence explainable from the trace alone.
 *
 * D4B, 2026-10-01 — READ THE BUDGET ARITHMETIC WITH THE LADDER IN MIND. The
 * chain below was corrected TWICE, and the second correction is what changed
 * these numbers: `TOOL_FAILURE` is not retry-eligible, so an ordinary failure
 * went straight to the generic REPLAN tail until the replan budget and the
 * depth guard were spent. D4B gives an ordinary failure its own RETRY first, so
 * the same sequence now walks RETRY -> RETRY -> REPLAN -> TERMINATE(depth)
 * instead of REPLAN -> REPLAN -> TERMINATE(replan).
 *
 * The pins that asserted the ladder itself (F006.2, F006.2b, F006.3) were
 * written against the old one and are restated here against the new one. Every
 * claim about CLASSIFICATION, about `UNKNOWN` never reaching recovery, and about
 * a terminal reason naming the budget that actually stopped the run is
 * unchanged, and each carries a D4B note saying what moved and why.
 */

const LIMITS: RecoveryLimits = { maxToolRetries: 2, maxReplans: 2, maxStrategyChanges: 2, maxRecoveryDepth: 3, maxExecutionTimeMs: 1000 };

async function newAdapter() {
  const adapter = new KernelAdapter();
  adapter.registerTools([toolDescriptorFromPi({ name: "edit", description: "edit a file" })]);
  adapter.registerTools([toolDescriptorFromPi({ name: "read", description: "read a file" })]);
  await adapter.beginTask("edit the docs", "edit the docs");
  return adapter;
}

const events = (adapter: KernelAdapter, type: string) =>
  adapter.recentEvents(500).filter((e) => e.type === type);
const lastPayload = (adapter: KernelAdapter, type: string) =>
  events(adapter, type).at(-1)?.payload as Record<string, unknown> | undefined;

/** Drive `count` consecutive failed tool executions, as a bad edit would. */
async function failTimes(adapter: KernelAdapter, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    const bound = await adapter.beginToolExecution(`call-${i}`, "edit");
    assert.ok(bound, `execution ${i} must be admitted`);
    await adapter.recordToolResult(`call-${i}`, "edit", undefined, true);
  }
}

// --- 1. Structured failure classification reaches chooseRecovery -----------

test("F006.1 a failed tool reaches recovery as TOOL_FAILURE, not UNKNOWN", async () => {
  const adapter = await newAdapter();
  await failTimes(adapter, 1);

  const payload = lastPayload(adapter, "RECOVERY_STARTED");
  assert.equal(payload?.failure, "TOOL_FAILURE", "the tool error category must survive into recovery");
  assert.notEqual(payload?.failure, "UNKNOWN", "UNKNOWN is the F-006 regression");
  assert.ok(payload?.reason, "RECOVERY_STARTED must carry a structured reason");
});

test("F006.1b a CoreError keeps its category and retryable flag through classifyFailure", () => {
  assert.equal(classifyFailure(new CoreError("TOOL_ERROR", "boom", { retryable: false })), "TOOL_FAILURE");
  assert.equal(classifyFailure(new CoreError("TOOL_ERROR", "flaky", { retryable: true })), "TRANSIENT");
  assert.equal(classifyFailure(new CoreError("POLICY_ERROR", "denied", { retryable: false })), "PERMISSION");
  assert.equal(classifyFailure(new CoreError("VALIDATION_ERROR", "bad", { retryable: false })), "VALIDATION_FAILURE");
  assert.equal(classifyFailure(new CoreError("MODEL_ERROR", "upstream", { retryable: false })), "MODEL_FAILURE");
  assert.equal(classifyFailure(new Error("plain")), "UNKNOWN", "a plain Error is still UNKNOWN by design");
});

test("F006.1c RECOVERY_STARTED reports the budgets as they stood at the decision", async () => {
  const adapter = await newAdapter();
  await failTimes(adapter, 2);
  const payload = lastPayload(adapter, "RECOVERY_STARTED");
  // D4B: these are the counters AT the second decision, which is taken before
  // the first decision's budget is spent... which is exactly the point: the
  // second failure is decided on retryCount=1, having been told that one retry
  // is already spent. The old values (0 and 1) said the opposite — that
  // failures spent the replan budget and never the retry one.
  assert.equal(payload?.retryCount, 1, "the second decision sees one retry already spent");
  assert.equal(payload?.replanCount, 0, "D4B: and no replan has been spent at all");
  assert.equal(payload?.recoveryDepth, 2, "the second recovery is the second round");
});

// --- 2. Deterministic / non-retryable failures do not select RETRY --------

test("F006.2 a tool failure is retried ONLY when the tool does not declare itself non-idempotent", () => {
  // OVERTURNED BY D4B, and deliberately. This pin used to say a deterministic
  // non-retryable failure never selects RETRY for ANY idempotency, on the
  // theory that a retry is a blind repeat. A RETRY is not a blind repeat: it
  // re-enters PLANNING, so whoever plans decides what happens next, and the
  // kernel only funds the turn and books it. That distinction is why an
  // ordinary failure may be retried.
  //
  // What is KEPT, and is the whole of F006.2's protective intent: a tool that
  // DECLARES itself non-idempotent is still never retried, whatever the budget
  // holds. Nothing in D4B is worth overriding a caller's own declaration.
  for (const depth of [0, 1, 2]) {
    for (let retryCount = 0; retryCount <= 3; retryCount++) {
      for (let replanCount = 0; replanCount <= 3; replanCount++) {
        const declared = chooseRecoveryDetailed({
          failure: "TOOL_FAILURE", limits: LIMITS, retryCount, replanCount, depth, idempotency: "NON_IDEMPOTENT",
        });
        assert.equal(declared.strategy, "ESCALATE",
          "a tool that declares itself non-idempotent is escalated, never blindly retried");
        const undeclared = chooseRecoveryDetailed({
          failure: "TOOL_FAILURE", limits: LIMITS, retryCount, replanCount, depth, idempotency: "IDEMPOTENT",
        });
        if (retryCount < LIMITS.maxToolRetries) {
          assert.equal(undeclared.strategy, "RETRY", "an undeclared failure is retried while the retry budget allows it");
        } else if (replanCount < LIMITS.maxReplans) {
          assert.equal(undeclared.strategy, "REPLAN", "and replanned once the retries are gone and replan budget remains");
        } else {
          assert.equal(undeclared.strategy, "TERMINATE", "and terminates only once BOTH budgets are spent, naming them");
        }
      }
    }
  }
});

test("F006.2b repeated edit failures spend the retry budget before any replan", async () => {
  // D4B. Was: "repeated edit failures never increment retryCount" — the direct
  // fingerprint of the defect, since it meant the retry budget was advertised
  // and never once used. Now the first two failures take it, and the third is
  // the first that needs a replan.
  const adapter = await newAdapter();
  await failTimes(adapter, 3);
  const task = adapter.currentTask!;
  assert.equal(task.retryCount, 2, "both retries were offered first");
  assert.equal(task.replanCount, 1, "and only then was a replan spent");
  assert.notEqual(task.status, "FAILED", "three ordinary failures no longer end the task");
});

// --- 3. Explicit, observable terminal reason ------------------------------

test("F006.3 the terminal reason names the exhausted budget and the failure", async () => {
  const adapter = await newAdapter();
  // D4B: four failures, not three — the ladder is one rung longer.
  await failTimes(adapter, 4);

  assert.equal(adapter.currentTask!.status, "FAILED");
  const reason = adapter.currentTask!.failureReason!;
  assert.match(reason, /RECOVERY_DEPTH_EXHAUSTED/, "the reason must identify what was exhausted");
  assert.match(reason, /failure=TOOL_FAILURE/, "the reason must identify the failure category");
  assert.match(reason, /retryCount=2\/2/, "and must show the retry budget WAS used, which is the D4B fix stated as evidence");
  assert.match(reason, /replanCount=1\/2/);
  // `4/3`, not `3/3`: the adapter increments the depth for the round it is
  // entering before the guard reads it, so the round that trips the guard is
  // itself counted. Pinned as measured, because a certificate that under-reports
  // the depth it consumed is the same class of lie as one that names the wrong
  // budget.
  assert.match(reason, /recoveryDepth=4\/3/);
  assert.doesNotMatch(reason, /no safe recovery strategy remains/, "the generic F-006 reason is gone");
});

test("F006.3b TASK_FAILED carries the structured reason, not one generic sentence", async () => {
  const adapter = await newAdapter();
  await failTimes(adapter, 4);
  const payload = lastPayload(adapter, "TASK_FAILED");
  assert.equal(payload?.reasonCode, "RECOVERY_DEPTH_EXHAUSTED");
  assert.equal(payload?.failure, "TOOL_FAILURE");
  assert.equal(payload?.strategy, "TERMINATE");
  assert.equal(payload?.replanCount, 1);
  assert.equal(payload?.retryCount, 2, "D4B: and the retry budget is reported as spent, not as untouched");
});

test("F006.3c depth exhaustion is distinguishable from replan exhaustion", () => {
  const depthTrip = chooseRecoveryDetailed({
    failure: "TOOL_FAILURE", limits: LIMITS, retryCount: 0, replanCount: 0, depth: 3, idempotency: "IDEMPOTENT",
  });
  assert.deepEqual(depthTrip, { strategy: "TERMINATE", reason: "RECOVERY_DEPTH_EXHAUSTED" });

  // D4B: `TOOL_FAILURE` can no longer reach `REPLAN_BUDGET_EXHAUSTED` — with the
  // retry rung in front of it, it reaches `RETRY_AND_REPLAN_BUDGET_EXHAUSTED`,
  // which is the same outcome with both budgets named. The generic tail still
  // ends the run for every class that has no retry rung, and that is what this
  // pin now distinguishes the depth trip from.
  const replanTrip = chooseRecoveryDetailed({
    failure: "UNKNOWN", limits: LIMITS, retryCount: 0, replanCount: 2, depth: 0, idempotency: "IDEMPOTENT",
  });
  assert.deepEqual(replanTrip, { strategy: "TERMINATE", reason: "REPLAN_BUDGET_EXHAUSTED" });

  const bothTrip = chooseRecoveryDetailed({
    failure: "TOOL_FAILURE", limits: LIMITS, retryCount: 2, replanCount: 2, depth: 0, idempotency: "IDEMPOTENT",
  });
  assert.deepEqual(bothTrip, { strategy: "TERMINATE", reason: "RETRY_AND_REPLAN_BUDGET_EXHAUSTED" });
  assert.notEqual(bothTrip.reason, depthTrip.reason, "a budget death and a depth death are never reported as one thing");
});

test("F006.3d describeTerminalRecovery reports every budget it consulted", () => {
  const decision = chooseRecoveryDetailed({
    failure: "TOOL_FAILURE", limits: LIMITS, retryCount: 0, replanCount: 2, depth: 3, idempotency: "IDEMPOTENT",
  });
  const text = describeTerminalRecovery(decision, {
    failure: "TOOL_FAILURE", limits: LIMITS, retryCount: 0, replanCount: 2, depth: 3,
  });
  assert.match(text, /RECOVERY_DEPTH_EXHAUSTED/);
  assert.match(text, /replanCount=2\/2/);
  assert.match(text, /retryCount=0\/2/);
  assert.match(text, /recoveryDepth=3\/3/);
});

// --- 4. maxStepRetries is no longer a dead limit --------------------------

test("F006.4 maxStepRetries has been removed from the public limits surface", () => {
  assert.equal("maxStepRetries" in DEFAULT_LIMITS, false, "DEFAULT_LIMITS must not advertise an unenforced bound");
  assert.equal(Object.keys(DEFAULT_LIMITS).includes("maxStepRetries"), false);
});

/**
 * F-006 was about `maxStepRetries`. The same sweep found that
 * `maxExecutionTimeMs` was declared on RecoveryLimits and read by no recovery
 * decision, and that `maxTaskDurationMs` / `maxStepDurationMs` /
 * `maxToolDurationMs` / `maxParallelTasks` / `maxParallelTools` /
 * `maxOutputBytes` on CoreLimits were likewise declared but unenforced.
 *
 * D-009 closed that gap: `maxExecutionTimeMs` is now enforced from elapsed
 * time, and the six unenforced fields were removed rather than left on paper.
 * `DECLARED_BUT_UNENFORCED` is therefore empty — every limit this module
 * declares is read by recovery logic. If a limit is ever added without being
 * enforced, it must be added to that set, not left silently dead.
 */
const DECLARED_BUT_UNENFORCED = new Set<string>();

test("F006.4b every other limit declared on RecoveryLimits is read by recovery logic", () => {
  // Guards the class of defect F-006 found: a limit that exists only on paper.
  const source = readFileSync(new URL("../core/recovery.ts", import.meta.url), "utf8");
  // Prose may name the limit while explaining its removal; only code counts.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const declared = ["maxToolRetries", "maxReplans", "maxRecoveryDepth", "maxExecutionTimeMs"] as const;
  for (const limit of declared) {
    const occurrences = source.split(limit).length - 1;
    if (DECLARED_BUT_UNENFORCED.has(limit)) {
      assert.equal(occurrences, 1, `${limit} is now enforced or removed; update DECLARED_BUT_UNENFORCED`);
      continue;
    }
    assert.ok(occurrences > 1, `${limit} is declared but never read by recovery logic`);
  }
  assert.equal(code.includes("maxStepRetries"), false, "the dead limit must not linger in the recovery contract");
});

// --- 5. Bounded recovery and fail-closed rules remain intact -------------

test("F006.5 transient idempotent failures are still retried, within bounds", () => {
  assert.equal(chooseRecovery({ failure: "TRANSIENT", limits: LIMITS, retryCount: 0, replanCount: 0, depth: 0, idempotency: "IDEMPOTENT" }), "RETRY");
  assert.equal(chooseRecovery({ failure: "TIMEOUT", limits: LIMITS, retryCount: 1, replanCount: 0, depth: 0, idempotency: "IDEMPOTENT" }), "RETRY");
  // Retry budget spent: falls through to REPLAN, then TERMINATE. Unchanged from before F-006.
  assert.equal(chooseRecovery({ failure: "TRANSIENT", limits: LIMITS, retryCount: 2, replanCount: 0, depth: 0, idempotency: "IDEMPOTENT" }), "REPLAN");
  assert.equal(chooseRecovery({ failure: "TRANSIENT", limits: LIMITS, retryCount: 2, replanCount: 2, depth: 0, idempotency: "IDEMPOTENT" }), "TERMINATE");
});

test("F006.5b non-idempotent transient failures still escalate", () => {
  assert.equal(chooseRecovery({ failure: "TRANSIENT", limits: LIMITS, retryCount: 0, replanCount: 0, depth: 0, idempotency: "NON_IDEMPOTENT" }), "ESCALATE");
});

test("F006.5c PERMISSION and INVALID_INPUT still fail closed without retrying", () => {
  for (const failure of ["PERMISSION", "INVALID_INPUT"] as const) {
    for (const idempotency of ["IDEMPOTENT", "NON_IDEMPOTENT"] as const) {
      assert.equal(chooseRecovery({ failure, limits: LIMITS, retryCount: 0, replanCount: 0, depth: 0, idempotency }), "ESCALATE");
    }
  }
});

test("F006.5d terminal states still refuse new executions after a TERMINATE", async () => {
  const adapter = await newAdapter();
  await failTimes(adapter, 4);
  assert.equal(adapter.currentTask!.status, "FAILED");
  const bound = await adapter.beginToolExecution("call-after", "read");
  assert.equal(bound, undefined, "a FAILED task must admit no further execution");
});

test("F006.5e a VALID validation still resets the recovery depth", async () => {
  const adapter = await newAdapter();
  await failTimes(adapter, 2);
  const bound = await adapter.beginToolExecution("call-ok", "read");
  assert.ok(bound, "a healthy task must still admit a new execution after two failures");
  await adapter.recordToolResult("call-ok", "read", { ok: true }, false);
  const finished = await adapter.finishTask({});
  assert.equal(finished.status, "COMPLETED", "recovery must remain recoverable");
});
