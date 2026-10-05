import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIELD_SEP, REDACTED_REF_PREFIX } from "./reader.ts";
import { createCryptoWorkerClient } from "./worker/crypto-worker-client.ts";
import { packVault, writeVault, ENTRY_FLAG_PRESENT, ENTRY_FLAG_RETIRED, DIGEST_BYTES, FILE_HEADER_BYTES } from "./writer.ts";

/**
 * THE WRITER, PROVEN AGAINST THE READER RATHER THAN AGAINST ITSELF.
 *
 * === WHY THE TEST READS THE FILE BACK WITH THE REAL CONSUMER ===
 *
 * A writer tested against a reimplementation of the format proves the two agree
 * with each other. It does not prove they agree with the READER, which is the
 * component that has to agree with them, and which was written and shipped before
 * this writer existed.
 *
 * So every round trip here goes: `writeVault` -> disk -> `createCryptoWorkerClient`
 * -> the same reference `reader.ts` computes. The expected value is derived from
 * ADR-011 §3 by hand and from `reader.ts`'s own digest scheme, never from the
 * writer's output, so a writer and reader that agree on the SAME wrong thing still
 * fails here.
 *
 * === AND WHY THE PAYLOADS IN THIS FILE ARE HOSTILE ===
 *
 * Most of these payloads are not valid UTF-8. `0x00`, `0xFF`, lone surrogates in
 * disguise, bytes that decode to replacement characters.
 *
 * That is the whole test. Every layer between a caller and this file is tempted to
 * make the payload a string, and a string round trip is not identity: invalid UTF-8
 * becomes U+FFFD, and the reference changes. A test using only printable ASCII
 * passes on a writer that corrupts every non-ASCII credential in production.
 */

const VAULT_KEY = randomBytes(32);
const ROTATED_AT = Date.UTC(2026, 9, 4, 12, 0, 0);

/** Bytes that must survive untouched. Includes NUL, invalid UTF-8, and a lone high byte. */
const BINARY_PAYLOAD = Buffer.from([
  0x00, 0xff, 0xfe, 0x80, 0x41, 0x0a, 0x00, 0xc3, 0x28, 0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80,
  0x7f, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xe2, 0x98, 0x83, 0x00, 0xff, 0xff, 0xff, 0xfe,
]);

function vaultDir(): string {
  return mkdtempSync(join(tmpdir(), "nfv-writer-"));
}

/**
 * The reference `reader.ts` computes.
 *
 * Built with plain `createHash`, deliberately, and deliberately NOT with the same
 * call shape the writer uses. Both are SHA-256 over the same three fields, so this
 * is an independent statement of the expected value rather than a second copy of the
 * writer's own logic -- which is what a reader and a writer agreeing on the same
 * wrong thing would look like.
 */
function expectedReference(tenant: string, keyName: string, value: Buffer): string {
  const hex = createHash("sha256")
    .update(tenant)
    .update(FIELD_SEP)
    .update(keyName)
    .update(FIELD_SEP)
    .update(value)
    .digest("hex")
    .slice(0, 16);
  return `${REDACTED_REF_PREFIX}${hex}>`;
}

/* -------------------------------------------------------------------------- */

test("a written vault is read back by the real reader, byte for byte", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    const entry = {
      tenant: "acme",
      keyName: "payments/api-key",
      value: BINARY_PAYLOAD,
      rotatedAt: ROTATED_AT,
    };

    const written = await writeVault(path, [entry], { hmacKey: VAULT_KEY });
    assert.equal(written.entries, 1);
    // Exact, not approximate: 16 header + 28 entry + 4 "acme" + 16 "payments/api-key"
    // + payload + 32 trailer.
    assert.equal(
      written.bytes,
      FILE_HEADER_BYTES + 28 + 4 + 16 + BINARY_PAYLOAD.length + DIGEST_BYTES,
      "the packed size does not match the layout in ADR-011 §3",
    );

    const client = createCryptoWorkerClient({ hmacKey: VAULT_KEY });
    const response = await client.reference({ tenant: "acme", keyName: "payments/api-key", vaultPath: path });

    assert.equal(response.ok, true, "the reader refused a file its own writer produced");
    assert.ok(
      response.ok && response.reference === expectedReference(entry.tenant, entry.keyName, BINARY_PAYLOAD),
      "the round-tripped reference differs from the one reader.ts would compute from the original bytes",
    );
    assert.ok(response.ok && response.rotatedAt === new Date(ROTATED_AT).toISOString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("many entries across many tenants all round-trip", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    const entries = Array.from({ length: 25 }, (_, i) => ({
      tenant: `tenant-${i % 5}`,
      keyName: `service/credential-${i}`,
      // Deliberately not ASCII, and not all the same length.
      value: Buffer.concat([Buffer.from(`value-${i}-`, "utf8"), BINARY_PAYLOAD]),
      rotatedAt: ROTATED_AT + i,
    }));
    await writeVault(path, entries, { hmacKey: VAULT_KEY });

    const client = createCryptoWorkerClient({ hmacKey: VAULT_KEY });
    const responses = await Promise.all(
      entries.map((entry) =>
        client.reference({ tenant: entry.tenant, keyName: entry.keyName, vaultPath: path }),
      ),
    );

    responses.forEach((response, index) => {
      const entry = entries[index]!;
      assert.equal(response.ok, true, `entry ${index} was refused`);
      assert.ok(
        response.ok && response.reference === expectedReference(entry.tenant, entry.keyName, entry.value),
        `entry ${index} came back as another credential`,
      );
    });
    assert.equal(new Set(responses.map((r) => (r.ok ? r.reference : ""))).size, entries.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a payload larger than one read chunk round-trips intact", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    // Comfortably past the reader's 64 KiB digest chunk, so the streamed digest and
    // the seeked region read are both exercised against a file bigger than either.
    const big = randomBytes(512 * 1024);
    const entry = { tenant: "acme", keyName: "blob", value: big, rotatedAt: ROTATED_AT };
    await writeVault(path, [entry], { hmacKey: VAULT_KEY });

    const client = createCryptoWorkerClient({ hmacKey: VAULT_KEY });
    const response = await client.reference({ tenant: "acme", keyName: "blob", vaultPath: path });

    assert.equal(response.ok, true);
    assert.ok(response.ok && response.reference === expectedReference("acme", "blob", big));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty credential is a credential, not an absence", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    const entry = { tenant: "acme", keyName: "blank", value: Buffer.alloc(0), rotatedAt: ROTATED_AT };
    await writeVault(path, [entry], { hmacKey: VAULT_KEY });

    const client = createCryptoWorkerClient({ hmacKey: VAULT_KEY });
    const response = await client.reference({ tenant: "acme", keyName: "blank", vaultPath: path });

    // Distinguishable from a missing entry, and correctly so: a credential rotated to
    // the empty string is a different fact from a credential that was never there.
    assert.equal(response.ok, true);
    assert.ok(response.ok && response.reference === expectedReference("acme", "blank", Buffer.alloc(0)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tombstone is written but not served", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    await writeVault(
      path,
      [{ tenant: "acme", keyName: "dead", value: Buffer.from("old"), rotatedAt: ROTATED_AT, flags: ENTRY_FLAG_PRESENT | ENTRY_FLAG_RETIRED }],
      { hmacKey: VAULT_KEY },
    );

    const client = createCryptoWorkerClient({ hmacKey: VAULT_KEY });
    const response = await client.reference({ tenant: "acme", keyName: "dead", vaultPath: path });

    // The bytes ARE in the file -- the digest covers them and the reader verified it
    // -- and the reader still declines, because the flag is checked before the run
    // is fetched.
    assert.equal(response.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a vault with no entries is a valid 48-byte file the reader declines to serve from", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    const written = await writeVault(path, [], { hmacKey: VAULT_KEY });

    // The minimum size in ADR-011 §3.4: header plus trailer and nothing else.
    assert.equal(written.bytes, FILE_HEADER_BYTES + DIGEST_BYTES);
    assert.equal(readFileSync(path).length, 48);

    const client = createCryptoWorkerClient({ hmacKey: VAULT_KEY });
    const response = await client.reference({ tenant: "acme", keyName: "anything", vaultPath: path });
    assert.equal(response.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* THE FILE ITSELF                                                             */
/* -------------------------------------------------------------------------- */

test("packing is deterministic: the same entries produce the same bytes", async () => {
  const entries = [
    { tenant: "acme", keyName: "k", value: BINARY_PAYLOAD, rotatedAt: ROTATED_AT },
    { tenant: "globex", keyName: "k", value: Buffer.from("v"), rotatedAt: ROTATED_AT },
  ];
  const a = packVault(entries, { hmacKey: VAULT_KEY });
  const b = packVault(entries, { hmacKey: VAULT_KEY });
  assert.ok(a.equals(b), "two packings of identical input differ");

  // And a different key must produce a different trailer, or the key is not in it.
  const other = packVault(entries, { hmacKey: randomBytes(32) });
  assert.equal(a.equals(other), false);
});

test("the bytes on disk have the layout ADR-011 §3 specifies", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    const value = Buffer.from("hunter2", "utf8");
    await writeVault(path, [{ tenant: "acme", keyName: "k", value, rotatedAt: ROTATED_AT }], { hmacKey: VAULT_KEY });

    const bytes = readFileSync(path);

    assert.equal(bytes.toString("latin1", 0, 4), "NFV1");
    assert.equal(bytes.readUInt16LE(4), 1, "FORMAT_VERSION");
    assert.equal(bytes.readUInt16LE(6), FILE_HEADER_BYTES, "HEADER_BYTES");
    assert.equal(bytes.readUInt32LE(8), 1, "ENTRY_COUNT");
    assert.equal(bytes.readUInt32LE(12), 0, "RESERVED must be written as zero");

    assert.equal(bytes.toString("latin1", 16, 20), "NFE1", "entry magic");
    assert.equal(bytes.readUInt8(20), ENTRY_FLAG_PRESENT, "FLAGS");
    assert.equal(bytes.readUInt32LE(24), 4, "TENANT_BYTES");
    assert.equal(bytes.readUInt32LE(28), 1, "KEY_BYTES");
    assert.equal(bytes.readUInt32LE(32), value.length, "PAYLOAD_BYTES");
    assert.equal(bytes.readBigInt64LE(36), BigInt(ROTATED_AT), "ROTATED_AT");
    assert.equal(bytes.toString("utf8", 44, 48), "acme", "TENANT");
    assert.equal(bytes.toString("utf8", 48, 49), "k", "KEY");
    assert.equal(bytes.toString("utf8", 49, 49 + value.length), "hunter2", "PAYLOAD");

    // And the trailer is a keyed MAC over everything before it, recomputed here.
    const expected = createHmac("sha256", VAULT_KEY).update(bytes.subarray(0, bytes.length - DIGEST_BYTES)).digest();
    assert.ok(bytes.subarray(bytes.length - DIGEST_BYTES).equals(expected), "the trailer is not the keyed digest of the body");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the payload bytes appear verbatim, including NUL and invalid UTF-8", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    await writeVault(path, [{ tenant: "acme", keyName: "k", value: BINARY_PAYLOAD, rotatedAt: ROTATED_AT }], { hmacKey: VAULT_KEY });

    const bytes = readFileSync(path);
    const payloadOffset = payloadOffsetFor(4, 1); // "acme", "k"

    // The payload run is copied byte-for-byte. If any layer had made it a string,
    // 0xff/0xfe would have become U+FFFD and this would not match.
    assert.ok(
      bytes.subarray(payloadOffset, payloadOffset + BINARY_PAYLOAD.length).equals(BINARY_PAYLOAD),
      "the payload did not survive the write unchanged",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Where the payload run BEGINS: file header, entry header, tenant, key. */
function payloadOffsetFor(tenantBytes: number, keyBytes: number): number {
  return FILE_HEADER_BYTES + 28 + tenantBytes + keyBytes;
}

test("the write leaves no temporary file behind", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    await writeVault(path, [{ tenant: "acme", keyName: "k", value: Buffer.from("v"), rotatedAt: ROTATED_AT }], { hmacKey: VAULT_KEY });

    const leftovers = readdirSync(dir).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, [], "a temp file was left beside the vault, holding every credential in it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rewriting replaces the vault wholesale", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    await writeVault(path, [{ tenant: "acme", keyName: "old", value: Buffer.from("v1"), rotatedAt: ROTATED_AT }], { hmacKey: VAULT_KEY });
    await writeVault(path, [{ tenant: "acme", keyName: "new", value: Buffer.from("v2"), rotatedAt: ROTATED_AT }], { hmacKey: VAULT_KEY });

    const client = createCryptoWorkerClient({ hmacKey: VAULT_KEY });
    assert.equal((await client.reference({ tenant: "acme", keyName: "new", vaultPath: path })).ok, true);
    assert.equal((await client.reference({ tenant: "acme", keyName: "old", vaultPath: path })).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* WHAT THE WRITER REFUSES                                                     */
/* -------------------------------------------------------------------------- */

test("an empty vault key is refused rather than silently producing an unkeyed file", () => {
  // createHmac accepts a zero-length key and produces a valid MAC under it, so this
  // is the one configuration where the writer would work perfectly and protect
  // nothing at all.
  assert.throws(() => packVault([], { hmacKey: Buffer.alloc(0) }), /must not be empty/);
});

test("a string credential value is refused by the type check", () => {
  assert.throws(
    () =>
      packVault(
        [{ tenant: "acme", keyName: "k", value: "a string credential" as unknown as Buffer, rotatedAt: ROTATED_AT }],
        { hmacKey: VAULT_KEY },
      ),
    /must be a Buffer/,
  );
});

test("reserved flag bits are refused before they produce an unreadable file", () => {
  assert.throws(
    () =>
      packVault(
        [{ tenant: "acme", keyName: "k", value: Buffer.from("v"), rotatedAt: ROTATED_AT, flags: 0b1000_0000 }],
        { hmacKey: VAULT_KEY },
      ),
    /reserved bit/,
  );
});

test("a vault signed with one key is refused by a reader holding another", async () => {
  const dir = vaultDir();
  try {
    const path = join(dir, "vault.bin");
    await writeVault(path, [{ tenant: "acme", keyName: "k", value: Buffer.from("v"), rotatedAt: ROTATED_AT }], { hmacKey: VAULT_KEY });

    const wrongKey = createCryptoWorkerClient({ hmacKey: randomBytes(32) });
    const response = await wrongKey.reference({ tenant: "acme", keyName: "k", vaultPath: path });

    // Proves the key is actually load-bearing in the trailer rather than advisory.
    assert.equal(response.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});