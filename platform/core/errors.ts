export type ErrorCategory =
  | "TASK_ERROR" | "PLANNING_ERROR" | "SKILL_ERROR" | "TOOL_ERROR" | "VALIDATION_ERROR"
  | "POLICY_ERROR" | "CONTEXT_ERROR" | "MEMORY_ERROR" | "MODEL_ERROR" | "RECOVERY_ERROR"
  | "CONFIGURATION_ERROR"
  /**
   * A call the policy REFUSED, distinct from a permission failure.
   *
   * `POLICY_ERROR` is a fault in what the agent was trying to do; this is the
   * policy declining it outright. The distinction matters because only one of
   * them is final: a permission failure may be resolved another way, a refused
   * call cannot, so it must not be retried or replanned.
   */
  | "POLICY_DENIED";

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

  /**
   * F-006 §2.3: the exit status of the command that failed, when one is known.
   *
   * Optional and fail-closed. Absent means the classifier has no exit
   * information and behaves exactly as it did before, which is what keeps every
   * existing call site — none of which supplies this — bit-for-bit unchanged.
   */
  readonly exitStatus?: number;
  /**
   * F-006 §2.3: the PROGRAM name that ran, e.g. `grep`. Never the command text.
   *
   * A command line carries paths and can carry credentials; an error object
   * outlives the call and may be serialized, so only the bare program name is
   * retained. That is all the classifier needs, and it leaves nothing here that
   * a later reader would have to remember to redact.
   */
  readonly commandName?: string;

  override readonly name: string = "CoreError";

  constructor(
    category: ErrorCategory,
    message: string,
    options: {
      retryable?: boolean; taskId?: string; stepId?: string; executionId?: string;
      cause?: unknown; field?: string; exitStatus?: number; commandName?: string;
    } = {},
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
    this.exitStatus = options.exitStatus;
    this.commandName = options.commandName;
  }
}

export function isCoreError(error: unknown): error is CoreError {
  return error instanceof CoreError;
}
