/**
 * THE READER: THE ONE PATH FROM AN APPROVED CALL TO A VALUE.
 *
 * === THIS IS THE SEAM ADR-009 §4 NAMED AS THE BLOCKER ===
 *
 * `capability.ts` verifies. `store.ts` refuses to verify -- a store that signs its
 * own capabilities is an authority on its own isolation. So something has to sit
 * between the gateway and the store, hold the key, and translate a verified
 * signature into the `Capability` object the store will accept. That something is
 * this file, and it is the last piece between an approved call and a credential.
 *
 * === THE ORDER, WHICH IS THE SECURITY PROPERTY ===
 *
 * Verify, then read. Always. Anything that can refuse does so before the store is
 * touched, because the store is the slow, dangerous dependency: a refusal decided
 * after the value is in hand is a filter over a read, not a gate. The tests assert
 * this by checking the store's SOURCE was never loaded, not by checking the store
 * returned nothing -- the former is the property, the latter is a symptom.
 *
 * === WHY A REFERENCE IS THE DEFAULT, AND IT IS NOT A SANITISATION ===
 *
 * The reader of an MCP response is a language model. Its context window is not a
 * trusted place for a credential: it gets quoted, summarised, logged, echoed in the
 * next turn, and pasted into a ticket. Redacting at the edges -- masking characters,
 * warning the model, asking it not to repeat the value -- all leave the bytes in the
 * window, and a model asked not to say a thing is a model that has been told a thing.
 *
 * So the default answer does not contain the value at all. It is a REFERENCE: a
 * stable, non-reversible label derived from a salted digest, so an agent can hold
 * it, compare it, and cite it in a conversation, and a transcript full of references
 * leaks nothing. ADR-008 §5.3 named the missing operator standing instruction; this
 * is it, enforced in code rather than configured.
 *
 * === AND WHY RAW STILL EXISTS ===
 *
 * A tool that can never return a value has no use, and an option nobody can reach is
 * not an option -- it is a limitation waiting to be worked around somewhere less
 * careful. So raw is reachable and deliberately expensive: a caller flag, a warning
 * the operator cannot miss, and a SECOND, SEPARATE acknowledgement.
 *
 * One box ticked under a generic heading is how a credential ends up in a
 * transcript. The distinction between "approve this read" and "approve this read AND
 * put a live credential into a model's memory" is the entire reason the second
 * acknowledgement exists.
 *
 * === THE ONE THING THIS DOES NOT FIX, STATED PLAINLY ===
 *
 * In BOTH modes the value transits this process, because `store.ts` returns it.
 * Avoiding that needs a metadata-only read path in the store -- a capability that
 * answers "does this exist and when was it rotated" without materialising the bytes.
 * Until that exists, the reference protects the CONTEXT WINDOW and nothing else: it
 * does not reduce this process's exposure. Saying so here is the point; a reader
 * that let a reader believe otherwise would be worse than one that returned the
 * value outright.
 */

import { createHash, randomFillSync } from "node:crypto";

import { READ_SCOPE, verifyCapability, type CapabilityClaims } from "./capability.ts";
import { AuditUnavailableError, type TenantSecretStore } from "./store.ts";

/** What every reference starts with, so one is recognisable in a transcript. */
export const REDACTED_REF_PREFIX = "<redacted_credential_ref:";

/** How much of the caller's request this reader will act on. */
export type Exposure = "reference" | "metadata" | "raw";

/**
 * ONE REFUSAL, EVERY CAUSE.
 *
 * Unverified capability, wrong tenant, missing scope, expired, absent entry, a
 * store that faulted, an unacknowledged raw request -- all of them answer the same
 * way to the caller. A refusal that varies with its cause tells a probing agent
 * which grants are live and which entry names are real, which is an index rather
 * than a denial. The distinct codes stay inside this file, for the trail.
 */
const REFUSAL_CODE = "REFUSED";
const REFUSAL_MESSAGE = "this call cannot reach a credential";

export interface ReadRequest {
  readonly tenant: string;
  readonly credentialName: string;
  /** Defaults to a reference. Raw must be asked for AND acknowledged. */
  readonly exposure?: Exposure;  /**
   * The operator's SECOND acknowledgement, for raw only.
   *
   * Separate from `exposure` on purpose so that neither one alone is sufficient.
   * If they were the same field, a caller that could set the mode could satisfy
   * the acknowledgement too, and the warning would become decoration.
   */
  readonly acknowledged?: boolean;
}

export type ReadOutcome =
  | { readonly ok: true; readonly reference: string; readonly exposed: boolean; readonly metadata?: { readonly present: boolean; readonly rotatedAt: string } }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface ReaderAuditEvent {
  readonly at: string;
  readonly capabilityId: string;
  readonly tenant: string;
  readonly credentialName: string;
  /** "reference", "metadata" and "raw" are different events and the trail says which. */
  readonly exposure: Exposure | "refused";
  readonly reason: string;
}

export interface ApprovedCredentialReaderOptions {
  readonly store: TenantSecretStore;
  /** The opaque capability. Verified on every read, never cached past the call. */
  readonly capability: string;
  /** The signing key. Held here and nowhere else -- see `capability.ts`. */
  readonly verificationKey: Buffer;
  readonly now?: () => number;
  /** Optional trail. The durable log is wired here by the composition root. */
  readonly audit?: (event: ReaderAuditEvent) => void;
}

/** The port `server.ts` already expects. Satisfied by what this returns. */
export interface CredentialReader {
  read(request: ReadRequest): Promise<ReadOutcome>;
}

/**
 * A REFERENCE, AND NOTHING ELSE.
 *
 * A salted digest of the tenant, the entry name and the value, so:
 *   - it is stable, so the same credential has the same reference and a reader can
 *     be told "that is the one already rotated" without anybody handling bytes;
 *   - it is not reversible, so the reference cannot be used to recover the value;
 *   - it is scoped, so two tenants with an entry of the same name do not collide and
 *     a transcript cannot be used to correlate entries across tenants.
 *
 * The value is an input to the digest deliberately. A digest of the NAME alone would
 * be a dictionary: an attacker who guessed `payments/api-key` could predict its
 * reference. Including the value means the reference changes when the value rotates,
 * which is also how "the same reference" comes to mean "the same credential", not
 * merely "the same slot".
 */
/**
 * THE SEPARATOR BETWEEN HASHED FIELDS, AND WHY IT IS A NUL.
 *
 * A space would be ambiguous. Tenant "acme eu" with entry "key" and tenant "acme"
 * with entry "eu key" would digest identically, so two different credentials could
 * share a reference -- and a reference is a thing an agent holds and cites, so a
 * collision means it can be holding a handle to the wrong credential.
 *
 * NUL cannot occur inside a tenant id, an entry name or a value, so joining on it is
 * unambiguous by construction.
 *
 * It sat in this file as a RAW NUL BYTE for several commits before anybody noticed,
 * and the only symptom was that tooling classified the source as binary. It is an
 * escape now, and documented, so the next reader sees a decision rather than an
 * artefact.
 *
 * Exported because `worker/crypto-worker.ts` derives the reference digest from the
 * same field order and MUST use the same separator: two implementations of
 * "reference for this credential" that disagree produce two different references for
 * one credential, and a caller comparing them concludes the value rotated.
 */
export const FIELD_SEP = "\u0000";

function referenceFor(claims: CapabilityClaims, credentialName: string, value: Buffer): string {
  const digest = createHash("sha256")
    .update(claims.tenant)
    .update(FIELD_SEP)
    .update(credentialName)
    .update(FIELD_SEP)
    // The BYTES, not a string derived from them. Hashing a Buffer means the
    // credential never has to become a string to be referenced.
    .update(value)
    .digest("hex")
    .slice(0, 16);
  return `${REDACTED_REF_PREFIX}${digest}>`;
}

/**
 * ERASE A CREDENTIAL BUFFER, NOW, NOT WHENEVER THE COLLECTOR GETS ROUND TO IT.
 *
 * `randomFillSync` rather than `fill(0)`: a zero fill leaves the previous contents
 * in any copy-on-write page the engine made on the way, and it leaves a recognisable
 * pattern where a credential used to be. Random bytes over the same length mean
 * there is nothing left to recognise, and the operation is synchronous so the bytes
 * are gone before this function returns rather than at some later tick.
 *
 * === WHAT THIS DOES NOT DO, AND THE CODE SAYS SO RATHER THAN THE COMMIT ===
 *
 * It wipes THE BUFFER. It does not wipe:
 *
 *   - the string the file source parsed out of JSON, which is unreachable from here;
 *   - the string the raw path creates when it converts the buffer to answer a caller;
 *   - any copy V8 made internally while the buffer was alive.
 *
 * So this narrows a window that was measured in "until the collector runs" down to
 * one measured in "for the duration of the parse", which is the part that is
 * reachable. Closing the rest needs a binary credential format in which the value is
 * never a string at any point. Recorded on `SecretEntry` and in ADR-010.
 */
function wipe(value: Buffer): void {
  randomFillSync(value);
}

export function createApprovedCredentialReader(options: ApprovedCredentialReaderOptions): CredentialReader {
  const now = options.now ?? (() => Date.now());

  /**
   * WRITE THE READER'S OWN TRAIL, OR THROW.
   *
   * It used to swallow a failing sink, on the reasoning that a logging fault must
   * not become an outage. That reasoning was right about the wrong thing: the fault
   * it invited was somebody disabling the trail to keep the service up, and the
   * alternative -- refusing the read -- is cheaper than a gateway whose whole
   * justification is that the decisions are kept.
   *
   * The previous comment here claimed "the refusal is applied by the caller" and no
   * caller applied one. Swallowing was not fail-closed, it was fail-silent: the read
   * succeeded, the model received the reference, and no row existed. It throws the
   * same named error the store uses, so the gateway reports one fault rather than
   * two shapes of the same one.
   */
  const record = (event: ReaderAuditEvent): void => {
    try {
      options.audit?.(event);
    } catch {
      throw new AuditUnavailableError();
    }
  };

  const refuse = (
    claims: CapabilityClaims | undefined,
    tenant: string,
    credentialName: string,
    reason: string,
    capabilityId: string,
  ): ReadOutcome => {
    record({
      at: new Date(now()).toISOString(),
      capabilityId,
      tenant,
      credentialName,
      exposure: "refused",
      reason,
    });
    return { ok: false, code: REFUSAL_CODE, message: REFUSAL_MESSAGE };
  };

  return {
    async read(request: ReadRequest): Promise<ReadOutcome> {
      const credentialName = request.credentialName;
      const requested = request.exposure ?? "reference";

      /**
       * STEP 1: VERIFY. Before the store is touched, before the exposure is even
       * considered.
       *
       * The claims below are extracted from a VERIFIED signature. That is the whole
       * seam: the tenant handed to the store is `claims.tenant`, not
       * `request.tenant`, and a bug that made those differ would be the worst bug
       * this file could have.
       */
      const verdict = verifyCapability(options.capability, options.verificationKey, {
        tenant: request.tenant,
        scope: READ_SCOPE,
        now: now(),
      });
      if (!verdict.ok) {
        return refuse(undefined, request.tenant, credentialName, verdict.code, "unknown");
      }
      const claims = verdict.claims;

      /**
       * STEP 2: THE RAW REQUEST IS CHECKED BEFORE THE READ, NOT AFTER.
       *
       * Asking for raw is not the same as being allowed raw. Doing this before the
       * store call means an unacknowledged raw request never causes the value to be
       * loaded at all -- there is no window in which it existed here and was then
       * thrown away.
       */
      if (requested === "raw" && request.acknowledged !== true) {
        return refuse(claims, claims.tenant, credentialName, "raw exposure was not acknowledged", claims.capabilityId);
      }

      /**
       * === METADATA: THE PATH THAT DOES NOT LOAD THE VALUE AT ALL ===
       *
       * The reference path below hashes the credential, which means it has to hold
       * it -- so the default "safe" answer still pulled a live credential into this
       * process to produce a label containing none of it. This is the path that
       * closes that: it asks the store the metadata question and returns, and the
       * bytes never arrive.
       *
       * It is deliberately NOT reachable by setting the raw acknowledgement on a
       * reference request. The exposure decides what crosses the boundary; the boxes
       * only ever make the exposure MORE expensive to obtain.
       */
      if (requested === "metadata") {
        const described = await options.store.describe(
          {
            id: claims.capabilityId,
            tenant: claims.tenant,
            secrets: [credentialName],
            expiresAt: claims.expiresAt,
          },
          credentialName,
        );
        if (!described.ok) {
          return refuse(claims, claims.tenant, credentialName, "the store refused", claims.capabilityId);
        }
        record({
          at: new Date(now()).toISOString(),
          capabilityId: claims.capabilityId,
          tenant: claims.tenant,
          credentialName,
          exposure: "metadata",
          reason: "existence and rotation answered without loading the value",
        });
        return {
          ok: true,
          reference: `${REDACTED_REF_PREFIX}metadata>`,
          exposed: false,
          metadata: { present: described.metadata.present, rotatedAt: described.metadata.rotatedAt },
        };
      }

      // STEP 3: the read. The capability handed down is built from VERIFIED claims.
      //
      // Wrapped, because `store.retrieve` can fault in transit -- a source that
      // throws, a database that will not open. Uncontained it would escape into the
      // dispatcher and be reported there as a protocol fault, which is the wrong
      // layer and the wrong story: a credential that could not be read is a
      // refusal, not a broken server.
      let outcome: Awaited<ReturnType<TenantSecretStore["retrieve"]>>;
      try {
        outcome = await options.store.retrieve(
          {
            id: claims.capabilityId,
            tenant: claims.tenant,
            // Scoped to the entry that was ASKED FOR. Widening this to the capability's
            // full scope would let one approved read reach every entry the grant covers,
            // which is precisely the over-broad read an approval was supposed to bound.
            secrets: [credentialName],
            expiresAt: claims.expiresAt,
          },
          credentialName,
        );
      } catch (error) {
        /**
         * A BROKEN TRAIL IS NOT A REFUSAL, AND SAYING OTHERWISE IS A LIE.
         *
         * Everything else this catch turns into a refusal -- a source that threw, a
         * store that faulted in transit -- because "a credential that could not be
         * read is a refusal" is the right story for a caller. `AuditUnavailableError`
         * is a different fact: the read may well have succeeded and the RECORD of it
         * is what is missing. Reported as a refusal, an operator is told they lacked
         * authority for a request the gateway had already approved, and nobody goes
         * looking at the ledger. So it propagates and the gateway answers
         * INTERNAL_ERROR on the caller's id.
         */
        if (error instanceof AuditUnavailableError) throw error;
        return refuse(claims, claims.tenant, credentialName, "the store could not be read", claims.capabilityId);
      }

      if (!outcome.ok) {
        return refuse(claims, claims.tenant, credentialName, "the store refused", claims.capabilityId);
      }

      record({
        at: new Date(now()).toISOString(),
        capabilityId: claims.capabilityId,
        tenant: claims.tenant,
        credentialName,
        exposure: requested,
        reason: requested === "raw" ? "raw exposure approved and acknowledged" : "reference returned instead of the value",
      });

      if (requested === "raw") {
        // The string the caller receives is a NEW copy; erasing the buffer afterwards
        // does not touch it, and pretending otherwise would be the exact overclaim
        // this function exists to avoid. See `wipe`.
        const value = outcome.value.toString("utf8");
        wipe(outcome.value);
        return { ok: true, reference: value, exposed: true };
      }

      // REFERENCE: compute from the bytes, then wipe them before returning. The
      // ordering is the whole point -- the hash is taken first, and the buffer is
      // never readable by anything once this call returns.
      const reference = referenceFor(claims, credentialName, outcome.value);
      wipe(outcome.value);
      return { ok: true, reference, exposed: false };
    },
  };
}
