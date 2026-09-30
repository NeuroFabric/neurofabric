import test from "node:test";
import assert from "node:assert/strict";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { classifyFailure } from "../core/index.ts";
import { CoreError } from "../core/errors.ts";

/**
 * F-006 Phase 2a: real retryability propagation.
 *
 * `recordToolResult` used to build `CoreError("TOOL_ERROR", ..., { retryable:
 * false })` for EVERY tool error, whatever the caller knew. `classifyFailure`
 * honours that flag, so every real tool error was TOOL_FAILURE, TRANSIENT was
 * unreachable from a real error, and the RETRY branch could only ever be
 * exercised by a test that built the CoreError itself. The operator-verified
 * fingerprint of 82 deaths shows the consequence: `retryCount=0/2` beside
 * `replanCount=2/2` — the retry budget was never touched once.
 *
 * The kernel now propagates the caller's answer instead of asserting one. The
 * value is OPTIONAL, so an unmarked error must behave EXACTLY as before.
 */

async function newAdapter() {
  const adapter = new KernelAdapter();
  adapter.registerTools([toolDescriptorFromPi({ name: "edit", description: "edit a file" })]);
  await adapter.beginTask("retryability propagation", "retryability propagation");
  return adapter;
}

async function failOnce(adapter: KernelAdapter, errorRetryable?: boolean) {
  const bound = await adapter.beginToolExecution("call-1", "edit");
  assert.ok(bound, "the execution must be admitted");
  await adapter.recordToolResult("call-1", "edit", undefined, true, errorRetryable);
}

const lastPayload = (adapter: KernelAdapter, type: string) =>
  adapter.recentEvents(500).filter((e) => e.type === type).at(-1)?.payload as Record<string, unknown> | undefined;

test("a tool error marked retryable is classified TRANSIENT and exercises RETRY", async () => {
  const adapter = await newAdapter();
  await failOnce(adapter, true);

  const payload = lastPayload(adapter, "RECOVERY_STARTED");
  assert.equal(payload?.failure, "TRANSIENT", "a caller-supplied retryable flag must reach classifyFailure");
  assert.equal(payload?.strategy, "RETRY", "TRANSIENT + retry budget available must select RETRY");
  assert.equal(payload?.reason, "TRANSIENT_RETRY");
  assert.equal(adapter.currentTask?.retryCount, 1, "a RETRY must consume retry budget, which was the fingerprint's whole point");
  assert.equal(adapter.currentTask?.replanCount, 0, "a RETRY must not consume the replan budget");
  assert.equal(adapter.currentTask?.status, "PLANNING", "RETRY re-enters planning");
});

test("an unmarked tool error keeps the pre-Phase-2a behaviour exactly", async () => {
  const adapter = await newAdapter();
  await failOnce(adapter); // no flag at all — what every existing caller does

  const payload = lastPayload(adapter, "RECOVERY_STARTED");
  assert.equal(payload?.failure, "TOOL_FAILURE", "no flag means non-retryable, exactly as the hard-coded false did");
  assert.equal(payload?.strategy, "REPLAN", "TOOL_FAILURE takes the generic REPLAN tail, as it always did");
  assert.equal(payload?.reason, "GENERIC_REPLAN");
  assert.equal(adapter.currentTask?.retryCount, 0, "an unmarked error must not touch the retry budget");
  assert.equal(adapter.currentTask?.replanCount, 1);
});

test("an explicit false and a non-boolean value are both treated as unmarked", async () => {
  for (const [label, value] of [["false", false], ["undefined", undefined], ["a string", "yes" as unknown as boolean]] as const) {
    const adapter = await newAdapter();
    await failOnce(adapter, value);

    const payload = lastPayload(adapter, "RECOVERY_STARTED");
    assert.equal(payload?.failure, "TOOL_FAILURE", `${label} must not be read as retryable`);
    assert.equal(payload?.strategy, "REPLAN", `${label} must not reach the RETRY branch`);
  }
});

test("a successful result is never marked retryable, whatever the flag says", async () => {
  const adapter = await newAdapter();
  const bound = await adapter.beginToolExecution("call-ok", "edit");
  assert.ok(bound);
  await adapter.recordToolResult("call-ok", "edit", { ok: true }, false, true);

  const payload = lastPayload(adapter, "RECOVERY_STARTED");
  assert.equal(payload, undefined, "a success must not open a recovery at all");
  assert.equal(adapter.currentTask?.retryCount, 0);
});

test("only the flag separates RETRY from REPLAN for a TOOL_ERROR", () => {
  // Stated directly, because it is the whole mechanism: for a TOOL_ERROR,
  // `retryable` is the single input that decides TRANSIENT/RETRY vs
  // TOOL_FAILURE/REPLAN. classifyFailure is `instanceof CoreError`-typed, not
  // structurally matched, so a plain `{ category, retryable }` object is
  // UNKNOWN — which is why recordToolResult must build a real CoreError and
  // not just set a field on one.
  assert.equal(classifyFailure(new CoreError("TOOL_ERROR", "flaky", { retryable: true })), "TRANSIENT");
  assert.equal(classifyFailure(new CoreError("TOOL_ERROR", "deterministic", { retryable: false })), "TOOL_FAILURE");
  assert.equal(classifyFailure({ category: "TOOL_ERROR", retryable: true } as unknown), "UNKNOWN");
});
