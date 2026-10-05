/**
 * ASYNCHRONOUS HITL: THE SERVER ASKS, ANSWERS, AND DOES NOT HOLD THE CALL OPEN.
 *
 * === THE TIMEOUT THIS EXISTS TO FIX ===
 *
 * `elicitation.ts` was already non-blocking in the event-loop sense: `begin` writes a
 * row and returns, and the human's answer arrives later as an ordinary inbound line.
 * That was true and it was not sufficient.
 *
 * The *protocol* request cycle was still open. `handleCredentialCall` returned only
 * the `elicitation/create` frame, so the caller's `tools/call` id received no
 * response at all until either a human answered or the 120-second sweep expired. MCP
 * clients time out long before that. The event loop was free and the request was
 * still dead, and a timeout produces a client-side retry, which is a second request
 * for one human decision.
 *
 * So the cycle is now closed immediately. The server answers `-32001` with a task
 * token and gets out of the way; the verdict arrives on SSE, keyed by that token.
 *
 * === THE TOKEN IS A BEARER, SO IT MUST BE UNGUESSABLE ===
 *
 * This is the one decision in this file that is a security decision rather than a
 * protocol decision, and it is worth stating plainly.
 *
 * The token authorises its holder to collect the result of an APPROVED credential
 * read. The existing elicitation id is `el-1`, `el-2`, `el-3` -- a counter. If that
 * were reused, anybody could collect anybody's approved credential by counting, and
 * the approval would be a speed bump rather than a control.
 *
 * So the token is 192 bits of CSPRNG output. It is minted once, stored hashed, and
 * never appears in a log, a row, or a broadcast except as the token itself.
 *
 * === WHAT A TOKEN DOES NOT DO ===
 *
 * It is not an authorisation. Holding one proves you were the caller that received
 * it, which is necessary and not sufficient: the decision was already made by a
 * person before the result was stashed. It cannot be used to request a credential,
 * to change an exposure, or to widen a scope.
 *
 * === AND THE PENDING ROW IS WRITTEN BEFORE THE HUMAN IS ASKED ===
 *
 * A request that no operator ever saw is indistinguishable from one that was
 * refused, unless something was written when the request was made. So `begin`
 * appends `APPROVAL_PENDING` durably and returns; if that write fails, the whole
 * path refuses, for the same reason and with the same rule as everywhere else in
 * this gateway: a decision that is not on the record is not a decision.
 *
 * A row that says `PENDING` forever is itself a signal — it is what an operator
 * queries to find approvals nobody ever answered, which today is invisible.
 */

import { createHash, randomBytes } from "node:crypto";

import type { ApprovalSubject } from "./elicitation.ts";

/**
 * THE ERROR CODE.
 *
 * `-32001` sits in JSON-RPC's implementation-defined server range (-32000 to
 * -32099), so it is a protocol-legal error rather than a misuse code, and it is
 * distinct from every code this gateway already returns. That matters: a client can
 * tell "you must obtain an approval" apart from "this call was refused", and the
 * two call for completely different behaviour — retry-after-approval versus
 * give-up.
 */
export const ELICITATION_REQUIRED = -32001;

/** The message. Fixed, because a message that varies is a shape a caller can key on. */
export const ELICITATION_REQUIRED_MESSAGE = "Elicitation Required";

/** How long a task lives before it is swept. Matches the gate's window. */
const DEFAULT_TASK_TTL_MS = 120_000;
/** How long an approved result stays retrievable after the verdict. */
const DEFAULT_RESULT_TTL_MS = 60_000;

/** Where the client should listen for the verdict. */
export const VERDICT_CHANNEL = "/alert";
export const VERDICT_EVENT = "elicitation.verdict";

export type TaskStatus = "pending" | "approved" | "refused" | "expired";

/** What the caller is told it has to do next. Never a value, never a bearer. */
export interface ElicitationRequiredData {
  readonly taskToken: string;
  readonly status: "pending";
  readonly subject: {
    readonly tool: string;
    readonly credentialName: string;
    readonly exposure: ApprovalSubject["exposure"];
    readonly sideEffects: readonly string[];
  };
  readonly notify: { readonly transport: "sse"; readonly channel: string; readonly event: string };
  readonly expiresAt: string;
}

/** The row written when the request is made, before any human is interrupted. */
export interface PendingAuditEvent {
  readonly outcome: "pending" | "granted" | "refused" | "expired";
  readonly taskToken: string;
  readonly subject: ApprovalSubject;
  readonly decidedAt: string;
  readonly reason: string;
  readonly approvedBy?: string;
}

export interface VerdictBroadcast {
  readonly taskToken: string;
  readonly status: Extract<TaskStatus, "approved" | "refused">;
  readonly subject: {
    readonly tool: string;
    readonly credentialName: string;
    readonly exposure: ApprovalSubject["exposure"];
  };
  readonly decidedAt: string;
  readonly approvedBy?: string;
  /**
   * Present on a grant, and it is the ONLY thing that can carry a credential out of
   * this module. The read happens here, at the moment of approval, and the value is
   * held for exactly one retrieval.
   */
  readonly result?: string;
  readonly exists?: boolean;
  readonly rotatedAt?: string;
}

export interface AsyncApprovalOptions {
  /**
   * The durable trail. Writes the PENDING row and the verdict row.
   *
   * Throwing here REFUSES the request. Same rule, same reason, and same consequence
   * as an approval ledger that will not open: an approval path with no record is a
   * gateway that has quietly stopped asking.
   */
  readonly audit: (event: PendingAuditEvent) => void;
  readonly now?: () => number;
  readonly taskTtlMs?: number;
  readonly resultTtlMs?: number;
  /** SSE. Omit to run headless; verdicts are then countable but not broadcast. */
  readonly broadcast?: (verdict: VerdictBroadcast) => void;
}

interface Task {
  readonly token: string;
  readonly subject: ApprovalSubject;
  readonly requestedAt: number;
  status: TaskStatus;
  decidedAt?: number;
  approvedBy?: string;
  reason?: string;
  /** The approved outcome, retrievable ONCE. See `collect`. */
  result?: { readonly value: string; readonly exists?: boolean; readonly rotatedAt?: string };
  resultExpiresAt?: number;
}

export interface AsyncApprovalStats {
  readonly requested: number;
  readonly approved: number;
  readonly refused: number;
  readonly expired: number;
  readonly pending: number;
  /** Approved results nobody ever collected. A leak, and worth a number. */
  readonly uncollected: number;
}

export interface AsyncApprovalGate {
  /**
   * WRITE THE PENDING ROW, MINT THE TOKEN, RETURN THE -32001 PAYLOAD.
   *
   * Throws if the trail will not take the row. There is no "answer anyway" path:
   * the alternative is a credential request with no record that it was ever made.
   */
  begin(subject: ApprovalSubject): ElicitationRequiredData;
  /**
   * THE SUBJECT BEHIND A TOKEN, while it is still pending.
   *
   * The verdict arrives from a portal keyed by the token, with no other context, so
   * something has to recover the tenant, the credential name and the exposure from
   * it — and the approved read has to happen against exactly those, not against
   * anything the verdict request supplied. That is why this exists, and why it
   * refuses to return a subject for a token that is no longer pending.
   */
  subject(token: string): ApprovalSubject | undefined;
  /**
   * RECORD THE VERDICT AND BROADCAST IT.
   *
   * `result` is supplied only on a grant, and only because the read has to happen at
   * the moment of approval — afterwards there may be nobody left who was watching.
   */
  settle(token: string, decision: { approved: boolean; approvedBy?: string; reason: string }, result?: { value: string; exists?: boolean; rotatedAt?: string }): VerdictBroadcast | undefined;
  /** Fetch an approved result. SINGLE USE, whether it succeeded or not. */
  collect(token: string): VerdictBroadcast | undefined;
  /** Expire anything past its window. The timer calls this. */
  sweep(): void;
  stats(): AsyncApprovalStats;
  dispose(): void;
}

/** Why the token is stored hashed. See the header: it is a bearer. */
function digestOf(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function createAsyncApprovalGate(options: AsyncApprovalOptions): AsyncApprovalGate {
  const now = options.now ?? (() => Date.now());
  const taskTtlMs = options.taskTtlMs ?? DEFAULT_TASK_TTL_MS;
  const resultTtlMs = options.resultTtlMs ?? DEFAULT_RESULT_TTL_MS;

  /** Keyed by the token's SHA-256. A dump of this map is not a list of live tokens. */
  const tasks = new Map<string, Task>();
  let requested = 0;
  let approved = 0;
  let refused = 0;
  let expired = 0;
  let uncollected = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const write = (event: PendingAuditEvent): void => {
    // No try/catch. A trail that will not take the row must propagate, and every
    // caller of this module decides what to do about it — which is always refuse.
    options.audit(event);
  };

  const sweep = (): void => {
    const at = now();
    for (const [key, task] of [...tasks.entries()]) {
      if (task.status === "pending" && at - task.requestedAt >= taskTtlMs) {
        task.status = "expired";
        task.reason = "the approval window closed before an answer arrived";
        expired += 1;
        // Expired is recorded. An approval that nobody answered and that then
        // vanishes leaves no trace that a person was ever asked.
        write({
          outcome: "expired",
          taskToken: task.token,
          subject: task.subject,
          decidedAt: new Date(at).toISOString(),
          reason: task.reason,
        });
        tasks.delete(key);
        continue;
      }
      if (task.result !== undefined && task.resultExpiresAt !== undefined && at >= task.resultExpiresAt) {
        // The result outlived its window. Dropping it is the whole point of a TTL.
        tasks.delete(key);
      }
    }
  };

  const stopTimer = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  const startTimer = (): void => {
    if (timer !== undefined) return;
    timer = setInterval(sweep, Math.min(taskTtlMs, 1_000));
    timer.unref?.();
  };

  return {
    begin(subject: ApprovalSubject): ElicitationRequiredData {
      const at = now();

      /**
       * 192 bits, hex. Not a counter — see the header.
       *
       * 32 hex characters is also wide enough that the token cannot be guessed by
       * anything that would plausibly be pointed at it, and short enough to put in a
       * URL, a log line and an SSE frame without ceremony.
       */
      const token = `tk_${randomBytes(24).toString("hex")}`;

      const task: Task = { token, subject, requestedAt: at, status: "pending" };

      /**
       * THE PENDING ROW GOES IN FIRST.
       *
       * Before this returns, and before any frame reaches the caller, so a caller
       * that never gets its -32001 has still left a record that it asked.
       */
      write({
        outcome: "pending",
        taskToken: token,
        subject,
        decidedAt: new Date(at).toISOString(),
        reason: "an operator is being asked",
      });

      tasks.set(digestOf(token).toString("hex"), task);
      requested += 1;
      startTimer();

      return {
        taskToken: token,
        status: "pending",
        subject: {
          tool: subject.tool,
          credentialName: subject.credentialName,
          exposure: subject.exposure,
          sideEffects: subject.sideEffects,
        },
        notify: { transport: "sse", channel: VERDICT_CHANNEL, event: VERDICT_EVENT },
        expiresAt: new Date(at + taskTtlMs).toISOString(),
      };
    },

    subject(token: string): ApprovalSubject | undefined {
      const task = tasks.get(digestOf(token).toString("hex"));
      if (task === undefined || task.status !== "pending") return undefined;
      return task.subject;
    },

    settle(
      token: string,
      decision: { approved: boolean; approvedBy?: string; reason: string },
      result?: { value: string; exists?: boolean; rotatedAt?: string },
    ): VerdictBroadcast | undefined {
      const key = digestOf(token).toString("hex");
      const task = tasks.get(key);
      // An answer for a token nothing is holding resolves nothing. In particular it
      // is not applied to the nearest task.
      if (task === undefined || task.status !== "pending") return undefined;

      const at = now();
      task.status = decision.approved ? "approved" : "refused";
      task.decidedAt = at;
      task.reason = decision.reason;
      if (decision.approvedBy !== undefined) task.approvedBy = decision.approvedBy;
      if (decision.approved) approved += 1;
      else refused += 1;

      write({
        outcome: task.status === "approved" ? "granted" : "refused",
        taskToken: task.token,
        subject: task.subject,
        decidedAt: new Date(at).toISOString(),
        reason: decision.reason,
        ...(decision.approvedBy === undefined ? {} : { approvedBy: decision.approvedBy }),
      });

      /**
       * THE RESULT IS STASHED ONLY ON A GRANT, AND ONLY FROM THIS CALL.
       *
       * There is no other path by which a value enters this module. That is what
       * makes `collect` safe to expose: by the time anyone can present the token,
       * a person has already decided, and the decision is already on the record.
       */
      if (decision.approved && result !== undefined) {
        task.result = result;
        task.resultExpiresAt = at + resultTtlMs;
      } else {
        // A refusal has nothing to hand back, so the row goes immediately rather
        // than sitting in the map holding a decision nobody needs.
        tasks.delete(key);
      }

      const verdict: VerdictBroadcast = {
        taskToken: task.token,
        status: task.status,
        subject: {
          tool: task.subject.tool,
          credentialName: task.subject.credentialName,
          exposure: task.subject.exposure,
        },
        decidedAt: new Date(at).toISOString(),
        ...(task.approvedBy === undefined ? {} : { approvedBy: task.approvedBy }),
      };

      /**
       * THE BROADCAST CARRIES THE RESULT ON A GRANT.
       *
       * Only for `approved`, and only because the caller may never poll — a client
       * that connected to SSE and then disconnected would otherwise lose a decision
       * a person made. A refusal carries no result because there is none.
       */
      if (decision.approved && result !== undefined) {
        options.broadcast?.({
          ...verdict,
          result: result.value,
          ...(result.exists === undefined ? {} : { exists: result.exists }),
          ...(result.rotatedAt === undefined ? {} : { rotatedAt: result.rotatedAt }),
        });
      } else {
        options.broadcast?.(verdict);
      }

      return verdict;
    },

    collect(token: string): VerdictBroadcast | undefined {
      const key = digestOf(token).toString("hex");
      const task = tasks.get(key);
      if (task === undefined || task.status !== "approved" || task.result === undefined) return undefined;

      const at = now();
      if (task.resultExpiresAt !== undefined && at >= task.resultExpiresAt) {
        tasks.delete(key);
        return undefined;
      }

      // SINGLE USE, AND REMOVED WHETHER IT WORKED OR NOT.
      //
      // A result that is removed before it is checked cannot be replayed by a client
      // that retries, and a "found but expired" must not leave the row behind for a
      // second attempt.
      tasks.delete(key);
      if (task.resultExpiresAt !== undefined && at >= task.resultExpiresAt) uncollected += 1;

      return {
        taskToken: task.token,
        status: "approved",
        subject: {
          tool: task.subject.tool,
          credentialName: task.subject.credentialName,
          exposure: task.subject.exposure,
        },
        decidedAt: new Date(task.decidedAt ?? at).toISOString(),
        ...(task.approvedBy === undefined ? {} : { approvedBy: task.approvedBy }),
        result: task.result.value,
        ...(task.result.exists === undefined ? {} : { exists: task.result.exists }),
        ...(task.result.rotatedAt === undefined ? {} : { rotatedAt: task.result.rotatedAt }),
      };
    },

    sweep,

    stats(): AsyncApprovalStats {
      let pending = 0;
      let awaitingCollection = 0;
      for (const task of tasks.values()) {
        if (task.status === "pending") pending += 1;
        else if (task.result !== undefined) awaitingCollection += 1;
      }
      return { requested, approved, refused, expired, pending, uncollected: uncollected + awaitingCollection };
    },

    dispose(): void {
      stopTimer();
      // Anything still stashed goes, on the principle that a credential outliving
      // the object that was approved to release it is the failure mode.
      tasks.clear();
    },
  };
}