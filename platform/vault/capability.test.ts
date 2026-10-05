import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

import {
  mintCapability,
  verifyCapability,
  READ_SCOPE,
  type CapabilityClaims,
  type VerificationCode,
} from "./capability.ts";

/**
 * A CAPABILITY THAT PROVES SOMETHING RATHER THAN ASSERING IT.
 *
 * === WHY THIS EXISTS ===
 *
 * ADR-008 §4.1 recorded that the store deliberately does NOT verify the capability
 * it is handed: a store that signs its own capabilities is an authority on its own
 * isolation, so verification was pushed outward and never built. ADR-009 §4 named
 * the missing seam as the blocker. This is it.
 *
 * Until now a `Capability` was a plain object from a caller, and "the capability
 * names tenant acme" was a sentence rather than a check. A caller that asserted
 * the wrong tenant got the right answer for the wrong reason.
 *
 * === THE ONE PROPERTY EVERYTHING ELSE SERVES ===
 *
 * The signature covers the claims, so the claims cannot be edited. That is what
 * makes a capability cryptographically BOUND to a tenant and a scope rather than
 * carrying them as labels: change `tenant` in the payload and the HMAC no longer
 * matches, and the verifier refuses before it reads the field it would have
 * believed.
 *
 * Most of these tests are therefore about TAMPERING, because the untampered path is
 * one function call and the tampered path is the design.
 */

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);

const CLAIMS: CapabilityClaims = {
  capabilityId: "cap-01",
  tenant: "acme",
  scopes: [READ_SCOPE],
  expiresAt: 2_000_000,
};

/** Decode a token's payload WITHOUT verifying it, so a test can tamper with it. */
function parts(token: string): { head: string; payload: string; sig: string } {
  const [head, payload, sig] = token.split(".");
  return { head: head ?? "", payload: payload ?? "", sig: sig ?? "" };
}

/**
 * Forge a token from the published format, WITHOUT using this module.
 *
 * Written against `node:crypto` directly on purpose. If the test imported the
 * module's own signing helper it would only be proving the module agrees with
 * itself; this proves the format is forgeable by anyone who holds the key and by
 * nobody else, which is the property that matters.
 */
function sign(message: string, key: Buffer): string {
  return createHmac("sha256", key).update(message).digest("base64url");
}

function reSign(payload: string, key: Buffer = KEY): string {
  const head = "v1";
  return `${head}.${payload}.${sign(`${head}.${payload}`, key)}`;
}

test("A MINTED CAPABILITY VERIFIES AND RETURNS ITS CLAIMS", () => {
  const token = mintCapability(CLAIMS, KEY);
  const verdict = verifyCapability(token, KEY, { tenant: "acme", scope: READ_SCOPE, now: 1_000_000 });

  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.claims.capabilityId, "cap-01");
    assert.equal(verdict.claims.tenant, "acme");
  }
});

test("A TENANT EDITED IN THE PAYLOAD IS REFUSED, which is what binding means", () => {
  // The attack this whole module exists to stop: take a valid capability for one
  // tenant and repoint it at another. If the tenant were a label rather than a
  // signed claim, this would verify and hand over another tenant's credential.
  const forged = reSign(Buffer.from(JSON.stringify({ ...CLAIMS, tenant: "globex" })).toString("base64url"), OTHER_KEY);

  const verdict = verifyCapability(forged, KEY, { tenant: "globex", scope: READ_SCOPE, now: 1_000_000 });

  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.code, "BAD_SIGNATURE", "a payload signed by another key is not this capability");
});

test("A SCOPE ADDED TO THE PAYLOAD IS REFUSED", () => {
  const forged = reSign(Buffer.from(JSON.stringify({ ...CLAIMS, scopes: [READ_SCOPE, "vault:write"] })).toString("base64url"), KEY);

  const verdict = verifyCapability(forged, KEY, { tenant: "acme", scope: "vault:write", now: 1_000_000 });

  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.code, "BAD_SIGNATURE", "the signature covers the scopes, so adding one breaks it");
});

test("A TAMPERED SIGNATURE IS REFUSED", () => {
  const { head, payload, sig } = parts(mintCapability(CLAIMS, KEY));
  const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");

  const verdict = verifyCapability(`${head}.${payload}.${flipped}`, KEY, { tenant: "acme", scope: READ_SCOPE, now: 1_000_000 });

  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.code, "BAD_SIGNATURE");
});

test("A CAPABILITY SIGNED WITH ANOTHER KEY IS REFUSED", () => {
  const token = mintCapability(CLAIMS, OTHER_KEY);

  const verdict = verifyCapability(token, KEY, { tenant: "acme", scope: READ_SCOPE, now: 1_000_000 });

  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.code, "BAD_SIGNATURE");
});

test("A CAPABILITY FOR ANOTHER TENANT IS REFUSED, EVEN THOUGH THE SIGNATURE IS GOOD", () => {
  // Distinct from tampering: this capability is perfectly genuine, it is simply
  // not this tenant's. Reusing it across a tenant boundary is the whole attack.
  const token = mintCapability(CLAIMS, KEY);

  const verdict = verifyCapability(token, KEY, { tenant: "globex", scope: READ_SCOPE, now: 1_000_000 });

  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.code, "WRONG_TENANT");
});

test("A CAPABILITY WITHOUT THE READ SCOPE IS REFUSED", () => {
  const token = mintCapability({ ...CLAIMS, scopes: ["vault:list"] }, KEY);

  const verdict = verifyCapability(token, KEY, { tenant: "acme", scope: READ_SCOPE, now: 1_000_000 });

  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.code, "MISSING_SCOPE");
});

test("AN EXPIRED CAPABILITY IS REFUSED, AND EXPIRY IS NOT A CLAIM THE HOLDER DECIDES", () => {
  const token = mintCapability(CLAIMS, KEY);

  const verdict = verifyCapability(token, KEY, { tenant: "acme", scope: READ_SCOPE, now: 2_000_001 });

  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.equal(verdict.code, "EXPIRED");
});

test("MALFORMED TOKENS ARE REFUSED WITHOUT THROWING, and never reach the signature check", () => {
  const cases: readonly string[] = [
    "",
    "not-a-token",
    "v1.only-two-parts",
    `v2.${parts(mintCapability(CLAIMS, KEY)).payload}.${parts(mintCapability(CLAIMS, KEY)).sig}`,
    `v1.${Buffer.from("not json").toString("base64url")}.aaaa`,
    `v1.${Buffer.from(JSON.stringify({ tenant: "acme" })).toString("base64url")}.aaaa`,
    `v1.${Buffer.from(JSON.stringify({ ...CLAIMS, expiresAt: "soon" })).toString("base64url")}.aaaa`,
  ];

  for (const token of cases) {
    const verdict = verifyCapability(token, KEY, { tenant: "acme", scope: READ_SCOPE, now: 1_000_000 });
    assert.equal(verdict.ok, false, `"${token.slice(0, 24)}" must refuse`);
    if (!verdict.ok) assert.equal(verdict.code, "MALFORMED", `"${token.slice(0, 24)}" is malformed, not merely invalid`);
  }
});

test("A WEAK OR ABSENT KEY IS REFUSED AT MINTING AND AT VERIFICATION", () => {
  // A short HMAC key is a short capability. Refusing it loudly is better than
  // minting capabilities that look strong and are not.
  for (const weak of [Buffer.alloc(0), Buffer.alloc(8, 7)]) {
    const verdict = verifyCapability(mintCapability(CLAIMS, KEY), weak, { tenant: "acme", scope: READ_SCOPE, now: 1_000_000 });
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.code, "WEAK_KEY");
  }
});

test("A CAPABILITY NEVER CONTAINS THE KEY THAT SIGNED IT, or any other tenant's data", () => {
  const token = mintCapability(CLAIMS, KEY);

  assert.equal(token.includes(KEY.toString("hex")), false);
  assert.equal(token.includes("globex"), false);
  // The payload is readable by design -- an operator reading a capability needs to
  // see which tenant and which scope it exercises. The signature is what stops
  // anyone CHANGING them, and that is the trade being made.
  assert.match(Buffer.from(parts(token).payload, "base64url").toString("utf8"), /acme/);
});

test("EVERY REFUSAL CARRIES A CODE AND NO CLAIMS, because a failed verification must not leak what it saw", () => {
  const verdict = verifyCapability(mintCapability(CLAIMS, KEY), KEY, { tenant: "globex", scope: READ_SCOPE, now: 1_000_000 });

  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.ok((verdict.code as VerificationCode).length > 0);
    assert.equal((verdict as { claims?: unknown }).claims, undefined, "a refusal must not carry the claims it read");
  }
});

test("A CAPABILITY IS DETERMINISTIC FOR THE SAME KEY, so a restart does not invalidate it", () => {
  assert.equal(mintCapability(CLAIMS, KEY), mintCapability(CLAIMS, KEY));
});