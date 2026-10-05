/**
 * A CAPABILITY THAT PROVES SOMETHING RATHER THAN ASSERTING IT.
 *
 * === THE SEAM THIS FILLS ===
 *
 * ADR-008 §4.1 recorded that `store.ts` deliberately does NOT verify the capability
 * it is handed, and that a store which signs its own capabilities is an authority on
 * its own isolation — so verification was pushed outward and, until now, never
 * built. ADR-009 §4 named that as the blocker for wiring the vault at all.
 *
 * This is the outside. A capability is now an opaque token whose tenant and scopes
 * are covered by an HMAC, and `store.ts` receives a `Capability` extracted from a
 * verified signature rather than from anything a caller said.
 *
 * === WHY HMAC AND NOT A PUBLIC/SIGNATURE PAIR ===
 *
 * Zero dependencies, and this is a single process minting for itself. There is no
 * second party verifying, so there is nothing asymmetric buys: distributing a public
 * key would mean publishing the ability to MINT, which is exactly the authority
 * being kept in one place. HMAC's requirement — that the verifier hold the signing
 * key — is already the deployment's shape, so symmetric is not a compromise here.
 *
 * === WHAT "BOUND" MEANS, PRECISELY ===
 *
 * The signature covers the payload, so the claims cannot be edited. That is the whole
 * difference between a capability and a label: a token saying `tenant: acme` proves
 * nothing, and a token whose HMAC covers `tenant: acme` proves it. Change the tenant
 * in the payload and verification fails BEFORE the verifier reads the field it would
 * otherwise have believed — which is why the tamper tests assert `BAD_SIGNATURE`
 * rather than `WRONG_TENANT`.
 *
 * === THE PAYLOAD IS READABLE, AND THAT IS THE TRADE ===
 *
 * Base64url, not encrypted. An operator reading a capability needs to see which
 * tenant and which scope it exercises, and a secret that only the verifier can read
 * is one nobody can audit. The signature is what stops anyone CHANGING it. For a
 * credential to be present, this would be wrong — for a grant descriptor, it is
 * correct, and the two are never confused here.
 *
 * === NO DEPENDENCY, AND NOTHING IN AN ERROR PATH THAT COULD BE USED ===
 *
 * `node:crypto` and nothing else. Comparison is constant-time via `timingSafeEqual`,
 * so a caller cannot learn a correct signature one byte at a time. Refusals carry a
 * code and never carry the claims that were read.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** The scope a capability needs to exercise a credential read. */
export const READ_SCOPE = "vault:read";

/** The one thing this module will mint, and the only thing it will accept. */
export interface CapabilityClaims {
  readonly capabilityId: string;
  readonly tenant: string;
  readonly scopes: readonly string[];
  /** Epoch millis. Required: a grant with no window is not a grant. */
  readonly expiresAt: number;
}

/**
 * THE REFUSALS, AND WHY THEY ARE DISTINCT INTERNALLY.
 *
 * They differ so the audit trail can say what happened — a bad signature and an
 * expired capability are different operational problems. They are NOT what the
 * caller sees: the reader maps all of them to one outward answer, because a refusal
 * that varies with its cause is an index of what exists.
 */
export type VerificationCode = "MALFORMED" | "BAD_SIGNATURE" | "WEAK_KEY" | "EXPIRED" | "WRONG_TENANT" | "MISSING_SCOPE";

export type Verification =
  | { readonly ok: true; readonly claims: CapabilityClaims }
  | { readonly ok: false; readonly code: VerificationCode };

/** What the verifier is checking FOR. None of it comes from the token. */
export interface Expectation {
  /** The tenant the caller is asking on behalf of. Must match a signed claim. */
  readonly tenant: string;
  readonly scope: string;
  readonly now: number;
}

/** Token version. Bumping it retires every outstanding capability at once. */
const VERSION = "v1";

/**
 * A SIGNING KEY WORTH THE NAME. 256 bits.
 *
 * A short HMAC key is a short capability, and minting with one produces tokens that
 * look strong and are not. Refused loudly at both ends rather than warned about.
 */
const MIN_KEY_BYTES = 32;

function usableKey(key: Buffer): boolean {
  return Buffer.isBuffer(key) && key.length >= MIN_KEY_BYTES;
}

function sign(message: string, key: Buffer): string {
  return createHmac("sha256", key).update(message).digest("base64url");
}

/** Constant-time over equal-length buffers; the length check happens first. */
function sameBytes(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Read the claims WITHOUT verifying anything.
 *
 * Separate from `verifyCapability` on purpose: this is the decode step, and the
 * only thing allowed to call it is the verifier, which must not act on the result
 * until the signature has been checked. Keeping the two apart is what makes
 * "verified before trusted" a structural property rather than a careful ordering.
 */
function decodePayload(payload: string): CapabilityClaims | undefined {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;

  const claims = value as Record<string, unknown>;
  const { capabilityId, tenant, scopes, expiresAt } = claims;

  if (typeof capabilityId !== "string" || capabilityId === "") return undefined;
  if (typeof tenant !== "string" || tenant === "") return undefined;
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) return undefined;
  // A non-numeric expiry is refused rather than coerced. `expiresAt: "soon"` must
  // not become `NaN`, and `NaN` compares false against everything -- which would
  // make an unparseable expiry mean "never expires" rather than "refused".
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return undefined;

  return { capabilityId, tenant, scopes: scopes as readonly string[], expiresAt };
}

/**
 * Mint a capability. Deterministic for a given key and claims, so a restart does not
 * invalidate anything already handed out.
 */
export function mintCapability(claims: CapabilityClaims, key: Buffer): string {
  if (!usableKey(key)) {
    throw new Error(`a signing key of at least ${MIN_KEY_BYTES} bytes is required`);
  }
  if (typeof claims.expiresAt !== "number" || !Number.isFinite(claims.expiresAt)) {
    throw new Error("a capability must carry a numeric expiry");
  }
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const head = `${VERSION}.${payload}`;
  return `${head}.${sign(head, key)}`;
}

/**
 * Verify a capability against what the CALLER is asking for.
 *
 * The order is the security property: decode for shape, recompute and compare the
 * signature, and only then read the claims for a decision. Everything that can
 * refuse on the token alone refuses before any claim is believed.
 */
export function verifyCapability(token: string, key: Buffer, expected: Expectation): Verification {
  if (typeof token !== "string" || token === "") return { ok: false, code: "MALFORMED" };
  if (!usableKey(key)) return { ok: false, code: "WEAK_KEY" };

  const segments = token.split(".");
  if (segments.length !== 3) return { ok: false, code: "MALFORMED" };
  const [version, payload, signature] = segments as [string, string, string];
  if (version !== VERSION) return { ok: false, code: "MALFORMED" };

  const claims = decodePayload(payload);
  if (claims === undefined) return { ok: false, code: "MALFORMED" };

  // THE GATE. Nothing above this line has believed a claim; nothing below it can be
  // reached without the key.
  if (!sameBytes(signature, sign(`${VERSION}.${payload}`, key))) {
    return { ok: false, code: "BAD_SIGNATURE" };
  }

  // From here the claims are this deployment's own, so acting on them is safe.
  if (claims.expiresAt <= expected.now) return { ok: false, code: "EXPIRED" };
  if (!sameBytes(claims.tenant, expected.tenant)) return { ok: false, code: "WRONG_TENANT" };
  if (!claims.scopes.some((scope) => sameBytes(scope, expected.scope))) {
    return { ok: false, code: "MISSING_SCOPE" };
  }

  return { ok: true, claims };
}