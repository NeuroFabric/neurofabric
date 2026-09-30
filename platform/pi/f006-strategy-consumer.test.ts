import test from "node:test";
import assert from "node:assert/strict";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import type { RecoveryLimits } from "../core/index.ts";

/**
 * F006.4c C4: the strategy fork stops being inert.
 *
 * C1 declared the fork and C2 proved the table, but every call site omitted the
 * new arguments, so the adapter always took the repeat path and the strategy
 * fund could never be spent. C4 passes them for real: `strategyCount` from
 * per-task state, `attemptMatchesLastFailure` from comparing the failing
 * attempt's signature against the previous failure's.
 *
 * These are ADAPTER-MEDIATED on purpose. F006.4b checks that a limit is read
 * somewhere in the source; that passed while the adapter consumed nothing, and
 * it would pass again if the wiring were removed tomorrow. The fourteen
 * failures that killed three tasks were the adapter's own surface firing, so
 * the completion criterion here is that surface, driven end to end.
 *
 * The anchor is `lastFailureSignature`: which attempt failed last, for this
 * task, reset on the VALID boundary and cleared on supersession. Without it
 * there is nothing to compare and the fork cannot open.
 */

const TOOLS = ["read", "write"].map((name) => toolDescriptorFromPi({ name, description: name }));

/**
 * Limits that make the strategy fund the scarce resource, so exhaustion is
 * reachable in a handful of failures. `maxReplans` is deliberately generous:
 * the point is to show WHICH ledger is charged, and a tight replan budget
 * would terminate before the distinction could be read.
 */
const LIMITS: RecoveryLimits = {
  maxToolRetries: 2,
  maxReplans: 5,
  maxStrategyChanges: 1,
  maxRecoveryDepth: 20,
  maxExecutionTimeMs: 10 * 60 * 1000,
};

function newKernel(): KernelAdapter {
  const k = new KernelAdapter({ limits: LIMITS });
  k.registerTools(TOOLS);
  return k;
}

const lastPayload = (k: KernelAdapter, type: string) =>
  k.recentEvents(500).filter((e) => e.type === type).at(-1)?.payload as Record<string, unknown> | undefined;

/**
 * Precheck, bind, and FAIL. Every attempt goes through the precheck on purpose:
 * that is the only path that records a signature, so a different `input` here
 * is the only way to make an attempt novel.
 */
async function failWith(
  k: KernelAdapter,
  callId: string,
  input: Record<string, unknown>,
  opts: { retryable?: boolean } = {},
): Promise<void> {
  const { decision } = await k.precheckToolCall("read", "execute", input, undefined, callId);
  assert.equal(decision.decision, "ALLOW", `${callId} must be admitted`);
  const bound = await k.beginToolExecution(callId, "read");
  assert.ok(bound, `${callId} must bind an execution, or no signature is recorded`);
  await k.recordToolResult(callId, "read", undefined, true, opts.retryable);
}

/** Succeed, so the VALID boundary resets the anchor and the depth together. */
async function succeedWith(k: KernelAdapter, callId: string, input: Record<string, unknown>): Promise<void> {
  const { decision } = await k.precheckToolCall("read", "execute", input, undefined, callId);
  assert.equal(decision.decision, "ALLOW");
  const bound = await k.beginToolExecution(callId, "read");
  assert.ok(bound);
  await k.recordToolResult(callId, "read", { ok: true }, false);
}

const strategyCount = (k: KernelAdapter) => k.currentTask!.strategyCount ?? 0;

/**
 * Park a handler inside the first `type` event, run `interleave` while it is
 * suspended, then let it resume. Deterministic, never a timer race.
 */
async function interleaveAt(
  k: KernelAdapter,
  type: string,
  trigger: () => Promise<unknown>,
  interleave: () => Promise<unknown>,
): Promise<unknown> {
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  let parked = false;
  const off = k.events.subscribe((e) => {
    if (e.type !== type || parked) return;
    parked = true;
    return gate; // the sink yields control until released
  });
  const run = trigger();
  await new Promise((res) => setImmediate(res)); // let the handler reach its emit
  await interleave();
  release();
  off();
  return run;
}

// --- a3.1 a novel failure spends the strategy fund -------------------------

test("C4.1 a novel failure takes the strategy path and books to strategyCount", async () => {
  const k = newKernel();
  await k.beginTask("one");
  // The first failure has no prior failure to differ from, so it is a repeat
  // and books to the replan budget. It establishes the anchor.
  await failWith(k, "a1", { path: "a.md" });
  assert.equal(k.currentTask!.replanCount, 1, "the first failure is a repeat, charged to the replan budget");
  assert.equal(strategyCount(k), 0, "and to nothing else");

  // A DIFFERENT input is a new approach, not a repeat of the one that just failed.
  await failWith(k, "a2", { path: "b.md" });
  assert.equal(strategyCount(k), 1, "a novel attempt books to the strategy fund");
  assert.equal(k.currentTask!.replanCount, 1, "and leaves the replan budget alone");
  assert.equal(lastPayload(k, "RECOVERY_STARTED")?.reason, "STRATEGY_CHANGE_REPLAN",
    "the decision names the strategy path");
  assert.equal(lastPayload(k, "RECOVERY_STARTED")?.attemptMatchesLastFailure, false,
    "and the trace says the attempt was novel");
});

// --- a3.2 an identical attempt is legacy, verbatim -------------------------

test("C4.2 an identical attempt keeps the legacy path and books to replanCount, never strategyCount", async () => {
  const k = newKernel();
  await k.beginTask("one");
  // Byte-identical input both times: the second is a repeat of the first.
  await failWith(k, "a1", { path: "same.md" });
  await failWith(k, "a2", { path: "same.md" });

  assert.equal(k.currentTask!.replanCount, 2, "both replans were charged to the replan budget");
  assert.equal(strategyCount(k), 0, "an identical attempt NEVER books to the strategy fund");
  assert.equal(lastPayload(k, "RECOVERY_STARTED")?.attemptMatchesLastFailure, true,
    "the trace records it as a repeat");
  assert.equal(lastPayload(k, "RECOVERY_STARTED")?.reason, "GENERIC_REPLAN",
    "and the legacy reason, unchanged");
});

test("C4.2b key order is not novelty: a reordered input is the SAME attempt", async () => {
  // The normalizer's contract, seen through the fork. If reordered keys read as
  // a new approach, every call that happens to build its object differently
  // would silently spend the strategy fund.
  const k = newKernel();
  await k.beginTask("one");
  await failWith(k, "a1", { path: "same.md", offset: 1 });
  await failWith(k, "a2", { offset: 1, path: "same.md" });

  assert.equal(strategyCount(k), 0, "a reordered input is a repeat, not a new approach");
  assert.equal(k.currentTask!.replanCount, 2, "so both charged the replan budget");
});

// --- a3.3/a3.4 exhaustion, adapter-mediated -------------------------------

test("C4.3 an exhausted fund with a retry-legal failure takes the legacy retry path verbatim", async () => {
  const k = newKernel();
  await k.beginTask("one");
  await failWith(k, "a1", { path: "a.md" });            // repeat, books replan
  await failWith(k, "a2", { path: "b.md" });            // novel, books strategy (fund now 1/1)
  assert.equal(strategyCount(k), 1);

  // Novel again, so the fund is exhausted, but TRANSIENT: F006.5's path must
  // still get its retry. Terminating here would pre-punish a failure that has
  // not happened.
  await failWith(k, "a3", { path: "c.md" }, { retryable: true });

  assert.notEqual(k.currentTask!.status, "FAILED", "a retry-legal failure must never be pre-terminated");
  assert.equal(lastPayload(k, "RECOVERY_STARTED")?.strategy, "RETRY",
    "the legacy retry path is taken verbatim");
  assert.equal(k.currentTask!.retryCount, 1, "and the retry was actually issued");
  assert.equal(strategyCount(k), 1, "the exhausted fund spent nothing further");
});

test("C4.4 an exhausted fund with no legal retry TERMINATES with STRATEGY_BUDGET_EXHAUSTED", async () => {
  const k = newKernel();
  await k.beginTask("one");
  await failWith(k, "a1", { path: "a.md" });
  await failWith(k, "a2", { path: "b.md" });
  assert.equal(strategyCount(k), 1, "precondition: the fund is spent");

  // Novel, and a deterministic non-retryable failure: nothing is left to fund
  // and retry is forbidden (F006.2), so the strategy fund is what ran out.
  await failWith(k, "a3", { path: "c.md" });

  assert.equal(k.currentTask!.status, "FAILED");
  const reason = k.currentTask!.failureReason!;
  assert.match(reason, /STRATEGY_BUDGET_EXHAUSTED/, "the certificate names the fund that ran out");
  assert.match(reason, /failure=TOOL_FAILURE/, "and the failure that exhausted it");
  assert.match(reason, /strategyCount=1\/1/, "showing the fund spent");
  assert.equal(lastPayload(k, "TASK_FAILED")?.reasonCode, "STRATEGY_BUDGET_EXHAUSTED");
  assert.equal(k.currentTask!.retryCount, 0, "no retry was ever issued");
});

// --- a3.5 the anchor lifecycle -------------------------------------------

test("C4.5 the VALID boundary resets the anchor, so the next failure repeats again", async () => {
  const k = newKernel();
  await k.beginTask("one");
  await failWith(k, "a1", { path: "a.md" });
  await failWith(k, "a2", { path: "b.md" });
  assert.equal(strategyCount(k), 1, "precondition: one strategy change is booked");

  // A success heals the task. The anchor must reset with it, or the next
  // failure would be compared against a failure from before the recovery.
  await succeedWith(k, "ok1", { path: "c.md" });
  assert.equal(k.diagnostics.recoveryDepth, 0, "the VALID boundary reset the depth");

  await failWith(k, "a3", { path: "d.md" });
  assert.equal(lastPayload(k, "RECOVERY_STARTED")?.attemptMatchesLastFailure, true,
    "after a VALID boundary the next failure repeats, it is not a new approach");
  assert.equal(k.currentTask!.replanCount, 2, "so it is charged to the replan budget");
  assert.equal(strategyCount(k), 1, "and not to the strategy fund");
});

test("C4.6 a newer task starts with no anchor, so its first failure is a repeat", async () => {
  const k = newKernel();
  await k.beginTask("one");
  await failWith(k, "a1", { path: "a.md" });
  await failWith(k, "a2", { path: "b.md" });
  assert.equal(strategyCount(k), 1, "precondition: the first turn spent the fund");

  await k.beginTask("two");
  assert.equal(k.currentTask!.status, "PLANNING", "the newer turn is live");
  assert.equal(k.currentTask!.replanCount, 0, "with its own budgets");
  assert.equal(strategyCount(k), 0, "and no strategy changes of its own");

  await failWith(k, "b1", { path: "b.md" });
  assert.equal(lastPayload(k, "RECOVERY_STARTED")?.attemptMatchesLastFailure, true,
    "the older turn's anchor must not fork the newer turn's first decision");
  assert.equal(k.currentTask!.replanCount, 1, "so it books to the replan budget");
  assert.equal(strategyCount(k), 0, "and never to the strategy fund");
});

test("C4.7 the anchor pins are live, not inert", async () => {
  // C3.4b's shape. Without this, C4.2, C4.5 and C4.6 could all pass simply
  // because nothing is ever novel.
  const k = newKernel();
  await k.beginTask("one");
  await failWith(k, "a1", { path: "a.md" });
  await failWith(k, "a2", { path: "definitely-different.md" });
  assert.equal(lastPayload(k, "RECOVERY_STARTED")?.attemptMatchesLastFailure, false,
    "a different input really is novel, through the adapter");
  assert.equal(strategyCount(k), 1, "and really does spend the fund");
});

test("C4.8 a failure whose attempt was never prechecked books to the replan budget", async () => {
  // The direct beginToolExecution path: no precheck means no signature, so
  // there is no identity to compare. Unknown identity must be treated as the
  // legacy path, or an embedder that binds its own executions would silently
  // start spending the strategy fund.
  const k = newKernel();
  await k.beginTask("one");
  for (const id of ["d1", "d2"]) {
    const bound = await k.beginToolExecution(id, "read");
    assert.ok(bound);
    await k.recordToolResult(id, "read", undefined, true);
  }
  assert.equal(k.currentTask!.replanCount, 2, "both charged the replan budget, exactly as before C4");
  assert.equal(strategyCount(k), 0, "and none to the strategy fund");
});

// --- a3.6 the ANCHOR's staleness (C3.4's template, for C4's own state) ----

test("C4.9 a stale failure classification must not write the anchor onto the newer task", async () => {
  // The audit found this cell empty: C3.4 covers the ATTEMPT side
  // (lastAttemptSignature) and the H2-H6 series covers other counters, but
  // nothing pinned the ANCHOR C4 introduced. A stale handler writing it would
  // give the newer task a history it never had, and the very next failure would
  // be compared against a failure from a task that no longer exists.
  const k = newKernel();
  await k.beginTask("one");
  // Give the first task a real anchor, so "no anchor" is a meaningful state.
  await failWith(k, "a1", { path: "a.md" });
  assert.equal(lastPayload(k, "RECOVERY_STARTED")?.attemptMatchesLastFailure, true,
    "precondition: the first task has an anchor");

  // Bind a second call, then park its failure classification mid-emit.
  const { decision } = await k.precheckToolCall("read", "execute", { path: "b.md" }, undefined, "stale1");
  assert.equal(decision.decision, "ALLOW");
  assert.ok(await k.beginToolExecution("stale1", "read"));

  await interleaveAt(
    k,
    "TOOL_FAILED",
    () => k.recordToolResult("stale1", "read", undefined, true),
    () => k.beginTask("two"), // the newer turn now owns the lifecycle
  );

  assert.equal(k.currentTask!.status, "PLANNING", "the stale classification must not fail the newer task");
  assert.equal(k.currentTask!.failureReason, undefined, "and must leave it no failure reason");
  assert.equal(k.currentTask!.replanCount, 0, "and spend no replan budget on it");
  assert.equal(strategyCount(k), 0, "and none of the strategy fund");

  // The observable consequence: the newer task's own first failure must read
  // as a REPEAT, because no anchor of its own exists. If the stale handler had
  // written one, this would be novel and would book to the strategy fund.
  await failWith(k, "b1", { path: "b.md" });
  assert.equal(lastPayload(k, "RECOVERY_STARTED")?.attemptMatchesLastFailure, true,
    "a stale anchor must not make the newer task's first failure look novel");
  assert.equal(k.currentTask!.replanCount, 1, "so it books to the replan budget");
  assert.equal(strategyCount(k), 0, "and never to the strategy fund");
});

test("C4.10 the staleness pin is live, not inert", async () => {
  // C3.4b's shape, for the anchor. Without it C4.9 could pass merely because
  // the anchor is never written by anyone.
  const k = newKernel();
  await k.beginTask("one");
  await failWith(k, "a1", { path: "a.md" });
  await failWith(k, "a2", { path: "different.md" });
  assert.equal(lastPayload(k, "RECOVERY_STARTED")?.attemptMatchesLastFailure, false,
    "a current-task classification really does move the anchor");
  assert.equal(strategyCount(k), 1, "and really does open the fork");
});
