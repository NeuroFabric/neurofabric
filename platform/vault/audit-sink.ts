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
 */

import type { MemoryStore } from "../memory/store.ts";
import type { ApprovalAuditEvent } from "../embassy/elicitation.ts";

/** The action prefix, so every row this sink writes is greppable as one class. */
const ACTION_PREFIX = "vault.approval";

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