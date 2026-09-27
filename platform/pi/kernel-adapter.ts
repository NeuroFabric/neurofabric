import { randomUUID } from "node:crypto";
import {
  CoreError,
  DefaultPolicy,
  EventBus,
  InMemoryStore,
  ToolRegistry,
  createArtifact,
  createTask,
  declaredArtifactReferences,
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
  type PolicyEngine,
  type SkillDescriptor,
  type Task,
  type TaskStatus,
  type ToolBudgetTelemetry,
  type ToolDescriptor,
  type ToolResult,
  type ValidationResult,
} from "../core/index.ts";
import { chooseRecovery, classifyFailure, type RecoveryLimits } from "../core/index.ts";

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
  private readonly skills: SkillDescriptor[];
  private readonly limits: RecoveryLimits;
  private readonly boundary?: WorkspaceBoundary;
  private task?: Task;
  private plan?: Plan;
  private lastValidation?: ValidationResult;
  private recoveryDepth = 0;

  /** Real executions currently in flight, keyed by Pi toolCallId. */
  private readonly activeExecutions = new Map<string, BoundExecution>();
  /** Every toolCallId that has been admitted (started or policy-denied) at preflight. */
  private readonly knownToolCallIds = new Set<string>();
  /** Preflight-denied toolCallIds; Pi may still emit an execution_start for them. */
  private readonly deniedToolCallIds = new Set<string>();
  /** Execution ids whose result has already been observed. */
  private readonly observedExecutionIds = new Set<string>();
  /** Output references declared at preflight, keyed by Pi toolCallId. */
  private readonly declaredOutputs = new Map<string, string[]>();
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
    this.skills = options.skills ?? [];
    this.boundary = options.boundary;
    this.limits = options.limits ?? {
      maxToolRetries: 2,
      maxStepRetries: 1,
      maxReplans: 2,
      maxRecoveryDepth: 3,
      maxExecutionTimeMs: 30 * 60 * 1000,
    };
  }

  setSkills(skills: SkillDescriptor[]): void {
    this.skills.splice(0, this.skills.length, ...skills);
  }

  get skills(): SkillDescriptor[] {
    return [...this.skills];
  }

  findSkillsByCapabilities(capabilities: string[]): SkillDescriptor[] {
    return skillsForCapabilities(this.skills, capabilities);
  }

  /** Install the policy used by preflight. Used to select the trust model. */
  setPolicy(policy: PolicyEngine): void {
    this.policy = policy;
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
    for (const descriptor of descriptors) {
      if (!this.tools.has(descriptor.name)) this.tools.register(descriptor);
    }
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
    // A task that policy has aborted, or that has already finished, may not
    // admit another call. This is what makes `on_violation: abort` stick: the
    // model can keep asking, and every request is refused.
    if (REFUSED_EXECUTION_STATES.includes(this.task.status)) {
      // Nothing was evaluated and no rule was broken: the task was already in a
      // state that admits no execution. This is a lifecycle refusal, recorded as
      // `refusal`, never as a policy `violation`.
      this.terminalRefusalCount += 1;
      const decision: PolicyDecision = {
        decision: "DENY",
        reason: `Task is ${this.task.status}; no further tool calls are accepted`,
        refusal: "task_terminal",
      };
      if (toolCallId) {
        this.deniedToolCallIds.add(toolCallId);
        this.knownToolCallIds.add(toolCallId);
      }
      await this.events.emit(event("APPROVAL_DENIED", this.task.taskId, {
        tool: toolName,
        toolCallId,
        reason: decision.reason,
        refusal: decision.refusal,
      }));
      return { decision, task: this.task };
    }
    // An approval provider must never be able to *replace* the installed trust
    // model. In TRUSTED_PROJECT mode it is ignored outright, so no caller can
    // escalate a hard denial by passing an always-approving provider.
    const trusted = this.policy.mode === "TRUSTED_PROJECT";
    const policy = !trusted && approval ? new DefaultPolicy(approval) : this.policy;
    const request = { taskId: this.task.taskId, tool, operation, input };
    // Evaluate first so that an approval prompt is traced even when it is granted.
    const required = policy.evaluate(request);
    const decision = !trusted && approval ? await policy.evaluateWithApproval(request) : required;

    if (required.decision === "REQUIRE_APPROVAL") {
      await this.events.emit(event("APPROVAL_REQUIRED", this.task.taskId, { tool: toolName, toolCallId }));
    }

    // Task identity is re-checked HERE, immediately before the first task-owned
    // mutation and before the decision is returned, and it covers EVERY path
    // that can yield between entry and that point: the approval prompt above,
    // and `evaluateWithApproval` itself, which is awaited whenever an approval
    // provider is supplied. A handler that resumes against a task it does not
    // own must record nothing on the task that replaced it — not an id in
    // `knownToolCallIds` or `deniedToolCallIds`, not a `denialCount` — and must
    // not hand the caller a verdict produced for the superseded task. It is
    // refused on lifecycle grounds instead, which is a different thing from
    // policy having denied the call, so it carries `refusal` and never
    // `violation`.
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
      await this.events.emit(event("APPROVAL_DENIED", this.task.taskId, {
        tool: toolName,
        toolCallId,
        reason: decision.reason,
        violation: decision.violation,
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
    // read nor write the newer task's budget state, and only when the installed
    // policy is the one that actually evaluated the call: passing an approval
    // provider substitutes a tier policy, and that one does not meter.
    if (decision.decision === "ALLOW" && policy === this.policy) {
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
      // Pi emits execution_start around a blocked preflight. Never fabricate
      // an execution plan for a call policy refused.
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
      validatePlan(plan, this.skills, this.tools.list());
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
      selectedSkills: this.skills.filter((skill) => skill.requiredTools.includes(toolName)).map((skill) => skill.name),
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

  async observeToolResult(result: ToolResult, error?: unknown): Promise<ValidationResult> {
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
      error: error?.message,
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
      const strategy = chooseRecovery({
        failure,
        limits: this.limits,
        retryCount: this.task.retryCount,
        replanCount: this.task.replanCount,
        depth: this.recoveryDepth,
        idempotency: tool.idempotency,
      });
      this.recoveryDepth += 1;
      await this.events.emit(event("RECOVERY_STARTED", this.task.taskId, { strategy, failure, recoveryDepth: this.recoveryDepth }));

      switch (strategy) {
        case "RETRY":
          this.task = { ...this.task, retryCount: this.task.retryCount + 1 };
          this.advance("RETRYING", `Recovery strategy RETRY (depth ${this.recoveryDepth})`, { expectTaskId: taskId });
          this.advance("PLANNING", "Retry re-enters planning", { expectTaskId: taskId });
          break;
        case "REPLAN":
          this.task = { ...this.task, replanCount: this.task.replanCount + 1 };
          this.advance("REPLANNING", `Recovery strategy REPLAN (depth ${this.recoveryDepth})`, { expectTaskId: taskId });
          this.advance("PLANNING", "Replan re-enters planning", { expectTaskId: taskId });
          break;
        case "ESCALATE":
          this.advance("ESCALATED", "Recovery strategy ESCALATE", { expectTaskId: taskId });
          break;
        case "TERMINATE":
        default:
          this.advance("FAILED", "Recovery strategy TERMINATE: budget exhausted or no safe strategy remains", {
            failureReason: "Recovery budget exhausted or no safe recovery strategy remains",
            expectTaskId: taskId,
          });
          await this.events.emit(event("TASK_FAILED", this.task.taskId, {
            reason: "Recovery budget exhausted or no safe recovery strategy remains",
            strategy,
          }));
          break;
      }
    } else {
      this.recoveryDepth = 0;
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
  async recordToolResult(toolCallId: string, toolName: string, payload: unknown, isError: boolean): Promise<ValidationResult> {
    if (!this.task) throw new Error("No active task");
    const bound = this.activeExecutions.get(toolCallId);
    const now = new Date().toISOString();
    const taskId = this.task.taskId;
    const stepId = bound?.stepId ?? this.task.currentStep ?? "unknown";
    const tool = this.tools.get(toolName);

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
      error: isError ? { category: "TOOL_ERROR", message: "Pi reported a tool error", retryable: false } : undefined,
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
    return this.observeToolResult(result, isError ? new Error("Pi reported a tool error") : undefined);
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
    validatePlan(plan, this.skills, this.tools.list());
    await this.events.emit(event("PLAN_VALIDATED", this.task.taskId, { planId: plan.planId }));
    for (const skill of plan.selectedSkills) await this.events.emit(event("SKILL_SELECTED", this.task.taskId, { skill }));
    await this.events.emit(event("TOOL_SELECTED", this.task.taskId, { tool: toolName, inputMetadata }));
    this.advance("EXECUTING", "Legacy planToolCall admits execution");
    this.toolExecutionCount += 1;
    return { decision: { decision: "ALLOW" }, plan, task: this.task };
  }

  /**
   * Legacy combined entry point: plan, then evaluate policy, failing the task on
   * denial. The Pi adapter must use `precheckToolCall` + `beginToolExecution`
   * instead; this exists for direct kernel callers and legacy tests.
   */
  async evaluateToolCall(toolName: string, operation: string, input: unknown, approval?: ApprovalProvider): Promise<ToolCallDecision> {
    // Legacy ordering: plan first, then evaluate. Denial recovery therefore runs
    // from EXECUTING (EXECUTING -> RECOVERING -> FAILED), as it always has.
    const planned = await this.planToolCall(toolName, input);
    const precheck = await this.precheckToolCall(toolName, operation, input, approval);
    if (precheck.decision.decision === "DENY") {
      this.advance("RECOVERING", "Legacy path: policy denial after planning");
      this.advance("FAILED", "Legacy path: policy denial", { failureReason: precheck.decision.reason });
      await this.events.emit(event("TASK_FAILED", this.task.taskId, { reason: precheck.decision.reason }));
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
    validatePlan(plan, this.skills, this.tools.list());
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
