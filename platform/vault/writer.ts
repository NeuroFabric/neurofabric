/**
 * THE VAULT WRITER: THE ONLY THING IN THIS REPOSITORY THAT PRODUCES AN NFV1 FILE.
 *
 * === WHAT THIS CLOSES, AND WHAT IT STILL DOES NOT ===
 *
 * ADR-011 was implemented read-path-first, deliberately: the reader landed while the
 * writer did not, because a reader nobody has pointed at a file cannot strand a
 * deployment and a writer cannot be deployed safely without a reader to check it
 * against. This is the other half.
 *
 * **The gate is now open.** The ADR's read-before-build note says the byte layout
 * must be ratified before a file exists, and from this commit a file can exist. So
 * the layout is now a compatibility contract: changing §3 from here is a migration,
 * and §6 (dual-read, dual-write, verify, retire) stops being a plan and becomes a
 * prerequisite. That is recorded in the ADR rather than left to be discovered.
 *
 * === THE PAYLOAD IS NEVER A STRING. NOT ONCE, NOT TRANSIENTLY. ===
 *
 * The value goes in as a `Buffer` and is copied byte-for-byte into the entry run.
 * There is no `toString`, no template literal and no `Buffer.from(value, "utf8")`
 * anywhere on the payload path, and the type of `value` is `Buffer` so a string
 * cannot be passed by accident. The temporary body buffer is overwritten with random
 * bytes after it is on disk, for the reason in `reader.ts` `wipe`: a zero fill
 * leaves a recognisable pattern where a credential used to be.
 *
 * === THE DIGEST IS KEYED, AND THE ADR WAS WRONG ABOUT THAT ===
 *
 * ADR-011 §3.3 specified a bare SHA-256 over the body. The reader that was shipped
 * in the previous release computes **HMAC-SHA256** with the vault key, and this
 * writer matches the reader, because a writer whose files its own reader refuses is
 * not a writer.
 *
 * The ADR has been amended to say so, and the amendment is not cosmetic. A bare
 * SHA-256 over a credential file is a **corruption check only**: anyone who can
 * write the file can recompute the digest and the file verifies. HMAC makes forgery
 * require the key. The reader was already right; the document was under-specified,
 * and a document that describes the wrong algorithm is worse than no document.
 *
 * === THE WRITE IS ATOMIC, BECAUSE A HALF-WRITTEN VAULT IS A DECOY ===
 *
 * The body is written to a temporary file in the SAME directory, flushed, and then
 * renamed over the target. Rename within a filesystem is atomic, so a reader
 * opening the path sees either the old vault or the new one and never a truncated
 * mixture.
 *
 * This matters more than it looks. The reader verifies the digest before
 * interpreting anything, so a truncated file is refused rather than misread — but
 * "refused" during a rotation means the credential is unavailable at the moment
 * somebody changed it, which is the worst possible time to find out about a
 * non-atomic writer. The digest makes a partial file *safe*; the rename makes it
 * *not happen*.
 *
 * === NO WRITER-ONLY PLEASANTRIES ===
 *
 * There is no "write one entry" and no "append". A vault is written whole. Append
 * would need a re-signed trailer over every preceding byte on every append, which
 * is a rewrite wearing a hat, and the tombstone question in ADR-011 §8 is still
 * open precisely because append is expensive here.
 */

import { createHmac, randomBytes, randomFillSync } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

/* -------------------------------------------------------------------------- */
/* THE LAYOUT -- ADR-011 §3                                                    */
/* -------------------------------------------------------------------------- */

export const FILE_HEADER_BYTES = 16;
export const DIGEST_BYTES = 32;
export const ENTRY_HEADER_BYTES = 28;
export const MIN_VAULT_BYTES = FILE_HEADER_BYTES + DIGEST_BYTES;

const VAULT_MAGIC = "NFV1";
const ENTRY_MAGIC = "NFE1";
const FORMAT_VERSION = 1;

export const ENTRY_FLAG_PRESENT = 1 << 0;
export const ENTRY_FLAG_RETIRED = 1 << 1;
/** Everything outside the two defined bits. Written as zero, read as a hard refusal. */
export const ENTRY_FLAG_RESERVED_MASK = ~(ENTRY_FLAG_PRESENT | ENTRY_FLAG_RETIRED) & 0xff;

const UNKNOWN_INSTANT = 0;

/** The largest a u32 length field can hold. Checked before it can silently wrap. */
const MAX_U32 = 0xffffffff;

export interface VaultEntryInput {
  readonly tenant: string;
  readonly keyName: string;
  /**
   * THE CREDENTIAL, AS BYTES.
   *
   * `Buffer` and not `string`, and that is the point of the type: a caller with a
   * string has already made the copy this format exists to avoid, and a signature
   * accepting `string` would make the conversion look like the writer's job.
   */
  readonly value: Buffer;
  /** Epoch milliseconds. An i64 on disk, so this must not be a float. */
  readonly rotatedAt?: number | bigint;
  /** `ENTRY_FLAG_PRESENT` by default. Pass `0` for a tombstone. */
  readonly flags?: number;
}

export interface PackVaultOptions {
  /** The vault key. Required, non-empty, and never written anywhere near the file. */
  readonly hmacKey: Buffer;
}

export interface WrittenVault {
  readonly path: string;
  readonly bytes: number;
  readonly entries: number;
  /** ISO instant of the last rotation found in `entries`. */
  readonly rotatedAt: string;
}

/**
 * AN EMPTY KEY IS REFUSED, NOT ACCEPTED.
 *
 * `createHmac` accepts a zero-length key without complaint and produces a perfectly
 * valid MAC under it. So a caller that forgot to pass a key would get files that
 * the reader also accepts with an empty key — the format would work, the protection
 * would be absent, and nothing anywhere would report it.
 *
 * This is the one place the writer refuses rather than produces, and it refuses on
 * the configuration that would silently disable the security property.
 */
function requireKey(key: Buffer): Buffer {
  if (!Buffer.isBuffer(key)) {
    throw new TypeError("the vault key must be a Buffer");
  }
  if (key.length === 0) {
    throw new Error("the vault key must not be empty: an unkeyed digest is a forgery invitation");
  }
  return key;
}

function checkedLength(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_U32) {
    // Caught here rather than left to writeUInt32LE, which throws a RangeError
    // naming a byte offset and nothing about which field was wrong.
    throw new RangeError(`${label} does not fit a u32 length field`);
  }
  return value;
}

/**
 * PACK A WHOLE VAULT INTO ONE BUFFER.
 *
 * Returns the exact bytes of the file, including the trailer. The caller owns the
 * returned buffer and is responsible for overwriting it if it holds credentials —
 * `writeVault` does that for you, which is why it exists.
 */
export function packVault(
  entries: readonly VaultEntryInput[],
  options: PackVaultOptions,
): Buffer {
  const key = requireKey(options.hmacKey);

  if (entries.length > MAX_U32) {
    throw new RangeError("a vault cannot hold more entries than a u32 count can express");
  }

  const header = Buffer.alloc(FILE_HEADER_BYTES);
  header.write(VAULT_MAGIC, 0, "latin1");
  header.writeUInt16LE(FORMAT_VERSION, 4);
  header.writeUInt16LE(FILE_HEADER_BYTES, 6);
  header.writeUInt32LE(entries.length, 8);
  // RESERVED stays zero. A v1 reader refuses a non-zero value, so writing one would
  // produce a file this repository cannot read.
  header.writeUInt32LE(0, 12);

  const runs: Buffer[] = [header];

  for (const entry of entries) {
    if (!Buffer.isBuffer(entry.value)) {
      throw new TypeError("a credential value must be a Buffer, never a string");
    }
    const flags = entry.flags ?? ENTRY_FLAG_PRESENT;
    if ((flags & ENTRY_FLAG_RESERVED_MASK) !== 0) {
      // Writing a reserved bit would produce a file the reader hard-refuses, and the
      // refusal would point at the file rather than at this call.
      throw new RangeError("entry flags set a reserved bit the v1 reader refuses");
    }

    // The tenant and the key are NAMES, and they become bytes here and are never
    // decoded on the way in. The reader compares them on bytes (ADR-011 §4.5).
    const tenant = Buffer.from(entry.tenant, "utf8");
    const keyName = Buffer.from(entry.keyName, "utf8");
    const payload = entry.value;

    const tenantBytes = checkedLength("a tenant name", tenant.length);
    const keyBytes = checkedLength("a key name", keyName.length);
    const payloadBytes = checkedLength("a credential value", payload.length);

    const rotatedAt = entry.rotatedAt ?? UNKNOWN_INSTANT;
    const rotatedMs = typeof rotatedAt === "bigint" ? rotatedAt : BigInt(Math.trunc(rotatedAt));
    if (rotatedMs < -(2n ** 63n) || rotatedMs > 2n ** 63n - 1n) {
      throw new RangeError("rotatedAt does not fit an i64");
    }

    const entryHeader = Buffer.alloc(ENTRY_HEADER_BYTES);
    entryHeader.write(ENTRY_MAGIC, 0, "latin1");
    entryHeader.writeUInt8(flags, 4);
    // Offsets 5..7 are reserved and stay zero.
    entryHeader.writeUInt32LE(tenantBytes, 8);
    entryHeader.writeUInt32LE(keyBytes, 12);
    entryHeader.writeUInt32LE(payloadBytes, 16);
    entryHeader.writeBigInt64LE(rotatedMs, 20);

    runs.push(entryHeader, tenant, keyName, payload);
  }

  const body = Buffer.concat(runs);
  const digest = createHmac("sha256", key).update(body).digest();
  const file = Buffer.concat([body, digest]);

  // The key is not in `body`, but the payloads are, and this is the only place the
  // writer holds them outside the caller's buffer.
  randomFillSync(body);

  return file;
}

/**
 * WRITE A VAULT TO DISK, ATOMICALLY.
 *
 * The temp file is created in the SAME DIRECTORY as the target, because rename is
 * only atomic within a filesystem -- a temp file in the system temp directory on a
 * different mount would turn an atomic replace into a non-atomic copy.
 *
 * The temp file is removed on any failure. A leftover `.tmp` beside a vault is a
 * file containing every credential in it, and leaving one behind because a rename
 * failed would be an unpleasant surprise on the next disk-space incident.
 */
export async function writeVault(
  path: string,
  entries: readonly VaultEntryInput[],
  options: PackVaultOptions,
): Promise<WrittenVault> {
  const file = packVault(entries, options);

  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);

  let handle;
  try {
    // 'wx' fails if the path exists, so a collision cannot silently overwrite
    // somebody else's temporary file.
    handle = await open(temporary, "wx", 0o600);
    await handle.write(file, 0, file.length, 0);
    // Flush before the rename. Without this the rename can land while the bytes are
    // still in the page cache, and a power loss leaves a correctly named vault whose
    // contents are a truncated prefix of it.
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    // The packed file is the vault in memory. Overwrite it before this function
    // returns, whether or not the write succeeded.
    randomFillSync(file);
  }

  const rotated = entries.reduce<bigint>((latest, entry) => {
    const value = entry.rotatedAt ?? UNKNOWN_INSTANT;
    const ms = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
    return ms > latest ? ms : latest;
  }, 0n);

  return {
    path,
    bytes: file.length,
    entries: entries.length,
    rotatedAt: new Date(Number(rotated)).toISOString(),
  };
}