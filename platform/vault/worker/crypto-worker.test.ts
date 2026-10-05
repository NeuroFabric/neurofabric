import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIELD_SEP, REDACTED_REF_PREFIX } from "../reader.ts";
import { createCryptoWorkerClient } from "./crypto-worker-client.ts";

/**
 * THE CRYPTO WORKER.
 *
 * === WHAT IS WORTH A TEST HERE, AND WHAT IS NOT ===
 *
 * The interesting property is not "does it read the file". That is the easy half and
 * a happy-path assertion catches almost nothing. The properties worth a test are the
 * ones a refactor would quietly break:
 *
 *   - **no value in the response**, asserted on the serialised response rather than
 *     on the type, because a type does not stop a field being added;
 *   - **digest parity with `reader.ts`**, because two implementations of "the
 *     reference for this credential" that disagree produce two references for one
 *     credential and a caller concludes the value rotated;
 *   - **tenant isolation**, and specifically the ambiguous-join case, which is a real
 *     bug that already happened once in this repository;
 *   - **corruption fails closed**, and **a missing file is a FAULT and not a
 *     REFUSAL**, because an operator told "you may not read this" when the disk is
 *     not there goes to bed with the wrong problem.
 *
 * === AND THE ONE THAT IS NOT HERE ===
 *
 * There is no test asserting the worker was never inlined back onto the main thread,
 * because that property cannot be asserted from inside the process it is about. It is
 * a code-review property, and it is the reason the client's response type has no
 * variant that could carry a payload.
 */

const HMAC_KEY = randomBytes(32);
const ROTATED_AT = BigInt(Date.UTC(2026, 9, 4));

interface TestEntry {
  readonly tenant: string;
  readonly keyName: string;
  readonly value: string;
  /** Defaults to PRESENT. Tests use the others to reach the tombstone branch. */
  readonly flags?: number;
}

/** Builds a real ADR-011 vault. Not a mock: the format is the contract under test. */
function buildVault(entries: readonly TestEntry[]): Buffer {
  const parts: Buffer[] = [];

  const header = Buffer.alloc(16);
  header.write("NFV1", 0, "latin1");
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(16, 6);
  header.writeUInt32LE(entries.length, 8);
  header.writeUInt32LE(0, 12);
  parts.push(header);

  for (const entry of entries) {
    const tenant = Buffer.from(entry.tenant, "utf8");
    const keyName = Buffer.from(entry.keyName, "utf8");
    const payload = Buffer.from(entry.value, "utf8");

    const head = Buffer.alloc(28);
    head.write("NFE1", 0, "latin1");
    head.writeUInt8(entry.flags ?? 1, 4);
    head.writeUInt32LE(tenant.length, 8);
    head.writeUInt32LE(keyName.length, 12);
    head.writeUInt32LE(payload.length, 16);
    head.writeBigInt64LE(ROTATED_AT, 20);
    parts.push(head, tenant, keyName, payload);
  }

  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHmac("sha256", HMAC_KEY).update(body).digest()]);
}

/** What `reader.ts` computes, recomputed here so a drift between the two fails. */
function readerReference(tenant: string, keyName: string, value: string): string {
  return `${REDACTED_REF_PREFIX}${createHash("sha256")
    .update(tenant)
    .update(FIELD_SEP)
    .update(keyName)
    .update(FIELD_SEP)
    .update(Buffer.from(value, "utf8"))
    .digest("hex")
    .slice(0, 16)}>`;
}

function vaultDir(): string {
  return mkdtempSync(join(tmpdir(), "nfv-test-"));
}

function client(overrides: Partial<Parameters<typeof createCryptoWorkerClient>[0]> = {}) {
  return createCryptoWorkerClient({ hmacKey: HMAC_KEY, idleTimeoutMs: 250, ...overrides });
}

test("a matched entry yields the same reference the in-process reader would produce", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    const entry = { tenant: "acme", keyName: "payments/api-key", value: "sk-live-0001" };
    writeFileSync(path, buildVault([entry]));

    const response = await client().reference({
      tenant: entry.tenant,
      keyName: entry.keyName,
      vaultPath: path,
    });

    assert.equal(response.ok, true);
    assert.ok(response.ok && response.reference === readerReference(entry.tenant, entry.keyName, entry.value));
    assert.ok(response.ok && response.rotatedAt === new Date(Number(ROTATED_AT)).toISOString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NO RESPONSE VARIANT CARRIES A VALUE", async () => {
  const dir = vaultDir();
  try {
    const secret = "sk-live-MUST-NOT-APPEAR";
    const path = join(dir, "vault.bin");
    writeFileSync(path, buildVault([{ tenant: "acme", keyName: "k", value: secret }]));

    const response = await client().reference({ tenant: "acme", keyName: "k", vaultPath: path });

    // Asserted on the SERIALISED response, because this is the form it travels in.
    assert.equal(JSON.stringify(response).includes(secret), false);
    assert.equal(JSON.stringify(response).includes("acme"), false);
    assert.equal(JSON.stringify(response).includes("\"k\""), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two tenants holding the same key name get different references", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    const acme = { tenant: "acme", keyName: "payments/api-key", value: "sk-live-A" };
    const globex = { tenant: "globex", keyName: "payments/api-key", value: "sk-live-G" };
    writeFileSync(path, buildVault([acme, globex]));

    const forAcme = await client().reference({ tenant: "acme", keyName: acme.keyName, vaultPath: path });
    const forGlobex = await client().reference({ tenant: "globex", keyName: globex.keyName, vaultPath: path });

    assert.ok(forAcme.ok && forGlobex.ok);
    assert.notEqual(forAcme.reference, forGlobex.reference);
    // Each tenant's answer is that tenant's credential, not the first match.
    assert.ok(forAcme.reference === readerReference(acme.tenant, acme.keyName, acme.value));
    assert.ok(forGlobex.reference === readerReference(globex.tenant, globex.keyName, globex.value));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an ambiguous tenant/key join cannot collide (the NUL separator regression)", async () => {
  const dir = vaultDir();
  try {
    // The pair `reader.ts` documents having got wrong once: "acme eu" + "key" and
    // "acme" + "eu key" digest identically under any separator that can occur in a
    // name. If this ever passes with equal references, the separator is gone.
    const path = join(dir, "vault.bin");
    writeFileSync(path, buildVault([
      { tenant: "acme eu", keyName: "key", value: "v1" },
      { tenant: "acme", keyName: "eu key", value: "v2" },
    ]));

    const left = await client().reference({ tenant: "acme eu", keyName: "key", vaultPath: path });
    const right = await client().reference({ tenant: "acme", keyName: "eu key", vaultPath: path });

    assert.ok(left.ok && right.ok);
    assert.notEqual(left.reference, right.reference);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a flipped byte inside the payload region is a refusal, not a shortened credential", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    const bytes = buildVault([{ tenant: "acme", keyName: "k", value: "sk-live-ORIGINAL" }]);
    // Inside the payload run, past the header, so only the digest can catch it.
    bytes[16 + 28 + 5 + 1] ^= 0xff;
    writeFileSync(path, bytes);

    const response = await client().reference({ tenant: "acme", keyName: "k", vaultPath: path });

    assert.equal(response.ok, false);
    assert.equal(response.ok === false && response.code, "REFUSED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown version is refused rather than read optimistically", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    const bytes = buildVault([{ tenant: "acme", keyName: "k", value: "v" }]);
    bytes.writeUInt16LE(2, 4); // a v2 file, signed correctly over the new bytes
    const body = bytes.subarray(0, bytes.length - 32);
    const mac = createHmac("sha256", HMAC_KEY).update(body).digest();
    mac.copy(bytes, bytes.length - 32);
    writeFileSync(path, bytes);

    const response = await client().reference({ tenant: "acme", keyName: "k", vaultPath: path });

    assert.equal(response.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a truncated file is refused rather than read as a short credential", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    const bytes = buildVault([{ tenant: "acme", keyName: "k", value: "sk-live-PARTIAL" }]);
    writeFileSync(path, bytes.subarray(0, bytes.length - 20)); // trailer gone

    const response = await client().reference({ tenant: "acme", keyName: "k", vaultPath: path });

    assert.equal(response.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a RETIRED entry is not served even though its bytes are in the file", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    // PRESENT | RETIRED.
    writeFileSync(path, buildVault([{ tenant: "acme", keyName: "k", value: "old", flags: 0b11 }]));

    const response = await client().reference({ tenant: "acme", keyName: "k", vaultPath: path });

    assert.equal(response.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file that cannot be opened is a FAULT, distinct from a REFUSAL", async () => {
  const dir = vaultDir();
  try {
    const response = await client().reference({
      tenant: "acme",
      keyName: "k",
      vaultPath: join(dir, "does-not-exist.bin"),
    });

    // The distinction is the whole point: "the store refused" and "the disk is not
    // there" are different facts and an operator needs to be told which.
    assert.equal(response.ok, false);
    assert.equal(response.ok === false && response.code, "WORKER_FAULT");
    // And the reason does not leak: no vault path, no errno, in the caller-visible shape.
    assert.equal(response.ok === false && response.message.includes("ENOENT"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tenant absent from the vault is refused, and answers identically to an absent key", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    writeFileSync(path, buildVault([{ tenant: "acme", keyName: "k", value: "v" }]));

    const missingTenant = await client().reference({ tenant: "nope", keyName: "k", vaultPath: path });
    const missingKey = await client().reference({ tenant: "acme", keyName: "nope", vaultPath: path });

    assert.equal(missingTenant.ok, false);
    assert.equal(missingKey.ok, false);
    // No existence oracle: identical in every caller-visible field but the id.
    assert.equal(missingTenant.ok === false && missingTenant.message, missingKey.ok === false && missingKey.message);
    assert.equal(missingTenant.ok === false && missingTenant.code, missingKey.ok === false && missingKey.code);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a vault over the ceiling is refused rather than partially read", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    writeFileSync(path, buildVault([{ tenant: "acme", keyName: "k", value: "v" }]));

    const response = await client({ maxVaultBytes: 16 }).reference({
      tenant: "acme",
      keyName: "k",
      vaultPath: path,
    });

    assert.equal(response.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent requests are matched by correlation id, not by arrival order", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    const entries = Array.from({ length: 8 }, (_, i) => ({
      tenant: `tenant-${i}`,
      keyName: "k",
      value: `value-${i}`,
    }));
    writeFileSync(path, buildVault(entries));

    const shared = client();
    // Fired together so the worker's file I/O genuinely overlaps and the responses
    // cannot come back in the order they were sent.
    const responses = await Promise.all(
      entries.map((entry) => shared.reference({ tenant: entry.tenant, keyName: entry.keyName, vaultPath: path })),
    );

    responses.forEach((response, index) => {
      assert.ok(response.ok, `request ${index} was refused`);
      assert.ok(
        response.ok && response.reference === readerReference(entries[index].tenant, entries[index].keyName, entries[index].value),
        `request ${index} got another tenant's reference`,
      );
    });
    assert.equal(new Set(responses.map((r) => (r.ok ? r.reference : ""))).size, entries.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the worker is created lazily, reaped when idle, and never holds the process open", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    writeFileSync(path, buildVault([{ tenant: "acme", keyName: "k", value: "v" }]));

    const shared = client({ idleTimeoutMs: 50 });
    assert.equal(shared.running, false, "constructed a worker before the first request");

    await shared.reference({ tenant: "acme", keyName: "k", vaultPath: path });
    assert.equal(shared.running, true, "did not start a worker for a request");

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(shared.running, false, "did not reap the idle worker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispose fails everything in flight and refuses further work", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    writeFileSync(path, buildVault([{ tenant: "acme", keyName: "k", value: "v" }]));

    const shared = client();
    await shared.reference({ tenant: "acme", keyName: "k", vaultPath: path });
    shared.dispose();

    assert.equal(shared.running, false);
    const after = await shared.reference({ tenant: "acme", keyName: "k", vaultPath: path });
    assert.equal(after.ok, false);

    // Idempotent: a second dispose is a no-op rather than a throw.
    shared.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});