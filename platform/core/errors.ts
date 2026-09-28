export type ErrorCategory =
  | "TASK_ERROR" | "PLANNING_ERROR" | "SKILL_ERROR" | "TOOL_ERROR" | "VALIDATION_ERROR"
  | "POLICY_ERROR" | "CONTEXT_ERROR" | "MEMORY_ERROR" | "MODEL_ERROR" | "RECOVERY_ERROR"
  | "CONFIGURATION_ERROR";

export class CoreError extends Error {
  readonly category: ErrorCategory;
  readonly retryable: boolean;
  readonly taskId?: string;
  readonly stepId?: string;
  readonly executionId?: string;
  // `override` is required, not stylistic: `cause` already exists on the Error
  // base class (ES2022 `Error.cause`) and `noImplicitOverride` rejects any
  // member that shadows an inherited one without saying so.
  override readonly cause?: unknown;
  /**
   * The configuration field a parse failure is about, when there is one.
   *
   * Callers have been passing this since the configuration parsers landed, but
   * it was absent from the options type, so it was silently discarded and never
   * reached the error. The static gate surfaced that; the field is now carried.
   */
  readonly field?: string;

  override readonly name: string = "CoreError";

  constructor(
    category: ErrorCategory,
    message: string,
    options: { retryable?: boolean; taskId?: string; stepId?: string; executionId?: string; cause?: unknown; field?: string } = {},
  ) {
    super(message);
    this.name = "CoreError";
    this.category = category;
    this.retryable = options.retryable ?? false;
    this.taskId = options.taskId;
    this.stepId = options.stepId;
    this.executionId = options.executionId;
    this.cause = options.cause;
    this.field = options.field;
  }
}

export function isCoreError(error: unknown): error is CoreError {
  return error instanceof CoreError;
}
