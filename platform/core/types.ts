export type TaskStatus =
  | "RECEIVED" | "UNDERSTANDING" | "PLANNING" | "PLAN_VALIDATION" | "EXECUTING"
  | "OBSERVING" | "VALIDATING" | "RECOVERING" | "RETRYING" | "REPLANNING" | "ESCALATED"
  | "COMPLETED" | "FAILED" | "CANCELLED" | "TIMEOUT";

export type Priority = "low" | "normal" | "high" | "critical";
export type RiskLevel = "READ_ONLY" | "CONTROLLED" | "WRITE" | "DESTRUCTIVE";
export type SideEffect = "PURE" | "SIDE_EFFECTING";
export type Idempotency = "IDEMPOTENT" | "NON_IDEMPOTENT" | "UNKNOWN";
export type ValidationStatus = "VALID" | "INVALID" | "INCONCLUSIVE" | "REQUIRES_REPLAN";

export interface Artifact {
  artifactId: string;
  type: string;
  reference: string;
  producer: string;
  taskId: string;
  stepId?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
  /**
   * How the reference came to be known. `TOOL_DECLARED` means a tool declared
   * it as its output; anything inferred is marked as such so provenance is
   * never overstated.
   */
  origin?: "TOOL_DECLARED" | "DERIVED_FROM_INPUT";
  /**
   * Trust level. An artifact starts UNVERIFIED and only becomes VERIFIED by an
   * actual filesystem check, never by being declared.
   */
  trust?: "UNVERIFIED" | "VERIFIED" | "INVALID";
  /** Outcome of the last verification pass, including the checks performed. */
  verification?: import("./artifact.ts").ArtifactVerification;
}

export interface Provenance {
  source: string;
  locator?: string;
  executionId?: string;
  artifactIds: string[];
  evidence?: string;
}

export interface ValidationResult {
  status: ValidationStatus;
  validator: string;
  message: string;
  evidenceIds?: string[];
  details?: Record<string, unknown>;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
}

export interface PlanStep {
  stepId: string;
  description: string;
  skill?: string;
  tools: string[];
  dependencies: string[];
  expectedOutput: string;
  validationCriteria: string[];
  retryPolicy: RetryPolicy;
  timeoutMs: number;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED";
}

export interface Plan {
  planId: string;
  objective: string;
  assumptions: string[];
  steps: PlanStep[];
  selectedSkills: string[];
  selectedTools: string[];
  expectedOutputs: string[];
  validationCriteria: string[];
  riskLevel: RiskLevel;
}

export interface Task {
  taskId: string;
  parentTaskId?: string;
  rootTaskId: string;
  userRequest: string;
  objective: string;
  constraints: Record<string, unknown>;
  priority: Priority;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  deadline?: string;
  currentPlan?: Plan;
  currentStep?: string;
  completedSteps: string[];
  failedSteps: string[];
  observations: string[];
  artifacts: Artifact[];
  selectedSkills: string[];
  selectedTools: string[];
  validationResults: ValidationResult[];
  retryCount: number;
  replanCount: number;
  context: { estimatedTokens: number; maxTokens: number };
  execution: Record<string, unknown>;
  finalResult?: unknown;
  failureReason?: string;
}

export interface SkillDescriptor {
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  supportedInputs: string[];
  supportedOutputs: string[];
  requiredTools: string[];
  optionalTools: string[];
  dependencies: string[];
  constraints: string[];
  riskLevel: RiskLevel;
  examples: string[];
}

export interface ToolDescriptor {
  name: string;
  version: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  capabilities: string[];
  permissions: string[];
  riskLevel: RiskLevel;
  timeoutMs: number;
  retryPolicy: RetryPolicy;
  idempotency: Idempotency;
  sideEffect: SideEffect;
}

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  metadata?: Record<string, unknown>;
  artifacts: Artifact[];
  warnings: string[];
  error?: { category: string; message: string; retryable: boolean };
  provenance: Provenance[];
  execution: ExecutionRecord;
}

export interface ExecutionRecord {
  executionId: string;
  taskId: string;
  stepId: string;
  tool: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: "STARTED" | "COMPLETED" | "FAILED" | "CANCELLED";
  retryNumber: number;
  inputMetadata?: Record<string, unknown>;
  outputMetadata?: Record<string, unknown>;
  error?: { category: string; message: string; retryable: boolean };
}

export interface PolicyRequest {
  taskId: string;
  tool: ToolDescriptor;
  operation: string;
  input: unknown;
  approval?: boolean;
}

/**
 * Why a call was refused when no policy decision was made.
 *
 * Neither value is a `ViolationAction`. Nothing was evaluated and no rule was
 * broken: the task was already in a state that admits no further execution
 * (`task_terminal`), or the call belongs to a task that a newer turn has
 * already replaced (`stale_task`). Keeping them out of `violation` is what stops
 * a lifecycle refusal from being read as "policy blocked this call".
 */
export type DenialRefusal = "task_terminal" | "stale_task";

export type PolicyDecision =
  | { decision: "ALLOW" }
  | { decision: "DENY"; reason: string; violation?: ViolationAction; refusal?: DenialRefusal }
  | { decision: "REQUIRE_APPROVAL"; reason: string };

/**
 * How much of a metered budget a task has consumed.
 *
 * `ok` is below every threshold, `low` is the first crossing, `critical` is the
 * second. The two thresholds exist because a limit that is only enforced at the
 * limit itself gives no chance to course-correct: by the time the denial
 * arrives, the task is already terminal.
 */
export type BudgetLevel = "ok" | "low" | "critical";

/**
 * A read-only view of one task's call budget, reported immediately after a
 * call has been counted.
 *
 * This is telemetry, never a decision. Nothing in the kernel may turn it into a
 * denial: `remaining` can be 0 while the call that produced this telemetry was
 * still allowed, and the limit check itself is unchanged. It exists so that
 * running low is visible BEFORE the terminal denial, and so that a repeated
 * identical call is visible as a count rather than only as a growing total.
 */
export interface ToolBudgetTelemetry {
  /** Counted calls in this task so far, including the call just evaluated. */
  used: number;
  /** The configured `maxToolCallsPerTask`. */
  limit: number;
  /** `limit - used`, floored at 0. */
  remaining: number;
  level: BudgetLevel;
  /**
   * How many times this exact call — same tool, operation and input — has now
   * been made in this task. 1 on the first occurrence, so `> 1` is a repeat.
   *
   * The comparison is on an internal signature; the input is never carried into
   * a trace or a log, only this count is.
   */
  repeatCount: number;
}

/**
 * What a DENY does to the task, from `on_violation` in the declarative policy.
 *
 * `block` (default) refuses the call and lets the task continue. `abort`
 * terminates the task. The kernel acts on this at its single policy choke point,
 * so an embedder cannot ignore it.
 */
export type ViolationAction = "block" | "abort";

export interface ContextSource {
  id: string;
  kind: "instruction" | "task" | "plan" | "step" | "skill" | "tool" | "observation" | "artifact" | "memory" | "conversation";
  priority: number;
  estimatedTokens: number;
  content: string;
  required?: boolean;
}

export interface MemoryRecord {
  id: string;
  scope: "SESSION" | "PROJECT" | "LONG_TERM";
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface MemoryStore {
  read(scope: MemoryRecord["scope"], query?: string): Promise<MemoryRecord[]>;
  write(record: Omit<MemoryRecord, "id" | "createdAt">): Promise<MemoryRecord>;
  search(scope: MemoryRecord["scope"], query: string): Promise<MemoryRecord[]>;
  delete(id: string): Promise<void>;
}

// Type-only re-exports. The policy contract is DECLARED in policy.ts, but
// `configured-policy.ts` legitimately imports it from here, so it is re-exported
// from the module that centralises the kernel's type surface. These are erased
// at runtime, so no import cycle is created.
export type { ApprovalProvider, PolicyEngine, PolicyMode } from "./policy.ts";
export type { RuleVerdict } from "./policy-config.ts";
