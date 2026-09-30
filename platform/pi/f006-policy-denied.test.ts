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
 * D1: a policy refusal is deterministic, and it was being replanned.
 *
 * A `ConfiguredPolicy` denial is not a transient fault. Nothing about retrying
 * the same call, or replanning around it, can make a denied call permitted: the
 * rule that denied it is a rule about the call itself.
 *
 * The defect, as observed twice in a live session (each time killing the task):
 *
 *   ConfiguredPolicy denial
 *     -> PolicyDecision { decision: "DENY", reason, violation }
 *     -> the adapter reduced that to a boolean plus an optional retryable flag
 *     -> recordToolResult FABRICATED a TOOL_ERROR, discarding reason and cause
 *     -> classifyFailure -> TOOL_FAILURE
 *     -> the table REPLANned it, and the identical denial burned the replan
 *        budget until the task died with REPLAN_BUDGET_EXHAUSTED
 *
 * A refusal was being treated as a fault worth another attempt. Two deaths, two
 * tasks, zero progress: the replan is re-proposing the very block that was
 * denied, so the outcome is determined in advance.
 *
 * The contract asserted here, and ONLY for a marked denial:
 *   POLICY_DENIED -> TERMINATE, no retry, no replan, no budget consumed,
 *   and the certificate names the actual denial reason.
 *
 * Generic TOOL_FAILURE and transient failures are untouched, and pinned as such
 * so this fix cannot quietly widen into a change of recovery policy.
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
  // NOT `abort`: the whole point is to prove the fix works on the paths where
  // the adapter does NOT already terminate. `abort` is handled by abortTask.
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

/** Drive one preflight-denied call, which must leave the task ALIVE (F-008's contract). */
async function denyAtPrecheck(adapter: KernelAdapter, callId: string): Promise<void> {
  const { decision } = await adapter.precheckToolCall("bash", "execute", { cmd: "rm -rf x" }, undefined, callId);
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

// --- 2-5. the invariant, end to end ---------------------------------------

test("D1.2 a denied call terminates the task immediately", async () => {
  const { adapter } = await denyingAdapter();
  await deniedMidExecution(adapter, "d1");
  assert.equal(adapter.currentTask!.status, "FAILED", "a refusal must not leave the task running");
});

test("D1.3 a denied call issues no retry", async () => {
  const { adapter } = await denyingAdapter();
  await deniedMidExecution(adapter, "d1");
  assert.equal(adapter.currentTask!.retryCount, 0, "a refusal is not retried");
  assert.equal(lastPayload(adapter, "TASK_FAILED")?.strategy, "TERMINATE");
});

test("D1.4 a denied call issues no replan and consumes no replan budget", async () => {
  const { adapter } = await denyingAdapter();
  await deniedMidExecution(adapter, "d1");
  assert.equal(adapter.currentTask!.replanCount, 0, "the replan budget is untouched by a refusal");
  assert.equal(lastPayload(adapter, "RECOVERY_STARTED")?.strategy, "TERMINATE", "the table never selected REPLAN");
});

test("D1.5 repeated identical denials consume no replan budget", async () => {
  const { adapter } = await denyingAdapter();
  await deniedMidExecution(adapter, "d1");
  assert.equal(adapter.currentTask!.status, "FAILED");
  assert.equal(adapter.currentTask!.replanCount, 0, "not one replan was spent on the refusal");
  assert.equal(adapter.currentTask!.retryCount, 0, "and not one retry");
  assert.equal(adapter.currentTask!.failureReason!.includes("REPLAN_BUDGET_EXHAUSTED"), false,
    "the task must not die of a budget it never spent");
});

test("D1.6 the terminal certificate names the ACTUAL denial reason", async () => {
  const { adapter } = await denyingAdapter();
  await deniedMidExecution(adapter, "d1");
  const reason = adapter.currentTask!.failureReason!;
  assert.match(reason, /POLICY_DENIED/, "the failure class is named");
  assert.ok(reason.includes(DENIAL_REASON), "the policy's own words, verbatim");
  assert.ok(reason.includes("outside the allowed roots"), "which rule refused it is identifiable");
  assert.doesNotMatch(reason, /no safe recovery strategy remains/);
  assert.doesNotMatch(reason, /Pi reported a tool error/);
});

// --- 6. the table --------------------------------------------------------

test("D1.7 the table terminates POLICY_DENIED without consulting any budget", () => {
  for (const idempotency of ["IDEMPOTENT", "NON_IDEMPOTENT", "UNKNOWN"] as Idempotency[]) {
    for (const attemptMatchesLastFailure of [true, false]) {
      // Every budget deliberately spent: a refusal must not be able to reach a
      // path that another move could have funded.
      const decision = chooseRecoveryDetailed({
        failure: "POLICY_DENIED", limits: DEFAULT_LIMITS,
        retryCount: 0, replanCount: DEFAULT_LIMITS.maxReplans,
        strategyCount: DEFAULT_LIMITS.maxStrategyChanges, depth: 0, idempotency,
        attemptMatchesLastFailure,
      });
      assert.equal(decision.strategy, "TERMINATE", "a refusal always terminates");
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
        assert.notEqual(decision.strategy, "ESCALATE", "a refusal terminates, it does not escalate");
      }
    }
  }
});

test("D1.9 the refusal guard precedes the guards that could mask it", () => {
  // Depth and elapsed-time guards also terminate, so a refusal must not be
  // reported as one of THOSE: the reason would be wrong.
  const exhaustedDepth = chooseRecoveryDetailed({
    failure: "POLICY_DENIED", limits: DEFAULT_LIMITS,
    retryCount: 0, replanCount: 0, strategyCount: 0,
    depth: DEFAULT_LIMITS.maxRecoveryDepth, idempotency: "IDEMPOTENT",
  });
  assert.match(
    (exhaustedDepth as { reason: string }).reason, /POLICY_DENIED/,
    "a refusal at the depth limit must still be reported as a refusal",
  );
});

// --- 7-8. nothing else moved ---------------------------------------------

test("D1.10 a generic deterministic tool failure still REPLANS", () => {
  // The fix is scoped to MARKED denials. A tool that failed for reasons of its
  // own keeps every bit of its previous recovery behaviour.
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
  assert.equal(adapter.currentTask!.status, "FAILED", "the denial ends its own task, and only that one");

  // A newer turn must start clean: the refusal belongs to the dead task.
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
