  import test from "node:test";
   import assert from "node:assert/strict";
   import { mkdtemp } from "node:fs/promises";
   import os from "node:os";
   import path from "node:path";
   import { KernelAdapter } from "./kernel-adapter.ts";
   import { toolDescriptorFromPi } from "./tool-adapter.ts";
   import { buildPolicy } from "./project-config.ts";

   /**
    * F-006 denial refusal: the shape, and the EVENT ORDER that delivers it.
    *
    * THE D1 REVERSAL (ratified 2026-10-01). This file used to pin a TERMINAL
    * CERTIFICATE for a policy denial. There is no longer one, by name: the D1
    * contract reversal made a denial CONTINUE, so the artifact these pins measured
    * does not exist any more. The certificate is GONE, deliberately — and the
    * reason string it carried is not gone with it, because that string is the
    * only thing that ever told the operator WHICH RULE refused a call. So the
    * refusal's attribution moves onto `SOFT_REFUSAL_CONTINUED`, the one event a
    * survivable refusal makes, and the pins below re-base onto that record.
    *
    * A kill-the-task certificate could afford to be the only record, because the
    * task's death made it unmissable. A survivable refusal cannot: the task simply
    * carries on, so if the reason is not delivered here the refusal is visible
    * only as "something was refused" with no rule named. These pins are therefore
    * now the sole guard on attribution, which is why they assert the record
    * STRUCTURALLY rather than by pattern.
    *
    * The order is the other half of the finding, and it is unchanged. Pi emits, for
    * one toolCallId:
    *
    *   tool_execution_start   -> beginToolExecution BINDS (id not yet denied)
    *   tool_call (preflight)  -> precheckToolCall DENIES (reason stashed by id)
    *   tool_execution_end    -> recordToolResult DELIVERS the reason
    *
    * so the binding exists by the time the refusal arrives, the task is EXECUTING,
    * and the settling execution is the last one. That is why a policy denial
    * reaches recovery at all, instead of being recorded as a generic tool error and
    * replanned until the budget died.
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
    * WHY SUBSTRING ASSERTIONS ARE WORTHLESS HERE
    *
    * Two fields in the refusal record sit one substring away from each other, and
    * conflating them is the class of defect a survivable refusal can no longer
    * self-correct through:
    *
    *   record.failure = "POLICY_DENIED"      the CATEGORY
    *   record.reason  = "POLICY_SOFT_REFUSED" the STRATEGY'S REASON
    *
    * A regex loose enough to pass on a wrong field also passes on a missing one.
    * Every assertion below is an equality against the exact string, or an exact
    * field-set comparison, and none of them would be satisfied by a record that
    * simply mentioned the word POLICY_DENIED somewhere.
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

   test("BRIDGE.A1 a refusal in production order leaves the task LIVE, and is REPORTED", async () => {
     const adapter = await trustedAdapter();
     const forwarded = await productionOrder(adapter, "call-a1", { path: ".env" });
     assert.equal(forwarded, REAL_REASON, "the stashed reason is what gets delivered");

     const task = adapter.currentTask!;
     assert.notEqual(task.status, "FAILED", "a refusal does not kill the task");
     // `PLANNING` is this kernel's live, actionable, awaiting-next-move state.
     assert.equal(task.status, "PLANNING", "the task is still in control and can act on the answer");
     assert.equal(task.failureReason, undefined, "and there is no terminal certificate to misread");

     // The certificate is gone, so THIS is the attribution. If it were dropped the
     // task would carry on perfectly happily and the refusal would be unattributable.
     const record = lastPayload(adapter, "SOFT_REFUSAL_CONTINUED");
     assert.ok(record, "the refusal is recorded, not swallowed");
     assert.equal(record!.failure, "POLICY_DENIED", "it keeps its identity all the way through recovery");
     assert.equal(record!.denialReason, REAL_REASON, "with the policy's own words, verbatim");
   });

   test("BRIDGE.A2 a refusal in production order spends no budget of any kind", async () => {
     // Counters are task-cumulative, so this is measured from a fresh task with no
     // prior failure: the zero is the denial's own doing, not a carryover.
     const adapter = await trustedAdapter();
     await productionOrder(adapter, "call-a2", { path: ".env" });

     const task = adapter.currentTask!;
     assert.equal(task.replanCount, 0, "a refusal is not replanned");
     assert.equal(task.retryCount, 0, "and not retried");
     assert.equal(task.strategyCount ?? 0, 0, "and it triggers no strategy change either");

     const started = lastPayload(adapter, "RECOVERY_STARTED");
     assert.equal(started?.strategy, "CONTINUE", "recovery made exactly one move: carry on");
     assert.equal(started?.reason, "POLICY_SOFT_REFUSED", "reporting the refusal as the reason");
     assert.doesNotMatch(
       String(started?.reason),
       /BUDGET_EXHAUSTED|DEPTH_EXHAUSTED/,
       "a refusal must never be attributed to a budget it never spent",
     );
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
     // a generic tool error that replans to death — with no refusal record and no
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
     // Reversal-relevant: the guard staying silent is now load-bearing for
     // attribution as well as for classification.
     assert.equal(
       payloadsOf(adapter, "SOFT_REFUSAL_CONTINUED").length,
       1,
       "the refusal still arrives as a reportable denial, not as a bare tool error",
     );
   });

   test("BRIDGE.C2 a refusal while a sibling is still bound IS classified, and books no budget", async () => {
     // INVERTED 2026-10-01, F006 §5 item 8, and the inversion is the point.
     //
     // This pin used to assert the DEFECT: "recovery did not run while the
     // sibling was in flight", zero SOFT_REFUSAL_CONTINUED events, and the
     // early return described as a "precondition". All of it was measured and
     // all of it was true — and together it is precisely the mechanism by which
     // a sibling-settled refusal killed the task. `observeToolResult` returned
     // early at the sibling branch, `attemptBlocked` was set from the
     // ValidationResult alone, and `finishTask` then failed the task with a
     // reason naming no rule, no policy and no path, while nothing failed
     // verification. The old assertion was a description of the bug wearing
     // the costume of a precondition.
     //
     // What this pin ACTUALLY guards is kept, and is still load-bearing: the
     // refusal must not be discarded as out-of-order, and no terminal outcome
     // may be recorded while a sibling is still in flight. A fix that
     // classified the refusal by letting the FULL recovery block run would
     // advance the task out from under its siblings and break both.
     const adapter = await trustedAdapter();
     await adapter.beginToolExecution("sibling", "read", { toolCallId: "sibling" });
     await adapter.precheckToolCall("read", "execute", { path: "notes.md" }, undefined, "sibling");
     assert.equal(adapter.currentTask!.status, "EXECUTING", "the sibling put the task in EXECUTING");

     await adapter.beginToolExecution("call-c2", "read", { toolCallId: "call-c2" });
     const reason = await denyRealRead(adapter, "call-c2");
     const result = await adapter.recordToolResult("call-c2", "read", undefined, true, undefined, reason);

     // Still guarded, unchanged in substance.
     assert.notEqual(result.validator, "pi-result-order", "the refusal was not discarded as unordered");
     assert.notEqual(adapter.currentTask!.status, "FAILED",
       "and no outcome is recorded while the sibling is in flight, so the task is not failed early");
     assert.equal(payloadsOf(adapter, "TASK_FAILED").length, 0,
       "specifically: nothing terminal was written ahead of the siblings settling");

     // Inverted: the refusal IS classified where it lands. A refusal that is
     // visible but not attributable is the outcome the certificate existed to
     // prevent, and on the sibling path it used to be exactly that.
     const continued = payloadsOf(adapter, "SOFT_REFUSAL_CONTINUED");
     assert.equal(continued.length, 1, "the sibling-settled refusal is classified, not silently dropped");
     assert.equal(continued[0].denialReason, REAL_REASON,
       "and it carries the policy's own words verbatim, so the operator learns WHICH rule refused it");
     assert.equal(adapter.currentTask!.retryCount, 0, "and it books no retry budget");
     assert.equal(adapter.currentTask!.replanCount, 0,
       "and no replan budget - a refused call that charged one could exhaust it purely by being refused");
   });

   // ===========================================================================
   // CERT — the refusal record's literal shape, and its negative
   // ===========================================================================

   test("CERT.1 the refusal record matches the real shape end to end", async () => {
     const adapter = await trustedAdapter();
     await productionOrder(adapter, "call-1", { path: ".env" });

     const records = payloadsOf(adapter, "SOFT_REFUSAL_CONTINUED");
     assert.equal(records.length, 1, "a survivable refusal is recorded exactly once");
     const record = records[0]!;

     // Field-by-field, and by SET. The old pin matched one long string with an
     // anchored regex, which tolerates a dropped field and a swapped pair; an exact
     // key-set comparison tolerates neither. This record is the ONLY attribution a
     // refusal has now that the certificate is gone, so its shape is the contract.
     assert.deepEqual(
       Object.keys(record).sort(),
       ["denialReason", "failure", "reason", "recoveryDepth", "strategy"].sort(),
       "the record's field SET is the contract: a dropped or an added field fails here",
     );
     assert.equal(record.strategy, "CONTINUE", "the strategy is the one the table actually chose");
     assert.equal(record.reason, "POLICY_SOFT_REFUSED", "and the reason is the refusal, never a budget");
     assert.equal(record.failure, "POLICY_DENIED", "the category is carried under its own name");
     assert.equal(record.denialReason, REAL_REASON, "and the policy's own words arrive verbatim");
     assert.equal(typeof record.recoveryDepth, "number", "the depth is a position, and it is recorded");
   });

   test("CERT.2 the strategy reason is never confused with the failure category", async () => {
     const adapter = await trustedAdapter();
     await productionOrder(adapter, "call-2", { path: ".env" });
     const record = lastPayload(adapter, "SOFT_REFUSAL_CONTINUED")!;

     // Both fields name the same event and neither may stand in for the other.
     // A single loose regex over both would pass on a record that had swapped them,
     // which is the class of defect a survivable refusal can no longer self-correct
     // through: nothing about the task dying would tell anyone the record was wrong.
     assert.equal(record.reason, "POLICY_SOFT_REFUSED", "the reason field holds the strategy's own reason");
     assert.equal(record.failure, "POLICY_DENIED", "the category is named separately, under `failure`");
     assert.notEqual(record.reason, record.failure, "the two fields are not interchangeable");
   });

   test("CERT.3 the reason is delivered ONCE, whole, and only in its own field", async () => {
     const adapter = await trustedAdapter();
     await productionOrder(adapter, "call-3", { path: ".env" });
     const record = lastPayload(adapter, "SOFT_REFUSAL_CONTINUED")!;

     assert.equal(
       record.denialReason,
       REAL_REASON,
       "the reason sits whole in its own contracted field, not spliced into prose",
     );
     // A reason duplicated across fields, or echoed into a summary, would still
     // satisfy every substring pin this file used to carry. Counting deliveries is
     // the only assertion that notices.
     const serialized = JSON.stringify(record);
     assert.equal(
       serialized.split(REAL_REASON).length - 1,
       1,
       "exactly one delivery of the reason: never duplicated, never elided",
     );
     assert.doesNotMatch(
       String(record.failure),
       new RegExp(lit(REAL_REASON)),
       "and it never leaks into the category field, where it would read as a category name",
     );
   });

   test("CERT.4 without a delivered reason there is no refusal record", async () => {
     // The negative that makes the positives mean something: production order,
     // with the reason withheld — exactly the pre-bridge behaviour. Without this,
     // CERT.1 could pass because the reason is synthesised downstream, and the
     // bridge could be deleted with every pin still green.
     const adapter = await trustedAdapter();
     await adapter.beginToolExecution("call-4", "read", { toolCallId: "call-4" });
     const { decision } = await adapter.precheckToolCall("read", "execute", { path: ".env" }, undefined, "call-4");
	 assert.equal(decision.decision, "DENY");
     await adapter.recordToolResult("call-4", "read", undefined, true, undefined, undefined);

     assert.equal(
       payloadsOf(adapter, "SOFT_REFUSAL_CONTINUED").length,
       0,
       "no refusal is reported when no reason was delivered",
     );
     assert.equal(adapter.currentTask!.failureReason, undefined, "and no certificate exists either");
     // D4B: the unmarked tool error no longer REPLANS — it takes the retry rung.
     // The claim this assertion exists to make is that the failure is NOT
     // laundered into a survivable refusal, and that is now made on the REASON,
     // which names the class rather than accumulating into a counter.
     assert.equal(lastPayload(adapter, "RECOVERY_STARTED")?.reason, "TOOL_FAILURE_RETRY",
       "an unmarked tool error is recovered as an ordinary failure: the death shape the bridge closes, one rung higher");
   });

   test("CERT.5 an admitted call that fails reports the same way — the forwarding guard", async () => {
     // The mid-execution sequence `f006-policy-denied.test.ts` pins behaviourally.
     // Kept here so the reason field has two independent paths under test: one
     // that arrives with a preflight denial and one that arrives on a call the
     // preflight ADMITTED. Two paths means the attribution cannot rest on a single
     // call site being correct.
     const adapter = await trustedAdapter();
     await adapter.precheckToolCall("read", "execute", { path: "notes.md" }, undefined, "call-5");
     const bound = await adapter.beginToolExecution("call-5", "read", { toolCallId: "call-5" });
     assert.ok(bound);
     await adapter.recordToolResult("call-5", "read", undefined, true, undefined, REAL_REASON);

     assert.notEqual(adapter.currentTask!.status, "FAILED", "a bound call refused on its result still survives");
     const record = lastPayload(adapter, "SOFT_REFUSAL_CONTINUED");
     assert.ok(record, "and is reported, not swallowed");
     assert.equal(record!.denialReason, REAL_REASON, "with the policy's own words");
     assert.equal(record!.failure, "POLICY_DENIED", "and its category intact on this second path too");
   });