import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { buildPolicy } from "./project-config.ts";

/**
 * F-006 denial certificate: the shape, and the precondition that delivers it.
 *
 * Two sequences, two pins, one reason field. They are kept apart because they
 * are genuinely different paths and a change to either must not be able to
 * quietly satisfy the other:
 *
 *   PROD.* — the PRODUCTION sequence. The one the live bridge runs and the one
 *            the 94 deaths came from: the call is refused at `tool_call`, the
 *            reason is stashed by toolCallId, and the refusal is re-delivered on
 *            the result at `tool_execution_end`.
 *   CERT.* — the MID-EXECUTION sequence. The call is admitted, binds an
 *            execution, and fails carrying a policy reason. This is the
 *            forwarding regression guard; `f006-policy-denied.test.ts` already
 *            pins it behaviourally, and this file pins the certificate's
 *            literal TEXT, which nothing else does.
 *
 * WHY THE SHORTHAND IS WORTHLESS AS AN ASSERTION
 *
 * The spec shorthand is `POLICY_DENIED`. The real label is
 * `POLICY_DENIED_TERMINATED`, of which the shorthand is a strict PREFIX. So
 * `assert.match(reason, /POLICY_DENIED/)` — what D1.6 asserts — passes whether
 * the reason was forwarded, whether the terminal reason is the refusal or
 * something else, and whether a certificate exists at all. Every label
 * assertion below is therefore an equality against the long form.
 *
 * THE PRECONDITION, and why it is not obvious
 *
 * `recordToolResult` rebuilds a refused result as its own error category and
 * hands it to `observeToolResult`, which consumes it in two places: the
 * validation message (`error.message`, :1161) and `classifyFailure(error)`
 * (:1212), whose POLICY_DENIED row drives TERMINATE and whose message becomes
 * the certificate's `denied=` field.
 *
 * Getting there requires THREE things to hold at once, and only the third was
 * obvious:
 *
 *   1. `resolveBoundExecution` (:1492) must resolve — either a real binding, or
 *      the fallback when `activeExecutions.size === 0` AND status is EXECUTING
 *      AND `currentStep` is set.
 *   2. `status === "EXECUTING"` (:1109).
 *   3. The settling execution must be the LAST one. `observeToolResult` deletes
 *      the binding at :1130 and then returns early at :1192 while any sibling
 *      is still in flight — recovery does not run on that path. This is why a
 *      refused call paired with a still-bound call never reaches recovery, and
 *      it is easy to mistake that for "unbound results are discarded".
 *
 * A refused call does NOT bind, and that is deliberate. `beginToolExecution`
 * refuses any id in `deniedToolCallIds` (kernel-adapter.ts:964), with the
 * comment "Pi emits execution_start around a blocked preflight. Never fabricate
 * an execution plan for a call policy refused." So condition 1 above can only be
 * met by the FALLBACK, which no reachable task state satisfies.
 *
 * THE MEASURED CONSEQUENCE, pinned as BRIDGE below: a preflight refusal never
 * reaches recovery, the stashed reason is never consumed, and the task is not
 * marked. The reason stashed at the deny site and the reason read at the record
 * site cannot meet for the same call.
 *
 * That is a finding, not a pin against production behaviour: the bridge as landed
 * is INERT on the preflight path it was built for. See the report. The CERT pins
 * therefore cover the mid-execution sequence, which is real and reachable, and
 * BRIDGE pins the inertness so that it is enforced and visible rather than
 * assumed absent.
 */

/** Escape a literal for embedding in a RegExp, so a reason cannot weaken its own pin. */
const lit = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TOOLS = ["read", "bash", "write"].map((name) => toolDescriptorFromPi({ name, description: name }));

async function trustedAdapter(): Promise<KernelAdapter> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-denial-cert-"));
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy({ policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] }, dir));
  adapter.registerTools(TOOLS);
  await adapter.beginTask("read the credentials file", "read the credentials file");
  return adapter;
}

/** The real policy's own words for a `.env` read — asserted, never assumed. */
const REAL_REASON = "Neurofebric policy: operation targets credential file '.env'";

const lastPayload = (k: KernelAdapter, type: string) =>
  k.recentEvents(500).filter((e) => e.type === type).at(-1)?.payload as Record<string, unknown> | undefined;

/**
 * The extension's three handlers, transcribed call for call from
 * `.pi/extensions/platform-orchestrator.ts`, so this driver cannot drift from
 * production into a shape that behaves differently:
 *
 *   tool_call           precheckToolCall(name, "execute", input, approval, id)
 *                       declareToolOutputs(id, name, input)
 *                       DENY -> stash reason, return { block: true }
 *   tool_execution_start beginToolExecution(id, name, { toolCallId: id })
 *   tool_execution_end  reason = stash.get(id); stash.delete(id)
 *                       recordToolResult(id, name, result, isError, undefined, reason)
 *
 * The metadata object and the `declareToolOutputs` call are both included
 * because omitting them is exactly the kind of drift that produces a green test
 * for a shape production never runs.
 */
async function runProductionHandlers(
  adapter: KernelAdapter,
  callId: string,
  input: unknown,
  stashedReason: string | undefined,
): Promise<void> {
  // tool_call
  const { decision } = await adapter.precheckToolCall("read", "execute", input, undefined, callId);
  await adapter.declareToolOutputs(callId, "read", input);
  let stash: string | undefined;
  if (decision.decision !== "ALLOW") {
    stash = decision.reason;
    // `decision.reason` is present on both DENY and REQUIRE_APPROVAL.
  }
  // The bridge forwards what the deny site stashed, not what this helper knows.
  if (stash === undefined) stash = stashedReason;

  // tool_execution_start
  await adapter.beginToolExecution(callId, "read", { toolCallId: callId });

  // tool_execution_end
  await adapter.recordToolResult(callId, "read", undefined, true, undefined, stash);
}

// ===========================================================================
// PROD — the production preflight-refusal sequence
// ===========================================================================

test("BRIDGE.1 a preflight-refused call does NOT bind an execution", async () => {
  const adapter = await trustedAdapter();
  const { decision } = await adapter.precheckToolCall("read", "execute", { path: ".env" }, undefined, "refused-1");
  assert.equal(decision.decision, "DENY", "the real policy must actually deny this call");
  assert.equal(decision.reason, REAL_REASON, "and refuse it in its own words");
  assert.equal(adapter.diagnostics.denialCount, 1, "the refusal is counted as one");
  assert.equal(adapter.diagnostics.deniedToolCallIdCount, 1, "and the id is recorded as refused");

  const bound = await adapter.beginToolExecution("refused-1", "read", { toolCallId: "refused-1" });
  assert.equal(bound, undefined, "a refused id never binds: Pi emits execution_start around a blocked preflight");
  const ignored = adapter.recentEvents(50).filter((e) => e.type === "TOOL_EXECUTION_IGNORED").at(-1)?.payload as Record<string, unknown> | undefined;
  assert.equal(ignored?.reason, "policy_denied", "and the refusal is recorded as such");
  assert.equal(adapter.currentTask!.status, "PLANNING", "the task never enters EXECUTING for a refused call");
});

test("BRIDGE.2 the stashed reason is never consumed on the preflight path", async () => {
  // The bridge's whole mechanism, end to end: a reason is stashed at the deny
  // site and read back at the record site. Because the refused id never binds,
  // the result is discarded before the reason can be read, and the task is not
  // marked. This is the finding, pinned so it cannot be quietly assumed fixed.
  const adapter = await trustedAdapter();
  const stash = new Map<string, string>();
  const { decision } = await adapter.precheckToolCall("read", "execute", { path: ".env" }, undefined, "refused-2");
  stash.set("refused-2", decision.reason);                      // deny site
  await adapter.declareToolOutputs("refused-2", "read", { path: ".env" });
  await adapter.beginToolExecution("refused-2", "read", { toolCallId: "refused-2" });  // refused
  const forwarded = stash.get("refused-2");                    // record site
  stash.delete("refused-2");
  assert.equal(forwarded, REAL_REASON, "the stash does hand the reason over");

  const result = await adapter.recordToolResult("refused-2", "read", undefined, true, undefined, forwarded);
  assert.equal(result.validator, "pi-result-order", "but the result is discarded as out-of-order");
  assert.equal(adapter.currentTask!.failureReason, undefined, "so no certificate is produced");
  assert.equal(adapter.currentTask!.status, "PLANNING", "and the task is left alive");
  const reasons = adapter.recentEvents(200).filter((e) => e.type === "TOOL_RESULT_IGNORED")
    .map((e) => (e.payload as Record<string, unknown>).reason as string);
  assert.ok(reasons.includes("no_active_execution"), "discarded for an absent execution, not on any policy verdict");
});

test("BRIDGE.3 a refusal paired with a still-bound call also fails to certify", async () => {
  // The other half of the precondition: `observeToolResult` returns early at
  // :1192 while any sibling is in flight, so recovery does not run even when a
  // binding does resolve. Recorded separately so the two independent
  // preconditions cannot be conflated.
  const adapter = await trustedAdapter();
  await adapter.precheckToolCall("read", "execute", { path: "notes.md" }, undefined, "ok-1");
  await adapter.beginToolExecution("ok-1", "read", { toolCallId: "ok-1" });
  assert.equal(adapter.currentTask!.status, "EXECUTING", "a bound execution puts the task in EXECUTING");

  const { decision } = await adapter.precheckToolCall("read", "execute", { path: ".env" }, undefined, "refused-3");
  const result = await adapter.recordToolResult("refused-3", "read", undefined, true, undefined, decision.reason);
  assert.equal(result.validator, "pi-result-order", "the refused result is discarded");
  assert.equal(adapter.currentTask!.failureReason, undefined, "and certifies nothing");
});

test("BRIDGE.4 the MID-EXECUTION sequence is the one that certifies", async () => {
  // The contrast case, and the reason CERT below is pinned at all: an ADMITTED
  // call that binds and then fails carrying a policy reason does reach the
  // certificate. So the certificate machinery works — the gap is specifically
  // that a preflight refusal never reaches it.
  const adapter = await trustedAdapter();
  await deniedMidExecution(adapter, REAL_REASON);
  assert.equal(adapter.currentTask!.status, "FAILED", "a bound call that fails on a policy reason terminates the task");
  assert.match(adapter.currentTask!.failureReason!, /POLICY_DENIED_TERMINATED/, "and certifies the refusal");
});

/** The mid-execution sequence: admitted, bound, then failed carrying a reason. */
async function deniedMidExecution(adapter: KernelAdapter, reason: string | undefined): Promise<void> {
  await adapter.precheckToolCall("read", "execute", { path: "notes.md" }, undefined, "admitted-1");
  const bound = await adapter.beginToolExecution("admitted-1", "read", { toolCallId: "admitted-1" });
  assert.ok(bound, "an admitted call binds, so its result is not discarded");
  await adapter.recordToolResult("admitted-1", "read", undefined, true, undefined, reason);
}

// ===========================================================================
// CERT — the certificate's literal text, and its negative
// ===========================================================================

test("CERT.1 the certificate matches the real shape end to end", async () => {
  const adapter = await trustedAdapter();
  await deniedMidExecution(adapter, REAL_REASON);
  const certificate = adapter.currentTask!.failureReason!;

  // Anchored `^...$`: a prefix, a dropped field or two swapped fields all fail.
  // The counts and the depth are free — they differ between runs. The LABELS,
  // their ORDER and the `denied=` field are the contract.
  const shape = new RegExp(
    "^Recovery TERMINATE \\[POLICY_DENIED_TERMINATED\\]: "
    + "failure=POLICY_DENIED, "
    + `denied=${lit(REAL_REASON)}, `
    + "replanCount=\\d+/\\d+, "
    + "strategyCount=\\d+/\\d+, "
    + "retryCount=\\d+/\\d+, "
    + "recoveryDepth=\\d+/\\d+"
    // `elapsed` is appended only when the caller supplies one.
    + "(, elapsedMs=\\d+/\\d+)?$",
  );
  assert.match(certificate, shape, `certificate did not match the pinned shape:\n${certificate}`);
});

test("CERT.2 the bracket label is the long form, never the shorthand", async () => {
  const adapter = await trustedAdapter();
  await deniedMidExecution(adapter, REAL_REASON);
  const certificate = adapter.currentTask!.failureReason!;

  const label = certificate.match(/^Recovery TERMINATE \[([^\]]+)\]/)?.[1];
  assert.equal(label, "POLICY_DENIED_TERMINATED", "the bracket holds the strategy reason");
  assert.match(certificate, /failure=POLICY_DENIED[, ]/, "the category is named separately, by `failure=`");
  assert.notEqual(label, "POLICY_DENIED", "the shorthand is a strict prefix of the real label, so it cannot be the assertion");
});

test("CERT.3 `denied=` is positioned in the contract, and appears once", async () => {
  const adapter = await trustedAdapter();
  await deniedMidExecution(adapter, REAL_REASON);
  const certificate = adapter.currentTask!.failureReason!;

  assert.ok(certificate.includes(`failure=POLICY_DENIED, denied=${REAL_REASON}, `),
    "the reason sits in its contracted position, not merely somewhere in the string");
  assert.equal(certificate.split("denied=").length - 1, 1, "exactly one `denied=` field");
});

test("CERT.4 without a forwarded reason there is no such certificate", async () => {
  // The negative that makes the positives mean something: the same refusal, with
  // the reason withheld. Without this, CERT.1 could pass because the reason is
  // synthesised downstream, and the bridge could be deleted with every pin green.
  const adapter = await trustedAdapter();
  await deniedMidExecution(adapter, undefined);
  const certificate = adapter.currentTask?.failureReason ?? "";

  assert.doesNotMatch(certificate, /POLICY_DENIED/, "no refusal is reported when no reason was forwarded");
  assert.doesNotMatch(certificate, /denied=/, "and there is no `denied=` field to fill");
  assert.equal(lastPayload(adapter, "RECOVERY_STARTED")?.strategy, "REPLAN",
    "an unmarked tool error still replans: the death shape the bridge closes");
});
