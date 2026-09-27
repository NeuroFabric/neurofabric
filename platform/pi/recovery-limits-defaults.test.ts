import test from "node:test";
import assert from "node:assert/strict";

import { KernelAdapter } from "./kernel-adapter.ts";
import { DEFAULT_LIMITS } from "../core/index.ts";
import type { RecoveryLimits } from "../core/index.ts";

/**
 * F-006: the recovery budgets the adapter enforces were written out a second
 * time in its constructor.
 *
 * `DEFAULT_LIMITS` is the exported source of truth, and the copy was free to
 * drift from it without anything failing: a change to the defaults would have
 * left recovery enforcing the old numbers while the platform advertised the new
 * ones. These tests pin the adapter to the exported values, and pin the values
 * themselves, so the two can only move together.
 */

test("the adapter derives its recovery budgets from DEFAULT_LIMITS", () => {
  const adapter = new KernelAdapter();
  const limits: RecoveryLimits = adapter.recoveryLimits;

  assert.equal(limits.maxToolRetries, DEFAULT_LIMITS.maxToolRetries);
  assert.equal(limits.maxReplans, DEFAULT_LIMITS.maxReplans);
  assert.equal(limits.maxRecoveryDepth, DEFAULT_LIMITS.maxRecoveryDepth);
  assert.equal(limits.maxExecutionTimeMs, DEFAULT_LIMITS.maxExecutionTimeMs);
});

test("the derived budgets are the enforced ones, unchanged", () => {
  // The behaviour that exists today must survive the de-duplication: 2 tool
  // retries, 2 replans, 3 recovery rounds.
  assert.equal(new KernelAdapter().recoveryLimits.maxToolRetries, 2);
  assert.equal(new KernelAdapter().recoveryLimits.maxReplans, 2);
  assert.equal(new KernelAdapter().recoveryLimits.maxRecoveryDepth, 3);
  // `maxStepRetries` was removed from the recovery surface (F-006) and must not
  // reappear here as a bound nothing reads.
  assert.equal("maxStepRetries" in DEFAULT_LIMITS, false, "the removed limit must not come back");
});

test("an explicitly configured budget is used as given", () => {
  const explicit: RecoveryLimits = {
    maxToolRetries: 5,
    maxReplans: 1,
    maxRecoveryDepth: 9,
    maxExecutionTimeMs: 1000,
  };
  const adapter = new KernelAdapter({ limits: explicit });
  assert.deepEqual(adapter.recoveryLimits, explicit);
  assert.deepEqual(adapter.recoveryLimits, explicit, "the accessor returns a copy, not the stored object");
  assert.notEqual(adapter.recoveryLimits, explicit);
});
