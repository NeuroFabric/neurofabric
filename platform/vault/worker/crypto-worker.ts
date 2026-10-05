/**
 * THE CRYPTO WORKER: THE ONLY THING IN THIS PROCESS THAT OPENS THE VAULT FILE.
 *
 * === WHAT THIS IS FOR, IN ONE SENTENCE ===
 *
 * Every other reader of this vault opens the file on the main thread, where the
 * event loop lives, where every other tenant's traffic is being served, and where a
 * single heap dump reveals every credential the process has ever touched. This file
 * exists so that the main thread **never holds a credential byte at all**: it names
 * a tenant, a key and a file, and receives a label containing none of their content.
 *
 * === THE MOVE THAT MAKES IT WORK ===
 *
 * The obvious design is to read the file on the main thread and send the bytes to
 * the worker. That design is worthless, and not marginally: once the bytes are on
 * the main thread they are on the event loop, they are in the V8 old space, they
 * are reachable by anything holding a heap snapshot, and they are copied into the
 * worker's heap by the structured clone. The worker would own a *second* copy and
 * the first would still be there.
 *
 * So the worker opens the file itself. The main thread passes a *path and a name*.
 * Names are not credentials. The bytes never arrive in the thread that serves
 * traffic.
 *
 * === WHAT IS ACTUALLY ELIMINATED, AND WHAT IS NOT ===
 *
 * Eliminated, on the main thread: every payload byte, every digest chunk, every
 * intermediate buffer, and every wipe that would have had to happen there.
 *
 * NOT eliminated, and stated here because the alternative is a header that implies
 * more than is true:
 *
 *   - **The HMAC key transits the main thread.** It is handed over in an `init`
 *     message and a copy is made. Wiping that copy helps; it does not mean the key
 *     was never resident. A deployment that wants the key absent from this process
 *     entirely should pass the worker a *path to a key file* and let it open that
 *     too. Not done here because it invents a key-management decision this ADR does
 *     not own.
 *   - **Swap and paging.** A worker thread is a thread, not a process. The kernel
 *     can page a worker's resident pages exactly as it can page the main thread's.
 *     ADR-011 §5(2) is untouched by this file and remains the largest residual.
 *   - **The payload still exists in this machine's memory** — in the worker's heap,
 *     for the duration of one call, and then overwritten with random bytes. It is a
 *     smaller and differently-shaped window than before, not a closed one.
 *
 * The claim being made is exactly this: **the credential does not enter the thread
 * that serves traffic.** That is worth having. It is not "the credential does not
 * exist in memory".
 *
 * === THE FORMAT RULES ARE NOT REIMPLEMENTED HERE, THEY ARE CITED ===
 *
 * The byte layout, the refusal rules and the bounded-read requirement live in
 * ADR-011. This file follows §4 pass 1 / pass 2 / pass 3 and does not negotiate
 * with it. Where ADR-011 and this file disagree, ADR-011 is right and this file has
 * a bug.
 *
 * === AND THE WORKER IS NOT A TRUST BOUNDARY ===
 *
 * It is an *isolation* boundary, not a *security* boundary. The main thread can
 * already ask for any tenant's any key through this interface; the capability check
 * in `reader.ts` is what decides whether it may, and it runs before anything here is
 * invoked. Moving bytes into a worker does not authorise a read, and a worker that
 * could be asked to verify its own authorisations would be a much worse design.
 */

import { createHash, createHmac, randomFillSync, timingSafeEqual } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { isMainThread, parentPort } from "node:worker_threads";

import { FIELD_SEP, REDACTED_REF_PREFIX } from "../reader.ts";

/**
 * THE ONE UNIT OF RESIDENCY, AND IT HAS A NAME.
 *
 * ADR-011 §1.1 requires a single named constant rather than a literal at each call
 * site, precisely so there is one number to answer "how much of the vault can be
 * resident in this process at once" with. Here that answer is this number, for the
 * digest pass, and for every other buffer in this file the answer is smaller still.
 *
 * A larger value is not faster in any way that matters at these sizes and is
 * strictly worse at the only question this file exists to answer.
 */
export const CHUNK_BYTES = 64 * 1024;

/** Header and trailer sizes, fixed by ADR-011 §3.1 and §3.3. */
const FILE_HEADER_BYTES = 16;
const DIGEST_BYTES = 32;
const ENTRY_HEADER_BYTES = 28;
const MIN_VAULT_BYTES = FILE_HEADER_BYTES + DIGEST_BYTES; // 48, §3.4

const VAULT_MAGIC = "NFV1";
const ENTRY_MAGIC = "NFE1";
const FORMAT_VERSION = 1;
const ENTRY_FLAG_PRESENT = 1 << 0;
const ENTRY_FLAG_RETIRED = 1 << 1;
const ENTRY_FLAG_RESERVED_MASK = ~(ENTRY_FLAG_PRESENT | ENTRY_FLAG_RETIRED) & 0xff;

/**
 * A CEILING ON THE FILE, NOT ON A VALUE.
 *
 * ADR-011 §8 asks whether the summed entry lengths need a bound and notes that one
 * is cheap. This is that bound, applied at the only point where an untrusted length
 * can cause an allocation: `size` comes off the filesystem and is the input to the
 * first read. Everything downstream is bounded by `size`, so bounding `size` bounds
 * the walk.
 *
 * It is a refusal, not a truncation. A vault larger than the ceiling is a deployment
 * the operator has to make a decision about, and silently reading the first N bytes
 * of a credential store is the failure this whole format exists to prevent.
 */
const DEFAULT_MAX_VAULT_BYTES = 64 * 1024 * 1024;

/* -------------------------------------------------------------------------- */
/* THE CONTRACT                                                                */
/* -------------------------------------------------------------------------- */

/**
 * ONE REQUEST, AND EVERYTHING IT CARRIES.
 *
 * Look at what is absent: there is no value field, no offset field, and no handle.
 * A caller can name a tenant, a key and a path. It cannot supply bytes, cannot ask
 * for bytes back, and cannot say where in the file to look — which means it cannot
 * use this interface to read a region of the vault the entry walk would not reach.
 *
 * The request is JSON-serialisable and structured-cloneable by construction. A
 * `Buffer` on this interface would be a credential on the main thread wearing a
 * different type name, and the compiler would not stop it.
 */
export interface CryptoWorkRequest {
  /**
   * Matches this request to its response.
   *
   * Necessary because a worker is a long-lived, concurrently-drained thing: two
   * reads for two tenants overlap in time, and a response with no id on it could be
   * delivered to the wrong caller. The id is checked before the response is handed
   * on, and an unmatched response is dropped rather than guessed at.
   */
  readonly correlationId: string;
  readonly tenant: string;
  readonly keyName: string;
  /** The binary vault. Opened by the worker, never by the caller. */
  readonly vaultPath: string;
}

/**
 * ONE RESPONSE, AND EVERYTHING IT CAN CARRY.
 *
 * The success variant is a **label**, not a value: a salted digest truncated to 16
 * hex characters, prefixed so it is recognisable in a transcript. It contains no
 * tenant, no key name and no credential content — the tenant and key are inputs to
 * the digest, not fields in the output, so the reference cannot be used to recover
 * either.
 *
 * There is no variant of this type that carries a payload, and that is the property
 * worth asserting rather than the one worth documenting. `ok: true` with a `value`
 * field does not exist to be added later without the type changing.
 *
 * The failure variant is split into two codes rather than one, deliberately:
 *
 *   - `REFUSED` means the worker read the file and decided no. Format mismatch,
 *     digest mismatch, tenant not found, key not found, file too large.
 *   - `WORKER_FAULT` means the worker could not finish. It threw, it died, it timed
 *     out. It never got to a decision.
 *
 * Collapsing these would tell an operator that the disk was full when the answer is
 * that a credential store refused, and would let a caller distinguish "this vault
 * is broken" from "you may not read this" — which is precisely the existence oracle
 * that `store.ts` refuses to have and that the uniform refusal message exists to
 * prevent.
 */
export type CryptoWorkResponse =
  | {
      readonly ok: true;
      readonly correlationId: string;
      /** `<redacted_credential_ref:...>`. Derived from the bytes, contains none of them. */
      readonly reference: string;
      /** ISO instant, carried through so the caller need not read the file to answer it. */
      readonly rotatedAt: string;
    }
  | {
      readonly ok: false;
      readonly correlationId: string;
      readonly code: string;
      readonly message: string;
    };

/** What the main thread sends down. `init` once, then `work` per request. */
export type CryptoWorkerInbound =
  | { readonly type: "init"; readonly hmacKey: Buffer; readonly maxVaultBytes?: number }
  | ({ readonly type: "work" } & CryptoWorkRequest);

/** One constant message, exactly as in `store.ts` and `reader.ts`. */
const REFUSAL_CODE = "REFUSED";
const REFUSAL_MESSAGE = "this call cannot reach a credential";
const FAULT_CODE = "WORKER_FAULT";
const FAULT_MESSAGE = "the credential worker could not complete the request";

/* -------------------------------------------------------------------------- */
/* ERROR HANDLING — EVERY FAILURE IS ONE OF TWO SHAPES                          */
/* -------------------------------------------------------------------------- */

/**
 * THE WORKER REFUSED. It read what it had to and the answer was no.
 *
 * The reason is carried **in the object and never in the message**, for the reason
 * `store.ts` gives: a message that varies with its cause is an oracle. The reason
 * is for this thread's own stderr, which an operator can read and a caller cannot.
 */
class VaultRefusal extends Error {
  /**
   * Assigned in the body, NOT as a constructor parameter property.
   *
   * `constructor(readonly reason: string)` is ordinary TypeScript and `tsc` accepts
   * it, but Node runs this repository with `--experimental-strip-types`, which
   * rewrites types by ERASING them and cannot erase a parameter property — it has no
   * runtime to erase them into. The result is a module that typechecks perfectly and
   * throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` the moment a worker loads it.
   *
   * It is written out here because that failure is invisible to every check this
   * project runs except actually starting the thread, and the fix is the same shape
   * as `store.ts`'s `AuditUnavailableError` for the same class of reason.
   */
  readonly reason: string;

  constructor(reason: string) {
    super(REFUSAL_MESSAGE);
    this.name = "VaultRefusal";
    this.reason = reason;
  }
}

function refuse(reason: string): never {
  throw new VaultRefusal(reason);
}

/**
 * COMPARISON ON BYTES, AND WHY IT IS NOT A STRING COMPARISON.
 *
 * ADR-011 §4.5: the tenant in the file is a byte run that is never decoded, so
 * decoding it to compare it against the caller's tenant would reintroduce the exact
 * copy this format exists to prevent — and would do it on the metadata path too,
 * where nothing else forces a decode.
 *
 * Constant-time because the ADR says so, but the honest reason it costs nothing is
 * that a tenant id and a key name are not secrets: they are in the vault file in
 * plaintext and in every request this process makes. Constant-time here is
 * defence in depth against a future where that stops being true, not a mitigation
 * of a present leak.
 */
function bytesEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Overwrite in place. `fill(0)` leaves a recognisable pattern; see ADR-011 §4.3. */
function wipe(value: Buffer | undefined): void {
  if (value !== undefined && value.length > 0) randomFillSync(value);
}

/* -------------------------------------------------------------------------- */
/* THE READ — ADR-011 §4, PASSES 1 TO 3                                        */
/* -------------------------------------------------------------------------- */

/**
 * THE WHOLE ALGORITHM, AND THE ONLY PLACE IN THE REPOSITORY THAT OPENS A VAULT.
 *
 * Returns the reference and the rotation instant. The payload buffer is wiped
 * before this function returns, on every path, including the paths that throw —
 * `finally` is not decorative here, it is the only reason the throw paths are safe.
 */
async function readReference(
  vaultPath: string,
  tenant: string,
  keyName: string,
  hmacKey: Buffer,
  maxVaultBytes: number,
): Promise<{ reference: string; rotatedAt: string }> {
  const tenantBytes = Buffer.from(tenant, "utf8");
  const keyBytes = Buffer.from(keyName, "utf8");

  let handle: FileHandle | undefined;
  let chunk: Buffer | undefined;
  let header: Buffer | undefined;
  let trailer: Buffer | undefined;
  let payload: Buffer | undefined;

  try {
    handle = await open(vaultPath, "r");

    /* --- PASS 1: size, header, trailer. Three bounded reads (ADR-011 §4). --- */

    const { size } = await handle.stat();
    if (!Number.isSafeInteger(size) || size < MIN_VAULT_BYTES) refuse("shorter than a valid vault");
    if (size > maxVaultBytes) refuse("larger than this deployment permits");

    header = Buffer.allocUnsafe(FILE_HEADER_BYTES);
    await handle.read(header, 0, FILE_HEADER_BYTES, 0);
    if (header.toString("latin1", 0, 4) !== VAULT_MAGIC) refuse("bad magic");
    if (header.readUInt16LE(4) !== FORMAT_VERSION) refuse("unknown format version");
    if (header.readUInt16LE(6) !== FILE_HEADER_BYTES) refuse("unexpected header length");
    if (header.readUInt32LE(12) !== 0) refuse("reserved header bits are set");

    const entryCount = header.readUInt32LE(8);
    // An entry is at least a 28-byte header. Checking that the count cannot exceed
    // what the file could physically hold refuses a corrupt `ENTRY_COUNT` before it
    // is used to bound a loop, which is the arithmetic ADR-011 §8 flags.
    if (entryCount > Math.floor((size - MIN_VAULT_BYTES) / ENTRY_HEADER_BYTES)) {
      refuse("entry count cannot fit in this file");
    }

    trailer = Buffer.allocUnsafe(DIGEST_BYTES);
    await handle.read(trailer, 0, DIGEST_BYTES, size - DIGEST_BYTES);

    /* --- PASS 2: the digest, streamed over every byte below the trailer. ------ */

    const mac = createHmac("sha256", hmacKey);
    chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    const digestLimit = size - DIGEST_BYTES;
    for (let position = 0; position < digestLimit; ) {
      const wanted = Math.min(CHUNK_BYTES, digestLimit - position);
      const { bytesRead } = await handle.read(chunk, 0, wanted, position);
      if (bytesRead === 0) refuse("file ended before the digest region did");
      mac.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    // The chunk is reused across iterations and holds the last credential bytes
    // read. Wipe it before anything else can observe it — ADR-011 §4.3.
    wipe(chunk);
    chunk = undefined;

    if (!bytesEqual(mac.digest(), trailer)) refuse("digest mismatch");

    /* --- PASS 3: walk entries, reading only the regions this call needs. ----- */

    let offset = FILE_HEADER_BYTES;
    for (let index = 0; index < entryCount; index += 1) {
      if (offset + ENTRY_HEADER_BYTES > digestLimit) refuse("truncated entry header");

      const entryHeader = Buffer.allocUnsafe(ENTRY_HEADER_BYTES);
      // Declared out here so the offset advance below the `finally` can see it; the
      // whole point of the `finally` is that it runs even on the early return, which
      // means the advance cannot live inside the same block.
      let runBytes = 0;
      try {
        await handle.read(entryHeader, 0, ENTRY_HEADER_BYTES, offset);
        if (entryHeader.toString("latin1", 0, 4) !== ENTRY_MAGIC) refuse("entry misalignment");

        const flags = entryHeader.readUInt8(4);
        if ((flags & ENTRY_FLAG_RESERVED_MASK) !== 0) refuse("reserved entry bits are set");
        // A retired or absent entry is skipped without its payload being read at
        // all. The flag is checked before the region is fetched, so a tombstone
        // never causes its payload to become resident.
        const usable = (flags & ENTRY_FLAG_PRESENT) !== 0 && (flags & ENTRY_FLAG_RETIRED) === 0;

        const tenantLength = entryHeader.readUInt32LE(8);
        const keyLength = entryHeader.readUInt32LE(12);
        const payloadLength = entryHeader.readUInt32LE(16);
        const rotatedAtMs = entryHeader.readBigInt64LE(20);

        // Summed in doubles, never with `+` on three u32s that could wrap.
        runBytes = ENTRY_HEADER_BYTES + tenantLength + keyLength + payloadLength;
        if (!Number.isSafeInteger(runBytes)) refuse("entry length arithmetic overflowed");
        if (offset + runBytes > digestLimit) refuse("truncated entry");

        if (usable) {
          // TENANT and KEY are adjacent, so one read covers both.
          const namesLength = tenantLength + keyLength;
          const names = Buffer.allocUnsafe(namesLength);
          await handle.read(names, 0, namesLength, offset + ENTRY_HEADER_BYTES);
          const fileTenant = names.subarray(0, tenantLength);
          const fileKey = names.subarray(tenantLength, namesLength);

          if (bytesEqual(fileTenant, tenantBytes) && bytesEqual(fileKey, keyBytes)) {
            // The payload is read HERE and nowhere else — after the match, once,
            // for the entry that was actually asked for.
            payload = Buffer.allocUnsafe(payloadLength);
            await handle.read(payload, 0, payloadLength, offset + ENTRY_HEADER_BYTES + namesLength);

            const reference = `${REDACTED_REF_PREFIX}${createHash("sha256")
              .update(tenant)
              .update(FIELD_SEP)
              .update(keyName)
              .update(FIELD_SEP)
              // The bytes, not a string derived from them — identical to
              // `reader.ts` `referenceFor`, and it MUST stay identical or a caller
              // gets two different references for one credential.
              .update(payload)
              .digest("hex")
              .slice(0, 16)}>`;

            wipe(payload);
            payload = undefined;
            wipe(names);
            return { reference, rotatedAt: new Date(Number(rotatedAtMs)).toISOString() };
          }
          wipe(names);
        }
      } finally {
        wipe(entryHeader);
      }

      offset += runBytes;
    }

    if (offset !== digestLimit) refuse("trailing bytes after the last entry");
    return refuse("no entry for that tenant and key");
  } finally {
    // Every path out of this function, including all four refusals and any throw
    // from `open`, runs this. This is the whole reason the try starts above `open`.
    if (handle !== undefined) await handle.close().catch(() => undefined);
    wipe(chunk);
    wipe(header);
    wipe(trailer);
    wipe(payload);
  }
}

/* -------------------------------------------------------------------------- */
/* THE WORKER SIDE                                                             */
/* -------------------------------------------------------------------------- */

function startWorker(port: NonNullable<typeof parentPort>): void {
  let hmacKey: Buffer | undefined;
  let maxVaultBytes = DEFAULT_MAX_VAULT_BYTES;

  /**
   * DIAGNOSTICS GO TO THIS THREAD'S OWN STDERR, NEVER BACK TO THE CALLER.
   *
   * The refusal *reason* is genuinely useful to an operator and genuinely unsafe to
   * hand to a caller, because "the digest did not match" and "that tenant is not in
   * this file" are different facts and the caller must not learn which one it hit.
   * So the reason is printed here, where the transcript is not, and the response
   * carries the constant message only.
   */
  const diagnose = (correlationId: string, reason: string): void => {
    process.stderr.write(`[crypto-worker] ${correlationId}: ${reason}\n`);
  };

  port.on("message", (inbound: CryptoWorkerInbound) => {
    if (inbound.type === "init") {
      if (hmacKey !== undefined) {
        // A second init would replace a live key without wiping the old one.
        wipe(hmacKey);
      }
      hmacKey = Buffer.from(inbound.hmacKey);
      inbound.hmacKey.fill(0);
      if (typeof inbound.maxVaultBytes === "number" && inbound.maxVaultBytes > 0) {
        maxVaultBytes = inbound.maxVaultBytes;
      }
      return;
    }

    const { correlationId } = inbound;
    if (hmacKey === undefined) {
      port.postMessage({
        ok: false,
        correlationId,
        code: FAULT_CODE,
        message: FAULT_MESSAGE,
      } satisfies CryptoWorkResponse);
      return;
    }

    /**
     * `async` inside a listener, deliberately.
     *
     * The awaits inside `readReference` are file I/O. Two reads for two tenants
     * therefore overlap inside this thread, which is why the response carries a
     * `correlationId` and why nothing downstream infers which request a reply
     * belongs to. The main thread is NOT blocked — that is the entire reason this
     * runs off-thread, and a synchronous read here would have defeated it without
     * anyone noticing until a latency investigation.
     */
    void readReference(inbound.vaultPath, inbound.tenant, inbound.keyName, hmacKey, maxVaultBytes)
      .then(({ reference, rotatedAt }) => {
        port.postMessage({
          ok: true,
          correlationId,
          reference,
          rotatedAt,
        } satisfies CryptoWorkResponse);
      })
      .catch((error: unknown) => {
        if (error instanceof VaultRefusal) {
          diagnose(correlationId, error.reason);
          port.postMessage({
            ok: false,
            correlationId,
            code: REFUSAL_CODE,
            message: REFUSAL_MESSAGE,
          } satisfies CryptoWorkResponse);
          return;
        }
        // Deliberately not the message: an Error from a failed `open` carries the
        // absolute vault path, and that path is an operator's filesystem layout
        // leaking into a transcript. The name is not dropped either — it goes to
        // stderr, which is where a stack trace belongs.
        diagnose(correlationId, error instanceof Error ? `${error.name}: ${error.message}` : "unknown");
        port.postMessage({
          ok: false,
          correlationId,
          code: FAULT_CODE,
          message: FAULT_MESSAGE,
        } satisfies CryptoWorkResponse);
      });
  });

  /**
   * THE MAIN THREAD OWNS THIS THREAD'S LIFETIME. DO NOT `unref` HERE.
   *
   * The main thread calls `worker.unref()`, which is what stops the process being
   * held open. Doing the same thing to `parentPort` from in here is a different
   * operation with a nastier failure: this port would become the one handle holding
   * the worker's event loop, and unref'ing it lets the thread exit while a request
   * is in flight — a hang that presents as a request that never comes back, on the
   * one code path that has no timeout of its own.
   */
}

/**
 * GUARD, NOT A NO-OP.
 *
 * This module is imported by the client as well as loaded as a worker entry, and the
 * client is loaded on the main thread. If the guard were missing, importing the
 * client would start a worker on every import — once per test file, once per
 * module instance — with no way to shut them down.
 */
if (!isMainThread && parentPort !== null) {
  startWorker(parentPort);
}