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
  readonly value: string;
  /** ISO instant of the last rotation, carried through to the caller. */
  readonly rotatedAt: string;
}

/** Everything one tenant holds. */
export interface SecretSet {
  readonly tenant: string;
  readonly secrets: readonly SecretEntry[];
}

/**
 * Where a tenant's secrets come from.
 *
 * A port, not a file read, for the reason `portal-routes.ts` takes a vault rather
 * than importing one: a store that reached into a file itself would make the
 * credential location a property of this module, and the operator's control over
 * where those bytes live is the one lever they should not have to argue for.
 */
export interface SecretSource {
  load(tenant: string): Promise<SecretSet | undefined>;
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
  readonly value: string;
  readonly rotatedAt: string;
}

export interface RetrievalRefused {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type RetrievalOutcome = RetrievalGranted | RetrievalRefused;

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

export function createTenantSecretStore(options: TenantSecretStoreOptions): TenantSecretStore {
  const now = options.now ?? (() => Date.now());

  const record = (event: VaultAuditEvent): void => {
    try {
      options.audit(event);
    } catch {
      // A broken audit sink must NOT become an open door. The alternative --
      // letting the sink's exception propagate -- would turn a logging fault
      // into an outage, and an outage in this path would be somebody disabling
      // the trail to keep the service up. The read is refused instead, so a
      // broken trail means no reads rather than unaudited reads.
      throw new Error("the audit trail is unavailable");
    }
  };

  const refuse = (
    capability: Capability,
    name: string,
    reason: "absent" | "expired" | "revoked" | "ungranted" | "unknown-tenant" | "audit-unavailable",
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
  };
}