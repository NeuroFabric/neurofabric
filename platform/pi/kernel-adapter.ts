import { randomUUID } from "node:crypto";
import {
  CoreError,
  DEFAULT_LIMITS,
  DefaultPolicy,
  EventBus,
  InMemoryStore,
  ToolRegistry,
  createArtifact,
  createTask,
  declaredArtifactReferences,
  isConfiguredPolicy,
  redactString,
  transitionTask,
  validatePlan,
  skillsForCapabilities,
  verifyArtifacts,
  WorkspaceBoundary,
  type ApprovalProvider,
  type Artifact,
  type BudgetLevel,
  type Plan,
  type PlanStep,
  type PolicyDecision,
  type DenialRefusal,
  type PolicyEngine,
  type SkillDescriptor,
  type Task,
  type TaskStatus,
  type ToolBudgetTelemetry,
  type ToolDescriptor,
  type ToolResult,
  type ValidationResult,
} from "../core/index.ts";
import { chooseRecoveryDetailed, classifyFailure, describeTerminalRecovery, type RecoveryLimits } from "../core/index.ts";
import { callSignature } from "../core/call-signature.ts";
import { commandNameFrom, exitStatusFrom } from "../core/benign-exit.ts";
import { vaultToolDescriptors, vaultToolsEnabled, type VaultWiring } from "./vault-tools.ts";

export interface KernelAdapterOptions {
  skills?: SkillDescriptor[];
  limits?: RecoveryLimits;
  memory?: InMemoryStore;
  /**
   * Workspace boundary used to verify produced artifacts. When absent,
   * artifacts are still checked for existence and content but not for
   * containment.
   */
  boundary?: WorkspaceBoundary;
  /**
   * The operator-configured credentials vault, when there is one (D-016).
   *
   * Absent means the vault ships dark: no tools are registered and nothing
   * about it exists here. The adapter holds the WIRING only — enough to decide
   * whether the four descriptors attach — and never the handlers, because a
   * descriptor is a declaration and the binding belongs to the extension (M2).
   */
  vault?: VaultWiring;
}

export interface ToolCallDecision {
  decision: PolicyDecision;
  plan?: Plan;
  task?: Task;
}

/**
 * A real tool execution bound to the task, identified by Pi's toolCallId.
 * This is the only identity used to correlate tool_execution_end.
 */
export interface BoundExecution {
  toolCallId: string;
  executionId: string;
  planId: string;
  stepId: string;
  tool: string;
  startedAt: string;
  /** The input metadata supplied when the execution was begun. */
  inputMetadata?: Record<string, unknown>;
}

/**
 * States from which a *new* tool execution must not be admitted.
 * REPLANNING mean the kernel is deciding what to do next,
 * and the rest are terminal.
 */
/**
 * States from which a task can never move again.
 *
 * Distinct from `REFUSED_EXECUTION_STATES`, which also contains REPLANNING: a
 * REPLANNING task is still live and is still owned by whoever started it.
 */
const TERMINAL_TASK_STATES: readonly TaskStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
  "ESCALATED",
];

const REFUSED_EXECUTION_STATES: readonly TaskStatus[] = [
  "REPLANNING",
  "ESCALATED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
];

/**
 * A recorded task-state transition, with the internal counters as they stood
 * when it happened.
 *
 * This exists so a terminal state can be explained after the fact: which
 * transition produced it, from which call site, and what the lifecycle counters
 * were at that moment. It records facts; it makes no decision.
 */
export interface TaskTransitionRecord {
  /** The task this transition moved, so history spanning turns stays attributable. */
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  /** Why the caller moved the task, in the caller's own words. */
  reason: string;
  /** `KernelAdapter.<method>` — the code that moved the task. */
  callSite: string;
  at: string;
  failureReason?: string;
  diagnostics: KernelDiagnostics;
}

/**
 * An operation that was refused because its task had already been superseded.
 *
 * Pi dispatches lifecycle events from independent async handlers, so a handler
 * that began under one task can resume after a newer task has replaced it.
 * Recording the refusal keeps the race visible instead of silent.
 */
export interface StaleOperation {
  /** `KernelAdapter.<method>` that tried to act. */
  handler: string;
  /** The transition it tried to make, when the race surfaced at a transition. */
  attempted?: TaskStatus;
  reason: string;
  /** The task the handler believed it was operating on. */
  expectedTaskId: string;
  /** The task actually current when the handler resumed. */
  currentTaskId?: string;
}

/** A point-in-time view of the kernel's lifecycle bookkeeping. */
export interface KernelDiagnostics {
  status?: TaskStatus;
  failureReason?: string;
  /** The current attempt has an unresolved failure. */
  attemptBlocked: boolean;
  recoveryDepth: number;
  /**
   * Whether the current task holds a recorded attempt signature.
   *
   * The signature VALUE is deliberately not exposed: the policy that owns the
   * hashing never emits it, and a recovery identity derived from call input must
   * not start leaking into traces through a diagnostics bag.
   */
  attemptSignatureRecorded: boolean;
  /** Real executions bound to this task. A denied call never increments it. */
  toolExecutionCount: number;
  lastValidation?: ValidationResult;
  /** Policy DENY decisions, whatever `on_violation` they carried. */
  denialCount: number;
  /** Refusals because the task was already terminal. Not policy decisions. */
  terminalRefusalCount: number;
  activeExecutionCount: number;
  deniedToolCallIdCount: number;
  observedResultCount: number;
}

/**
 * Content block types that represent a real assistant *action*.
 *
 * A tool call is an action the model actually took, so a turn whose only
 * content is a tool call is a completed turn. It is not an absence of output.
 */
const TOOL_CONTENT_TYPES: ReadonlySet<string> = new Set(["toolCall", "toolUse", "toolResult", "tool_call"]);

function isCleanTerminal(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const msg = result as any;
  if (msg.role !== "assistant") return false;
  const content = Array.isArray(msg.content) ? msg.content : [];
  const hasContent = content.some((c: any) =>
    (c.type === "text" && c.text && c.text.trim().length > 0) || TOOL_CONTENT_TYPES.has(c.type));
  const hasFinishReason = Boolean(msg.finish_reason || msg.stopReason);
  return hasContent || hasFinishReason;
}

/**
 * Reduce an unknown rejection value to text that is safe to place on an error
 * surface.
 *
 * A tool call rejects with `unknown`, and the kernel copies that value into
 * `ToolResult.error`, which is a trace field that flows into diagnostics and
 * into anything a human reads afterwards. Interpolating such a value directly
 * would let a hostile rejection smuggle arbitrary text into that surface, so
 * anything that is not a real `Error` is described by its TYPE and never by
 * its content.
 *
 * `typeof` is used deliberately in place of `Object.prototype.toString`,
 * whose tag is controllable by the value itself through `Symbol.toStringTag`
 * and would therefore reopen the injection this function exists to close.
 */
function describeError(error: unknown): string | undefined {
  // Nullish means the call failed without carrying a value, which describes
  // nothing, so the field is left absent rather than filled with a filler.
  if (error === null || error === undefined) return undefined;
  if (error instanceof Error) return error.message;
  // `typeof` yields a closed set of literals that the value cannot influence.
  return `<rejection value of type ${typeof error}>`;
}

function event(type: Parameters<EventBus["emit"]>[0]["type"], taskId: string, payload: Record<string, unknown> = {}) {
  return {
    eventId: randomUUID(),
    type,
    taskId,
    correlationId: taskId,
    timestamp: new Date().toISOString(),
    payload,
  };
}

export class KernelAdapter {
  readonly events = new EventBus();
  readonly tools: ToolRegistry;
  readonly memory: InMemoryStore;
  /**
   * Active policy. Defaults to approval mode so that an unconfigured embedding
   * keeps the conservative behaviour; a trusted project installs
   * `TrustedProjectPolicy` explicitly.
   */
  policy: PolicyEngine = new DefaultPolicy();
  /**
   * The installed skill list, held under a name distinct from the accessor.
   *
   * This was previously a field named `skills` sitting alongside a
   * `get skills()` accessor that returned a defensive copy. A class field
   * declared without an initializer is still a real field: it is installed as
   * an OWN property during construction and therefore SHADOWED the prototype
   * accessor, so the defensive copy never ran and every caller received the
   * live internal array. `setSkills` is the validated entry point for changing
   * this state, and the leaked reference let any caller bypass it.
   *
   * Type erasure hid this completely, which is why the suite in
   * skills-defensive-copy.test.ts was written before the fix. The distinct
   * name lets the accessor do what it was written to do.
   */
  private readonly skillList: SkillDescriptor[];
  private readonly limits: RecoveryLimits;
  /**
   * Boundary used to verify produced artifacts.
   *
   * Installed either through the constructor or `setBoundary`. It is absent
   * only for an embedding that never resolves allowed roots, and then artifacts
   * are still checked for existence, readability and content, but not for
   * containment.
   */
  private boundary?: WorkspaceBoundary;
  /**
   * The operator's vault wiring, or absent when the vault ships dark.
   *
   * Held so registration can ask whether the tools should exist. It is never
   * read on a call path, so no execution behaviour depends on it.
   */
  private vault?: VaultWiring;
  private task?: Task;
  private plan?: Plan;
  private lastValidation?: ValidationResult;
  private recoveryDepth = 0;
  /**
   * The call signature of the most recent attempt this task actually ran.
   *
   * Recorded at the moment the attempt's identity is in hand — the precheck,
   * AFTER the stale guard — and never re-derived at classification time, because
   * by then the adapter holds no `PolicyRequest` to hash: `BoundExecution` keeps
   * only caller-supplied `inputMetadata`, not the policy input the signature is
   * computed over.
   *
   * Hashed by the SAME `callSignature` the policy's repeat accounting uses, so
   * the two cannot disagree about whether two calls are the same call.
   *
   * Per-task recovery state, with the same lifecycle as `recoveryDepth`: reset on
   * the VALID boundary, cleared when a newer task supersedes this one. A stale
   * signature must never fork a newer task's decisions, which is what the H2-H6
   * pins exist to prevent for every other counter.
   *
   * The VALUE is never emitted to a trace, a log, or `diagnostics`. Only whether
   * one was recorded is observable.
   */
  private lastAttemptSignature: string | undefined;
  /**
   * The signature of the attempt that failed most recently, for THIS task.
   *
   * C4. `lastAttemptSignature` answers "which attempt is this?"; this answers
   * "which attempt failed last?", and comparing the two is what tells the fork
   * whether the move is a NEW APPROACH or a REPEAT of the same one. Without the
   * anchor there is nothing to compare against, and the fork stays inert.
   *
   * Recorded when a failure is classified, never at preflight: a call that is
   * admitted is not a failure, and an anchor that moved on admission would
   * compare an attempt against itself.
   *
   * Same lifecycle as `recoveryDepth`: reset on the VALID boundary, cleared when
   * a newer task supersedes this one, never written by a stale handler. A stale
   * anchor would fork the newer task's decisions using the older task's history.
   */
  private lastFailureSignature: string | undefined;

  /** Real executions currently in flight, keyed by Pi toolCallId. */
  private readonly activeExecutions = new Map<string, BoundExecution>();
  /** Every toolCallId that has been admitted (started or policy-denied) at preflight. */
  private readonly knownToolCallIds = new Set<string>();
  /** Preflight-denied toolCallIds; Pi may still emit an execution_start for them. */
  private readonly deniedToolCallIds = new Set<string>();
  /**
   * D5 / §2.4(b): the second pending map, keyed the same way as the set above.
   *
   * `deniedToolCallIds` records THAT a call was refused. This one records WHY,
   * for the refusal classes that are not violations: an out-of-root discovery
   * span is a refusal of scope, not a rule breach, and the distinction has to
   * survive from the decision to the result, because by the time the result
   * arrives the decision object is gone.
   *
   * Held per toolCallId and cleared with the set above, so it cannot outlive the
   * call it describes.
   */
  private readonly pendingRefusals = new Map<string, DenialRefusal>();
  /** Execution ids whose result has already been observed. */
  private readonly observedExecutionIds = new Set<string>();
  /** Output references declared at preflight, keyed by Pi toolCallId. */
  private readonly declaredOutputs = new Map<string, string[]>();
  /**
   * F-006 §2.3: the PROGRAM name of each in-flight shell call, keyed the same
   * way, written at preflight and read-and-deleted at the record site.
   *
   * Why the preflight: Pi's `tool_call` is the only lifecycle event that carries
   * the call's input, and the extension's own comment says so. The result event
   * does not carry it, so the name has to be taken while it still exists. That is
   * the whole reason this map exists, and it is the same shape as the
   * denial-reason map above.
   *
   * Only the bare program name is stored, never the command text, which can
   * carry paths and credentials. Delete-on-read is unconditional, so a name can
   * never outlive its call.
   */
  private readonly toolCommandNames = new Map<string, string>();
  /**
   * Budget bands already warned about for the CURRENT task.
   *
   * The point of a warning is that it arrives while there is still room to act,
   * so it is sent once when the band is crossed rather than on every later call:
   * ten identical "you are low" messages between 90% and the limit would be
   * noise, and would bury the signal it exists to provide. Cleared by
   * `beginTask`, because a new turn has a new budget and needs its own warnings.
   */
  private readonly budgetWarned = new Set<BudgetLevel>();
  /**
   * Budget telemetry from the most recent counted call, for diagnostics and the
   * status command. Read-only: nothing in the kernel may turn this into a
   * decision, and the limit itself is enforced in the policy, not here.
   */
  private lastBudget: ToolBudgetTelemetry | undefined;
  /** Artifacts confirmed for this task. */
  private artifactList: Artifact[] = [];
  /**
   * Whether the *current* attempt has an unresolved failure.
   *
   * Reset when a new execution round begins, so a failure that recovery has
   * legitimately retried does not block completion forever, while a failure
   * inside the current round (for example a sibling execution) still does.
   */
  private attemptBlocked = false;
  /** Number of real tool executions bound to this task (drives honest finalisation). */
  private toolExecutionCount = 0;
  /** Policy DENY decisions made at preflight, `block` and `abort` alike. */
  private denialCount = 0;
  /** Refusals because the task was already in a state that admits no execution. */
  private terminalRefusalCount = 0;
  /** Every lifecycle transition, in order, for after-the-fact explanation. */
  private readonly transitionLog: TaskTransitionRecord[] = [];
  /**
   * D-009: monotonic start of the current task, for `maxExecutionTimeMs`.
   * `hrtime` rather than wall-clock so a system clock adjustment cannot extend
   * or prematurely cut a task's budget. Reset in `beginTask`.
   */
  private executionStartedAtNs = process.hrtime.bigint();
  /** Operations refused because a newer task had already replaced theirs. */
  private staleOperationCount = 0;
  private readonly staleOperations: StaleOperation[] = [];
  /**
   * Superseded tasks, kept only so the `beginTask` that created one can report
   * its final state instead of the newer task that displaced it.
   */
  private readonly supersededTasks = new Map<string, Task>();

  constructor(options: KernelAdapterOptions = {}) {
    this.tools = new ToolRegistry();
    this.memory = options.memory ?? new InMemoryStore();
    this.skillList = options.skills ?? [];
    this.boundary = options.boundary;
    this.vault = options.vault;
    // F-006: DEFAULT_LIMITS is the single source of truth for these bounds.
    // They used to be written out again here, which meant a change to the
    // exported defaults silently left recovery enforcing the old numbers.
    this.limits = options.limits ?? {
      maxToolRetries: DEFAULT_LIMITS.maxToolRetries,
      maxReplans: DEFAULT_LIMITS.maxReplans,
      maxStrategyChanges: DEFAULT_LIMITS.maxStrategyChanges,
      maxRecoveryDepth: DEFAULT_LIMITS.maxRecoveryDepth,
      maxExecutionTimeMs: DEFAULT_LIMITS.maxExecutionTimeMs,
    };
  }

  /**
   * The recovery budgets this kernel enforces.
   *
   * Read-only. Explicitly supplied limits are returned as given, so an embedder
   * that configured different budgets can see what it configured.
   */
  get recoveryLimits(): RecoveryLimits {
    return { ...this.limits };
  }

  /**
   * D-009: wall-clock milliseconds this task has been running, from a monotonic
   * source. Fed to recovery so `maxExecutionTimeMs` is enforced rather than
   * merely declared.
   */
  private elapsedMs(): number {
    return Number((process.hrtime.bigint() - this.executionStartedAtNs) / 1_000_000n);
  }

  /**
   * Install the boundary used to verify produced artifacts.
   *
   * The extension resolves allowed roots at session start, which is after the
   * kernel exists, so the boundary is installed here rather than only through
   * the constructor. It is the same boundary policy evaluation uses; it adds a
   * containment check to artifact verification and removes none.
   */
  setBoundary(boundary: WorkspaceBoundary): void {
    this.boundary = boundary;
  }

  setSkills(skills: SkillDescriptor[]): void {
    this.skillList.splice(0, this.skillList.length, ...skills);
  }

  get skills(): SkillDescriptor[] {
    return [...this.skillList];
  }

  findSkillsByCapabilities(capabilities: string[]): SkillDescriptor[] {
    return skillsForCapabilities(this.skillList, capabilities);
  }

  /** Install the policy used by preflight. Used to select the trust model. */
  setPolicy(policy: PolicyEngine): void {
    this.policy = policy;
  }

  /**
   * Install, replace, or clear the vault wiring.
   *
   * The policy document is read asynchronously, so the configuration can arrive
   * either side of the extension's first `registerTools`. Both funnel through
   * `vaultDescriptors`, which makes the order irrelevant. Clearing it removes
   * nothing that is already registered — the registry is append-only by design —
   * but it does mean nothing further is added.
   */
  setVault(wiring?: VaultWiring): void {
    this.vault = wiring;
    for (const descriptor of this.vaultDescriptors()) {
      if (!this.tools.has(descriptor.name)) this.tools.register(descriptor);
    }
  }

  /**
   * Drop the per-task accounting a finished task left in the policy.
   *
   * A metered policy keys its counters and its repeat map by task id, so those
   * maps would otherwise grow for the life of the process. A turn boundary is
   * the one point where the previous task is provably over, whatever state it
   * ended in, and it is purely bookkeeping: no task state, event or decision
   * depends on it.
   */
  private forgetPolicyAccounting(taskId: string): void {
    if (isConfiguredPolicy(this.policy)) this.policy.forgetTask(taskId);
  }

  /** Every task-state transition so far, oldest first. */
  get transitions(): readonly TaskTransitionRecord[] {
    return [...this.transitionLog];
  }

  /** Operations refused as stale, oldest first. */
  get staleHandlerOperations(): readonly StaleOperation[] {
    return [...this.staleOperations];
  }

  /**
   * Budget telemetry for the most recent counted call, if the installed policy
   * meters calls at all.
   *
   * Read-only, and deliberately NOT part of `diagnostics`: that object is
   * snapshotted into every transition record, so a field that changes on every
   * tool call would rewrite the history of every task. This is a live view for
   * the status command and for tests.
   */
  get budget(): ToolBudgetTelemetry | undefined {
    return this.lastBudget;
  }

  /**
   * Whether a handler that began under `taskId` is now stale.
   *
   * `this.task` is a single mutable slot shared by every Pi event handler, and
   * `beginTask` replaces it. A handler that captured its task at entry and then
   * yielded (every `events.emit` yields) must re-check before it mutates
   * anything, or it will act on whichever task happens to be current.
   */
  private isStale(taskId: string): boolean {
    return this.task?.taskId !== taskId;
  }

  /** Record a refused stale operation. Callers report it and return without mutating. */
  private refuseStale(taskId: string, handler: string, reason: string, extra: Partial<StaleOperation> = {}): void {
    this.staleOperationCount += 1;
    this.staleOperations.push({
      handler,
      reason,
      expectedTaskId: taskId,
      currentTaskId: this.task?.taskId,
      ...extra,
    });
  }

  /** Current lifecycle bookkeeping. */
  get diagnostics(): KernelDiagnostics {
    return {
      status: this.task?.status,
      failureReason: this.task?.failureReason,
      attemptBlocked: this.attemptBlocked,
      recoveryDepth: this.recoveryDepth,
      attemptSignatureRecorded: this.lastAttemptSignature !== undefined,
      toolExecutionCount: this.toolExecutionCount,
      lastValidation: this.lastValidation,
      denialCount: this.denialCount,
      terminalRefusalCount: this.terminalRefusalCount,
      activeExecutionCount: this.activeExecutions.size,
      deniedToolCallIdCount: this.deniedToolCallIds.size,
      observedResultCount: this.observedExecutionIds.size,
    };
  }

  /**
   * The single place a task state changes, so every transition is recorded with
   * the state it came from, the method that moved it, and the counters as they
   * stood. Behaviour is exactly `transitionTask`; the bookkeeping is additive.
   *
   * `expectTaskId` is the task the calling handler began under. When it no
   * longer matches, the handler is stale: it resumed after a newer task had
   * replaced the one it started with. The transition is then REFUSED and
   * recorded rather than applied, because applying it would move a task the
   * handler does not own. This is the single choke point that keeps a
   * re-entrant event from producing an illegal transition or clobbering a
   * newer task.
   */
  private advance(
    to: TaskStatus,
    reason: string,
    opts: { now?: string; failureReason?: string; expectTaskId?: string } = {},
  ): Task {
    if (opts.expectTaskId !== undefined && this.task?.taskId !== opts.expectTaskId) {
      this.refuseStale(opts.expectTaskId, this.callSite(), reason, { attempted: to });
      return this.task!;
    }
    const from = this.task!.status;
    this.task = transitionTask(this.task!, to, opts.now);
    if (opts.failureReason !== undefined) this.task = { ...this.task, failureReason: opts.failureReason };
    this.transitionLog.push({
      taskId: this.task!.taskId,
      from,
      to,
      reason,
      callSite: this.callSite(),
      at: this.task!.updatedAt,
      failureReason: this.task!.failureReason,
      // Snapshotted AFTER the transition, so `status` is the new state and the
      // counters are exactly as they stood when the task became terminal.
      // `diagnostics` is a getter, so it is read, not called.
      diagnostics: this.diagnostics,
    });
    // The log is the only after-the-fact explanation of a lifecycle, so it spans
    // turns and is bounded rather than reset: clearing it per task would erase
    // exactly the evidence a supersession needs.
    if (this.transitionLog.length > 500) this.transitionLog.shift();
    return this.task!;
  }

  /**
   * `KernelAdapter.<method>` for the frame that requested the transition.
   *
   * This method's own frame is skipped, as is `advance`, so the first
   * `KernelAdapter.*` frame found is the lifecycle method that asked for the
   * transition.
   */
  private callSite(): string {
    const frames = (new Error().stack ?? "").split("\n");
    for (const frame of frames) {
      const match = /KernelAdapter\.(\w+)/.exec(frame);
      if (match && match[1] !== "callSite" && match[1] !== "advance") return `KernelAdapter.${match[1]}`;
    }
    return "KernelAdapter.unknown";
  }

  /**
   * Record the output references a model-requested tool call declares.
   *
   * Called from Pi's `tool_call` preflight, which is the only lifecycle event
   * that carries the tool input. Whether a call declares artifacts at all is
   * derived from the tool's `sideEffect` classification, so read-only tools
   * record no outputs and free-form shell commands are not guessed at.
   */
  declareToolOutputs(toolCallId: string, toolName: string, input: unknown): string[] {
    if (!this.task) throw new Error("No active task");
    const references = declaredArtifactReferences(this.tools.get(toolName), input);
    if (references.length > 0) this.declaredOutputs.set(toolCallId, references);
    return references;
  }

  /** Artifacts confirmed for the current task. */
  get artifacts(): Artifact[] {
    return [...this.artifactList];
  }

  registerTools(descriptors: ToolDescriptor[]): void {
    for (const descriptor of [...descriptors, ...this.vaultDescriptors()]) {
      if (!this.tools.has(descriptor.name)) this.tools.register(descriptor);
    }
  }

  /**
   * The vault's four descriptors, or none of them.
   *
   * One funnel, reached from both `registerTools` and `setVault`, so the vault
   * attaches whether the configuration arrived before or after the extension's
   * first registration — and attaches not at all when the block is absent or
   * disabled, which is what "ships dark" means (A2).
   */
  private vaultDescriptors(): ToolDescriptor[] {
    return vaultToolsEnabled(this.vault) ? vaultToolDescriptors() : [];
  }

  get currentTask(): Task | undefined {
    return this.task;
  }

  get currentPlan(): Plan | undefined {
    return this.plan;
  }

  /** Real executions currently in flight. Used by the Pi adapter to correlate results. */
  activeExecution(toolCallId: string): BoundExecution | undefined {
    return this.activeExecutions.get(toolCallId);
  }

  async beginTask(userRequest: string, objective = userRequest, constraints: Record<string, unknown> = {}): Promise<Task> {
    // The previous turn is over the moment a new one begins, whatever state it
    // reached, so its per-task policy accounting is released here rather than
    // being retained for the life of the process. No lifecycle state, event or
    // decision reads it.
    if (this.task) this.forgetPolicyAccounting(this.task.taskId);
    // A turn that begins while an earlier task has not reached a terminal state
    // is a genuine race, not a normal sequence. The earlier task is terminated
    // EXPLICITLY here — recorded as a real FAILED transition with its own
    // TASK_FAILED event — rather than being silently replaced. That keeps the
    // supersession visible in the trace, and it uses only transitions the state
    // machine already allows (every non-terminal state may go to FAILED), so no
    // handler is left believing it still owns the lifecycle.
    if (this.task && !TERMINAL_TASK_STATES.includes(this.task.status)) {
      const superseded = this.task;
      this.advance("FAILED", "Superseded by a newer turn", {
        failureReason: "Superseded by a newer turn before it reached a terminal state",
      });
      this.supersededTasks.set(superseded.taskId, this.task);
      await this.events.emit(event("TASK_FAILED", superseded.taskId, {
        reason: "Superseded by a newer turn",
        supersededStatus: superseded.status,
      }));
    }
    // Task state is explicit; Pi's transcript remains the source of conversational context.
    const task = createTask({ taskId: randomUUID(), userRequest, objective, constraints });
    this.task = task;
    this.plan = undefined;
    this.lastValidation = undefined;
    this.recoveryDepth = 0;
    this.lastAttemptSignature = undefined;
    this.lastFailureSignature = undefined;
    this.executionStartedAtNs = process.hrtime.bigint();
    this.activeExecutions.clear();
    this.knownToolCallIds.clear();
    this.deniedToolCallIds.clear();
    this.observedExecutionIds.clear();
    this.declaredOutputs.clear();
    this.artifactList = [];
    this.attemptBlocked = false;
    this.toolExecutionCount = 0;
    this.denialCount = 0;
    this.terminalRefusalCount = 0;
    this.staleOperations.length = 0;
    // A new turn starts with a fresh budget, so it must also start with no
    // warning already sent for the previous one's usage.
    this.budgetWarned.clear();
    this.lastBudget = undefined;
    // The lifecycle states are moved WITHOUT awaiting in between.
    //
    // `events.emit` yields to Pi (its sink reaches `pi.appendEntry`). An
    // `agent_end` arriving in that window used to finalise a task still sitting
    // in UNDERSTANDING, and the no-tool finalisation path then requested
    // UNDERSTANDING -> PLAN_VALIDATION, which the state machine correctly
    // rejects. A task is observable the moment it is created, so the states it
    // may be finalised from must be in place before the first yield.
    this.advance("UNDERSTANDING", "Task accepted");
    this.advance("PLANNING", "Task started");
    await this.events.emit(event("TASK_CREATED", task.taskId, { objective: task.objective }));
    await this.events.emit(event("TASK_STARTED", task.taskId));
    await this.events.emit(event("PLAN_CREATED", task.taskId, { state: this.task.status }));
    // The emits above yield. If a newer turn superseded this one meanwhile, this
    // call must report the task IT created, never the task that replaced it.
    if (this.isStale(task.taskId)) {
      const superseded = this.supersededTasks.get(task.taskId);
      this.supersededTasks.delete(task.taskId);
      return superseded ?? this.task;
    }
    return this.task;
  }

  // ---------------------------------------------------------------------------
  // POLICY PRECHECK  (Pi `tool_call` — a preflight interception hook)
  // ---------------------------------------------------------------------------

  /**
   * The refusal text for a call that arrived after the task was already terminal.
   *
   * WHY THIS EXISTS. The task's `failureReason` was, until this change, appended
   * to every subsequent refusal with no indication that it described something
   * that had already happened. Measured consequence: after a destructive-command
   * denial, a later call naming no such command was refused with a certificate
   * naming that earlier command, and the agent reported the earlier denial as
   * the cause of its own death. Two sessions were lost investigating a
   * certificate that belonged to a call neither of them had made.
   *
   * THE CONTRACT, in this order:
   *
   *   1. It names the call that triggered the refusal — tool, operation and
   *      toolCallId — so the refusal is about THIS call and can be correlated
   *      with the trace entry for it.
   *   2. It says the call was NOT evaluated. Nothing ran and no policy rule
   *      refused it, which is the fact most easily lost and the one that decides
   *      whether the agent retries, reports a policy problem, or stops.
   *   3. The stored failure is labelled ORIGINAL, with its counters, and is
   *      attributed to the moment the task terminated rather than to this call.
   *      That is what makes a certificate's counters auditable: they describe
   *      the death, not the call being refused afterwards.
   *
   * A replayed reason is never presented as this call's own refusal. Where there
   * is no stored reason, that is stated outright rather than left as a dangling
   * separator.
   */
  private describeTerminalRefusal(toolName: string, operation: string, toolCallId: string | undefined): string {
    const status = this.task?.status ?? "UNKNOWN";
    const identity = `the call that triggered this refusal is tool=${toolName} `
      + `operation=${operation} toolCallId=${toolCallId ?? "<none>"}`;
    const notEvaluated = "it was NOT evaluated and no policy rule refused it";

    let tail: string;
    const original = this.task?.failureReason;
    if (original !== undefined && original !== "") {
      tail = `the task's ORIGINAL failure, recorded when the task terminated and unchanged since, is: ${original}`;
    } else if (status === "COMPLETED") {
      tail = "the turn completed successfully - report your results and stop; a new user message begins a new task";
    } else if (status === "ESCALATED") {
      tail = "the task escalated and awaits operator handling";
    } else {
      tail = "the task terminated WITHOUT recording a failureReason, so there is no original failure to replay";
    }

    return `Task is ${status}; no further tool calls are accepted; ${identity}; ${notEvaluated}; ${tail}`;
  }

  /**
   * Policy evaluation only. This is called from Pi's `tool_call` preflight hook,
   * which may fire several times *before* any tool actually executes.
   *
   * It therefore must not create a plan, must not bind a step, and must not
   * move the task through the lifecycle. It is intentionally side-effect free
   * with respect to task state.
   */
  async precheckToolCall(
    toolName: string,
    operation: string,
    input: unknown,
    approval?: ApprovalProvider,
    toolCallId?: string,
  ): Promise<ToolCallDecision> {
    if (!this.task) throw new Error("No active task");
    const ownerTaskId = this.task.taskId;
    // Unknown tools are rejected here, before Pi executes anything.
    const tool = this.tools.get(toolName);
    // F-006 §2.3: take the program name while the call's input still exists —
    // `tool_call` is the only event that carries it. Written only when a name
    // was actually read, so a repeated preflight cannot erase a good name.
    //
    // This does not contradict "side-effect free with respect to task state"
    // above: nothing here moves the task, and a per-call note keyed by
    // toolCallId is bookkeeping, not lifecycle. The same is true of the output
    // references the extension declares from this very event.
    if (toolCallId !== undefined) {
      const name = commandNameFrom(input);
      if (name !== undefined) this.toolCommandNames.set(toolCallId, name);
    }
    // A task that policy has aborted, or that has already finished, may not
    // admit another call. This is what makes `on_violation: abort` stick: the
    // model can keep asking, and every request is refused.
    if (REFUSED_EXECUTION_STATES.includes(this.task.status)) {
      // Nothing was evaluated and no rule was broken: the task was already in a
      // state that admits no execution. This is a lifecycle refusal, recorded as
      // `refusal`, never as a policy `violation`.
      this.terminalRefusalCount += 1;
      const reason = this.describeTerminalRefusal(toolName, operation, toolCallId);

      const decision: PolicyDecision = {
        decision: "DENY",
        reason,
        refusal: "task_terminal",
      };
      if (toolCallId) {
        this.deniedToolCallIds.add(toolCallId);
        this.knownToolCallIds.add(toolCallId);
      }
      await this.events.emit(event("LIFECYCLE_REFUSED", this.task.taskId, {
        tool: toolName,
        operation,
        toolCallId,
        reason: decision.reason,
        refusal: decision.refusal,
        taskStatus: this.task.status,
        // The structured form of the same three facts the reason states in prose.
        // A trace consumer must not have to parse a sentence to learn which call
        // was refused, that it was never evaluated, and what the task's ORIGINAL
        // failure was — the three things whose absence caused the echo.
        evaluated: false,
        originalFailureReason: this.task.failureReason ?? null,
        replayed: this.task.failureReason !== undefined && this.task.failureReason !== "",
      }));
      return { decision, task: this.task };
    }
    // The INSTALLED policy is the policy that evaluates every call. An approval
    // provider resolves a REQUIRE_APPROVAL; it never becomes the policy. In
    // TRUSTED_PROJECT mode it is ignored outright, so no caller can escalate a
    // hard denial by passing an always-approving provider.
    //
    // This is what makes the declarative controls survive APPROVAL mode. When a
    // provider was supplied by substituting a bare tier policy here, every
    // configured rule — the workspace boundary, the destructive-command and
    // deletion guards, the secret-write guard, the tool name lists and the
    // configured limits — was discarded, and an interactive operator who
    // answered "yes" then granted the call the policy had denied.
    const trusted = this.policy.mode === "TRUSTED_PROJECT";
    const request = { taskId: this.task.taskId, tool, operation, input };
    // Evaluated EXACTLY ONCE, by the installed policy. A second evaluation
    // would consume a second unit of a metered budget for a single call, so
    // resolution of a REQUIRE_APPROVAL is done against the decision this
    // already produced rather than by asking the policy again.
    const required = this.policy.evaluate(request);
    let decision: PolicyDecision = required;

    if (required.decision === "REQUIRE_APPROVAL") {
      // Traced before it is resolved, so the prompt is visible in the trace
      // even when it is granted.
      await this.events.emit(event("APPROVAL_REQUIRED", this.task.taskId, { tool: toolName, toolCallId }));
      if (!trusted && approval) {
        // The one and only thing a provider may do. It is reachable only for a
        // decision the policy left open, so it can neither override a denial
        // nor widen a rule the policy already applied.
        const approved = await approval.requestApproval(request);
        decision = approved ? { decision: "ALLOW" } : { decision: "DENY", reason: "Approval denied" };
      }
    }

    // Task identity is re-checked HERE, immediately before the first task-owned
    // mutation and before the decision is returned, and it covers EVERY path
    // that can yield between entry and that point — above all the approval
    // prompt, which is awaited whenever an approval provider is supplied and
    // the operator takes arbitrarily long to answer it. A handler that resumes
    // against a task it does not own must record nothing on the task that
    // replaced it — not an id in `knownToolCallIds` or `deniedToolCallIds`, not
    // a `denialCount` — and must not hand the caller a verdict produced for the
    // superseded task. It is refused on lifecycle grounds instead, which is a
    // different thing from policy having denied the call, so it carries
    // `refusal` and never `violation`.
    if (this.isStale(ownerTaskId)) {
      this.refuseStale(
        ownerTaskId,
        "KernelAdapter.precheckToolCall",
        "A newer task replaced this one while the policy decision was resolved",
      );
      const stale: PolicyDecision = {
        decision: "DENY",
        reason: "This tool call belongs to a task that has been superseded",
        refusal: "stale_task",
      };
      return { decision: stale, task: this.task };
    }

    // Attempt versus execution.
    //
    // Every evaluated call is an ATTEMPT and is recorded as one, whatever the
    // outcome. An EXECUTION binds only on ALLOW. A DENY, and equally a
    // REQUIRE_APPROVAL that was never resolved because no approval provider was
    // available, both mean "not authorised" — and an unauthorised call must
    // never acquire an execution identity.
    //
    // Pi's `tool_call` hook already blocks anything that is not ALLOW, so the
    // production path was safe. Relying on the caller was still a latent hole:
    // any embedder that evaluated a call and then ignored the decision would
    // have executed an unapproved write. The kernel is now independently safe.
    if (decision.decision !== "ALLOW" && toolCallId) {
      // Remember the refusal so a later execution_start for this id is ignored
      // rather than turned into a fake successful execution.
      this.deniedToolCallIds.add(toolCallId);
      this.knownToolCallIds.add(toolCallId);
    }
    if (decision.decision === "DENY") {
      // A real policy denial. Counted separately from terminal refusals, which
      // never reach this branch because no policy is evaluated for them.
      this.denialCount += 1;
      // D5 / §2.4(b): a refusal that is not a violation is recorded per call so
      // the distinction survives to the result, where the decision object no
      // longer exists. Cleared with `deniedToolCallIds`.
      if (decision.refusal !== undefined && toolCallId !== undefined) this.pendingRefusals.set(toolCallId, decision.refusal);
      await this.events.emit(event("APPROVAL_DENIED", this.task.taskId, {
        tool: toolName,
        toolCallId,
        reason: decision.reason,
        violation: decision.violation,
        // Carried explicitly: a scope refusal is auditable as itself rather
        // than only as a string that happens to contain the word "refused".
        refusal: decision.refusal,
      }));
      if (decision.violation === "abort") await this.abortTask(decision.reason, toolName, toolCallId);
    }

    // Budget telemetry (F-008). Everything above has already decided this call;
    // nothing here may change that. There is no `advance`, no counter, and no
    // branch on the result — the only effects are two advisory trace events, so
    // a task that is running low is told while it can still act on it, instead
    // of learning about the limit only when the next call is denied.
    //
    // It runs AFTER the stale guard above, so a superseded handler can neither
    // read nor write the newer task's budget state. The installed policy is now
    // always the engine that evaluated the call, so this telemetry is wired on
    // the approval path as well as the no-provider one.
    if (decision.decision === "ALLOW") {
      // The attempt's identity, recorded here because this is the only point
      // where the tool, operation and input that define it are all in hand.
      //
      // It runs AFTER the stale guard above, for the same reason the budget
      // telemetry below does: a handler superseded mid-decision must not write
      // the newer task's recovery state. An EXECUTION binds only on ALLOW, so
      // this is recorded on the same condition — a refused call never ran, and
      // a call that never ran has no identity to repeat.
      this.lastAttemptSignature = callSignature(request);
      const budget = this.policy.toolBudget?.(request);
      if (budget) {
        this.lastBudget = budget;
        if (budget.level !== "ok" && !this.budgetWarned.has(budget.level)) {
          this.budgetWarned.add(budget.level);
          await this.events.emit(event("BUDGET_LOW", this.task.taskId, {
            tool: toolName,
            level: budget.level,
            used: budget.used,
            limit: budget.limit,
            remaining: budget.remaining,
          }));
        }
        if (budget.repeatCount > 1) {
          await this.events.emit(event("TOOL_CALL_REPEATED", this.task.taskId, {
            tool: toolName,
            toolCallId,
            repeatCount: budget.repeatCount,
          }));
        }
      }
    }
    return { decision, task: this.task };
  }

  /**
   * Terminate the task because policy said `on_violation: abort`.
   *
   * This is the ONE case where policy evaluation is allowed to move the task
   * lifecycle, and it is what the legacy engine's `on_violation: abort` did:
   * the violation ends the run rather than letting the agent try something else.
   * The trace records the rule, the tool, and the reason, so the termination is
   * visible after the fact and not just as a vanished task.
   */
  async abortTask(reason: string, tool?: string, toolCallId?: string): Promise<Task | undefined> {
    if (!this.task) return undefined;
    const taskId = this.task.taskId;
    const policyViolation = { reason, tool, toolCallId, onViolation: "abort" };

    // Already terminal: a second violation must not throw an illegal transition.
    if (REFUSED_EXECUTION_STATES.includes(this.task.status)) {
      await this.events.emit(event("POLICY_VIOLATION", taskId, { ...policyViolation, alreadyTerminal: true, taskStatus: this.task.status }));
      return this.task;
    }

    await this.events.emit(event("POLICY_VIOLATION", taskId, policyViolation));
    // The violation event yields. If a newer turn replaced this task, the abort
    // belongs to a task that no longer exists and must not terminate the new one.
    if (this.isStale(taskId)) {
      this.refuseStale(taskId, "KernelAdapter.abortTask", "A newer task replaced this one before the abort was applied");
      return this.task;
    }
    this.advance("FAILED", "Policy abort", { now: new Date().toISOString(), failureReason: reason, expectTaskId: taskId });
    // Nothing in flight can be trusted to finish correctly after an abort.
    this.activeExecutions.clear();
    this.attemptBlocked = true;
    await this.events.emit(event("POLICY_ABORTED", taskId, { reason, tool, toolCallId }));
    await this.events.emit(event("TASK_FAILED", taskId, { reason: `Policy abort: ${reason}` }));
    return this.task;
  }

  // ---------------------------------------------------------------------------
  // EXECUTION START  (Pi `tool_execution_start` — the real execution)
  // ---------------------------------------------------------------------------

  /**
   * Bind a real tool execution to the task. This is the only place that creates
   * a plan/step and advances the lifecycle:
   *
   *   PLANNING -> PLAN_VALIDATION -> EXECUTING
   *
   * Correlated by Pi's toolCallId. Duplicate starts, preflight-denied calls and
   * unauthorised task states are ignored rather than corrupting state.
   */
  async beginToolExecution(toolCallId: string, toolName: string, inputMetadata?: Record<string, unknown>): Promise<BoundExecution | undefined> {
    if (!this.task) throw new Error("No active task");
    const taskId = this.task.taskId;

    if (this.deniedToolCallIds.has(toolCallId)) {
      // Tripwire, not a live gate. Pi emits tool_execution_start BEFORE the
      // tool_call preflight, so at bind time the id is not yet recorded as
      // denied and this guard stays SILENT on the production path — which is
      // what lets a policy denial still deliver its reason to recovery and
      // terminate instead of being replanned to death.
      //
      // It fires only when a caller prechecks first (see BRIDGE.B in
      // f006-denial-certificate-shape.test.ts, the order Pi does not emit). If
      // Pi's emission order ever changes to preflight-before-start, this fires,
      // binding stops, and every policy denial silently reverts to a generic
      // tool error. BRIDGE.C pins that the guard is currently dormant.
      await this.events.emit(event("TOOL_EXECUTION_IGNORED", taskId, { toolCallId, tool: toolName, reason: "policy_denied" }));
      return undefined;
    }

    if (this.knownToolCallIds.has(toolCallId) || this.activeExecutions.has(toolCallId)) {
      await this.events.emit(event("TOOL_EXECUTION_IGNORED", taskId, { toolCallId, tool: toolName, reason: "duplicate_execution_start" }));
      return undefined;
    }

    if (REFUSED_EXECUTION_STATES.includes(this.task.status)) {
      await this.events.emit(event("TOOL_EXECUTION_IGNORED", taskId, {
        toolCallId,
        tool: toolName,
        reason: "task_state_not_authorised",
        taskStatus: this.task.status,
      }));
      return undefined;
    }

    const tool = this.tools.get(toolName);

    // Pi's default tool execution mode is "parallel": several tool_execution_start
    // events are emitted before any of them finishes. Siblings join the EXECUTING
    // phase instead of re-entering PLANNING.
    const joiningSibling = this.task.status === "EXECUTING" && this.activeExecutions.size > 0;

    if (!joiningSibling) {
      if (this.task.status === "VALIDATING") {
        // A completed validation is the real planning boundary for the next tool.
        if (this.lastValidation?.status !== "VALID") {
          await this.events.emit(event("TOOL_EXECUTION_IGNORED", taskId, {
            toolCallId,
            tool: toolName,
            reason: "last_validation_not_valid",
            taskStatus: this.task.status,
          }));
          return undefined;
        }
        this.advance("PLANNING", "A completed VALID validation opens the next planning turn", { expectTaskId: taskId });
      }
      if (this.task.status !== "PLANNING") {
        await this.events.emit(event("TOOL_EXECUTION_IGNORED", taskId, {
          toolCallId,
          tool: toolName,
          reason: "task_state_not_authorised",
          taskStatus: this.task.status,
        }));
        return undefined;
      }

      const { plan, step } = this.buildPlanStep(toolName, tool);
      // A new execution round starts here; previous-round failures have already
      // been handed to recovery and must not block this round's completion.
      this.attemptBlocked = false;
      this.plan = plan;
      this.task = {
        ...this.task,
        currentPlan: plan,
        currentStep: step.stepId,
        selectedTools: [toolName],
        selectedSkills: plan.selectedSkills,
      };
      this.advance("PLAN_VALIDATION", "Plan step built for the requested tool", { expectTaskId: taskId });
      validatePlan(plan, this.skillList, this.tools.list());
      await this.events.emit(event("PLAN_VALIDATED", taskId, { planId: plan.planId, toolCallId }));
      for (const skill of plan.selectedSkills) await this.events.emit(event("SKILL_SELECTED", taskId, { skill }));
      await this.events.emit(event("TOOL_SELECTED", taskId, { tool: toolName, toolCallId, inputMetadata }));
      this.advance("EXECUTING", "Plan validated; tool execution begins", { expectTaskId: taskId });
    }

    // The plan/validation events above yield. If a newer turn replaced this task
    // while they were being traced, binding the execution here would attach it to
    // a task that never asked for it.
    if (this.isStale(taskId)) {
      this.refuseStale(taskId, "KernelAdapter.beginToolExecution", "A newer task replaced this one before the execution was bound");
      return undefined;
    }

    const bound: BoundExecution = {
      toolCallId,
      executionId: toolCallId,
      planId: this.plan?.planId ?? "",
      stepId: joiningSibling ? `pi-${randomUUID().slice(0, 8)}` : this.task.currentStep!,
      tool: toolName,
      startedAt: new Date().toISOString(),
    };

    this.knownToolCallIds.add(toolCallId);
    this.activeExecutions.set(toolCallId, bound);
    this.toolExecutionCount += 1;
    await this.events.emit(event("TOOL_EXECUTION_STARTED", taskId, { toolCallId, tool: toolName, stepId: bound.stepId, joiningSibling }));
    return bound;
  }

  private buildPlanStep(toolName: string, tool: ToolDescriptor): { plan: Plan; step: PlanStep } {
    const task = this.task!;
    const step: PlanStep = {
      stepId: `pi-${randomUUID().slice(0, 8)}`,
      description: `Execute Pi tool ${toolName}`,
      tools: [toolName],
      dependencies: [],
      expectedOutput: "Pi tool result",
      validationCriteria: ["Tool execution completed and returned a result"],
      retryPolicy: tool.retryPolicy,
      timeoutMs: tool.timeoutMs,
      status: "PENDING",
    };
    const plan: Plan = {
      planId: randomUUID(),
      objective: task.objective,
      assumptions: ["Pi selected the requested tool"],
      steps: [step],
      selectedSkills: this.skillList.filter((skill) => skill.requiredTools.includes(toolName)).map((skill) => skill.name),
      selectedTools: [toolName],
      expectedOutputs: [step.expectedOutput],
      validationCriteria: [step.validationCriteria[0]],
      riskLevel: tool.riskLevel,
    };
    return { plan, step };
  }

  // ---------------------------------------------------------------------------
  // EXECUTION END  (Pi `tool_execution_end` — observation and validation)
  // ---------------------------------------------------------------------------

  async observeToolResult(result: ToolResult, error?: unknown, options?: { violation?: "block" | "abort" }): Promise<ValidationResult> {
    if (!this.task) throw new Error("No active tool step");
    const taskId = this.task.taskId;
    const executionId = result.execution.executionId;

    // Pi can emit duplicate tool_execution_end events.
    if (this.observedExecutionIds.has(executionId)) {
      await this.events.emit(event("TOOL_RESULT_IGNORED", this.task.taskId, { executionId, reason: "duplicate_execution_result" }));
      return { status: "INCONCLUSIVE", validator: "pi-result-dedup", message: "Duplicate tool result ignored" };
    }

    const bound = this.resolveBoundExecution(executionId, result.execution.stepId);

    // Only a real active execution may advance the lifecycle. This also rejects
    // late/out-of-order results, so we never attempt VALIDATING -> OBSERVING or
    // RECOVERING -> OBSERVING.
    if (!bound || result.execution.taskId !== this.task.taskId || this.task.status !== "EXECUTING") {
      await this.events.emit(event("TOOL_RESULT_IGNORED", this.task.taskId, {
        executionId,
        reason: bound ? "stale_or_out_of_order_result" : "no_active_execution",
        taskStatus: this.task.status,
        boundStep: bound?.stepId,
        resultTaskId: result.execution.taskId,
        resultStep: result.execution.stepId,
      }));
      return { status: "INCONCLUSIVE", validator: "pi-result-order", message: "Late or out-of-order tool result ignored" };
    }

    // Stale step identity: the result must belong to the execution it claims.
    if (result.execution.stepId !== bound.stepId) {
      await this.events.emit(event("TOOL_RESULT_IGNORED", this.task.taskId, {
        executionId,
        reason: "stale_step_id",
        boundStep: bound.stepId,
        resultStep: result.execution.stepId,
      }));
      return { status: "INCONCLUSIVE", validator: "pi-result-order", message: "Stale step id ignored" };
    }

    this.observedExecutionIds.add(executionId);
    this.activeExecutions.delete(executionId);

    await this.events.emit(event(result.success ? "TOOL_COMPLETED" : "TOOL_FAILED", this.task.taskId, {
      executionId,
      stepId: bound.stepId,
      tool: result.execution.tool,
      error: describeError(error),
      // Provenance is a fact about the execution, not a diagnostic decoration.
      // It used to stop at the `ToolResult` object and was lost the moment the
      // call returned, so nothing downstream could attribute a result to the
      // call that produced it. It travels on the event the trace already
      // persists, which is the only path it needs.
      provenance: result.provenance,
    }));

    // The completion event yields. A newer turn may have started meanwhile; this
    // result belongs to the task that bound it, not to whatever is current now.
    if (this.isStale(taskId)) {
      this.refuseStale(taskId, "KernelAdapter.observeToolResult", "A newer task replaced this one before the result was observed");
      return { status: "INCONCLUSIVE", validator: "stale-task-generation", message: "Result ignored: it belongs to a superseded task" };
    }

    // Verification is not "the tool returned success". When a call declared
    // outputs, those outputs must actually exist, be readable, be non-empty and
    // sit inside the workspace. A tool that reports success without producing
    // its declared artifact is INVALID.
    const invalidArtifacts = result.artifacts.filter((artifact) => artifact.trust === "INVALID");
    const unverifiedArtifacts = result.artifacts.filter((artifact) => artifact.trust === "UNVERIFIED");

    let validation: ValidationResult;
    if (!result.success) {
      validation = { status: "INVALID", validator: "pi-result", message: redactString(error instanceof Error ? error.message : "Tool failed") };
    } else if (invalidArtifacts.length > 0) {
      validation = {
        status: "INVALID",
        validator: "artifact-verification",
        message: `Tool reported success but ${invalidArtifacts.length} declared artifact(s) failed verification: ${invalidArtifacts.map((a) => `${a.reference} (${a.verification?.reason})`).join("; ")}`,
      };
      await this.events.emit(event("VALIDATION_FAILED", this.task.taskId, { reason: "declared_artifact_invalid", artifacts: invalidArtifacts.map((a) => a.reference) }));
    } else if (unverifiedArtifacts.length > 0) {
      validation = {
        status: "INCONCLUSIVE",
        validator: "artifact-verification",
        message: `Declared artifact(s) could not be verified: ${unverifiedArtifacts.map((a) => `${a.reference} (${a.verification?.reason})`).join("; ")}`,
      };
    } else if (result.artifacts.length > 0) {
      validation = {
        status: "VALID",
        validator: "artifact-verification",
        message: `${result.artifacts.length} declared artifact(s) verified on disk`,
      };
    } else {
      validation = { status: "VALID", validator: "pi-result", message: "Pi returned a successful tool result" };
    }

    if (validation.status === "INVALID" || validation.status === "INCONCLUSIVE") {
      this.attemptBlocked = true;
    }

    // Sibling executions from the same assistant message are still in flight;
    // the task stays EXECUTING until the last one settles.
    if (this.activeExecutions.size > 0) {
      this.task = {
        ...this.task,
        observations: [...this.task.observations, result.success ? "Tool completed" : "Tool failed"],
        validationResults: [...this.task.validationResults, validation],
      };
      return validation;
    }

    // Last execution: observe, then validate.
    this.advance("OBSERVING", "Last execution settled", { expectTaskId: taskId });
    this.task = { ...this.task, observations: [...this.task.observations, result.success ? "Tool completed" : "Tool failed"] };
    this.advance("VALIDATING", "Observing the settled execution", { expectTaskId: taskId });
    this.lastValidation = validation;
    this.task = { ...this.task, validationResults: [...this.task.validationResults, validation] };
    await this.events.emit(event(validation.status === "VALID" ? "VALIDATION_COMPLETED" : "VALIDATION_FAILED", this.task.taskId, validation as unknown as Record<string, unknown>));

    if (validation.status !== "VALID") {
      this.advance("RECOVERING", "Last validation was not VALID", { expectTaskId: taskId });
      const tool = this.tools.get(result.execution.tool);
      const failure = classifyFailure(error);
      // D1: the policy's own words, read off the error that already carries
      // them, so the terminal certificate can name WHICH rule refused the call
      // instead of a generic sentence. Spread into describeTerminalRecovery.
      const denialReason = error instanceof CoreError && error.category === "POLICY_DENIED" ? error.message : undefined;
      // C4: NOVELTY IS COMPUTED BEFORE ANY BUDGET IS BOOKED. Which ledger a
      // REPLAN charges is knowable only from this comparison, so the comparison
      // has to exist before `chooseRecoveryDetailed` is called, not after.
      //
      // `undefined` means REPEAT, deliberately. A signature is absent when the
      // attempt was never prechecked (the direct `beginToolExecution` path the
      // kernel's own tests and any embedder that binds an execution itself use).
      // There is nothing to compare in that case, and guessing "novel" would
      // charge a strategy change for a call whose identity was never recorded.
      // Unknown identity is treated as the legacy path, which is the
      // conservative direction: it can only preserve today's behaviour.
      const attemptSignature = this.lastAttemptSignature;
      const priorFailure = this.lastFailureSignature;
      const attemptMatchesLastFailure = attemptSignature === undefined
        || priorFailure === undefined
        || attemptSignature === priorFailure;
      // The anchor moves only on a classified FAILURE, and to the signature of
      // the attempt that just failed, never to the one before it.
      if (attemptSignature !== undefined) this.lastFailureSignature = attemptSignature;
      const recoveryOptions = {
        failure,
        limits: this.limits,
        retryCount: this.task.retryCount,
        replanCount: this.task.replanCount,
        strategyCount: this.task.strategyCount ?? 0,
        depth: this.recoveryDepth,
        idempotency: tool.idempotency,
        attemptMatchesLastFailure,
        elapsedMs: this.elapsedMs(),
        denialReason,
        // D5: the violation the policy put on the decision that produced this
        // result. Without it recovery cannot tell a survivable refusal from a
        // terminating one and terminates on both.
        violation: options?.violation,
      };
      const decision = chooseRecoveryDetailed(recoveryOptions);
      const strategy = decision.strategy;
      this.recoveryDepth += 1;
      await this.events.emit(event("RECOVERY_STARTED", this.task.taskId, {
        strategy,
        reason: decision.reason,
        failure,
        retryCount: recoveryOptions.retryCount,
        replanCount: recoveryOptions.replanCount,
        strategyCount: recoveryOptions.strategyCount,
        attemptMatchesLastFailure: recoveryOptions.attemptMatchesLastFailure,
        recoveryDepth: this.recoveryDepth,
      }));

      switch (strategy) {
        case "RETRY":
          this.task = { ...this.task, retryCount: this.task.retryCount + 1 };
          this.advance("RETRYING", `Recovery strategy RETRY (depth ${this.recoveryDepth})`, { expectTaskId: taskId });
          this.advance("PLANNING", "Retry re-enters planning", { expectTaskId: taskId });
          break;
        case "REPLAN":
          // C4: the budget follows the MOVE, not the failed attempt's character.
          // A REPLAN that changed strategy is a different move from one that
          // repeats the same approach, so it is charged to the strategy fund
          // rather than to the replan budget. An identical attempt keeps the
          // pre-existing charge, which is the distinction C1 preserves and
          // pins.
          if (attemptMatchesLastFailure) {
            this.task = { ...this.task, replanCount: this.task.replanCount + 1 };
          } else {
            this.task = { ...this.task, strategyCount: (this.task.strategyCount ?? 0) + 1 };
          }
          this.advance("REPLANNING", `Recovery strategy REPLAN (depth ${this.recoveryDepth})`, { expectTaskId: taskId });
          this.advance("PLANNING", "Replan re-enters planning", { expectTaskId: taskId });
          break;
        case "ESCALATE":
          this.advance("ESCALATED", "Recovery strategy ESCALATE", { expectTaskId: taskId });
          break;
        case "CONTINUE":
          // D5: a refusal the operator configured as survivable. The task is
          // still alive and still able to act, which is the whole point of
          // `onViolation: block` -- the call was refused, and the agent gets to
          // try something else instead of the run ending.
          //
          // It books NO budget. A refused call that charged retry or replan
          // could exhaust the budget purely by being refused, which is the
          // benign-exit failure in ledger §2.3 wearing a different hat. The
          // recovery depth still resets below, because the task did make
          // progress: it learned the answer.
          this.advance("PLANNING", `Recovery strategy CONTINUE (${decision.reason})`, { expectTaskId: taskId });
          // `denialReason` is carried here because this is the ONLY event a
          // survivable refusal produces. The terminal certificate that used to
          // name WHICH rule refused the call is gone with the termination, and
          // without the reason on this event the reversal would leave the
          // operator with a refusal that is visible but not attributable — the
          // outcome the certificate existed to prevent.
          await this.events.emit(event("SOFT_REFUSAL_CONTINUED", this.task.taskId, {
            strategy,
            reason: decision.reason,
            failure,
            denialReason,
            recoveryDepth: this.recoveryDepth,
          }));
          break;
        case "TERMINATE":
        default: {
          const terminalReason = describeTerminalRecovery(decision, { ...recoveryOptions, depth: this.recoveryDepth });
          this.advance("FAILED", `Recovery strategy TERMINATE (${decision.reason})`, {
            failureReason: terminalReason,
            expectTaskId: taskId,
          });
          await this.events.emit(event("TASK_FAILED", this.task.taskId, {
            reason: terminalReason,
            reasonCode: decision.reason,
            strategy,
            failure,
            retryCount: recoveryOptions.retryCount,
            replanCount: recoveryOptions.replanCount,
            recoveryDepth: this.recoveryDepth,
          }));
          break;
        }
      }
    } else {
      this.recoveryDepth = 0;
      this.lastAttemptSignature = undefined;
      this.lastFailureSignature = undefined;
    }

    return validation;
  }

  /**
   * Convenience entry point for the Pi adapter: builds a normalized result from
   * the *bound* execution identity so task/step correlation cannot drift.
   *
   * Declared outputs are verified against the filesystem before the result is
   * accepted. A tool that reports success without actually producing its
   * declared artifact is INVALID, not VALID.
   */
  /**
   * `errorRetryable` is the caller's real answer to "would running this same
   * call again plausibly succeed?". It is OPTIONAL and defaults to false, so
   * every existing caller keeps byte-identical behaviour.
   *
   * F-006 Phase 2a: the flag used to be the literal `false`, which made
   * `classifyFailure` return TOOL_FAILURE for every tool error and left the
   * TRANSIENT retry path unreachable from a real error. The kernel now
   * propagates the value it is given instead of asserting one. See
   * `.pi/extensions/platform-orchestrator.ts` for why the bridge does not yet
   * supply it: Pi's `tool_execution_end` carries a boolean `isError` and
   * nothing else, and inventing a contract for it is not this layer's call.
   *
   * D1. `denialReason` carries the one piece of information a boolean cannot:
   * WHY the call was refused, in the policy's own words. It is optional and
   * additive, exactly like `errorRetryable` beside it, and when it is absent
   * the behaviour is byte-identical to before — so an ordinary tool failure is
   * unaffected.
   *
   * It is a PARAMETER rather than state recovered from `precheckToolCall` on
   * purpose. A preflight denial binds no execution, and `observeToolResult`
   * discards a result whose execution is unbound, so a locally-denied call
   * never reaches recovery: a marker keyed on the precheck would be written and
   * never read. The refusal that matters reaches this method on a call whose
   * execution Pi had already begun, and the reason has to arrive with it.
   *
   * EXTERNAL-WIRING, closed 2026-09-30 by measurement. A caller now exists:
   * `.pi/extensions/platform-orchestrator.ts` forwards `reason` as this
   * method's sixth positional argument, read back out of a per-taskId map at
   * `tool_execution_end`. The delivery works: Pi emits tool_execution_start
   * before the preflight, so the refused id has already bound by the time the
   * result is reported, and a policy denial terminates on the denial rather
   * than being replanned until the budget dies.
   *
   * `denialReason` reaches this method only when a binding exists, the task is
   * EXECUTING, and the settling execution is the last one (`observeToolResult`
   * returns early at :1192 while a sibling is in flight). Pinned, with the
   * emission order each precondition needs, in
   * `platform/pi/f006-denial-certificate-shape.test.ts`.
   */
  async recordToolResult(
    toolCallId: string,
    toolName: string,
    payload: unknown,
    isError: boolean,
    errorRetryable?: boolean,
    denialReason?: string,
    /**
     * D5, seventh parameter: the `onViolation` the policy carried on the
     * decision that refused this call. It is threaded to recovery so a refusal
     * configured as survivable is not turned into a dead task.
     *
     * Optional and fail-closed: absent means recovery terminates exactly as it
     * did before the threading, so every existing call site keeps its current
     * behaviour until it supplies the field deliberately.
     */
    violation?: "block" | "abort",
  ): Promise<ValidationResult> {
    if (!this.task) throw new Error("No active task");
    const bound = this.activeExecutions.get(toolCallId);
    const now = new Date().toISOString();
    const taskId = this.task.taskId;
    const stepId = bound?.stepId ?? this.task.currentStep ?? "unknown";
    const tool = this.tools.get(toolName);

    // F-006 §2.3: read the program name now and let it go. The deletion is
    // unconditional and happens BEFORE every early return below, so a name can
    // never outlive its call — including the stale-task and unbound-result
    // returns, which is the same discipline the denial reason follows.
    const commandName = this.toolCommandNames.get(toolCallId);
    this.toolCommandNames.delete(toolCallId);
    // Read only for a call that actually failed. A successful call's result is
    // not an exit status, and a zero is not a non-zero exit.
    const exitStatus = isError ? exitStatusFrom(payload) : undefined;

    // `=== true`, never truthiness: an absent, undefined or non-boolean value
    // must produce the same classification the hard-coded false always did.
    const retryable = isError && errorRetryable === true;
    // D1: a policy refusal arrives with the reason the policy actually gave.
    // No marker is consulted, because none is reachable: the reason is only
    // meaningful on the result, and `observeToolResult` discards any result
    // whose execution is unbound. Which results those are depends on Pi's
    // emission order — start-before-preflight binds first, so a refusal that
    // arrives afterwards DOES bind and does reach recovery. The reason has to
    // travel with the result, from whichever layer observed the refusal.
    // See f006-denial-certificate-shape.test.ts for the measured order.
    const denied = isError && denialReason !== undefined;
    const actualDenialReason = denialReason;
    const declared = this.declaredOutputs.get(toolCallId) ?? [];
    const candidates: Artifact[] = declared.map((reference) =>
      createArtifact({
        reference,
        descriptor: tool,
        taskId,
        stepId,
        executionId: toolCallId,
        origin: "TOOL_DECLARED",
      }),
    );

    const report = candidates.length > 0
      ? await verifyArtifacts(candidates, this.boundary ? { boundary: this.boundary } : {})
      : { artifacts: [], invalid: [], unverified: [], allVerified: false };

    // Artifact verification touches the filesystem and yields. A newer turn may
    // have started meanwhile; this result belongs to the task that bound it.
    if (this.isStale(taskId)) {
      this.refuseStale(taskId, "KernelAdapter.recordToolResult", "A newer task replaced this one during artifact verification");
      return { status: "INCONCLUSIVE", validator: "stale-task-generation", message: "Result ignored: it belongs to a superseded task" };
    }

    if (report.artifacts.length > 0) {
      this.artifactList = [...this.artifactList, ...report.artifacts];
      for (const artifact of report.artifacts) {
        await this.events.emit(event(artifact.trust === "INVALID" ? "ARTIFACT_INVALID" : "ARTIFACT_VERIFIED", taskId, {
          artifactId: artifact.artifactId,
          reference: artifact.reference,
          kind: artifact.type,
          producer: artifact.producer,
          taskId: artifact.taskId,
          stepId: artifact.stepId,
          status: artifact.verification?.status,
          reason: artifact.verification?.reason,
          sizeBytes: artifact.verification?.sizeBytes,
          // A content digest, not a credential. It is emitted so a claim can be
          // re-checked later; the redactor deliberately leaves digests intact.
          sha256: artifact.verification?.sha256,
        }));
      }
    }

    const result: ToolResult = {
      success: !isError,
      data: isError ? undefined : payload,
      metadata: { toolCallId },
      artifacts: report.artifacts,
      warnings: report.unverified.map((artifact) => `Artifact could not be verified: ${artifact.reference} (${artifact.verification?.reason})`),
      error: isError ? { category: "TOOL_ERROR", message: "Pi reported a tool error", retryable } : undefined,
      provenance: this.provenanceFor(toolName, toolCallId, stepId, declared),
      execution: {
        executionId: toolCallId,
        taskId,
        stepId,
        tool: toolName,
        startedAt: bound?.startedAt ?? now,
        endedAt: now,
        status: isError ? "FAILED" : "COMPLETED",
        retryNumber: 0,
      },
    };

    this.task = { ...this.task, artifacts: [...this.task.artifacts, ...report.artifacts] };
    // F-006: pass the real CoreError so recovery sees the tool error's category
    // and retryable flag. A plain Error collapsed to UNKNOWN and discarded both.
    // F-006 Phase 2a: the flag is the caller's, not a hard-coded `false`.
    // D1: a policy refusal is NOT a tool error. It is rebuilt as its own
    // category carrying the policy's own words, so recovery terminates on it
    // instead of replanning the very block that was denied. Every other failure
    // keeps the unchanged TOOL_ERROR construction below.
    return this.observeToolResult(
      result,
      isError
        ? denied
          ? new CoreError("POLICY_DENIED", actualDenialReason!, { retryable: false, taskId, stepId, executionId: toolCallId })
          : new CoreError("TOOL_ERROR", `Tool ${toolName} failed`, { retryable, taskId, stepId, executionId: toolCallId, exitStatus, commandName })
        : undefined,
      { violation },
    );
  }

  /**
   * Provenance for an execution: what ran, and which references it touched.
   *
   * Only facts are recorded. A reference is listed as an output locator only
   * when the tool was actually declared to write it, so a read path is never
   * presented as a produced artifact.
   */
  private provenanceFor(toolName: string, toolCallId: string, stepId: string, declared: string[]): ToolResult["provenance"] {
    const produced = this.tools.get(toolName).sideEffect === "SIDE_EFFECTING";
    return [{
      source: toolName,
      // Provenance strings can carry connection strings or credentials echoed
      // back by a tool, so they cross the same boundary as everything else.
      locator: declared.length > 0 ? redactString(declared.join(", ")) : undefined,
      executionId: toolCallId,
      artifactIds: produced ? this.artifactList.filter((a) => a.stepId === stepId).map((a) => a.artifactId) : [],
      evidence: declared.length > 0
        ? `${declared.length} declared output reference(s) verified against the filesystem`
        : "no output references declared for this call",
    }];
  }

  /**
   * Resolve which execution a result belongs to.
   *
   * Normal path: a real execution bound at tool_execution_start.
   * Fallback: a direct kernel caller (unit tests / non-Pi embedding) that drove
   * the legacy planToolCall path, where the sole EXECUTING step is the target.
   */
  private resolveBoundExecution(executionId: string, stepId: string): BoundExecution | undefined {
    const bound = this.activeExecutions.get(executionId);
    if (bound) return bound;
    if (this.activeExecutions.size === 0 && this.task?.status === "EXECUTING" && this.task.currentStep === stepId) {
      return {
        toolCallId: executionId,
        executionId,
        planId: this.plan?.planId ?? "",
        stepId,
        tool: this.plan?.selectedTools[0] ?? "unknown",
        startedAt: new Date().toISOString(),
      };
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // LEGACY DIRECT-KERNEL ENTRY POINTS
  // ---------------------------------------------------------------------------

  /**
   * Plan a tool call without an execution identity. Retained for direct kernel
   * embeddings and existing tests; the Pi adapter uses the precheck/execution
   * lifecycle above instead.
   */
  async planToolCall(toolName: string, _input: unknown, inputMetadata?: Record<string, unknown>): Promise<ToolCallDecision> {
    if (!this.task) throw new Error("No active task");
    if (this.task.status !== "PLANNING") {
      throw new CoreError("TASK_ERROR", `Task cannot plan from state ${this.task.status}`, { taskId: this.task.taskId });
    }
    const tool = this.tools.get(toolName);
    const { plan, step } = this.buildPlanStep(toolName, tool);
    this.plan = plan;
    this.task = { ...this.task, currentPlan: plan, currentStep: step.stepId, selectedTools: [toolName], selectedSkills: plan.selectedSkills };
    this.advance("PLAN_VALIDATION", "Legacy planToolCall built a plan step");
    validatePlan(plan, this.skillList, this.tools.list());
    await this.events.emit(event("PLAN_VALIDATED", this.task.taskId, { planId: plan.planId }));
    for (const skill of plan.selectedSkills) await this.events.emit(event("SKILL_SELECTED", this.task.taskId, { skill }));
    await this.events.emit(event("TOOL_SELECTED", this.task.taskId, { tool: toolName, inputMetadata }));
    this.advance("EXECUTING", "Legacy planToolCall admits execution");
    this.toolExecutionCount += 1;
    return { decision: { decision: "ALLOW" }, plan, task: this.task };
  }

  /**
   * Legacy combined entry point: plan, then evaluate policy. The Pi adapter
   * must use `precheckToolCall` + `beginToolExecution` instead; this exists for
   * direct kernel callers and legacy tests.
   *
   * F-003: the denial is handled according to the violation policy actually
   * declared, not unconditionally:
   *
   *  - `abort` — the task is already terminal. `precheckToolCall` ran the abort
   *    and traced it, so advancing again here would request an illegal
   *    transition from FAILED.
   *  - `block` — the call is refused and the turn continues. A block is not a
   *    failure, so the task must not be moved into FAILED; doing so is what made
   *    every blocked call look like a dead run.
   *  - no violation declared — the denial is unlabelled, so this path fails
   *    closed exactly as it did before.
   */
  async evaluateToolCall(toolName: string, operation: string, input: unknown, approval?: ApprovalProvider): Promise<ToolCallDecision> {
    // Legacy ordering: plan first, then evaluate. Denial recovery therefore runs
    // from EXECUTING (EXECUTING -> RECOVERING -> FAILED), as it always has.
    const planned = await this.planToolCall(toolName, input);
    const precheck = await this.precheckToolCall(toolName, operation, input, approval);
    if (precheck.decision.decision === "DENY") {
      // An `abort` violation already terminated the task inside precheckToolCall,
      // with its own POLICY_VIOLATION, POLICY_ABORTED and TASK_FAILED events.
      if (precheck.decision.violation === "abort") return { decision: precheck.decision, task: this.task };
      // A `block` violation refuses this call only. Nothing is recovered and
      // nothing fails; the caller is told why, and the task is left as it is.
      if (precheck.decision.violation === "block") return { decision: precheck.decision, task: this.task };
      this.advance("RECOVERING", "Legacy path: policy denial after planning");
      // `reason` is optional on a PolicyDecision, but both the terminal state
      // and the TASK_FAILED event need actual text. One fallback, resolved
      // once, so the two surfaces can never disagree about why this failed.
      const reason = precheck.decision.reason ?? "policy denial";
      this.advance("FAILED", "Legacy path: policy denial", { failureReason: reason });
      // `this.task!` uses the same non-null assertion as `advance()` above: this
      // path is only reachable after `planToolCall` has installed a task, and
      // the assertion states that invariant without adding a runtime check to a
      // legacy branch.
      await this.events.emit(event("TASK_FAILED", this.task!.taskId, { reason }));
      return { decision: precheck.decision, task: this.task };
    }
    return { ...planned, decision: precheck.decision };
  }

  // ---------------------------------------------------------------------------
  // FINALISATION
  // ---------------------------------------------------------------------------

  async finishTask(finalResult: unknown): Promise<Task> {
    if (!this.task) throw new Error("No active task");
    const taskId = this.task.taskId;
    // A task that policy aborted, or that has already reached a terminal state,
    // is reported as it is. Re-running finalisation would either fabricate a
    // completion or throw an illegal transition.
    if (this.task.status === "FAILED" || this.task.status === "CANCELLED"
      || this.task.status === "TIMEOUT" || this.task.status === "ESCALATED"
      || this.task.status === "COMPLETED") {
      return this.task;
    }
    if (this.task.status === "RECOVERING") {
      this.advance("FAILED", "Recovery requires a new planning turn", {
        failureReason: "Recovery requires a new planning turn",
        expectTaskId: taskId,
      });
      await this.events.emit(event("TASK_FAILED", this.task.taskId, { reason: "Recovery requires a new planning turn" }));
      return this.task;
    }

    if (this.toolExecutionCount > 0) {
      // A task that really executed tools is only complete from its own real
      // validation. Never fabricate an OBSERVING/VALIDATING pass here.
      if (this.task.status !== "VALIDATING") {
        await this.events.emit(event("TOOL_RESULT_IGNORED", this.task.taskId, {
          reason: "finish_without_validated_execution",
          taskStatus: this.task.status,
        }));
        return this.task;
      }
      if (this.lastValidation?.status === "INVALID") {
        this.advance("FAILED", "Final validation was INVALID", { failureReason: "Validation failed", expectTaskId: taskId });
        await this.events.emit(event("TASK_FAILED", this.task.taskId, { reason: "Validation failed" }));
        return this.task;
      }
      // A sibling execution may have failed validation while another was still
      // in flight. A task whose CURRENT attempt has any unresolved failure is
      // not complete, regardless of which result happened to settle last.
      if (this.attemptBlocked) {
        await this.events.emit(event("TOOL_RESULT_IGNORED", this.task.taskId, { reason: "prior_validation_failed" }));
        // That emit yields. A newer turn may own the lifecycle now, in which
        // case this attempt's failure belongs to the older task and must not
        // fail the newer one.
        if (this.isStale(taskId)) {
          this.refuseStale(taskId, "KernelAdapter.finishTask", "A newer task replaced this one before finalisation");
          return this.task;
        }
        this.advance("FAILED", "The current attempt still carries an unresolved failure (attemptBlocked)", {
          failureReason: "One or more results in this attempt failed or could not be verified",
          expectTaskId: taskId,
        });
        await this.events.emit(event("TASK_FAILED", this.task.taskId, { reason: "One or more results in this attempt failed or could not be verified" }));
        return this.task;
      }
      this.advance("COMPLETED", "Every execution in this attempt validated", { now: new Date().toISOString(), expectTaskId: taskId });
      this.task = { ...this.task, finalResult };
      await this.events.emit(event("TASK_COMPLETED", this.task.taskId));
      return this.task;
    }

    // The no-tool path below walks
    //   PLANNING -> PLAN_VALIDATION -> EXECUTING -> OBSERVING -> VALIDATING -> COMPLETED
    // and PLANNING is its only legal entry point. A task in any other live
    // state has not finished starting, so finalising it here would request a
    // transition the state machine forbids. Report the situation honestly
    // instead of attempting it.
    if (this.task.status !== "PLANNING") {
      await this.events.emit(event("TOOL_RESULT_IGNORED", this.task.taskId, {
        reason: "no_tool_finalisation_requires_planning_state",
        taskStatus: this.task.status,
      }));
      return this.task;
    }

    // No-tool task: handle stream death or clean completion
    if (!isCleanTerminal(finalResult)) {
      const msg = finalResult as any;
      let reason = "Stream ended without finish_reason";
      if (!msg || typeof msg !== "object") {
        reason = "Assistant response result was not an object";
      } else if (msg.role !== "assistant") {
        reason = `Expected assistant response, got role: ${msg.role}`;
      } else {
        reason = "Assistant response lacked content or finish_reason";
      }
      this.advance("FAILED", "Assistant stream ended without a usable result", { failureReason: reason, expectTaskId: taskId });
      await this.events.emit(event("TASK_FAILED", this.task.taskId, { reason }));
      return this.task;
    }

    const step: PlanStep = {
      stepId: "response",
      description: "Return response",
      tools: [],
      dependencies: [],
      expectedOutput: "Response",
      validationCriteria: ["Response produced"],
      retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
      timeoutMs: 1000,
      status: "PENDING",
    };
    const plan: Plan = {
      planId: randomUUID(),
      objective: this.task.objective,
      assumptions: [],
      steps: [step],
      selectedSkills: [],
      selectedTools: [],
      expectedOutputs: ["Response"],
      validationCriteria: ["Response produced"],
      riskLevel: "READ_ONLY",
    };
    this.plan = plan;
    this.task = { ...this.task, currentPlan: plan, currentStep: step.stepId };
    this.advance("PLAN_VALIDATION", "No-tool task: response plan", { expectTaskId: taskId });
    validatePlan(plan, this.skillList, this.tools.list());
    await this.events.emit(event("PLAN_VALIDATED", this.task.taskId, { planId: plan.planId }));
    this.advance("EXECUTING", "No-tool task: plan validated", { expectTaskId: taskId });

    this.advance("OBSERVING", "No-tool task: observing the assistant response", { expectTaskId: taskId });
    this.task = { ...this.task, observations: [...this.task.observations, "Assistant response produced"] };
    await this.events.emit(event("RESPONSE_OBSERVED", this.task.taskId));
    this.advance("VALIDATING", "No-tool task: validating the assistant response", { expectTaskId: taskId });

    const validation: ValidationResult = { status: "VALID", validator: "pi-response", message: "Assistant produced a response" };
    this.lastValidation = validation;
    this.task = { ...this.task, validationResults: [...this.task.validationResults, validation] };
    await this.events.emit(event("VALIDATION_COMPLETED", this.task.taskId, validation as unknown as Record<string, unknown>));

    this.advance("COMPLETED", "No-tool task: assistant response validated", { now: new Date().toISOString(), expectTaskId: taskId });
    this.task = { ...this.task, finalResult };
    await this.events.emit(event("TASK_COMPLETED", this.task.taskId));
    return this.task;
  }

  recentEvents() {
    return this.events.recent();
  }
}
