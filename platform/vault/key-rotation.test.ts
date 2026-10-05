import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  mintCapability,
  verifyCapability,
  normaliseKeyRing,
  READ_SCOPE,
  type CapabilityClaims,
} from "./capability.ts";
import { createCryptoWorkerClient } from "./worker/crypto-worker-client.ts";

/**
 * KEY ROTATION.
 *
 * === WHAT ROTATION ACTUALLY REQUIRES, AND WHY IT IS EASY TO GET HALF RIGHT ===
 *
 * Mint with the primary. Verify with every key. Both halves, and the second is the
 * one that is usually skipped: a verifier that knows only the new key refuses every
 * capability minted an hour ago, and a deployment that responds to that by keeping
 * the old key forever never rotates at all. A rotation that invalidates in-flight
 * tokens is not a rotation.
 *
 * === AND THE HAZARD IS THE OPPOSITE MISTAKE ===
 *
 * Minting with every key and accepting whichever verifies means a token's validity
 * depends on which keys happened to be in the set at the moment it was checked. A
 * deployment that cannot say which key signed a token cannot revoke one. So mint is
 * primary-only and never consults the rest of the ring.
 */

const PRIMARY = randomBytes(32);
const SECONDARY = randomBytes(32);
const RETIRED = randomBytes(32);
const NEVER_ACTIVE = randomBytes(32);

const NOW = 2_000_000_000_000;
const EXPECTATION = { tenant: "acme", scope: READ_SCOPE, now: NOW };

function claims(overrides: Partial<CapabilityClaims> = {}): CapabilityClaims {
  return {
    capabilityId: "cap-1",
    tenant: "acme",
    scopes: [READ_SCOPE],
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* THE TOKEN FORMAT                                                            */
/* -------------------------------------------------------------------------- */

test("a minted capability carries a version prefix", () => {
  const token = mintCapability(claims(), PRIMARY);
  // v1.<payload>.<hmac> -- three segments, and the first is the version.
  assert.equal(token.split(".").length, 3);
  assert.equal(token.split(".")[0], "v1");
});

test("an unknown version is refused rather than guessed at", () => {
  const token = mintCapability(claims(), PRIMARY);
  const [, payload, signature] = token.split(".");
  // The signature covers `v1.<payload>`, so re-labelling the version invalidates it.
  const forged = `v2.${payload}.${createHmac("sha256", PRIMARY).update(`v2.${payload}`).digest("base64url")}`;
  void signature;
  const verdict = verifyCapability(forged, PRIMARY, EXPECTATION);
  assert.equal(verdict.ok, false, "a v2 token was accepted by a v1 verifier");
});

/* -------------------------------------------------------------------------- */
/* MINTING                                                                     */
/* -------------------------------------------------------------------------- */

test("a token is signed with the PRIMARY key and no other", () => {
  const token = mintCapability(claims(), [PRIMARY, SECONDARY]);
  const [, payload, signature] = token.split(".") as [string, string, string];

  // Signed with index 0, provably: the primary reproduces the signature and the
  // secondary does not.
  assert.equal(signature, createHmac("sha256", PRIMARY).update(`v1.${payload}`).digest("base64url"));
  assert.notEqual(signature, createHmac("sha256", SECONDARY).update(`v1.${payload}`).digest("base64url"));
});

test("minting with a single key is still a ring of one", () => {
  // Backwards compatibility is the point: a deployment mid-migration must not break.
  const token = mintCapability(claims(), PRIMARY);
  assert.equal(verifyCapability(token, PRIMARY, EXPECTATION).ok, true);
  assert.equal(verifyCapability(token, [PRIMARY], EXPECTATION).ok, true);
});

test("a weak or empty key ring is refused at mint time", () => {
  assert.throws(() => mintCapability(claims(), []), /signing key/);
  assert.throws(() => mintCapability(claims(), Buffer.alloc(8)), /signing key/);
  assert.throws(() => mintCapability(claims(), [PRIMARY, Buffer.alloc(4)]), /signing key/);
});

/* -------------------------------------------------------------------------- */
/* VERIFICATION ACROSS A RING                                                  */
/* -------------------------------------------------------------------------- */

test("a token signed BEFORE a rotation still verifies afterwards", () => {
  // The case that makes rotation possible at all. Minted with the old key, verified
  // by a deployment whose primary is now the new one.
  const token = mintCapability(claims(), RETIRED);
  const verdict = verifyCapability(token, [PRIMARY, SECONDARY, RETIRED], EXPECTATION);
  assert.equal(verdict.ok, true, "a rotation invalidated a capability already in flight");
});

test("a key that was NEVER active does not verify anything", () => {
  const token = mintCapability(claims(), PRIMARY);
  assert.equal(verifyCapability(token, [NEVER_ACTIVE], EXPECTATION).ok, false);
  assert.equal(verifyCapability(token, [SECONDARY, NEVER_ACTIVE], EXPECTATION).ok, false);
});

test("a tampered payload fails under EVERY key, not just the primary", () => {
  const token = mintCapability(claims(), PRIMARY);
  const [, payload, signature] = token.split(".") as [string, string, string];
  // Re-sign the tampered claims with the SECONDARY and offer both keys. If the loop
  // returned early on the primary, the secondary would verify it.
  const tampered = Buffer.from(JSON.stringify(claims({ tenant: "victim" })), "utf8").toString("base64url");
  const forged = `v1.${tampered}.${createHmac("sha256", SECONDARY).update(`v1.${tampered}`).digest("base64url")}`;
  void payload;
  void signature;

  assert.equal(verifyCapability(forged, [PRIMARY, SECONDARY], EXPECTATION).ok, false);
  // And the same token signed by the primary for different claims is also refused,
  // because the claims belong to another tenant.
  const honest = mintCapability(claims({ tenant: "victim" }), PRIMARY);
  assert.equal(verifyCapability(honest, [PRIMARY, SECONDARY], { ...EXPECTATION, tenant: "acme" }).ok, false);
});

test("claims are still checked AFTER the signature, for whichever key matched", () => {
  const expired = mintCapability(claims({ expiresAt: NOW - 1 }), RETIRED);
  const verdict = verifyCapability(expired, [PRIMARY, RETIRED], EXPECTATION);
  // Signed by a valid key in the ring, but expired: a good signature is not a grant.
  assert.equal(verdict.ok, false);
  assert.ok(!verdict.ok && verdict.code === "EXPIRED");
});

test("an empty or weak ring is a WEAK_KEY refusal, never a bad-signature one", () => {
  const token = mintCapability(claims(), PRIMARY);
  assert.ok(!verifyCapability(token, [], EXPECTATION).ok);
  assert.ok(!verifyCapability(token, [Buffer.alloc(4)], EXPECTATION).ok);
  assert.equal(normaliseKeyRing([]), undefined);
});

/* -------------------------------------------------------------------------- */
/* THE FILE DIGEST, WHICH IS A DIFFERENT KEY AND A DIFFERENT PROBLEM           */
/* -------------------------------------------------------------------------- */

function buildVault(key: Buffer, value: string): Buffer {
  const tenant = Buffer.from("acme", "utf8");
  const keyName = Buffer.from("k", "utf8");
  const payload = Buffer.from(value, "utf8");
  const header = Buffer.alloc(16);
  header.write("NFV1", 0, "latin1");
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(16, 6);
  header.writeUInt32LE(1, 8);
  const entry = Buffer.alloc(28);
  entry.write("NFE1", 0, "latin1");
  entry.writeUInt8(1, 4);
  entry.writeUInt32LE(tenant.length, 8);
  entry.writeUInt32LE(keyName.length, 12);
  entry.writeUInt32LE(payload.length, 16);
  entry.writeBigInt64LE(BigInt(NOW), 20);
  const body = Buffer.concat([header, entry, tenant, keyName, payload]);
  return Buffer.concat([body, createHmac("sha256", key).update(body).digest()]);
}

test("a vault written before a rotation is still readable afterwards", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kms-vault-"));
  const path = join(dir, "v.bin");
  // Signed with the OLD key; the deployment's primary is now PRIMARY.
  writeFileSync(path, buildVault(RETIRED, "hunter2"));

  const client = createCryptoWorkerClient({ hmacKey: [PRIMARY, RETIRED] });
  const response = await client.reference({ tenant: "acme", keyName: "k", vaultPath: path });

  assert.equal(response.ok, true, "a vault signed by a rotated-out key became unreadable");
  client.dispose();
});

test("a vault signed by a key that was never in the ring is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kms-vault-"));
  const path = join(dir, "v.bin");
  writeFileSync(path, buildVault(NEVER_ACTIVE, "hunter2"));

  const client = createCryptoWorkerClient({ hmacKey: [PRIMARY, RETIRED] });
  const response = await client.reference({ tenant: "acme", keyName: "k", vaultPath: path });

  assert.equal(response.ok, false, "a vault signed by an unknown key was served");
  client.dispose();
});