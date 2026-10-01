import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { buildPolicy } from "./project-config.ts";
import { parsePolicyConfig, type PolicyConfig } from "../core/policy-config.ts";
import {
  DEFAULT_LIMITS,
  chooseRecoveryDetailed,
  classifyFailure,
  type FailureCategory,
  type Idempotency,
} from "../core/index.ts";
import { CoreError } from "../core/errors.ts";

/**
 * D1: a policy refusal is an ANSWER, and it was being treated as a FAULT.
 *
 * A `ConfiguredPolicy` denial is not a transient fault. Nothing about retrying
 * the same call, or replanning around it, can make a denied call permitted: the
 * rule that denied it is a rule about the call itself.
 *
 * THE ORIGINAL DEFECT, as observed twice in a live session (each time killing
 * the task):
 *
 *   ConfiguredPolicy denial
 *     -> PolicyDecision { decision: "DENY", reason, violation }
 *     -> the adapter reduced that to a boolean plus an optional retryable flag
 *     -> recordToolResult FABRICATED a TOOL_ERROR, discarding reason and cause
 *     -> classifyFailure -> TOOL_FAILURE
 *     -> the table REPLANned it, and the identical denial burned the replan
 *        budget until the task died with REPLAN_BUDGET_EXHAUSTED
 *
 * D1 FIXED that by making a marked denial TERMINATE. That was a DEFERRAL, not
 * a fix: it stopped the replan death and replaced it with a different one. A
 * refusal is not a fault, and a fault is what a task is allowed to die of.
 *
 * THE D1 CONTRACT REVERSAL (ratified 2026-10-01). This file previously asserted
 *   POLICY_DENIED -> TERMINATE
 * That assertion is now INVERTED, deliberately and by name:
 *   POLICY_DENIED -> CONTINUE, always, under every label
 *
 * The old contract was wrong on the evidence. `onViolation: block` says the
 * refusal is survivable, so a run that terminated on it contradicted its own
 * committed policy — and the committed policy is tracked and legitimate, so the
 * behaviour was the defect, never the setting. A termination certificate for a
 * refusal also destroys the refusal's ATTRIBUTION, which is the only reason the
 * certificate ever existed: it told the operator which rule refused the call,
 * and a certificate that kills the task cannot be read as an attribution of a
 * single call inside a longer run.
 *
 * `abort` still ends a task, but it no longer does so HERE: `precheckToolCall`
 * calls `abortTask` before a call can be refused, so by the time any result
 * could reach this table the task is already FAILED and the result is discarded
 * as out of order. Termination belongs to that decision, not to this one.
 *
 * The contract asserted here, and ONLY for a marked denial:
 *   POLICY_DENIED -> CONTINUE; the refusal is REPORTED with the policy's own
 *   words; no retry, no replan, no strategy change, no budget consumed; the
 *   task stays live and in control.
 *
 * Generic TOOL_FAILURE and transient failures are untouched, and pinned as such
 * (D1.10, D1.11) so this reversal cannot quietly widen into a change of
 * recovery policy for real faults.
 */

const RULES = {
  version: 1,
  // `bash` is denied outright, by a name rule, so the refusal is unambiguous
  // and is not entangled with path resolution or content scanning.
  deniedTools: ["bash"],
  allowedTools: [],
  fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
  destructiveCommandPatterns: ["rm -rf"],
  destructiveCommandTokens: ["rm"],
  limits: { maxToolCallsPerTask: 40, maxFileWritesPerTask: 10, maxBytesPerWrite: 2_000_000 },
  // NOT `abort`: the whole point is to prove the contract on the path where the
  // adapter does NOT already terminate. `abort` is handled by abortTask.
  onViolation: "block",
} as const;

const TOOLS = ["read", "bash", "write"].map((name) => toolDescriptorFromPi({ name, description: name }));

async function root(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "nf-d1-"));
}

/** An adapter fronted by a real ConfiguredPolicy, exactly as the extension builds it. */
async function denyingAdapter() {
  const dir = await root();
  const policyConfig: PolicyConfig = parsePolicyConfig({ ...RULES }, "d1-policy.json");
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy({ policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] }, dir, policyConfig));
  for (const name of ["read", "bash", "write"]) adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
  await adapter.beginTask("do the work", "do the work");
  return { adapter, dir };
}

const types = (k: KernelAdapter, type: string) => k.recentEvents(500).filter((e) => e.type === type);
const lastPayload = (k: KernelAdapter, type: string) =>
  types(k, type).at(-1)?.payload as Record<string, unknown> | undefined;

/**
 * The reason a real `ConfiguredPolicy` produces for a refused call, used to
 * drive the result path the way the external Pi bridge does.
 */
const DENIAL_REASON = "policy <d1-policy.json> denied 'read': path 'secrets.md' is outside the allowed roots";

/**
 * Reproduce the path on which the three observed deaths occurred.
 *
 * Pi BEGINS a real execution, and the policy refusal is then reported as that
 * execution's result. This is the only shape in which a denial can reach
 * recovery at all: `observeToolResult` discards a result whose execution is
 * unbound, and a preflight denial binds none, so a call refused at the precheck
 * is dropped as `no_active_execution` and never reaches the table. Pinning the
 * precheck shape instead would have tested a path that cannot execute and would
 * have passed while the real defect stayed.
 */
async function deniedMidExecution(adapter: KernelAdapter, callId: string): Promise<void> {
  const { decision } = await adapter.precheckToolCall("read", "execute", { path: "secrets.md" }, undefined, callId);
  assert.equal(decision.decision, "ALLOW", "the call is admitted: the denial arrives afterwards, mid-execution");
  const bound = await adapter.beginToolExecution(callId, "read");
  assert.ok(bound, "an execution is bound, so the result is not discarded as out-of-order");
  await adapter.recordToolResult(callId, "read", undefined, true, undefined, DENIAL_REASON);
}

/**
 * Drive one preflight-denied call, which must leave the task ALIVE (F-008's contract).
 *
 * The payload is inert by design: `RULES` denies `bash` by name, so the
 * decision is reached on the tool name alone and the input is never inspected.
 * The test is about denial accounting, not about any construct, so it names
 * none. D1.13 asserts the reason names `deniedTools`, which is what makes that
 * independence observable rather than assumed.
 */
async function denyAtPrecheck(adapter: KernelAdapter, callId: string): Promise<void> {
  const { decision } = await adapter.precheckToolCall("bash", "execute", { cmd: "noop" }, undefined, callId);
  assert.equal(decision.decision, "DENY", "the policy must actually deny this call");
}

// --- 1. classification ----------------------------------------------------

test("D1.1 a marked denial classifies as POLICY_DENIED, never as TOOL_FAILURE", () => {
  const marked = new CoreError("POLICY_DENIED", "policy <p> denied 'bash': tool is in deniedTools", { retryable: false });
  assert.equal(classifyFailure(marked), "POLICY_DENIED");
  assert.notEqual(classifyFailure(marked), "TOOL_FAILURE", "the F-006 defect was exactly this collapse");
  // A marked denial is deterministic whatever the retryable flag says: the
  // flag describes a fault that can be retried, and a refusal is not a fault.
  assert.equal(
    classifyFailure(new CoreError("POLICY_DENIED", "denied", { retryable: true })),
    "POLICY_DENIED",
  );
});

test("D1.1b an unmarked tool error still classifies as before", () => {
  assert.equal(classifyFailure(new CoreError("TOOL_ERROR", "boom", { retryable: false })), "TOOL_FAILURE");
  assert.equal(classifyFailure(new CoreError("TOOL_ERROR", "flaky", { retryable: true })), "TRANSIENT");
  assert.equal(classifyFailure(new CoreError("POLICY_ERROR", "denied", { retryable: false })), "PERMISSION");
});

test("D1.1c a refusal keeps its identity all the way OUT to the caller", async () => {
  const { adapter } = await denyingAdapter();
  await deniedMidExecution(adapter, "d1-caller");

  // The reversal stopped the death. It did not stop the refusal being
  // reported, and reporting it is the whole of the contract.
  assert.equal(
    lastPayload(adapter, "RECOVERY_STARTED")?.failure,
    "POLICY_DENIED",
    "the refusal reaches recovery under its own category, not collapsed to TOOL_FAILURE",
  );
  assert.equal(
    lastPayload(adapter, "SOFT_REFUSAL_CONTINUED")?.denialReason,
    DENIAL_REASON,
    "and reaches the caller verbatim, so the refusal is attributable to a rule",
  );

  // KNOWN GAP, NOT YET PINNED AS A FAILURE. The ValidationResult returned to the
  // caller is { status: "INVALID", validator: "pi-result" } - byte-identical to
  // a genuine tool failure. A caller that branches on `validator` to decide
  // whether to retry would treat this refusal as a fault and retry it: D1
  // reborn one layer out, where the kernel's own classification can no longer
  // reach in to correct it.
  //
  // Deliberately NOT asserted here. Threading a refusal-specific validator is a
  // behaviour change at a public boundary and has its own review cycle
  // (roadmap.md, P1). Asserting the gap would park a permanently red test in
  // CI, and a red test people learn to ignore is worse than an unwritten one.
  // The assertion inverts to an equality when the fix lands.
});

// --- 2-5. the invariant, end to end ---------------------------------------

test("D1.2 REVERSED: a denied call does NOT terminate the task", async () => {
  const { adapter } = await denyingAdapter();
  await deniedMidExecution(adapter, "d1");

  // The assertion this test used to make is now the bug. `PLANNING` is this
  // kernel's live, actionable, awaiting-next-move state: the task survived and
  // can still act on the answer it was given.
  assert.equal(
    adapter.currentTask!.status,
    "PLANNING",
    "a refusal is an answer: the task stays live and able to act on it",
  );
  assert.notEqual(adapter.currentTask!.status, "FAILED", "a refusal must never kill a task");
  assert.equal(
    types(adapter, "TASK_FAILED").length,
    0,
    "and no failure certificate is emitted, so there is no death to misattribute",
  );
});

test("D1.3 REVERSED: a denied call issues no retry", async () => {
  const { adapter } = await denyingAdapter();
  await deniedMidExecution(adapter, "d1");
  assert.equal(adapter.currentTask!.retryCount, 0, "a refusal is not retried");
  // Not "no retry" but "no recovery move that could fail again": a retry of a
  // deterministically denied call is a foregone conclusion.
  assert.equal(lastPayload(adapter, "RECOVERY_STARTED")?.strategy, "CONTINUE");
});

test("D1.4 REVERSED: a denied call issues no replan and consumes no replan budget", async () => {
  const { adapter } = await denyingAdapter();
  await deniedMidExecution(adapter, "d1");
  assert.equal(adapter.currentTask!.replanCount, 0, "the replan budget is untouched by a refusal");
  assert.equal(lastPayload(adapter, "RECOVERY_STARTED")?.strategy, "CONTINUE", "the table never selected REPLAN");
});

test("D1.5 repeated identical denials consume no budget and never end the task", async () => {
  const { adapter } = await denyingAdapter();
  for (let i = 1; i <= 5; i++) {
    await deniedMidExecution(adapter, `d1-${i}`);
    assert.notEqual(adapter.currentTask!.status, "FAILED", `the task survived denial ${i}`);
  }
  assert.equal(adapter.currentTask!.replanCount, 0, "five denials, zero replans");
  assert.equal(adapter.currentTask!.retryCount, 0, "five denials, zero retries");
  assert.equal(adapter.currentTask!.strategyCount ?? 0, 0, "five denials, zero strategy changes");
  assert.equal(
    types(adapter, "SOFT_REFUSAL_CONTINUED").length,
    5,
    "every refusal is REPORTED: survivable does not mean silent",
  );
});

test("D1.6 REVERSED: the refusal is REPORTED with the ACTUAL denial reason", async () => {
  const { adapter } = await denyingAdapter();
  await deniedMidExecution(adapter, "d1");

  // The terminal certificate is gone, and that costs the operator the one thing
  // it was for. So the replacement is not merely "the task survives": the
  // refusal's ATTRIBUTION moves onto the only event a survivable refusal makes,
  // and carries the policy's own words verbatim. A refusal that is visible but
  // not attributable is the outcome the certificate existed to prevent.
  const refusal = lastPayload(adapter, "SOFT_REFUSAL_CONTINUED");
  assert.ok(refusal, "a survivable refusal is recorded, not swallowed");
  assert.equal(refusal!.failure, "POLICY_DENIED", "it keeps its identity all the way through recovery");
  assert.equal(refusal!.strategy, "CONTINUE", "and it books no budget");
  assert.equal(
    refusal!.denialReason,
    DENIAL_REASON,
    "the policy's own words, verbatim: which rule refused it stays identifiable",
  );
  assert.ok(
    String(refusal!.denialReason).includes("outside the allowed roots"),
    "and it names the rule, not just the class",
  );
});

// --- 6. the table --------------------------------------------------------

test("D1.7 REVERSED: the table CONTINUES on POLICY_DENIED without consulting any budget", () => {
  for (const idempotency of ["IDEMPOTENT", "NON_IDEMPOTENT", "UNKNOWN"] as Idempotency[]) {
    for (const attemptMatchesLastFailure of [true, false]) {
      for (const violation of ["block", "abort", undefined] as const) {
        // Every budget deliberately spent: a refusal must not be able to reach a
        // path that another move could have funded, and must not die of a
        // budget it never touched. Pinned under EVERY label, because the
        // reversal is exactly the claim that the label no longer decides.
        const decision = chooseRecoveryDetailed({
          failure: "POLICY_DENIED", limits: DEFAULT_LIMITS,
          retryCount: 0, replanCount: DEFAULT_LIMITS.maxReplans,
          strategyCount: DEFAULT_LIMITS.maxStrategyChanges, depth: DEFAULT_LIMITS.maxRecoveryDepth,
          idempotency, attemptMatchesLastFailure, violation,
        });
        assert.equal(
          decision.strategy,
          "CONTINUE",
          `a refusal continued or died (${idempotency}, violation=${violation})`,
        );
        assert.equal(decision.reason, "POLICY_SOFT_REFUSED", "and it is reported as a refusal, not a budget");
      }
    }
  }
});

test("D1.8 a refusal is never REPLAN, on either branch of the fork", () => {
  for (const idempotency of ["IDEMPOTENT", "NON_IDEMPOTENT", "UNKNOWN"] as Idempotency[]) {
    for (const attemptMatchesLastFailure of [true, false]) {
      for (let budget = 0; budget <= 4; budget++) {
        const decision = chooseRecoveryDetailed({
          failure: "POLICY_DENIED", limits: DEFAULT_LIMITS,
          retryCount: 0, replanCount: budget, strategyCount: budget,
          depth: 0, idempotency, attemptMatchesLastFailure,
        });
        assert.notEqual(decision.strategy, "REPLAN", "a refusal must never be replanned");
        assert.notEqual(decision.strategy, "RETRY", "a refusal must never be retried");
        assert.notEqual(decision.strategy, "ESCALATE", "a refusal is reported, not escalated into a dead end");
        assert.notEqual(decision.strategy, "TERMINATE", "and, by the reversal, it never terminates either");
      }
    }
  }
});

test("D1.9 the refusal guard precedes the guards that could mask it", () => {
  // Depth and elapsed-time guards also end the task, so a refusal must not be
  // reported as one of THOSE: the reason would be wrong, and an investigator
  // sent after a depth budget that the refusal never touched is worse than no
  // certificate at all.
  const exhaustedDepth = chooseRecoveryDetailed({
    failure: "POLICY_DENIED", limits: DEFAULT_LIMITS,
    retryCount: 0, replanCount: 0, strategyCount: 0,
    depth: DEFAULT_LIMITS.maxRecoveryDepth, idempotency: "IDEMPOTENT",
  });
  assert.equal(
    (exhaustedDepth as { reason: string }).reason,
    "POLICY_SOFT_REFUSED",
    "a refusal at the depth limit is still reported as a refusal, never as depth exhaustion",
  );
  assert.doesNotMatch(
    (exhaustedDepth as { reason: string }).reason,
    /DEPTH_EXHAUSTED|BUDGET_EXHAUSTED/,
    "no budget may be named as the cause of something the refusal already explains",
  );
});

// --- 7-8. nothing else moved ---------------------------------------------

test("D1.10 a generic deterministic tool failure still REPLANS", () => {
  // The reversal is scoped to MARKED denials. A tool that failed for reasons of
  // its own keeps every bit of its previous recovery behaviour — this is the
  // pin that stops the reversal becoming "nothing is ever terminal".
  for (let replanCount = 0; replanCount < DEFAULT_LIMITS.maxReplans; replanCount++) {
    const decision = chooseRecoveryDetailed({
      failure: "TOOL_FAILURE", limits: DEFAULT_LIMITS,
      retryCount: 0, replanCount, strategyCount: 0, depth: 0, idempotency: "IDEMPOTENT",
    });
    assert.equal(decision.strategy, "REPLAN", `TOOL_FAILURE at replanCount=${replanCount} still replans`);
  }
});

test("D1.11 a transient failure still RETRIES then replans then terminates", () => {
  const base = { failure: "TRANSIENT" as FailureCategory, limits: DEFAULT_LIMITS, depth: 0, idempotency: "IDEMPOTENT" as Idempotency };
  assert.equal(chooseRecoveryDetailed({ ...base, retryCount: 0, replanCount: 0 }).strategy, "RETRY");
  assert.equal(chooseRecoveryDetailed({ ...base, retryCount: DEFAULT_LIMITS.maxToolRetries, replanCount: 0 }).strategy, "REPLAN");
  assert.equal(chooseRecoveryDetailed({ ...base, retryCount: DEFAULT_LIMITS.maxToolRetries, replanCount: DEFAULT_LIMITS.maxReplans }).strategy, "TERMINATE");
});

// --- 9. isolation ---------------------------------------------------------

test("D1.12 a denial on task N cannot affect task N+1", async () => {
  const { adapter } = await denyingAdapter();
  await deniedMidExecution(adapter, "d1");
  assert.notEqual(adapter.currentTask!.status, "FAILED", "the denial did not end its own task");

  // A newer turn must start clean: the refusal belongs to the task that got it,
  // and a task's own record must not be inherited by the next turn.
  await adapter.beginTask("second turn", "second turn");
  assert.equal(adapter.currentTask!.status, "PLANNING", "the newer task is untouched");
  assert.equal(adapter.currentTask!.failureReason, undefined, "it carries no failure reason");
  assert.equal(adapter.currentTask!.replanCount, 0);
  const { decision } = await adapter.precheckToolCall("read", "execute", { path: "notes.md" }, undefined, "new-1");
  assert.equal(decision.decision, "ALLOW", "the newer task is unaffected by the older task's denial");
  const fresh = await adapter.beginToolExecution("new-1", "read");
  assert.ok(fresh, "the newer task binds its own execution");
  const result = await adapter.recordToolResult("new-1", "read", { ok: true }, false);
  assert.equal(result.validator !== "pi-result-order", true, "the newer task's own result is processed normally");
  assert.notEqual(adapter.currentTask!.status, "FAILED", "and the newer task is alive and in control, not failed");
  assert.equal(adapter.currentTask!.failureReason, undefined, "with no failure of its own");
  assert.equal(adapter.currentTask!.replanCount, 0, "and no budget spent by the older task's denial");
});

// --- 10-11. existing semantics --------------------------------------------

test("D1.13 denial accounting and the deny trace are unchanged", async () => {
  const { adapter } = await denyingAdapter();
  await denyAtPrecheck(adapter, "a1");
  assert.equal(adapter.diagnostics.denialCount, 1, "a policy denial is still counted as one");
  assert.equal(adapter.diagnostics.deniedToolCallIdCount, 1, "and still refuses a later execution_start for that id");
  const payload = lastPayload(adapter, "APPROVAL_DENIED");
  assert.ok(payload, "the deny trace event is still emitted");
  assert.equal(payload?.tool, "bash");
  assert.equal(payload?.violation, "block");
  assert.match(String(payload?.reason), /deniedTools/, "the reason is still the policy's own");
  // F-008's contract, preserved deliberately: a preflight denial under
  // on_violation:block leaves the task alive so it can act on the warning.
  assert.equal(adapter.currentTask!.status, "PLANNING", "a preflight denial does not kill the task");
});

test("D1.14 the 40-call limit still denies, and still costs no replan budget", async () => {
  // F-008's budget boundary, re-checked through the new path: a metered denial
  // must not become a replan, or a long task would die at 40 calls.
  const dir = await root();
  const policyConfig: PolicyConfig = parsePolicyConfig(
    { ...RULES, deniedTools: [], limits: { ...RULES.limits, maxToolCallsPerTask: 3 } },
    "d1-budget.json",
  );
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy({ policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] }, dir, policyConfig));
  for (const name of ["read", "bash", "write"]) adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
  await adapter.beginTask("do the work", "do the work");

  for (let i = 1; i <= 3; i++) {
    const { decision } = await adapter.precheckToolCall("read", "execute", { path: `f${i}.md` }, undefined, `c${i}`);
    assert.equal(decision.decision, "ALLOW", `call ${i} is within budget`);
  }
  const { decision } = await adapter.precheckToolCall("read", "execute", { path: "f4.md" }, undefined, "c4");
  assert.equal(decision.decision, "DENY", "the 4th call is over the limit");
  assert.match(String(decision.reason), /maxToolCallsPerTask|40|3/);
  assert.equal(adapter.currentTask!.replanCount, 0, "a budget denial costs no replan budget");
});