/**
 * APPROVALS INTO THE DURABLE LEDGER.
 *
 * === WHAT ADR-010 A5 SAID, AND WHY IT WAS RIGHT ===
 *
 * The gate's decisions went to stderr. That is a log line, and a log line is
 * rotated, collected and eventually deleted -- while the platform is simultaneously
 * claiming, on the strength of this gate, that "a named person approved this
 * specific read". A claim that cannot be produced after the fact is not a control;
 * it is a message. This is the sink that makes the claim true.
 *
 * === WHY A SINK RATHER THAN A FLAG ===
 *
 * The gate must not know what a database is. It takes a function, which is what
 * makes it testable with a closure and deployable against SQLite without either
 * side growing an opinion about the other. The wedge keeps its decisions in
 * `MemoryStore`; this writes approvals into the same ledger, through the same
 * append-only table, so an investigator reads one place.
 *
 * === WHAT A ROW DOES NOT CARRY, AND WHY ===
 *
 * No credential. The ledger outlives the credential, so a row holding one would turn
 * a durable approval log into a durable credential archive -- a strictly worse thing
 * to protect than the thing it is protecting. The row carries the capability ID, the
 * tenant, the entry NAME, the exposure, the operator and the reason: enough to
 * answer "who authorised this, for what, and why", and not enough to reconstruct
 * anything.
 *
 * === IT THROWS, ON PURPOSE ===
 *
 * There is no catch here. A sink that swallowed a write failure would let the gate
 * believe a decision was recorded when it was not, and fail-closed depends on the
 * error arriving. Swallowing it at this layer would move the failure somewhere it
 * cannot be seen.
 *
 * === THE THREE ROW CLASSES, AND WHY THEY ARE THREE ===
 *
 * | Action | Written by | The fact it records |
 * |---|---|---|
 * | `vault.approval.*` | the gate | a PERSON decided |
 * | `vault.read.*` | the store | an ATTEMPT was granted or refused |
 * | `vault.exposure.*` | the reader | WHAT crossed the boundary |
 *
 * The second and third are separate rows rather than one row with an `exposure`
 * field, and the reason is a boundary neither side can cross. The store does not
 * know whether the caller received a reference or the credential itself -- it hands
 * back bytes and the decision about those bytes is the reader's. The reader does not
 * know whether the grant was checked, revoked or expired. Widening either interface
 * to carry the other's field would put a question in the module that cannot answer
 * it honestly, and an audit row nobody trusts is worse than a missing one because it
 * is read as present.
 *
 * All three carry `capability` under that name, so "what was approved for cap-01 and
 * what did cap-01 then actually reach" is one join over one field.
 */

import type { MemoryStore } from "../memory/store.ts";
import type { ApprovalAuditEvent } from "../embassy/elicitation.ts";
import type { ReaderAuditEvent } from "./reader.ts";
import type { VaultAuditEvent } from "./store.ts";

/** The action prefix, so every row this sink writes is greppable as one class. */
const ACTION_PREFIX = "vault.approval";
/** A grant and a refusal are the same two facts a store can report about a read. */
const READ_ACTION_PREFIX = "vault.read";
/** What crossed the boundary. The reader's row, because the reader is what chose. */
const EXPOSURE_ACTION_PREFIX = "vault.exposure";

export interface DurableSinkOptions {
  /**
   * The ledger directory, recorded IN the row.
   *
   * So an investigator holding a row knows which store to open. Without it a
   * decision is a fact with no address, which is the difference between a record and
   * a rumour when there is more than one deployment.
   */
  readonly directory?: string;
}

/**
 * A sink that appends one immutable row per decision.
 *
 * Throws if the ledger will not take the write -- see the file header. Callers that
 * need to fail closed already do.
 */
export function createDurableApprovalSink(
  ledger: MemoryStore,
  options: DurableSinkOptions = {},
): (event: ApprovalAuditEvent) => void {
  return (event: ApprovalAuditEvent): void => {
    ledger.appendAudit(
      event.tenant,
      // A refusal has no operator. "nobody" is the honest value; inventing a name
      // for a decision no human made would be the first lie in the ledger.
      event.approvedBy ?? "nobody",
      `${ACTION_PREFIX}.${event.outcome}`,
      {
        capability: event.capability,
        tenant: event.tenant,
        credentialName: event.credentialName,
        tool: event.tool,
        /**
         * WHAT was approved, verbatim from the subject -- not the outcome.
         *
         * Remapping this to "granted" or "refused" would lose the only field that
         * says whether an operator agreed to a non-reversible reference or to a live
         * value in a model's context. Those are materially different agreements and
         * a row that cannot distinguish them cannot answer the question it exists
         * for. The outcome is already the row's `action`, so nothing is lost.
         */
        exposure: event.exposure,
        decision: event.outcome,
        reason: event.reason,
        decidedAt: event.at,
        ...(options.directory === undefined ? {} : { ledger: options.directory }),
      },
    );
  };
}

/**
 * A STORE READ INTO THE SAME LEDGER.
 *
 * === WHAT WAS WRONG, AND IT WAS NOT THE NAMESPACE ===
 *
 * The store's trail went to stderr. The reasoning for leaving it there was sound for
 * the CREDENTIALS -- a deployment with no ledger still gets a working, refusing
 * embassy -- and wrong for the TRAIL, which is the record that a credential left the
 * process. A stderr line is rotated and eventually deleted, so an investigator
 * searching for "what touched `payments/api-key` last Tuesday" was searching a
 * stream that no longer exists.
 *
 * === WHY success/failure RATHER THAN granted/refused ===
 *
 * Because the row's `document` already carries the store's own word for the outcome
 * verbatim, so nothing is lost -- and because `vault.read.*` sits next to
 * `vault.approval.*` in one table, where "granted" would read as "approved" and the
 * two would be conflated by anyone querying at 2am. The refusal to share a word is
 * the point.
 */
export function createDurableReadSink(
  ledger: MemoryStore,
  options: DurableSinkOptions = {},
): (event: VaultAuditEvent) => void {
  return (event: VaultAuditEvent): void => {
    ledger.appendAudit(
      event.tenant,
      /**
       * THE CAPABILITY, AS THE ACTOR.
       *
       * The approval rows name a person because a person decided. The store does not
       * verify capabilities -- `reader.ts` does, upstream of it -- so the only
       * authority this module can honestly attribute a read to is the capability it
       * was handed. Putting `"nobody"` here would be false and putting a tenant in
       * it would be a second authority for one the core already answers.
       */
      event.capabilityId,
      `${READ_ACTION_PREFIX}.${event.outcome === "granted" ? "success" : "failure"}`,
      {
        capability: event.capabilityId,
        tenant: event.tenant,
        credentialName: event.name,
        // The store's own word, kept: the row is a faithful record of the event, not
        // a translation of it into the action's vocabulary.
        outcome: event.outcome,
        readAt: event.at,
        ...(options.directory === undefined ? {} : { ledger: options.directory }),
      },
    );
  };
}

/**
 * WHAT ACTUALLY CROSSED THE BOUNDARY.
 *
 * The row that answers "was a live credential put into a model's context", which is
 * the question ADR-009 §4 exists to police and the question neither of the other two
 * rows can answer. `exposure` is carried verbatim, so `vault.exposure.raw` is
 * distinguishable from `vault.exposure.reference` after the fact -- a distinction
 * that is the entire reason raw requires a second acknowledgement box.
 *
 * The reason travels too, because "raw exposure approved and acknowledged" and
 * "raw exposure was not acknowledged" are the same action with opposite meanings,
 * and an investigator asking why a value was exposed deserves the answer in the row
 * rather than from a transcript.
 */
export function createDurableExposureSink(
  ledger: MemoryStore,
  options: DurableSinkOptions = {},
): (event: ReaderAuditEvent) => void {
  return (event: ReaderAuditEvent): void => {
    ledger.appendAudit(
      event.tenant,
      // No person decided this; the capability was asserted and verified upstream.
      event.capabilityId,
      `${EXPOSURE_ACTION_PREFIX}.${event.exposure}`,
      {
        capability: event.capabilityId,
        tenant: event.tenant,
        credentialName: event.credentialName,
        exposure: event.exposure,
        reason: event.reason,
        exposedAt: event.at,
        ...(options.directory === undefined ? {} : { ledger: options.directory }),
      },
    );
  };
}