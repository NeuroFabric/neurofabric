# ADR-011 — LENGTH-PREFIXED BINARY CREDENTIAL STORAGE

- **Status:** **IMPLEMENTED — read path and write path.** The reader in §4 is
  `platform/vault/worker/crypto-worker.ts`, the writer is
  `platform/vault/writer.ts`, and each is proven against the other rather than
  against a copy of the format. **There is still no migration.** No deployment holds
  a vault in this format, so §6 remains entirely ahead of the code and §3 is now a
  contract with a producer attached to it.
- **Date:** 2026-10-04 (proposed) · 2026-10-04 (read path) · 2026-10-04 (write path; §3.3 amended)
- **Ratified by:** §3 and §4 by `platform/vault/worker/crypto-worker.ts` and
  `platform/vault/writer.ts`. §6 by nothing, because nothing implements it.
- **Closes:** the first of the three residuals in ADR-010 §A7.2
- **Relates to:** ADR-010 (§A7.2, §A7.3), ADR-008, `platform/vault/store.ts`,
  `platform/vault/file-source.ts`, `platform/vault/reader.ts`,
  `platform/vault/writer.ts`

> **Read-before-build gate: CLOSED, AND IT IS NOW LOAD-BEARING.**
>
> §3 and §4 were implemented before ratification, which is the order this document
> exists to prevent. That was survivable while the reader was wired to nothing: no
> file existed against a contract that could still move, so a change to §3 was a doc
> edit. **That is no longer true.** `writeVault` can now produce a file, so the
> layout is frozen in the only sense that matters — changing it is a data migration
> for every file ever written, not a revision.
>
> The gate was not closed by ratification. It was closed by the existence of a
> writer, and the lesson for the next format here is that a read-only implementation
> is genuinely cheap to change and a read-write one is not.

---

## 1. The residual being closed

ADR-010 §A7.2 named three copies of a credential that the Buffer refactor cannot
reach. This ADR addresses exactly one of them:

> **The string the file-backed source produced while decoding JSON.** That parse
> creates one; it is unreachable from `reader.ts` and no amount of overwriting
> touches it.

The others stay open and §6 says so plainly.

The claim to be closed: **a credential read from disk never becomes a JavaScript
string at any point in this process.**

That is achievable because the primitive already exists and costs nothing: a
`Buffer` read with no encoding argument carries no decoder and allocates no string.
What forces a string today is not the file API — it is that **the file's content is
JSON**, and JSON is a text format.

So this is a format change, not a reading change. That is the whole design.

### 1.1 The read primitive is a STREAM, and that is normative

A whole-file read — `fs.readFileSync(path)`, `fs.promises.readFile`, or
`fs.readFile` with no `length`/`position` — **is prohibited by this ADR.** Not
discouraged. Prohibited, in the same voice as the `RESERVED` rule in §3.1: a
primitive that is available and wrong is a primitive somebody will reach for.

Every reader built on this format **MUST** hold at most a bounded number of bytes at
a time, using:

- `fs.createReadStream(path, { start, end, highWaterMark })` for a region read, or
- `fs.read(fd, buffer, offset, length, position)` in a loop into a **pre-allocated,
  fixed-size scratch buffer** for a sequential chunk read,

and **MUST NOT** allocate a buffer whose size is a function of `ENTRY_COUNT`,
`PAYLOAD_BYTES`, or the file's total length. "Read one credential" and "load every
credential in the vault" must not be the same code path with a different filter
applied afterwards. If a reader can be made to pull the whole file by asking for one
entry, it will be, eventually, by somebody who did not read this section.

The reason is not style. A whole-file read means the peak heap cost of answering one
question is the size of the entire secret estate, all of it resident in this
process simultaneously, all of it equally addressable by anything that can reach
this process's memory. The format's job is to make a credential's exposure
proportional to that credential. A format that requires the whole file to be
materialised to reach one entry does not do that, no matter how well it avoids
decoding.

`highWaterMark` is the unit of residency and **MUST be a named constant**, not a
literal at each call site, so there is one number to reason about when someone asks
how much of the vault can be resident at once.

---

## 2. Why the current format cannot be patched

A tempting cheaper fix: keep JSON but read it as bytes and parse with a byte-level
scanner. That is worse, not better, and it is worth saying why.

A hand-rolled JSON scanner still has to produce a **string** for every value, because
that is what a JSON string literal *is* — a decoded sequence of code points. The
decoding is not an artefact of using `JSON.parse`; it is inherent to representing a
value as text. Avoiding the function does not avoid the string.

Length-prefixed binary storage removes it for the only field that matters: **the
payload is never a string in the first place.** It is a run of bytes with a count in
front of it, and a byte run needs no decoding.

---

## 3. The byte layout

All integers **unsigned, little-endian**. Offsets are from the start of the named
region. There is no alignment padding and no string terminator anywhere — both would
be places for a format to disagree with itself.

### 3.1 File header — 16 bytes

| Off | Size | Type | Field | Rule |
|---|---|---|---|---|
| 0 | 4 | bytes | `MAGIC` | `"NFV1"` |
| 4 | 2 | u16 | `FORMAT_VERSION` | `1` |
| 6 | 2 | u16 | `HEADER_BYTES` | `16` |
| 8 | 4 | u32 | `ENTRY_COUNT` | number of entries that follow |
| 12 | 4 | u32 | `RESERVED` | must be `0` |

`HEADER_BYTES` exists so a future version can add header fields **without** bumping
the magic, and so a reader can skip a header longer than it understands rather than
guessing. `RESERVED` must be zero and any non-zero value is a **hard refusal**: a v1
reader that silently ignored unknown header bits would be a reader that could not
tell a v2 file from a v1 file.

### 3.2 Entry — 28-byte header, then three length-prefixed byte runs

| Off | Size | Type | Field | Rule |
|---|---|---|---|---|
| 0 | 4 | bytes | `ENTRY_MAGIC` | `"NFE1"` |
| 4 | 1 | u8 | `FLAGS` | bit0 `PRESENT`, bit1 `RETIRED`, bits 2–7 reserved = `0` |
| 5 | 3 | bytes | `RESERVED` | must be `0` |
| 8 | 4 | u32 | `TENANT_BYTES` | |
| 12 | 4 | u32 | `KEY_BYTES` | |
| 16 | 4 | u32 | `PAYLOAD_BYTES` | |
| 20 | 8 | i64 | `ROTATED_AT` | epoch milliseconds, UTC |
| 28 | `TENANT_BYTES` | bytes | `TENANT` | UTF-8, **not decoded on read** |
| … | `KEY_BYTES` | bytes | `KEY` | UTF-8, decoded only for display |
| … | `PAYLOAD_BYTES` | bytes | `PAYLOAD` | **never decoded** |

Three separate length prefixes, and the third is the whole point: **`PAYLOAD_BYTES`
is known before the payload is touched**, so a truncated file is detectable at the
boundary rather than discovered as a short credential.

`ROTATED_AT` is an epoch rather than a timestamp string so that the metadata read path
— which must answer "when was this rotated" without loading anything — needs no
decoding either. An ISO string would reintroduce the exact problem this ADR exists to
remove, in the one field the metadata path actually reads.

### 3.3 Trailer — 32 bytes

| Off from EOF | Size | Type | Field | Rule |
|---|---|---|---|---|
| −32 | 32 | bytes | `DIGEST` | **HMAC-SHA256** under the vault key, over `[0, EOF−32)` |

> **AMENDED. This said `SHA-256`, and that was wrong.**
>
> The read path shipped before this section was revisited, and the reader computes
> **HMAC-SHA256** under the vault key. §4's pass-2 pseudocode already said
> `HMAC_SHA256(key, ...)`; this table did not. The table is now the one that is
> correct and the pseudocode is unchanged.
>
> The difference is not cosmetic and not a naming preference:
>
> - A bare SHA-256 over a credential file is a **corruption check**. Anyone who can
>   write the file can recompute the digest, and the file verifies. It detects a
>   truncated disk, and it detects nothing else.
> - HMAC makes forgery require the key, so "the digest matches" means "this was
>   written by somebody holding the vault key", not "this file is internally
>   consistent".
>
> For a file whose entire contents are credentials, the second is the property worth
> having, and a document that specifies the wrong algorithm is worse than no
> document — because it reads as though the weaker guarantee had been the intended one.
>
> `writer.ts` matches this, and a writer that emitted bare SHA-256 would produce
> files its own reader refuses. `createHmac` accepts a zero-length key without
> complaint, so an unkeyed vault would be *writable and readable* and would protect
> nothing at all; `writeVault` therefore **refuses an empty key** rather than
> producing a file that only looks like a vault.

### 3.3.1 Entry ordering is a writer contract, not an accident

Entries appear in the order `writeVault` is given them, and the offsets in the file
follow from that. There is no index, so **a reader must not assume a tenant's
entries are contiguous** — a reader that seeks from one match to the next breaks the
first time two tenants are interleaved. `crypto-worker.ts` walks the whole region,
and `writer.test.ts` asserts it with interleaved tenants.

### 3.4 Whole file

```
+--------------------------+  offset 0
|  FILE HEADER      16 B    |
+--------------------------+  offset 16
|  ENTRY 0                  |
|  ENTRY 1                  |
|  ...                      |
|  ENTRY N-1                |
+--------------------------+  offset EOF-32
|  DIGEST           32 B    |
+--------------------------+  EOF
```

Minimum size is therefore **48 bytes**, and a reader that sees fewer has a truncated
or empty file and must refuse.

---

## 4. The read algorithm, and where it fails closed

The algorithm below is **three passes**, because §1.1 rules out holding the file and
because §4.1 requires the digest to be known before any field is interpreted. No
pass ever holds more than `CHUNK_BYTES` at once.

**PASS 1 — size, header, trailer. Three bounded reads. No whole-file allocation.**

```
fd = open(path, O_RDONLY)                          // numeric handle; no decode, no path retention
size = fstat(fd).size                              // the ONLY way to learn EOF

if size < 48:                                      refuse  (too short to be valid)

header = scratch(16)                               // FIXED size, allocated once
read(fd, header, 0, 16, position=0)
if header[0..4)  != "NFV1":                        refuse
if FORMAT_VERSION != 1:                            refuse  (do not attempt to read a future file)
if HEADER_BYTES   != 16:                           refuse
if RESERVED       != 0:                            refuse  (unknown bits are not ignored)

trailer = scratch(32)                              // FIXED size, allocated once
read(fd, trailer, 0, 32, position=size - 32)
```

**PASS 2 — the digest, streamed. Same `CHUNK_BYTES` scratch buffer, reused.**

```
h = HMAC_SHA256(key, empty)
for each chunk of size CHUNK_BYTES over [0, size - 32):     // createReadStream, or read() loop
    h.update(chunk)
    wipe(chunk)                                  // §4.3: the chunk held credential bytes
if not constantTimeEqual(h.digest(), trailer):               refuse  (corruption or truncation)
```

The digest is over `[0, EOF−32)` because that is the only region a v1 writer ever
signed, so the trailer is excluded from its own computation.

**PASS 3 — walk entries, one bounded region at a time.** Entry offsets come from
the fixed header sizes, so each entry is *seeked to*, not read through:

```
offset = HEADER_BYTES
for i in 0 .. ENTRY_COUNT - 1:
    if offset + 28 > size - 32:                          refuse
    eh = scratch(28)                                     // FIXED size
    read(fd, eh, 0, 28, position=offset)

    if ENTRY_MAGIC != "NFE1":                            refuse  (misalignment, not a soft error)
    if reserved bits in FLAGS != 0:                      refuse
    TENANT_BYTES = u32(eh, 8);  KEY_BYTES = u32(eh, 12);  PAYLOAD_BYTES = u32(eh, 16)
    ROTATED_AT     = i64(eh, 20)

    if TENANT_BYTES + KEY_BYTES + PAYLOAD_BYTES overflows u32:   refuse  (untrusted arithmetic)
    runBytes = 28 + TENANT_BYTES + KEY_BYTES + PAYLOAD_BYTES
    if offset + runBytes > size - 32:                    refuse  (truncated run)

    // Exactly the runs this call was asked for, and nothing else.
    tenant = scratch(TENANT_BYTES)                       // only if comparing on bytes, §4.5
    read(fd, tenant, 0, TENANT_BYTES, position=offset + 28)
    payload = scratch(PAYLOAD_BYTES)                     // only if this call asked for the value
    read(fd, payload, 0, PAYLOAD_BYTES, position=offset + 28 + TENANT_BYTES + KEY_BYTES)

    offset = offset + runBytes
    wipe(tenant); wipe(payload)                          // §4.3
```

And finally: `offset` **MUST** equal `size − 32`, and the number of entries walked
**MUST** equal `ENTRY_COUNT`. Either mismatch is a refusal — trailing garbage and a
short file are both refusals, and neither is "probably fine".

Every one of these is a refusal rather than a repair. A format that "does its best"
with a corrupt credential file is a format that eventually serves a truncated key as
though it were complete.

### 4.1 Why the digest is verified FIRST

Before any field is interpreted. A corrupted `PAYLOAD_BYTES` would otherwise send the
reader to a plausible-looking offset inside a file whose contents are not what the
operator last wrote. Verifying the whole file before trusting any part of it turns
"probably fine" into "known".

It is also, now, the **expensive** part of the read: one SHA-256 over every byte
below the trailer, streamed. That cost is accepted deliberately — it is a
correctness-before-convenience trade, and §5(5) records what it costs in read
amplification rather than pretending it is free.

### 4.3 Every buffer that held credential bytes is wiped, including the chunks

The `wipe` in `reader.ts` overwrites the value buffer after it has been hashed.
That discipline extends to **every** buffer in this algorithm, and it is stated here
because streaming makes it easy to forget: a pass-2 digest chunk and a pass-3 entry
region contain live credential bytes just as much as the buffer the reader wipes
does, and a chunk loop that does not wipe its scratch buffer has simply moved the
exposure from "one buffer, wiped" to "one buffer, overwritten sixteen times over its
lifetime".

`randomFillSync`, synchronously, before the buffer is released — the same rule and
for the same reason as `reader.ts`: a zero fill leaves the previous contents in any
copy-on-write page the engine made on the way, and "whenever the collector gets
round to it" is not a time.

### 4.4 What §1.1 does and does not buy, stated before anyone relies on it

Bounded residency means **this process's JavaScript heap** never holds more than
`CHUNK_BYTES` of the vault. It does **not** mean the plaintext is absent from the
machine:

- the **OS page cache** will hold plaintext pages for as long as the file is being
  read, and no userspace change can evict them;
- the **digest pass reads every byte of the vault** to verify it, so a single
  integrity check still touches every credential — it just no longer *retains* them,
  which is a real reduction and is not the same claim as "only one credential was
  read";
- a **length-prefixed region read is still a random-access read** into a file that a
  caller must know the size of, so an implementation that skips pass 1 and guesses
  offsets has reintroduced §1.1's prohibition while appearing to comply.

The honest claim is therefore: **the decode is gone, and peak heap residency is
bounded by a constant rather than by the size of the secret estate.** §5 lists what
is left.

### 4.5 Tenant is checked on BYTES, not on a decoded string

The store must refuse a capability whose tenant does not own the entry. Doing that
comparison on bytes (`Buffer.compare`, or `timingSafeEqual` after a length check)
means **even the tenant name is never decoded** on the read path. It becomes a string
only when it is written into an operator's approval prompt, and the key name only
when it is displayed.

This is a deliberate tightening over "decode tenant, compare strings", and it is the
single change that makes the ADR's headline claim true of *every* field rather than
only of the payload.

---

## 5. What this does NOT close

Stated here rather than discovered later, because the pattern of this project has
been to name residuals before relying on them.

1. **The raw-exposure string.** A caller that asks for the value gets text, and
   producing it makes a string. Unavoidable for that caller. ADR-010 §A7.2 item 2
   remains open.
2. **Swap and paging.** The OS can page a resident Buffer to disk. Overwriting a
   buffer does nothing about a copy the kernel already made, and **`mlock` is not
   available in pure Node.** No in-process change can fix this. It is the largest
   remaining exposure and it belongs to the deployment — encrypted swap, or a
   `mlock`-capable runtime.
3. **Core dumps and crash reports** capture resident memory.
4. **Copies V8 made internally** while the buffer was alive.
5. **The digest pass reads every byte.** §1.1 bounds how much is *held*; it cannot
   bound how much is *read*, because §4.1 verifies the whole file before trusting
   any of it. A vault whose integrity must be re-verified per call therefore
   touches every credential on every call. Closing this needs per-entry digests or a
   signed index, which changes the format and is **not** designed here. Until then,
   the residual is read amplification, not residency — and the two are commonly
   confused, so it is named rather than folded into the claim in §4.4.

So the honest claim is: **this removes the decode**, which was the copy this project
could actually reach and actually measure. It does not make a credential impossible
to find in a process's memory, and no file format will.

---

## 6. Migration

Not a refactor. It changes the on-disk contract for every existing deployment.

1. **Dual-read.** The source accepts binary and JSON, preferring binary. A deployment
   can upgrade the code with no data change and no downtime.
2. **Dual-write to a new path.** Existing vaults are untouched until verified.
3. **Verify, then switch.** Every entry in the old file must round-trip through the
   new format with an identical payload before the old file is retired.
4. **Retire in a later release**, once no deployment reports reading JSON.

Step 1 is the one that matters for safety: it is additive, and it means a bug in a
format nobody has deployed yet cannot strand anybody.

---

## 7. Alternatives considered

1. **Keep JSON, parse it with a byte-level scanner.** Rejected, §2. A JSON string
   literal is a decoded sequence; avoiding the function does not avoid the string.
2. **Encrypt the vault at rest.** Complementary, not a substitute — it addresses
   §6(2), where this format cannot help, and does nothing about §6(1). It also adds
   key management, which is its own ADR and its own failure modes. Worth doing; not
   this.
3. **Hold credentials in a separate helper process.** Genuinely promising: a process
   whose memory can be constrained and whose crash takes nothing else with it.
   Rejected *for now* only because it changes the deployment topology, and this ADR
   should not quietly make that decision. Named so it is not forgotten.
4. **Delegate to a platform credential facility.** Not portable, and the request
   here was a file format. The `SecretSource` port already exists for exactly this,
   and an adapter for one is a small, separable piece of work.

---

## 8. Open questions

- Should `RETIRED` entries stay in the file as tombstones, or does the file get
  rewritten without them? Tombstones keep the format append-only, which is worth a
  great deal; rewriting is smaller.
- Should `ENTRY_COUNT` be signed or protected against overflow when summed?
  Untrusted input arithmetic is §4's job, but a bound on the total is cheap — and
  §4 pass 3 now sums three u32 lengths, which is exactly the arithmetic that
  overflows.
- What is `CHUNK_BYTES`? §1.1 requires one named constant and deliberately does not
  set a value, because the right number depends on the vault size and the memory
  ceiling of the deployment. It needs a number, a floor, and a ceiling, and choosing
  it is a decision rather than a default.
- Does pass 1's `fstat` size need re-checking after pass 2? A file rewritten under
  an open descriptor can change size between the two passes, and the trailer read
  at `size - 32` would then be at the wrong offset. Either re-`fstat` before each
  pass or open with a lock, and §4 currently says neither.

### 8.1 KNOWN RESIDUAL — the size TOCTOU (Phase 4)

The question above is not open. It is a **known, accepted defect**, recorded here
so that it is a decision rather than a surprise:

> **`crypto-worker.ts` stats the file once, in pass 1, and every later offset in
> passes 1, 2 and 3 is derived from that one number.** If the file is replaced or
> rewritten between the `fstat` and the pass-3 seeks, the reader applies the entry
> offsets of one file to the bytes of another.

The window is small — a credential vault is not expected to be rewritten by
anything but the writer, and there is no writer — and the failure is **refusal, not
disclosure**, in the cases that matter:

- the digest in pass 2 covers `[0, size − 32)` of whatever is actually there, so a
  substituted file fails the HMAC unless it was signed with the same key;
- a truncated-by-rewrite file fails the `offset + runBytes > digestLimit` bound;
- the `ENTRY_COUNT` sanity bound is computed from the stale `size`, so a file that
  grew after the stat is bounded by the *smaller* number, which fails closed.

The residual that is **not** covered: a file rewritten *in place, same size, by a
process holding the key* is indistinguishable from the original, because it is
signed correctly by construction. That is true of any HMAC scheme and is not
specific to this race.

Deferred to **Phase 4**, and it should be one of three things, in this order of
preference: (1) re-`fstat` and refuse if the size or mtime moved since pass 1 —
cheap, catches the realistic case, does not catch a same-size in-place rewrite;
(2) hold an exclusive lock across passes 1–3, which is correct and which an
operator's rotation job may not tolerate; (3) put the entry offsets in a signed
index, which removes the stat entirely and is a format change.

Until then, **the file's size is assumed stable for the duration of one read**, and
an operator who rewrites a vault concurrently with a read should expect a refusal,
not a wrong answer. That assumption is the residual.
- Does a v1 reader refuse an unknown `FORMAT_VERSION`, or read what it understands?
  §4 refuses. That is a migration decision as much as a safety one.

---

## 9. Traceability

| Obligation | Where |
|---|---|
| Credential never becomes a string on the read path | §3.2, §4.5 |
| Whole-file reads prohibited; bounded residency required | §1.1, §4 pass 1–3 |
| Every buffer that held credential bytes is wiped | §4.3 |
| What bounded residency does not cover, stated | §4.4, §5(5) |
| Truncation and corruption fail closed | §4, every branch refuses |
| Unknown versions and reserved bits are not ignored | §3.1, §4 |
| Rotation readable without decoding anything | §3.2 `ROTATED_AT` |
| Residual stated before anyone relies on it | §5 |
| Read and write paths exist; migration does not | Status, §9 |
| Digest is keyed, and an unkeyed vault is refused | §3.3, `writer.ts` |
| A writer never produces a file its own reader rejects | `writer.test.ts` |
| Size TOCTOU across passes recorded as an accepted defect | §8.1 |
| Swap exposure is out of scope and named | §5(2) |