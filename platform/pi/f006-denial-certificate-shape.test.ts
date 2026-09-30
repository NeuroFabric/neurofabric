import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { buildPolicy } from "./project-config.ts";

/**
 * F-006 denial certificate: the shape, and the EVENT ORDER that delivers it.
 *
 * The order is the whole finding. Pi emits, for one toolCallId:
 *
 *   tool_execution_start   -> beginToolExecution BINDS (id not yet denied)
 *   tool_call (preflight)  -> precheckToolCall DENIES (reason stashed by id)
 *   tool_execution_end    -> recordToolResult DELIVERS the reason
 *
 * so the binding exists by the time the refusal arrives, the task is EXECUTING,
 * and the settling execution is the last one. That is why a policy denial
 * terminates on the denial instead of being recorded as a generic tool error
 * and replanned until the budget died.
 *
 * The guard at kernel-adapter.ts:964 — "never fabricate an execution plan for a
 * call policy refused" — does NOT fire in production, because binding happens
 * BEFORE the id is ever recorded as denied. It fires only when a caller
 * prechecks first, which Pi does not do. BRIDGE.C pins that the guard stays
 * silent; BRIDGE.B pins the precheck-first order so its behaviour is recorded
 * rather than left as folklore.
 *
 * Both orders were measured and both are real. An earlier revision of this file
 * pinned only the precheck-first order and reported the bridge as inert. That
 * conclusion was correct for the order it exercised and wrong about production.
 * The error was assuming Pi's order rather than measuring it; these pins now
 * name the order in every test so the mistake cannot recur silently.
 *
 * WHY THE SHORTHAND IS WORTHLESS AS AN ASSERTION
 *
 * The spec shorthand is `POLICY_DENIED`. The real label is
 * `POLICY_DENIED_TERMINATED`, of which the shorthand is a strict PREFIX, so
 * `assert.match(reason, /POLICY_DENIED/)` passes whether the reason was
 * forwarded, whether the label is right, and whether a certificate exists at
 * all. Every label assertion below is an equality against the long form.
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

const payloadsOf = (k: KernelAdapter, type: string) =>
  k.recentEvents(500).filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>);

/** The real policy must produce REAL_REASON, so every pin below is driven by live policy output. */
async function denyRealRead(adapter: KernelAdapter, callId: string): Promise<string> {
  const { decision } = await adapter.precheckToolCall("read", "execute", { path: ".env" }, undefined, callId);
  assert.equal(decision.decision, "DENY", "the real policy must actually deny this call");
  assert.equal(decision.reason, REAL_REASON, "and refuse it in its own words");
  return decision.reason;
}

/**
 * The PRODUCTION order, transcribed from `.pi/extensions/platform-orchestrator.ts`
 * and from Pi's measured emission order:
 *
 *   start  -> beginToolExecution(id, name, { toolCallId: id })
 *   preflight -> precheckToolCall(name, "execute", input, approval, id)
 *              -> declareToolOutputs(id, name, input)
 *              -> DENY stashes the reason under the id
 *   end    -> reason = stash.get(id); stash.delete(id)
 *          -> recordToolResult(id, name, result, isError, undefined, reason)
 */
async function productionOrder(adapter: KernelAdapter, callId: string, input: unknown): Promise<string | undefined> {
  // tool_execution_start — FIRST, before the preflight.
  const bound = await adapter.beginToolExecution(callId, "read", { toolCallId: callId });
  assert.ok(bound, "the start event binds before the preflight ever runs");

  // tool_call
  const { decision } = await adapter.precheckToolCall("read", "execute", input, undefined, callId);
  await adapter.declareToolOutputs(callId, "read", input);
  const stash: Map<string, string> = new Map();
  if (decision.decision !== "ALLOW") stash.set(callId, decision.reason);   // deny site

  // tool_execution_end
  const forwarded = stash.get(callId);                                     // record site
  stash.delete(callId);
  await adapter.recordToolResult(callId, "read", undefined, true, undefined, forwarded);
  return forwarded;
}

// ===========================================================================
// BRIDGE.A — the production order
// ===========================================================================

test("BRIDGE.A1 a refusal in production order produces the POLICY_DENIED certificate", async () => {
  const adapter = await trustedAdapter();
  const forwarded = await productionOrder(adapter, "call-a1", { path: ".env" });
  assert.equal(forwarded, REAL_REASON, "the stashed reason is what gets delivered");

  const task = adapter.currentTask!;
  assert.equal(task.status, "FAILED", "a refusal terminates the task");
  assert.match(task.failureReason!, /POLICY_DENIED_TERMINATED/, "naming the refusal");
  assert.ok(task.failureReason!.includes(REAL_REASON), "carrying the policy's own words, verbatim");
});

test("BRIDGE.A2 a refusal in production order spends no replan budget", async () => {
  // Counters are task-cumulative and the label names the final trigger, so this
  // is measured from a fresh task with no prior failure: the zero is the
  // denial's own doing, not a carryover.
  const adapter = await trustedAdapter();
  await productionOrder(adapter, "call-a2", { path: ".env" });

  const task = adapter.currentTask!;
  assert.equal(task.replanCount, 0, "a refusal is not replanned");
  assert.equal(task.retryCount, 0, "and not retried");
  assert.match(task.failureReason!, /replanCount=0\//, "the certificate reports the untouched replan budget");
  assert.match(task.failureReason!, /strategyCount=0\//, "and the untouched strategy budget");
  assert.doesNotMatch(task.failureReason!, /REPLAN_BUDGET_EXHAUSTED|STRATEGY_BUDGET_EXHAUSTED|RETRY_BUDGET_EXHAUSTED/,
    "a refusal must not die of a budget it never spent");
  assert.equal(lastPayload(adapter, "RECOVERY_STARTED")?.strategy, "TERMINATE", "and one recovery move was enough");
});

// ===========================================================================
// BRIDGE.B / BRIDGE.C — the order Pi does NOT emit, and the guard that stays silent
// ===========================================================================

test("BRIDGE.B precheck-FIRST order discards the result — an order Pi never emits", async () => {
  // Recorded, not endorsed. Pi emits start before preflight, so this sequence
  // has no production counterpart; it is pinned because it is reachable through
  // the public API and because it is the order in which :964 fires. Its
  // behaviour is "discarded, task unmarked" and that is stated here so nobody
  // later mistakes it for a live path.
  const adapter = await trustedAdapter();
  const reason = await denyRealRead(adapter, "call-b1");
  const bound = await adapter.beginToolExecution("call-b1", "read", { toolCallId: "call-b1" });
  assert.equal(bound, undefined, "the guard refuses to bind an already-denied id");

  const result = await adapter.recordToolResult("call-b1", "read", undefined, true, undefined, reason);
  assert.equal(result.validator, "pi-result-order", "so the result is discarded as out-of-order");
  assert.equal(adapter.currentTask!.failureReason, undefined, "and the task is left unmarked");
  assert.equal(adapter.currentTask!.status, "PLANNING", "and alive");
});

test("BRIDGE.C the :964 guard stays SILENT in production order", async () => {
  // The tripwire. If Pi's emission order ever changes to preflight-before-start,
  // the guard fires, binding stops, and every policy denial silently reverts to
  // a generic tool error that replans to death — with no certificate and no
  // alarm. This asserts the guard is dormant on the live path.
  const adapter = await trustedAdapter();
  await productionOrder(adapter, "call-c1", { path: ".env" });

  const ignored = payloadsOf(adapter, "TOOL_EXECUTION_IGNORED");
  assert.equal(ignored.length, 0, "no execution_start was ignored: the guard never fired");
  assert.ok(
    !ignored.some((p) => p.reason === "policy_denied"),
    "specifically, no binding was refused as policy_denied",
  );
  // And the id was recorded as denied only AFTER it had already bound.
  assert.equal(adapter.diagnostics.denialCount, 1, "the refusal is still counted");
  assert.equal(adapter.diagnostics.deniedToolCallIdCount, 1, "and the id is still recorded as refused");
});

test("BRIDGE.C2 a refusal while a sibling is still bound does not certify", async () => {
  // The third precondition, independent of order: `observeToolResult` returns
  // early at :1192 while any execution remains in flight, so recovery does not
  // run. Pinned separately so it cannot be conflated with the ordering findings.
  const adapter = await trustedAdapter();
  await adapter.beginToolExecution("sibling", "read", { toolCallId: "sibling" });
  await adapter.precheckToolCall("read", "execute", { path: "notes.md" }, undefined, "sibling");
  assert.equal(adapter.currentTask!.status, "EXECUTING", "the sibling put the task in EXECUTING");

  await adapter.beginToolExecution("call-c2", "read", { toolCallId: "call-c2" });
  const reason = await denyRealRead(adapter, "call-c2");
  const result = await adapter.recordToolResult("call-c2", "read", undefined, true, undefined, reason);

  assert.notEqual(result.validator, "pi-result-order", "the refusal was not discarded as unordered");
  assert.notEqual(adapter.currentTask!.status, "FAILED",
    "but recovery did not run while the sibling was in flight, so no certificate exists yet");
});

// ===========================================================================
// CERT — the certificate's literal text, and its negative
// ===========================================================================

test("CERT.1 the certificate matches the real shape end to end", async () => {
  const adapter = await trustedAdapter();
  await productionOrder(adapter, "call-1", { path: ".env" });
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
  await productionOrder(adapter, "call-2", { path: ".env" });
  const certificate = adapter.currentTask!.failureReason!;

  const label = certificate.match(/^Recovery TERMINATE \[([^\]]+)\]/)?.[1];
  assert.equal(label, "POLICY_DENIED_TERMINATED", "the bracket holds the strategy reason");
  assert.match(certificate, /failure=POLICY_DENIED[, ]/, "the category is named separately, by `failure=`");
  assert.notEqual(label, "POLICY_DENIED", "the shorthand is a strict prefix of the real label, so it cannot be the assertion");
});

test("CERT.3 `denied=` is positioned in the contract, and appears once", async () => {
  const adapter = await trustedAdapter();
  await productionOrder(adapter, "call-3", { path: ".env" });
  const certificate = adapter.currentTask!.failureReason!;

  assert.ok(certificate.includes(`failure=POLICY_DENIED, denied=${REAL_REASON}, `),
    "the reason sits in its contracted position, not merely somewhere in the string");
  assert.equal(certificate.split("denied=").length - 1, 1, "exactly one `denied=` field");
});

test("CERT.4 without a delivered reason there is no such certificate", async () => {
  // The negative that makes the positives mean something: production order,
  // with the reason withheld — exactly the pre-bridge behaviour. Without this,
  // CERT.1 could pass because the reason is synthesised downstream, and the
  // bridge could be deleted with every pin still green.
  const adapter = await trustedAdapter();
  await adapter.beginToolExecution("call-4", "read", { toolCallId: "call-4" });
  const { decision } = await adapter.precheckToolCall("read", "execute", { path: ".env" }, undefined, "call-4");
  assert.equal(decision.decision, "DENY");
  await adapter.recordToolResult("call-4", "read", undefined, true, undefined, undefined);
  const certificate = adapter.currentTask?.failureReason ?? "";

  assert.doesNotMatch(certificate, /POLICY_DENIED/, "no refusal is reported when no reason was delivered");
  assert.doesNotMatch(certificate, /denied=/, "and there is no `denied=` field to fill");
  assert.equal(lastPayload(adapter, "RECOVERY_STARTED")?.strategy, "REPLAN",
    "an unmarked tool error still replans: the death shape the bridge closes");
});

test("CERT.5 an admitted call that fails also certifies — the forwarding guard", async () => {
  // The mid-execution sequence `f006-policy-denied.test.ts` pins behaviourally.
  // Kept here so the reason field has two independent paths under test: one
  // that arrives with a refusal and one that arrives on an admitted call.
  const adapter = await trustedAdapter();
  await adapter.precheckToolCall("read", "execute", { path: "notes.md" }, undefined, "call-5");
  const bound = await adapter.beginToolExecution("call-5", "read", { toolCallId: "call-5" });
  assert.ok(bound);
  await adapter.recordToolResult("call-5", "read", undefined, true, undefined, REAL_REASON);

  assert.equal(adapter.currentTask!.status, "FAILED", "a bound call failing on a policy reason terminates the task");
  assert.ok(adapter.currentTask!.failureReason!.includes(REAL_REASON), "with the policy's own words");
});
