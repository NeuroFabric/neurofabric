import { CoreError } from "./errors.ts";
import type { ExecutionRecord, Idempotency, Plan, Task, ToolResult } from "./types.ts";

export type FailureCategory = "TRANSIENT" | "PERMISSION" | "INVALID_INPUT" | "TOOL_FAILURE" | "TIMEOUT" | "RATE_LIMIT" | "MODEL_FAILURE" | "VALIDATION_FAILURE" | "DEPENDENCY_FAILURE" | "UNKNOWN";
export type RecoveryStrategy = "RETRY" | "MODIFY_INPUT" | "ALTERNATE_TOOL" | "ALTERNATE_SKILL" | "REPLAN" | "ESCALATE" | "TERMINATE";

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
  | "REPLAN_BUDGET_EXHAUSTED";

export interface RecoveryDecision {
  strategy: RecoveryStrategy;
  reason: RecoveryReason;
}

export function classifyFailure(error: unknown): FailureCategory {
  if (error instanceof CoreError) {
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
  depth: number;
  idempotency: Idempotency;
  /**
   * D-009: wall-clock milliseconds the task has been running. The adapter
   * always supplies this; it defaults to 0 so recovery logic can be exercised
   * in isolation without a clock. An exhausted budget terminates the task
   * regardless of failure category, because no strategy can buy more time.
   */
  elapsedMs?: number;
}): RecoveryDecision {
  const { limits, failure, retryCount, replanCount, depth, idempotency } = options;
  if (options.elapsedMs !== undefined && options.elapsedMs > limits.maxExecutionTimeMs) {
    return { strategy: "TERMINATE", reason: "EXECUTION_TIME_EXHAUSTED" };
  }
  if (depth >= limits.maxRecoveryDepth) return { strategy: "TERMINATE", reason: "RECOVERY_DEPTH_EXHAUSTED" };
  if (failure === "PERMISSION") return { strategy: "ESCALATE", reason: "PERMISSION_FAILURE_ESCALATED" };
  if (failure === "INVALID_INPUT") return { strategy: "ESCALATE", reason: "INVALID_INPUT_ESCALATED" };
  if (failure === "VALIDATION_FAILURE" && replanCount < limits.maxReplans) {
    return { strategy: "REPLAN", reason: "VALIDATION_FAILURE_REPLAN" };
  }
  if (failure === "DEPENDENCY_FAILURE" && replanCount < limits.maxReplans) {
    return { strategy: "REPLAN", reason: "DEPENDENCY_FAILURE_REPLAN" };
  }
  if (["TRANSIENT", "TIMEOUT", "RATE_LIMIT", "MODEL_FAILURE"].includes(failure)) {
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
  depth: number;
  idempotency: Idempotency;
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
  options: { failure: FailureCategory; limits: RecoveryLimits; retryCount: number; replanCount: number; depth: number; elapsedMs?: number },
): string {
  const { limits, retryCount, replanCount, depth, failure } = options;
  const elapsed = options.elapsedMs === undefined ? "" : `, elapsedMs=${options.elapsedMs}/${limits.maxExecutionTimeMs}`;
  return `Recovery TERMINATE [${decision.reason}]: failure=${failure}, `
    + `replanCount=${replanCount}/${limits.maxReplans}, `
    + `retryCount=${retryCount}/${limits.maxToolRetries}, `
    + `recoveryDepth=${depth}/${limits.maxRecoveryDepth}${elapsed}`;
}

export function assertRecoveryBudget(limits: RecoveryLimits, retryCount: number, replanCount: number): void {
  if (retryCount > limits.maxToolRetries || replanCount > limits.maxReplans) {
    throw new CoreError("RECOVERY_ERROR", "Recovery budget exceeded", { retryable: false });
  }
}

export function preserveSuccessfulWork(previous: Plan, next: Plan, completedSteps: string[]): Plan {
  const completed = new Set(completedSteps);
  return { ...next, steps: next.steps.map((step) => completed.has(step.stepId) ? { ...step, status: "COMPLETED" } : step) };
}
