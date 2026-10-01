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
 *
 * D4B, 2026-10-01. "Exactly as before" is no longer true for the unmarked case
 * and the two pins that asserted it are the ones this note covers. The CLASS
 * they assert is unchanged — an unmarked error is still `TOOL_FAILURE`, never
 * `TRANSIENT` — and that is the flag's whole job here. What D4B changed is what
 * recovery does with that class: an ordinary failure now takes a RETRY before it
 * replans. So the flag no longer separates RETRY from REPLAN; it separates
 * `TRANSIENT` (a caller who knows a repeat could work) from `TOOL_FAILURE` (one
 * who does not, or says nothing). Both are retried now. The flag is still worth
 * having and is still honoured — it is simply no longer load-bearing for the
 * ordinary-failure case, which is why the bridge can leave it `undefined`
 * without the kernel depending on a value Pi does not supply.
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

test("an unmarked tool error stays TOOL_FAILURE, and is now retried rather than replanned", async () => {
  const adapter = await newAdapter();
  await failOnce(adapter); // no flag at all — what every existing caller does

  const payload = lastPayload(adapter, "RECOVERY_STARTED");
  assert.equal(payload?.failure, "TOOL_FAILURE", "no flag means the same class it always did; it does NOT become TRANSIENT");
  assert.equal(payload?.strategy, "RETRY", "D4B: an ordinary failure is retried before it is replanned");
  assert.equal(payload?.reason, "TOOL_FAILURE_RETRY", "and the reason says which rung it took");
  assert.equal(adapter.currentTask?.retryCount, 1, "the retry budget is what it spends");
  assert.equal(adapter.currentTask?.replanCount, 0, "and no replan budget at all");
});

test("an explicit false and a non-boolean value are both treated as unmarked", async () => {
  for (const [label, value] of [["false", false], ["undefined", undefined], ["a string", "yes" as unknown as boolean]] as const) {
    const adapter = await newAdapter();
    await failOnce(adapter, value);

    const payload = lastPayload(adapter, "RECOVERY_STARTED");
    assert.equal(payload?.failure, "TOOL_FAILURE", `${label} must not be read as retryable`);
    assert.equal(payload?.reason, "TOOL_FAILURE_RETRY",
      `${label} takes the ordinary-failure rung, NOT the transient one — reading it as retryable would be laundering it into TRANSIENT`);
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

test("the flag separates the CLASSES; D4B moved the strategy for the unmarked one", () => {
  // Stated directly, because it is the whole mechanism. For a TOOL_ERROR,
  // `retryable` is the single input that decides TRANSIENT from TOOL_FAILURE.
  // classifyFailure is `instanceof CoreError`-typed, not structurally matched,
  // so a plain `{ category, retryable }` object is UNKNOWN — which is why
  // recordToolResult must build a real CoreError and not just set a field on
  // one.
  //
  // D4B amended the second half of this claim. Before, the flag also decided
  // RETRY from REPLAN, and this pin asserted that. Now both classes are
  // retried, so the flag decides the CLASS and the class no longer decides a
  // terminal-versus-recoverable difference. The first two assertions — the ones
  // about classification — are unchanged and are the ones that matter.
  assert.equal(classifyFailure(new CoreError("TOOL_ERROR", "flaky", { retryable: true })), "TRANSIENT");
  assert.equal(classifyFailure(new CoreError("TOOL_ERROR", "deterministic", { retryable: false })), "TOOL_FAILURE");
  assert.equal(classifyFailure({ category: "TOOL_ERROR", retryable: true } as unknown), "UNKNOWN");
});
