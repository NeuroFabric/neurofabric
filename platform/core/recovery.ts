import { CoreError } from "./errors.ts";
import type { ExecutionRecord, Idempotency, Plan, Task, ToolResult } from "./types.ts";

export type FailureCategory = "TRANSIENT" | "PERMISSION" | "INVALID_INPUT" | "TOOL_FAILURE" | "TIMEOUT" | "RATE_LIMIT" | "MODEL_FAILURE" | "VALIDATION_FAILURE" | "DEPENDENCY_FAILURE" | "POLICY_DENIED" | "UNKNOWN";
export type RecoveryStrategy = "RETRY" | "MODIFY_INPUT" | "ALTERNATE_TOOL" | "ALTERNATE_SKILL" | "REPLAN" | "ESCALATE" | "TERMINATE";

/**
 * The failure classes F006.5 treats as transient, and therefore the only ones
 * for which a retry of the same attempt is class-legal.
 *
 * Named once so the repeat path and the strategy-fund fallback cannot disagree
 * about which failures are transient.
 */
const RETRY_ELIGIBLE: ReadonlySet<FailureCategory> =
  new Set<FailureCategory>(["TRANSIENT", "TIMEOUT", "RATE_LIMIT", "MODEL_FAILURE"]);

/**
 * F-006: `maxStepRetries` was removed from this surface. It was declared here
 * and in DEFAULT_LIMITS but never read by any recovery decision, so it
 * advertised a bound that did not exist. Per-step attempt budgets are already
 * expressed where they belong, on the step and tool descriptors themselves
 * (`PlanStep.retryPolicy.maxAttempts`, `ToolDescriptor.retryPolicy.maxAttempts`).
 * Recovery budgets here are task-wide, and are named accordingly.
 */
export interface RecoveryLimits {
  /** Task-wide bound on identical tool retries. Consumed only by transient failures. */
  maxToolRetries: number;
  /** Task-wide bound on replans. */
  maxReplans: number;
  /** Task-wide bound on consecutive recovery rounds since the last success. */
  maxRecoveryDepth: number;
  /**
   * Task-wide bound on replans that change strategy, as opposed to replans that
   * repeat a failed approach. Governs the new-approach branch of
   * `chooseRecoveryDetailed`, where the move being funded is a strategy change.
   */
  maxStrategyChanges: number;
  /** Wall-clock bound on the whole task. D-009: enforced via `elapsedMs`. */
  maxExecutionTimeMs: number;
}

/**
 * F-006: a machine-readable account of WHY a strategy was chosen, so the trace
 * can distinguish "the replan budget ran out" from "the depth guard tripped"
 * instead of reporting one generic terminal reason for both.
 */
export type RecoveryReason =
  | "EXECUTION_TIME_EXHAUSTED"
  | "RECOVERY_DEPTH_EXHAUSTED"
  | "PERMISSION_FAILURE_ESCALATED"
  | "INVALID_INPUT_ESCALATED"
  | "VALIDATION_FAILURE_REPLAN"
  | "DEPENDENCY_FAILURE_REPLAN"
  | "NON_IDEMPOTENT_TRANSIENT_ESCALATED"
  | "TRANSIENT_RETRY"
  | "TRANSIENT_RETRY_EXHAUSTED_REPLAN"
  | "RETRY_AND_REPLAN_BUDGET_EXHAUSTED"
  | "GENERIC_REPLAN"
  | "REPLAN_BUDGET_EXHAUSTED"
  | "STRATEGY_CHANGE_REPLAN"
  | "STRATEGY_BUDGET_EXHAUSTED"
  | "POLICY_DENIED_TERMINATED";

export interface RecoveryDecision {
  strategy: RecoveryStrategy;
  reason: RecoveryReason;
}

export function classifyFailure(error: unknown): FailureCategory {
  if (error instanceof CoreError) {
    // Checked FIRST, and deliberately not derived from any other category. A
    // refusal is a final answer, not a fault, and it must keep its identity all
    // the way to recovery: folding it into TOOL_FAILURE is exactly what let the
    // table replan a denial until the replan budget was spent.
    if (error.category === "POLICY_DENIED") return "POLICY_DENIED";
    if (error.category === "POLICY_ERROR") return "PERMISSION";
    if (error.category === "VALIDATION_ERROR") return "VALIDATION_FAILURE";
    if (error.category === "MODEL_ERROR") return "MODEL_FAILURE";
    if (error.category === "TOOL_ERROR") return error.retryable ? "TRANSIENT" : "TOOL_FAILURE";
  }
  return "UNKNOWN";
}

export function chooseRecoveryDetailed(options: {
  failure: FailureCategory;
  limits: RecoveryLimits;
  retryCount: number;
  replanCount: number;
  /**
   * Strategy changes already funded. Optional because the fork is inert until
   * the signal is wired: defaults to 0, so a caller that does not yet track
   * strategy changes spends the strategy fund exactly as it did before the fund
   * was declared.
   */
  strategyCount?: number;
  depth: number;
  idempotency: Idempotency;
  /**
   * Whether the attempt now being judged repeats the failure it last suffered.
   *
   * `true` means repeat: the pre-existing decision table applies unchanged.
   * `false` means a new approach, which the strategy fund governs.
   *
   * Optional and defaulting to `true` — "assume repeat" — so every call site
   * that does not yet supply the signal keeps its pre-existing behaviour, bit
   * for bit. The default is conservative: it can only preserve today's
   * decisions, never change them. Pinned by C2.
   */
  attemptMatchesLastFailure?: boolean;
  /**
   * D-009: wall-clock milliseconds the task has been running. The adapter
   * always supplies this; it defaults to 0 so recovery logic can be exercised
   * in isolation without a clock. An exhausted budget terminates the task
   * regardless of failure category, because no strategy can buy more time.
   */
  elapsedMs?: number;
}): RecoveryDecision {
  const { limits, failure, depth, idempotency } = options;
  const strategyCount = options.strategyCount ?? 0;
  const attemptMatchesLastFailure = options.attemptMatchesLastFailure !== false;
  if (options.elapsedMs !== undefined && options.elapsedMs > limits.maxExecutionTimeMs) {
    return { strategy: "TERMINATE", reason: "EXECUTION_TIME_EXHAUSTED" };
  }
  // A policy refusal is final, so it is reported ahead of every budget guard.
  // If the task had ALSO run out of time or depth, naming the refusal is the
  // more useful truth: the counters are incidental, the denial is the cause, and
  // a certificate blaming a budget would send an investigator after the wrong
  // thing. Refusing to retry or replan is also what stops an identically
  // re-proposed block from burning replan budget.
  if (failure === "POLICY_DENIED") return { strategy: "TERMINATE", reason: "POLICY_DENIED_TERMINATED" };
  if (depth >= limits.maxRecoveryDepth) return { strategy: "TERMINATE", reason: "RECOVERY_DEPTH_EXHAUSTED" };
  if (failure === "PERMISSION") return { strategy: "ESCALATE", reason: "PERMISSION_FAILURE_ESCALATED" };
  if (failure === "INVALID_INPUT") return { strategy: "ESCALATE", reason: "INVALID_INPUT_ESCALATED" };

  // The attempt repeats the failure it just suffered. The table below is the
  // pre-existing one, unchanged.
  if (attemptMatchesLastFailure) return repeatAttemptDecision(options);

  // A NEW APPROACH. The budget that governs this move is the strategy fund,
  // because the move is a strategy change and not another run at the same thing.
  if (strategyCount < limits.maxStrategyChanges) {
    return { strategy: "REPLAN", reason: "STRATEGY_CHANGE_REPLAN" };
  }
  // The strategy fund is spent. What is left is whatever the failure class
  // still allows, and the budget follows the MOVE, not the failed attempt's
  // character: a transient idempotent failure of a fresh approach has not yet
  // had its one retry (F006.5), so it gets the legacy retry path verbatim.
  // Terminating here would pre-punish a failure that has not happened.
  if (RETRY_ELIGIBLE.has(failure) && idempotency === "IDEMPOTENT") {
    return repeatAttemptDecision(options);
  }
  // Deterministic, or retry-illegal (F006.2, F006.5b). No strategy left to fund
  // and no legal retry, so the strategy fund is what ran out.
  return { strategy: "TERMINATE", reason: "STRATEGY_BUDGET_EXHAUSTED" };
}

/**
 * The decision table for an attempt that repeats its last failure, byte for byte
 * the behaviour that existed before the strategy fund was declared.
 *
 * Extracted rather than inlined so the repeat path and the fallback path in
 * `chooseRecoveryDetailed` provably share one implementation. A second copy of
 * this table is exactly how the two branches would drift apart.
 */
function repeatAttemptDecision(options: {
  failure: FailureCategory;
  limits: RecoveryLimits;
  retryCount: number;
  replanCount: number;
  idempotency: Idempotency;
}): RecoveryDecision {
  const { limits, failure, retryCount, replanCount, idempotency } = options;
  if (failure === "VALIDATION_FAILURE" && replanCount < limits.maxReplans) {
    return { strategy: "REPLAN", reason: "VALIDATION_FAILURE_REPLAN" };
  }
  if (failure === "DEPENDENCY_FAILURE" && replanCount < limits.maxReplans) {
    return { strategy: "REPLAN", reason: "DEPENDENCY_FAILURE_REPLAN" };
  }
  if (RETRY_ELIGIBLE.has(failure)) {
    if (idempotency === "NON_IDEMPOTENT") {
      return { strategy: "ESCALATE", reason: "NON_IDEMPOTENT_TRANSIENT_ESCALATED" };
    }
    if (retryCount < limits.maxToolRetries) return { strategy: "RETRY", reason: "TRANSIENT_RETRY" };
    // Retries are spent but replans may remain: fall through, as before.
    if (replanCount < limits.maxReplans) {
      return { strategy: "REPLAN", reason: "TRANSIENT_RETRY_EXHAUSTED_REPLAN" };
    }
    return { strategy: "TERMINATE", reason: "RETRY_AND_REPLAN_BUDGET_EXHAUSTED" };
  }
  if (replanCount < limits.maxReplans) return { strategy: "REPLAN", reason: "GENERIC_REPLAN" };
  return { strategy: "TERMINATE", reason: "REPLAN_BUDGET_EXHAUSTED" };
}

export function chooseRecovery(options: {
  failure: FailureCategory;
  limits: RecoveryLimits;
  retryCount: number;
  replanCount: number;
  strategyCount?: number;
  depth: number;
  idempotency: Idempotency;
  attemptMatchesLastFailure?: boolean;
  elapsedMs?: number;
}): RecoveryStrategy {
  return chooseRecoveryDetailed(options).strategy;
}

/**
 * F-006: the terminal reason names the budget that was actually exhausted and
 * the category that failed, instead of one generic sentence for every cause.
 */
export function describeTerminalRecovery(
  decision: RecoveryDecision,
  options: { failure: FailureCategory; limits: RecoveryLimits; retryCount: number; replanCount: number; strategyCount?: number; depth: number; elapsedMs?: number; denialReason?: string },
): string {
  const { limits, retryCount, replanCount, depth, failure } = options;
  const strategyCount = options.strategyCount ?? 0;
  const elapsed = options.elapsedMs === undefined ? "" : `, elapsedMs=${options.elapsedMs}/${limits.maxExecutionTimeMs}`;
  // The policy's OWN words, when any survived to this point. A refusal is only
  // actionable if the operator can see WHICH rule refused it, so nothing
  // generic is substituted for a real reason.
  const denial = options.denialReason === undefined ? "" : `, denied=${options.denialReason}`;
  // BOTH the replan and the strategy counter are reported, whichever budget
  // blocked the final move: the investigator must always be able to see which
  // pattern died.
  return `Recovery TERMINATE [${decision.reason}]: failure=${failure}${denial}, `
    + `replanCount=${replanCount}/${limits.maxReplans}, `
    + `strategyCount=${strategyCount}/${limits.maxStrategyChanges}, `
    + `retryCount=${retryCount}/${limits.maxToolRetries}, `
    + `recoveryDepth=${depth}/${limits.maxRecoveryDepth}${elapsed}`;
}

export function assertRecoveryBudget(limits: RecoveryLimits, retryCount: number, replanCount: number, strategyCount = 0): void {
  if (retryCount > limits.maxToolRetries || replanCount > limits.maxReplans || strategyCount > limits.maxStrategyChanges) {
    throw new CoreError("RECOVERY_ERROR", "Recovery budget exceeded", { retryable: false });
  }
}

export function preserveSuccessfulWork(previous: Plan, next: Plan, completedSteps: string[]): Plan {
  const completed = new Set(completedSteps);
  return { ...next, steps: next.steps.map((step) => completed.has(step.stepId) ? { ...step, status: "COMPLETED" } : step) };
}
