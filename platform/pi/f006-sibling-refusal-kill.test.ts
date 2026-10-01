import test from "node:test";
import assert from "node:assert/strict";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";

/**
 * F006 §5 ITEM 8 — a refusal that settles as a SIBLING kills the task.
 *
 * The D1 reversal (ledger §0.1) makes a denial a RESULT, not a death: every
 * violation label, at every budget, answers CONTINUE / POLICY_SOFT_REFUSED.
 * That holds for a LONE denial, and it is pinned green below by S8.2.
 *
 * It does not hold when the denial is one of several tool calls Pi issued in
 * one assistant message. Siblings bound together (`joiningSibling`, see
 * kernel-adapter.ts:1098), and `observeToolResult` handles a settling sibling
 * at :1300 by appending its ValidationResult, setting `attemptBlocked = true`,
 * and RETURNING — before the recovery block at :1317 that would have
 * classified the refusal. So:
 *
 *   - the recovery decision never runs, so `SOFT_REFUSAL_CONTINUED` is never
 *     emitted and `denialReason` (:1324) is never read;
 *   - the refusal survives only as an `INVALID` validation, which is
 *     byte-identical to a genuine tool fault (item 9 / P1's collapse at :1270);
 *   - `attemptBlocked` is set as though a real failure occurred.
 *
 * Then the LAST sibling succeeds. `lastValidation.status` is VALID, so
 * `finishTask` reaches its `attemptBlocked` branch at :1807 and kills the task
 * with the only account it has:
 *
 *   "One or more results in this attempt failed or could not be verified"
 *
 * No rule. No policy. No path. And nothing failed verification — the sibling
 * verified, and the refusal was an ANSWER, correctly delivered.
 *
 * That sentence is not thin, it is FALSE, and it is the only account the
 * operator gets. This file pins the fix, and pins it narrowly: the fix must not
 * neuter `attemptBlocked` for real faults (S8.3), and must not disturb the
 * lone denial the reversal already got right (S8.2).
 *
 * Direction taken: ledger §5 item 8 candidate (b) — the sibling early return
 * also runs the recovery decision, so a refusal is CLASSIFIED before the
 * attempt is judged, wherever it lands. Candidate (a) (bookkeeping instead of
 * `attemptBlocked`) was the narrower option and was not chosen: it would leave
 * the refusal unclassified, which is the defect P1 would then be fixing one
 * layer out.
 */

const DENIAL = "policy f006-test-policy.json: destructive command 'rm' is denied; shell must not bypass deletion control";

/**
 * Two tool calls bound as siblings, exactly as Pi issues them in parallel mode:
 * preflight, then `beginToolExecution` for each, with neither settling before
 * the other is bound. `beginToolExecution` is required — `precheckToolCall`
 * alone binds nothing, and an unbound result is discarded as out-of-order, so
 * skipping it would test a path that cannot execute (see the measured order in
 * f006-policy-denied.test.ts).
 */
async function withSiblings(): Promise<{ adapter: KernelAdapter; a: string; b: string }> {
  const adapter = new KernelAdapter();
  adapter.registerTools([toolDescriptorFromPi({ name: "read", description: "read" })]);
  await adapter.beginTask("probe", "probe");
  const a = "sibling-a";
  const b = "sibling-b";
  for (const id of [a, b]) {
    const { decision } = await adapter.precheckToolCall("read", "execute", { path: "x" }, undefined, id);
    assert.equal(decision.decision, "ALLOW", "precondition: the call is admitted; the refusal arrives afterwards");
    const bound = await adapter.beginToolExecution(id, "read");
    assert.ok(bound, "precondition: an execution is bound, so the result is not discarded as out-of-order");
  }
  assert.equal(adapter.currentTask?.status, "EXECUTING",
    "precondition: both siblings are bound and the task has not settled");
  return { adapter, a, b };
}

/** `finishTask` rejects a non-object result; it wants the assistant payload. */
const RESULT = { output: "done" };

const eventTypes = (adapter: KernelAdapter) => adapter.recentEvents(500).map((e) => e.type);
const lastPayload = (adapter: KernelAdapter, type: string) =>
  adapter.recentEvents(500).filter((e) => e.type === type).at(-1)?.payload as Record<string, unknown> | undefined;

/**
 * S8.1 RED. The refusal settles FIRST, the successful sibling settles LAST, so
 * `lastValidation` is VALID and the attempt is judged purely on
 * `attemptBlocked`. Before the fix this task dies.
 */
test("S8.1 a refusal that settles as a sibling does not kill the task", async () => {
  const { adapter, a, b } = await withSiblings();

  // The refusal settles while the sibling is still in flight: the early return
  // at :1300 is taken here, so nothing classifies it.
  await adapter.recordToolResult(a, "read", undefined, true, undefined, DENIAL);
  assert.equal(adapter.currentTask?.status, "EXECUTING",
    "precondition: the sibling is still in flight, so the task has not settled");

  // The sibling then succeeds. Nothing failed verification.
  await adapter.recordToolResult(b, "read", { ok: true }, false);

  const finished = await adapter.finishTask(RESULT);

  assert.notEqual(finished.status, "FAILED",
    "a refusal is an answer, not a death, and it must not kill a task through a sibling");
  assert.equal(finished.failureReason, undefined,
    "and no failure may be recorded, because nothing failed");
});

/**
 * S8.1b The attribution. Killing the task was the first defect; returning to
 * the operator a reason that names no rule was the second, and it is the one
 * the operator reads. The policy's own words must reach the surface wherever
 * the refusal lands — sibling or lone.
 */
test("S8.1b the policy's reason survives the sibling path", async () => {
  const { adapter, a, b } = await withSiblings();
  await adapter.recordToolResult(a, "read", undefined, true, undefined, DENIAL);
  await adapter.recordToolResult(b, "read", { ok: true }, false);
  await adapter.finishTask(RESULT);

  const types = eventTypes(adapter);
  assert.ok(types.includes("SOFT_REFUSAL_CONTINUED"),
    "the sibling early return must not skip classification; the refusal is only observable once classified");

  assert.match(String(lastPayload(adapter, "SOFT_REFUSAL_CONTINUED")?.denialReason ?? ""), /destructive command 'rm' is denied/,
    "and the refusal must carry the policy's own words, verbatim, as the lone path already does");
});

/**
 * S8.2 GREEN TODAY — the guard against over-correcting. The lone denial is
 * already correct under the reversal. If this file's fix breaks it, the
 * reversal has been undone by a sibling-path patch.
 */
test("S8.2 a lone denial still survives and still reports its reason", async () => {
  const adapter = new KernelAdapter();
  adapter.registerTools([toolDescriptorFromPi({ name: "read", description: "read" })]);
  await adapter.beginTask("probe", "probe");
  const { decision } = await adapter.precheckToolCall("read", "execute", { path: "x" }, undefined, "lone");
  assert.equal(decision.decision, "ALLOW", "precondition: admitted; the refusal arrives afterwards");
  assert.ok(await adapter.beginToolExecution("lone", "read"), "precondition: bound");

  await adapter.recordToolResult("lone", "read", undefined, true, undefined, DENIAL);

  assert.notEqual(adapter.currentTask?.status, "FAILED", "a lone denial is survivable — measured, asserted");
  assert.match(String(lastPayload(adapter, "SOFT_REFUSAL_CONTINUED")?.denialReason ?? ""), /destructive command 'rm' is denied/,
    "and names the rule that refused it");
});

/**
 * S8.3 GREEN TODAY — the other guard, and the one this fix is most likely to
 * break. `attemptBlocked` exists for a reason: a real tool fault in ANY sibling
 * must still stop the attempt from completing. If a sibling GENUINE fault stops
 * blocking, the fix has thrown out the mechanism with the defect.
 */
test("S8.3 a genuine fault in a sibling still blocks the attempt", async () => {
  const { adapter, a, b } = await withSiblings();

  // No denialReason: its presence IS the refusal signal (recordToolResult:1551),
  // so supplying one would make this a refusal and test nothing.
  await adapter.recordToolResult(a, "read", undefined, true);
  await adapter.recordToolResult(b, "read", { ok: true }, false);

  const finished = await adapter.finishTask(RESULT);

  assert.equal(finished.status, "FAILED",
    "a real tool fault in a sibling must still fail the task — attemptBlocked is not the bug");
  assert.match(finished.failureReason ?? "", /One or more results in this attempt failed or could not be verified/,
    "and the reason it gives is the true one: an unresolved failure in the attempt, not a refusal");
  assert.doesNotMatch(finished.failureReason ?? "", /destructive command/,
    "a genuine fault must never be reported as a policy refusal");
});
