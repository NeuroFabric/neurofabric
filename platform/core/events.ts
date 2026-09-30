import { redactPayload, redactValue } from "./redaction.ts";

export type PlatformEvent =
  | "TASK_CREATED" | "TASK_STARTED" | "PLAN_CREATED" | "PLAN_VALIDATED" | "SKILL_DISCOVERED"
  | "SKILL_SELECTED" | "TOOL_SELECTED" | "TOOL_STARTED" | "TOOL_COMPLETED" | "TOOL_FAILED"
  | "VALIDATION_STARTED" | "VALIDATION_COMPLETED" | "VALIDATION_FAILED" | "RECOVERY_STARTED"
  | "RETRY_STARTED" | "REPLAN_STARTED" | "REPLAN_COMPLETED" | "APPROVAL_REQUIRED"
  | "APPROVAL_GRANTED" | "APPROVAL_DENIED" | "TASK_COMPLETED" | "TASK_FAILED" | "TASK_CANCELLED"
  | "TOOL_EXECUTION_STARTED" | "TOOL_EXECUTION_IGNORED" | "TOOL_RESULT_IGNORED" | "RESPONSE_OBSERVED"
  | "ARTIFACT_VERIFIED" | "ARTIFACT_INVALID" | "POLICY_VIOLATION" | "POLICY_ABORTED"
  // Budget telemetry. Neither can deny anything or move a task: they exist so a
  // task that is running low, or repeating the same call, is visible in the
  // trace BEFORE the terminal limit denial (F-008).
  | "BUDGET_LOW" | "TOOL_CALL_REPEATED" | "LIFECYCLE_REFUSED";

export interface PlatformEventRecord {
  eventId: string;
  type: PlatformEvent;
  taskId: string;
  correlationId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export type EventSink = (event: PlatformEventRecord) => void | Promise<void>;

/** Re-exported so persistence call sites need a single import. */
export { redactString, redactValue, redactPayload, createRedactingSink } from "./redaction.ts";

export class EventBus {
  private readonly sinks = new Set<EventSink>();
  private readonly history: PlatformEventRecord[] = [];
  /**
   * Redaction is ON by default and cannot be disabled through this class.
   *
   * The bus is the single choke point every platform event passes through, on
   * its way to the event history, to subscribers, and ultimately to
   * `pi.appendEntry`. Sanitizing here means a new event type or a new caller
   * is protected by construction rather than by remembering to sanitize.
   */
  private readonly redact: boolean;

  constructor(options: { redact?: boolean } = {}) {
    this.redact = options.redact ?? true;
  }

  subscribe(sink: EventSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  async emit(event: PlatformEventRecord): Promise<void> {
    const sanitized: PlatformEventRecord = this.redact
      ? { ...event, payload: redactPayload(event.payload) }
      : event;

    this.history.push(sanitized);
    if (this.history.length > 500) this.history.shift();
    await Promise.all([...this.sinks].map((sink) => sink(sanitized)));
  }

  recent(limit = 100): PlatformEventRecord[] {
    return this.history.slice(-limit);
  }
}
