/**
 * THE PRECHECK. A human decides before a credential is read.
 *
 * === WHY THIS EXISTS INSTEAD OF THE KERNEL'S ===
 *
 * ADR-008 §4 recorded that the kernel vault discloses a value because a person
 * approved that specific call at the precheck, recorded in the trace before the
 * handler ran. The embassy has no precheck. This is one, written for the surface
 * that lacked it.
 *
 * === WHY NOTHING HERE WAITS, AND WHY THAT IS THE WHOLE OF THE ASYNC STATE ===
 *
 * A pending approval can be held two ways: a promise the tool call awaits, or a
 * registry the dispatcher reads. The promise makes `dispatch` impure and
 * untestable without a pipe -- the one property this protocol layer was built to
 * keep -- and it buys nothing, because the answer arrives as an ordinary inbound
 * line either way.
 *
 * So this is a registry. `begin` writes an elicitation request and returns; the
 * caller's answer arrives later as a line; `offer` matches it against a row and
 * removes it. The event loop is never occupied and there is nothing to unblock,
 * because a pending call is not a suspended thread. It is a row in a map.
 *
 * === THE CAPABILITY, NEVER THE BEARER ===
 *
 * The prompt names the capability's ID and not the value that proves it.
 * Form-mode data is exposed to the client by design, so a bearer value here
 * would be handed to the host process, rendered into whatever UI the host has,
 * and plausibly written to its logs -- and the specification forbids form mode
 * for exactly that class of content. The ID is what lets a person identify which
 * grant they are approving, which is the entire reason to show them anything.
 *
 * === FAIL CLOSED, EVERY TIME ===
 *
 * Decline, cancel, a missing or falsy approval, an unowned approval, a malformed
 * answer, an answer for an id nothing is waiting on, a client that never replies,
 * a sweep that finds an expired row, and a trail that throws. Every one refuses,
 * and every one refuses with the SAME code -- a refusal that varies with its cause
 * is an oracle, and the internal reason travels to the audit trail instead of to
 * the caller.
 */

import { request, serialise, failure, type ParsedFrame, type RpcId } from "./jsonrpc.ts";

/** What is being approved. Identity and consequence; never a value. */
export interface ApprovalSubject {
  readonly tool: string;
  readonly tenant: string;
  /** The capability's identifier. NOT the bearer value that proves it. */
  readonly capability: string;
  readonly credentialName: string;
  /**
   * Whether the caller asked for a reference or for the plaintext.
   *
   * Carried on the subject because it CHANGES WHAT THE OPERATOR IS BEING ASKED TO
   * AGREE TO. "Approve this read" and "approve this read AND put a live credential
   * into a model's memory" are different decisions, and the prompt rendering the
   * second one has to say so in the operator's face before the box exists.
   */
  readonly exposure: "metadata" | "reference" | "raw";
  /** Stated to the operator, because an approval with no consequences is a stamp. */
  readonly sideEffects: readonly string[];
}

export type ApprovalDecision =
  | { readonly approved: true; readonly by: string; readonly reason: string }
  | { readonly approved: false; readonly code: string; readonly reason: string };

/** One awaiting decision. The row the whole module exists to hold. */
export interface PendingApproval {
  /**
   * The id of OUR request to the client. Answers correlate on this.
   *
   * A STRING, and deliberately not in the same space as the client's own request
   * ids. This server is bidirectional now, so it both sends and receives ids, and
   * a shared numeric space means our outbound id 1 is indistinguishable from the
   * client's inbound request 1 -- which is a correlation that can be aimed. The
   * prefix makes the direction of every id self-evident to anything reading the
   * stream, and the specification permits a string id.
   */
  readonly elicitationId: string;
  /** The tool call that is waiting, so the result goes back to the right id. */
  readonly toolCallId: RpcId;
  readonly subject: ApprovalSubject;
  /** When the window opened, so the sweep has something to measure from. */
  readonly startedAt: number;
}

export interface ResolvedApproval {
  readonly pending: PendingApproval;
  readonly decision: ApprovalDecision;
}

/** What the trail records. Carries the decision, never a value. */
export interface ApprovalAuditEvent {
  readonly at: string;
  readonly outcome: "granted" | "refused";
  readonly approvedBy?: string;
  /** Why, in the operator's words on a grant, or the cause on a refusal. */
  readonly reason: string;
  readonly tool: string;
  readonly tenant: string;
  readonly capability: string;
  readonly credentialName: string;
}

/**
 * ONE REFUSAL, FOR EVERY CAUSE.
 *
 * A single constant deliberately. The code and the message together are what a
 * caller can observe, so they must not vary with the reason -- otherwise a caller
 * learns which names are real, which grants are live, and whether an operator is
 * looking at their request.
 */
export const APPROVAL_REFUSED = "APPROVAL_REFUSED";
const REFUSAL_MESSAGE = "this call was not approved for a credential read";

const DEFAULT_TIMEOUT_MS = 120_000;

export interface ApprovalGateOptions {
  readonly timeoutMs?: number;
  readonly now?: () => number;
  /** Where the trail goes. Wrapped below, so no caller can skip it. */
  readonly audit: (event: ApprovalAuditEvent) => void;
  /**
   * The sweep interval. A parameter so a test never owns wall time -- the same
   * discipline the evaluation loop uses for its own clock.
   */
  readonly setIntervalFn?: (fn: () => void, ms: number) => { unref?(): void; ref?(): void };
  readonly clearIntervalFn?: (handle: unknown) => void;
}

export interface ApprovalGate {
  /** Arm a decision and return the frame to write. Nothing waits inside this. */
  begin(subject: ApprovalSubject, toolCallId: RpcId): { frame: string; pending: PendingApproval };
  /** Feed an inbound frame. Returns what it settled, if anything. */
  offer(frame: ParsedFrame): ResolvedApproval | undefined;
  /** Settle anything past its window. The timer calls this; a test calls it too. */
  sweep(nowMs: number): ResolvedApproval[];
  pendingCount(): number;
  /** Release every pending approval and the timer that sweeps them. */
  dispose(): void;
}

/** The prompt. Built from constants and the subject; no value ever reaches it. */
function buildElicitation(subject: ApprovalSubject): { message: string; requestedSchema: unknown } {
  const effects = subject.sideEffects.join("; ");
  const raw = subject.exposure === "raw";
  const metadata = subject.exposure === "metadata";

  /**
   * THE COST OF EACH MODE, STATED WHERE THE OPERATOR READS IT.
   *
   * The three modes are not a spectrum the caller picks from freely: metadata
   * never materialises the credential, a reference never returns it but does load
   * it in order to hash it, and raw returns it into a model's context. Saying which
   * is which is the difference between an operator agreeing to something and
   * agreeing to something they thought they were agreeing to.
   */
  const costLine = raw
    ? "You will receive the LIVE VALUE in plaintext."
    : metadata
      ? "You will receive existence and last-rotation only. The credential is never loaded."
      : "You will receive a non-reversible label. The credential is loaded here only to compute it.";

  /**
   * THE WARNING, AND WHY IT IS PROSE RATHER THAN A FIELD TITLE.
   *
   * A field titled "I understand the risks" is one line in a form, and forms are
   * scrolled past. This block is the first thing above the fold, it is prose somebody
   * actually reads, and it names the specific mechanism -- a context window that gets
   * quoted, summarised, logged and carried into later turns -- rather than gesturing
   * at "risk" in the abstract.
   */
  const warning = raw
    ? [
        "========================================================",
        "  RAW CREDENTIAL EXPOSURE REQUESTED",
        "========================================================",
        "Approving this places a LIVE credential in PLAINTEXT into a language",
        "model's context window. From there it can be quoted, summarised,",
        "written to logs, echoed in later turns, and pasted into a ticket.",
        "A model asked to hold a credential cannot be relied on not to repeat",
        "it, and no redaction downstream will help.",
        "",
        "If you only need to REFER to this credential, decline: the default",
        "returns a stable label that carries no value at all.",
        "========================================================",
        "",
      ].join("\n")
    : "";

  return {
    message:
      `${warning}A credential read needs your approval.\n\n` +
      `Tool: ${subject.tool}\n` +
      `Tenant: ${subject.tenant}\n` +
      `Capability: ${subject.capability}\n` +
      `Requested credential: ${subject.credentialName}\n` +
      `Requested as: ${raw ? "RAW PLAINTEXT" : metadata ? "METADATA ONLY (value never loaded)" : "a reference, not the value"}\n\n` +
      `${costLine}\n\n` +
      `If you approve, ${effects}.\n\n` +
      (raw ? "Approve only if you know why a model needs the live value here." : "Approve only if you know why this agent needs it."),
    requestedSchema: {
      type: "object",
      properties: {
        tool: { type: "string", title: "Tool", description: "The tool asking." },
        tenant: { type: "string", title: "Tenant", description: "Whose credential is named." },
        capability: { type: "string", title: "Capability", description: "The identifier of the grant being exercised." },
        credentialName: { type: "string", title: "Credential", description: "The specific entry requested." },
        exposure: {
          type: "string",
          title: "Requested as",
          description: raw
            ? "RAW PLAINTEXT -- see the warning above."
            : metadata
              ? "METADATA ONLY -- existence and last rotation, value never loaded."
              : "a reference, not the value",
        },
        sideEffects: { type: "string", title: "If approved", description: effects },
        approve: {
          type: "boolean",
          title: "Approve this read",
          description: "Leave unticked to decline. This is the decision; nothing proceeds without it.",
        },
        // Present ONLY for raw. In the reference case there is nothing extra to
        // agree to, and a box that always appears teaches people to tick boxes.
        ...(raw
          ? {
              acknowledgeRawExposure: {
                type: "boolean",
                title: "Yes -- put the plaintext credential into the model's context",
                description:
                  "A separate acknowledgement, required in addition to approving the read. It exists because the cost of this is paid later, by somebody who is not in this conversation.",
              },
            }
          : {}),
        approvedBy: {
          type: "string",
          title: "Approved by",
          description: "Your name or handle. Recorded permanently, and required.",
          minLength: 1,
        },
        reason: {
          type: "string",
          title: "Reason",
          description: "Why this read is happening. Recorded permanently, and required.",
          minLength: 1,
        },
      },
      required: raw ? ["approve", "acknowledgeRawExposure", "approvedBy", "reason"] : ["approve", "approvedBy", "reason"],
    },
  };
}

export function createApprovalGate(options: ApprovalGateOptions): ApprovalGate {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const setIntervalFn =
    options.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms) as unknown as { unref?(): void; ref?(): void });
  const clearIntervalFn = options.clearIntervalFn ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));

  /** Correlation id for OUR outbound requests. Separate space, see `elicitationId`. */
  let nextId = 0;
  const pending = new Map<string, PendingApproval>();
  let timer: { unref?(): void; ref?(): void } | undefined;

  /**
   * Record, and treat a broken trail as a refusal.
   *
   * The alternative -- letting the reporter's exception escape -- would turn a
   * logging fault into an outage, and an outage in this path gets answered by
   * disabling the trail. Refusing instead means a broken trail produces no reads.
   */
  const record = (subject: ApprovalSubject, decision: ApprovalDecision, approvedBy?: string): boolean => {
    try {
      options.audit({
        at: new Date(now()).toISOString(),
        outcome: decision.approved ? "granted" : "refused",
        ...(approvedBy === undefined ? {} : { approvedBy }),
        reason: decision.approved ? decision.reason : decision.reason,
        tool: subject.tool,
        tenant: subject.tenant,
        capability: subject.capability,
        credentialName: subject.credentialName,
      });
      return true;
    } catch {
      return false;
    }
  };

  const settle = (row: PendingApproval, decision: ApprovalDecision, approvedBy?: string): ResolvedApproval => {
    pending.delete(row.elicitationId);
    if (pending.size === 0) stopTimer();
    return { pending: row, decision };
  };

  function stopTimer(): void {
    if (timer === undefined) return;
    clearIntervalFn(timer);
    timer = undefined;
  }

  /** Armed only while something is waiting, so it cannot outlive the work. */
  function startTimer(): void {
    if (timer !== undefined) return;
    timer = setIntervalFn(() => {
      for (const resolved of sweep(now())) void resolved;
    }, Math.min(timeoutMs, 1_000));
    // The single line that makes a timer safe to construct anywhere. This shape
    // -- a timer in a long-lived object that nothing tears down -- has hung this
    // repository before, and the evaluation loop carries the same guard for the
    // same reason.
    timer.unref?.();
  }

  function sweep(nowMs: number): ResolvedApproval[] {
    const settled: ResolvedApproval[] = [];
    for (const row of [...pending.values()]) {
      if (nowMs - row.startedAt < timeoutMs) continue;
      const decision: ApprovalDecision = { approved: false, code: APPROVAL_REFUSED, reason: "the approval window closed before an answer arrived" };
      record(row.subject, decision);
      settled.push(settle(row, decision));
    }
    return settled;
  }

  return {
    begin(subject: ApprovalSubject, toolCallId: RpcId): { frame: string; pending: PendingApproval } {
      const elicitationId = `el-${(nextId += 1)}`;
      const row: PendingApproval = { elicitationId, toolCallId, subject, startedAt: now() };
      pending.set(elicitationId, row);
      startTimer();
      const { message, requestedSchema } = buildElicitation(subject);
      // A REQUEST envelope, because elicitation is this server asking first. The
      // client's answer arrives back as a response on `elicitationId`.
      const frame = serialise(request(elicitationId, "elicitation/create", { mode: "form", message, requestedSchema }));
      return { frame, pending: row };
    },

    offer(frame: ParsedFrame): ResolvedApproval | undefined {
      if (frame.kind !== "response") return undefined;
      const row = pending.get(String(frame.id));
      // An answer for an id nothing is waiting on resolves nothing, and in
      // particular is not matched to somebody else's request.
      if (row === undefined) return undefined;

      /**
       * FAIL CLOSED, IN ONE PLACE, so no branch can be more forgiving than another.
       *
       * Everything that is not "accept, with the box ticked, with a named human and
       * a stated reason" arrives here. Blank attribution counts as unowned, because
       * a trail row with no actor cannot answer the question a trail exists for.
       */
      const result = frame.result;
      if (frame.error !== undefined || result === null || typeof result !== "object" || Array.isArray(result)) {
        const decision: ApprovalDecision = { approved: false, code: APPROVAL_REFUSED, reason: "the answer was not a usable decision" };
        record(row.subject, decision);
        return settle(row, decision);
      }

      const answer = result as Record<string, unknown>;
      const content = answer["content"];
      const approved =
        answer["action"] === "accept" &&
        content !== null &&
        typeof content === "object" &&
        !Array.isArray(content) &&
        (content as Record<string, unknown>)["approve"] === true;

      const body = (content ?? {}) as Record<string, unknown>;
      const by = typeof body["approvedBy"] === "string" ? body["approvedBy"].trim() : "";
      const reason = typeof body["reason"] === "string" ? body["reason"].trim() : "";

      if (!approved || by === "" || reason === "") {
        const cause = !approved ? `the operator answered ${String(answer["action"] ?? "nothing")}` : "the approval carried no named human or no reason";
        const decision: ApprovalDecision = { approved: false, code: APPROVAL_REFUSED, reason: cause };
        record(row.subject, decision);
        return settle(row, decision);
      }

      /**
       * RAW EXPOSURE NEEDS ITS OWN TICK, ON TOP OF APPROVING THE READ.
       *
       * Separate from `approve` so neither field alone is sufficient, and checked
       * HERE rather than in the reader -- because by the time a reader sees an
       * unacknowledged raw request the decision has already been granted and written
       * to the trail, and a refusal that leaves a granted approval on the record is
       * worse than one that never happened. If the box is missing, the whole answer
       * is treated as not given.
       */
      if (row.subject.exposure === "raw" && body["acknowledgeRawExposure"] !== true) {
        const decision: ApprovalDecision = {
          approved: false,
          code: APPROVAL_REFUSED,
          reason: "raw exposure was requested without its separate acknowledgement",
        };
        record(row.subject, decision);
        return settle(row, decision);
      }

      const decision: ApprovalDecision = { approved: true, by, reason };
      // A trail that cannot record is a trail that does not exist, and an approval
      // nobody can see is not an approval.
      if (!record(row.subject, decision, by)) {
        const refusal: ApprovalDecision = { approved: false, code: APPROVAL_REFUSED, reason: "the decision could not be recorded" };
        return settle(row, refusal);
      }
      return settle(row, decision, by);
    },

    sweep: (nowMs: number) => sweep(nowMs),

    pendingCount: () => pending.size,

    dispose(): void {
      stopTimer();
      pending.clear();
    },
  };
}

/** The refusal a caller sees when a pending approval did not go our way. */
export function approvalRefusal(id: RpcId): string {
  return serialise(failure(id, -32001, REFUSAL_MESSAGE));
}