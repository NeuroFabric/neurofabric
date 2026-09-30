/**
 * D-009: `maxExecutionTimeMs` is enforced, not merely declared.
 *
 * It was declared on `RecoveryLimits` and on `CoreLimits` and read by no
 * recovery decision, so a task could run indefinitely. The adapter now measures
 * elapsed time from a monotonic clock and passes it into recovery, which
 * terminates with a specific reason. These tests pin the decision and the
 * reason string; the clock itself is covered by the adapter's own behaviour.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  chooseRecovery,
  chooseRecoveryDetailed,
  describeTerminalRecovery,
  type RecoveryLimits,
} from "../core/index.ts";
import type { Idempotency } from "../core/types.ts";

const LIMITS: RecoveryLimits = {
  maxToolRetries: 2,
  maxReplans: 2,
  maxStrategyChanges: 2,
  maxRecoveryDepth: 3,
  maxExecutionTimeMs: 1_000,
};

const base = { limits: LIMITS, retryCount: 0, replanCount: 0, depth: 0, idempotency: "IDEMPOTENT" as Idempotency };

// --- 1. the budget terminates the task --------------------------------------

test("D009.6 elapsed time over the budget terminates, whatever the failure", () => {
  for (const failure of ["TRANSIENT", "PERMISSION", "INVALID_INPUT", "VALIDATION_FAILURE", "UNKNOWN"] as const) {
    const decision = chooseRecoveryDetailed({ ...base, failure, elapsedMs: LIMITS.maxExecutionTimeMs + 1 });
    assert.equal(decision.strategy, "TERMINATE", `${failure} must not outlive the time budget`);
    assert.equal(decision.reason, "EXECUTION_TIME_EXHAUSTED");
  }
});

test("D009.6b elapsed time within budget does not terminate on that account", () => {
  const decision = chooseRecoveryDetailed({ ...base, failure: "TRANSIENT", elapsedMs: LIMITS.maxExecutionTimeMs });
  assert.notEqual(decision.reason, "EXECUTION_TIME_EXHAUSTED");
  assert.equal(decision.strategy, "RETRY", "the budget boundary itself is still inside the budget");
});

test("D009.6c the budget outranks depth, retries and replans alike", () => {
  // Budgets that would otherwise permit more work must not be able to buy time.
  const withFreshBudgets = chooseRecoveryDetailed({ ...base, retryCount: 0, replanCount: 0, depth: 0, elapsedMs: 5_000 });
  assert.equal(withFreshBudgets.reason, "EXECUTION_TIME_EXHAUSTED");
});

// --- 2. the decision is opt-in for isolated callers -------------------------

test("D009.6d omitting elapsed time leaves the pre-existing decision unchanged", () => {
  // Recovery logic is exercised in isolation by several suites; an absent clock
  // must mean "no time accounted", never "assume the worst".
  assert.equal(chooseRecovery({ ...base, failure: "TRANSIENT" }), "RETRY");
  assert.equal(chooseRecovery({ ...base, failure: "PERMISSION" }), "ESCALATE");
  assert.equal(chooseRecovery({ ...base, failure: "TRANSIENT", depth: 9 }), "TERMINATE");
});

// --- 3. the terminal reason names the budget, as F-006 requires -------------

test("D009.6e the terminal reason reports the elapsed time against the budget", () => {
  const options = { ...base, failure: "TRANSIENT" as const, elapsedMs: 7_500, depth: 1 };
  const decision = chooseRecoveryDetailed(options);
  const text = describeTerminalRecovery(decision, options);
  assert.match(text, /EXECUTION_TIME_EXHAUSTED/);
  assert.match(text, /elapsedMs=7500\/1000/);
});

test("D009.6f without elapsed time the reason omits the field rather than inventing a value", () => {
  const options = { ...base, failure: "TRANSIENT" as const, depth: 1 };
  const text = describeTerminalRecovery(chooseRecoveryDetailed(options), options);
  assert.equal(text.includes("elapsedMs"), false);
});

// --- 4. the other three budgets still decide as before ----------------------

test("D009.6g the depth budget still terminates with its own reason", () => {
  const decision = chooseRecoveryDetailed({ ...base, failure: "TRANSIENT", depth: LIMITS.maxRecoveryDepth });
  assert.deepEqual(decision, { strategy: "TERMINATE", reason: "RECOVERY_DEPTH_EXHAUSTED" });
});
