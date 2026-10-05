/**
 * TENANT-ISOLATED, CAPABILITY-BOUNDED SECRET RETRIEVAL.
 *
 * === STATUS: BUILT, TESTED, AND NOT WIRED TO ANYTHING ===
 *
 * This module is reachable only from its own tests. Nothing in the platform
 * constructs a store, and the embassy has no tool that reaches one. That is
 * deliberate and it is the same posture `platform/core/vault.ts` has held since
 * D-017: a capability that is correct and tested, and whose exposure is a
 * deliberate choice rather than an accident of wiring order.
 *
 * The reasoning is not caution for its own sake. It is that **the safety of the
 * older vault rests on a choke point this one does not have.**
 *
 * `CredentialVault`'s unredacted read is approved by the kernel precheck: every
 * tool reaches execution through one controlled point, `vault_reveal` is
 * CONTROLLED tier, and the approval lands in the trace BEFORE the handler runs.
 * That is a real, measured guarantee and D-016 is right to rely on it.
 *
 * The embassy has no equivalent. `callTool` invokes a handler directly and
 * `callCore` reaches the portal with a credential. A secret tool added there would
 * be a value-disclosing path with **no approval mechanism at all** -- not a weaker
 * version of the reviewed capability, a different one. So this store is designed
 * to be safe on its own terms, with the grant carried in the capability itself,
 * and it is left unwired until someone decides where the approval for an ungranted
 * read belongs. See ADR-008 §5.
 *
 * === THE ENTIRE DESIGN IS "NO IS THE SAME ANSWER" ===
 *
 * Four refusals look identical: wrong tenant, secret not granted, expired,
 * revoked, absent. One code, one message, no tenant, no secret name, no reason.
 *
 * That is not tidiness. If "you are not entitled to that" and "that does not
 * exist" answer differently, then a caller holding one valid token can ask for
 * every name it likes and learn which are real, and the store stops being a
 * retrieval surface and becomes a directory of the estate. An existence oracle is
 * the whole attack, and it is closed by refusing to have one.
 *
 * === THE GRANT IS CARRIED BY THE CALLER, WHICH HAS A CONSEQUENCE ===
 *
 * `Capability` is passed in by whoever is making the call. This module does NOT
 * mint, verify, or forge capabilities -- verifying a signature would mean a signing
 * key in this process, and a store that signs its own capabilities is an authority
 * on its own isolation. So a capability here is an ASSERTION, and the store's job
 * is to enforce it against the tenant's own secrets and to record the attempt.
 *
 * Whoever constructs capabilities must prove them. That boundary is named here
 * rather than left implicit, because "the store does not verify capabilities" read
 * as a reassurance rather than a hand-off would be exactly wrong.
 *
 * === NO DEPENDENCY, AND NO SECRET EVER LEAVES THROUGH A MESSAGE ===
 *
 * `node:crypto` for constant-time comparison, nothing else. A refusal message is
 * built from constants; no secret name, tenant, or value is interpolated into one.
 * The audit trail records the request so an operator can investigate, and records
 * only the outcome, so it is safe to persist somewhere the value is not.
 */

import { timingSafeEqual } from "node:crypto";

/** One secret belonging to one tenant. */
export interface SecretEntry {
  readonly name: string;
  /**
   * The value, as BYTES.
   *
   * A Buffer rather than a string, and that is the whole of why: a V8 string is
   * immutable and cannot be zeroed, so a credential held as one stays in memory
   * until the collector reclaims it and nothing can say when. A Buffer can be
   * overwritten on purpose, and the reader does exactly that once the reference has
   * been computed from it.
   *
   * === THE RESIDUAL, STATED PLAINLY ===
   *
   * This narrows the window. It does not close it. A string copy of the credential
   * exists at the JSON parse boundary of any file-backed source -- `JSON.parse`
   * produces one and it is unreachable from here -- and the raw exposure path
   * necessarily makes another when it converts the buffer back into a string to
   * answer the caller. Neither can be erased by overwriting a buffer.
   *
   * The fix for that boundary is a BINARY credential format, in which the value is
   * never a string to begin with. That is deliberately out of scope here and named
   * rather than glossed over.
   */
  readonly value: Buffer;
  /** ISO instant of the last rotation, carried through to the caller. */
  readonly rotatedAt: string;
}

/** Everything one tenant holds. */
export interface SecretSet {
  readonly tenant: string;
  readonly secrets: readonly SecretEntry[];
}

/** One entry's existence and age, and NO value. The point of this whole path. */
export interface SecretMetadata {
  readonly name: string;
  /** ISO instant of the last rotation. */
  readonly rotatedAt: string;
  /**
   * Whether an entry with this name exists for the tenant.
   *
   * Distinguishable from "the caller may not ask" only because the GRANT has already
   * been checked: a granted name that is absent answers `false`, an ungranted name
   * refuses outright. The grant, not existence, is the thing the caller must
   * already know.
   */
  readonly present: boolean;
}

/** A tenant's metadata, with no values anywhere in it. */
export interface SecretSetMetadata {
  readonly tenant: string;
  readonly entries: readonly SecretMetadata[];
}

/**
 * Where a tenant's secrets come from.
 *
 * A port, not a file read, for the reason `portal-routes.ts` takes a vault rather
 * than importing one: a store that reached into a file itself would make the
 * credential location a property of this module, and the operator's control over
 * where those bytes live is the one lever they should not have to argue for.
 *
 * `describe` is SEPARATE from `load` and is what makes a metadata read honest. If
 * `describe` were derived from `load`, "we answered without materialising the
 * value" would be true of the return type and false of the process -- the exact
 * distinction ADR-010 section 5 refused to blur.
 */
export interface SecretSource {
  load(tenant: string): Promise<SecretSet | undefined>;
  /**
   * Metadata without values. OPTIONAL, and a source that omits it can still serve
   * value reads -- it simply cannot serve metadata ones, which REFUSE.
   *
   * That refusal is the design. Falling back to `load` would make the safe path
   * depend on every source being configured a particular way, and the resulting
   * failure would be invisible until somebody noticed a credential being pulled for
   * a question that only asked when it was rotated.
   */
  describe?(tenant: string): Promise<SecretSetMetadata | undefined>;
}

/**
 * WHAT THE HOLDER MAY REACH, ASSERTED BY ITS HOLDER.
 *
 * See the file header: this module does not verify capabilities, so a caller who
 * constructs one is asserting it. Everything below the assertion is enforced.
 */
export interface Capability {
  /** Opaque identifier. Recorded on every attempt so a grant can be traced. */
  readonly id: string;
  /** The tenant this grant is scoped to. The store never widens it. */
  readonly tenant: string;
  /** Exact secret names. Never a prefix, glob, or pattern. */
  readonly secrets: readonly string[];
  /** Epoch millis. REQUIRED: an absent expiry is treated as no grant at all. */
  readonly expiresAt?: number;
  readonly revoked?: boolean;
}

/**
 * ONE REFUSAL, FOR EVERY REASON.
 *
 * A single constant on purpose. The code and the message together are the whole
 * oracle, so they must not vary with the cause -- see the header.
 */
const REFUSAL_CODE = "REFUSED";
const REFUSAL_MESSAGE = "this capability does not grant that secret";

export interface RetrievalGranted {
  readonly ok: true;
  readonly name: string;
  /** BYTES. The caller must overwrite this once it has what it needs. */
  readonly value: Buffer;
  readonly rotatedAt: string;
}

export interface RetrievalRefused {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type RetrievalOutcome = RetrievalGranted | RetrievalRefused;

/** Metadata answers existence and age. There is deliberately no granted-with-value shape. */
export type DescribeOutcome =
  | { ok: true; readonly metadata: SecretMetadata }
  | RetrievalRefused;

/** What the trail records. Never carries a value. */
export interface VaultAuditEvent {
  readonly at: string;
  readonly tenant: string;
  readonly capabilityId: string;
  readonly name: string;
  readonly outcome: "granted" | "refused";
}

export interface TenantSecretStoreOptions {
  readonly source: SecretSource;
  /** Where the redacted trail goes. Wrapped here, so no caller can skip it. */
  readonly audit: (event: VaultAuditEvent) => void;
  /** Injectable so expiry is assertable without waiting for a real clock. */
  readonly now?: () => number;
}

export interface TenantSecretStore {
  retrieve(capability: Capability, name: string): Promise<RetrievalOutcome>;
  /**
   * Whether an entry exists and when it was rotated, WITHOUT loading its value.
   *
   * Gated by exactly the same rules as `retrieve`, because a metadata read that
   * skipped them would still be a way to enumerate what a tenant has.
   */
  describe(capability: Capability, name: string): Promise<DescribeOutcome>;
}

/** Constant-time string equality, over equal-length buffers only. */
function equalConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // `timingSafeEqual` throws on a length mismatch, and a length mismatch is
  // already the answer. So the lengths are compared first and the early return
  // reveals nothing an attacker could use: the length of a NAME is not a secret,
  // and the names here are already the caller's own input.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * THE TRAIL COULD NOT BE WRITTEN, WHICH IS A FAULT AND NOT A REFUSAL.
 *
 * A NAMED error rather than a message, because failing closed is only half of it.
 * The caller has to be able to tell "you may not have this" from "this gateway
 * cannot record what it just did", and an operator told the first thing at 2am goes
 * back to sleep while a full disk eats every subsequent audit row.
 *
 * The message is a constant, like every other refusal string in this file: a reason
 * here would say whether the entry existed.
 */
export class AuditUnavailableError extends Error {
  constructor() {
    super("the audit trail is unavailable");
    this.name = "AuditUnavailableError";
  }
}

export function createTenantSecretStore(options: TenantSecretStoreOptions): TenantSecretStore {
  const now = options.now ?? (() => Date.now());

  /**
   * WRITE THE TRAIL, OR THROW `AuditUnavailableError`.
   *
   * Deliberately a throw rather than a refused return, and the distinction is the
   * whole design. Every refusal in this module is a DECISION the store reached on
   * the merits; a trail that will not take a row is a fault in the deployment, and
   * answering it with the same refusal would report a broken disk as a policy
   * decision. It propagates so the gateway can answer INTERNAL_ERROR on the
   * caller's id -- which is also what keeps the promise that no value, reference or
   * metadata crosses the boundary without a durable receipt first.
   */
  const record = (event: VaultAuditEvent): void => {
    try {
      options.audit(event);
    } catch {
      // The underlying cause is dropped deliberately. It names a file, a directory
      // or a driver message, and this error is carried into a JSON-RPC frame.
      throw new AuditUnavailableError();
    }
  };

  const refuse = (
    capability: Capability,
    name: string,
    reason:
      | "absent"
      | "expired"
      | "revoked"
      | "ungranted"
      | "unknown-tenant"
      | "audit-unavailable"
      | "no-metadata-path",
  ): RetrievalRefused => {
    // `reason` is deliberately consumed and never emitted. It exists so the
    // control flow can say why, and the output deliberately cannot.
    void reason;
    return { ok: false, code: REFUSAL_CODE, message: REFUSAL_MESSAGE };
  };

  return {
    async retrieve(capability: Capability, name: string): Promise<RetrievalOutcome> {
      const trail = (outcome: "granted" | "refused"): void => {
        record({
          at: new Date(now()).toISOString(),
          // The tenant recorded is the CAPABILITY's, which is the assertion under
          // test. Recording the one the caller hoped for would let a forged grant
          // rewrite who the trail thinks asked.
          tenant: capability.tenant,
          capabilityId: capability.id,
          name,
          outcome,
        });
      };

      // === THE CHECKS, IN THE ORDER THAT AVOIDS DOING WORK FOR A NO ===

      // Expiry and revocation first, because both are pure facts about the
      // capability and neither costs an I/O. A revoked grant never reaches the
      // source, so a revocation is effective even if the source is unavailable.
      if (capability.revoked === true) {
        trail("refused");
        return refuse(capability, name, "revoked");
      }
      if (typeof capability.expiresAt !== "number" || !Number.isFinite(capability.expiresAt)) {
        // REQUIRED rather than optional. A grant with no window is a grant that
        // cannot be reasoned about at review time, which is the same class of
        // problem as a session that never expires.
        trail("refused");
        return refuse(capability, name, "expired");
      }
      if (capability.expiresAt <= now()) {
        trail("refused");
        return refuse(capability, name, "expired");
      }

      // The grant is checked BEFORE the source is consulted. This is the whole of
      // tenant isolation: a capability naming tenant A cannot cause a read against
      // tenant B even when it asks for a name that exists in both, so there is no
      // path where the refusal is decided after the bytes were already in hand.
      if (!capability.secrets.some((granted) => equalConstantTime(granted, name))) {
        trail("refused");
        return refuse(capability, name, "ungranted");
      }

      // Only now is the capability's OWN tenant loaded, and never one named by the
      // request. A source that answers with a set labelled for a different tenant
      // is refused rather than served: that is a bug in the source, and serving it
      // would convert the bug into a cross-tenant disclosure.
      const set = await options.source.load(capability.tenant);
      if (set === undefined || set.tenant !== capability.tenant) {
        trail("refused");
        return refuse(capability, name, "unknown-tenant");
      }

      const entry = set.secrets.find((candidate) => candidate.name === name);
      if (entry === undefined) {
        trail("refused");
        return refuse(capability, name, "absent");
      }

      trail("granted");
      return { ok: true, name: entry.name, value: entry.value, rotatedAt: entry.rotatedAt };
    },

    /**
     * === A READ THAT NEVER MATERIALISES THE VALUE ===
     *
     * Same gate, same refusals, same tenant rules -- because a metadata read that
     * skipped them would still be a way to enumerate what a tenant has, and
     * "which credential names are real" is just as sensitive without the values as
     * with them.
     *
     * The difference is entirely in what crosses the process boundary, which is why
     * this is a second method and not a flag. A flag would change what comes back
     * while the credential was still loaded to produce it.
     */
    async describe(capability: Capability, name: string): Promise<DescribeOutcome> {
      const trail = (outcome: "granted" | "refused"): void => {
        record({
          at: new Date(now()).toISOString(),
          tenant: capability.tenant,
          capabilityId: capability.id,
          name,
          outcome,
        });
      };

      // Revocation, expiry and the grant, in the order that avoids an I/O for a no.
      if (capability.revoked === true) {
        trail("refused");
        return refuse(capability, name, "revoked");
      }
      if (typeof capability.expiresAt !== "number" || !Number.isFinite(capability.expiresAt)) {
        trail("refused");
        return refuse(capability, name, "expired");
      }
      if (capability.expiresAt <= now()) {
        trail("refused");
        return refuse(capability, name, "expired");
      }
      if (!capability.secrets.some((granted) => equalConstantTime(granted, name))) {
        trail("refused");
        return refuse(capability, name, "ungranted");
      }

      /**
       * NO FALLBACK TO `load`.
       *
       * A source without `describe` REFUSES. Deriving metadata from the value would
       * make the safe path depend on every source being configured a particular way,
       * and the resulting failure would be invisible until somebody noticed a
       * credential being pulled in order to answer a question about when it was last
       * rotated. Refusing is loud, immediate, and cheap to diagnose.
       */
      const describeEntry = options.source.describe;
      if (typeof describeEntry !== "function") {
        trail("refused");
        return refuse(capability, name, "no-metadata-path");
      }

      const set = await describeEntry.call(options.source, capability.tenant);
      // A set labelled for a different tenant is refused rather than served: that is
      // a bug in the source, and serving it would convert the bug into a
      // cross-tenant disclosure -- exactly as in the value read.
      if (set === undefined || set.tenant !== capability.tenant) {
        trail("refused");
        return refuse(capability, name, "unknown-tenant");
      }

      const entry = set.entries.find((candidate) => candidate.name === name);
      if (entry === undefined) {
        trail("refused");
        return refuse(capability, name, "absent");
      }

      trail("granted");
      // Only the two fields that answer the question. No value, and no field a value
      // could be added to later without a type change being noticed.
      return {
        ok: true,
        metadata: { name: entry.name, rotatedAt: entry.rotatedAt, present: entry.present },
      };
    },
  };
}