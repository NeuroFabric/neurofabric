# ADR-011 — LENGTH-PREFIXED BINARY CREDENTIAL STORAGE

- **Status:** **PROPOSED. Not implemented. No reader, no writer, no migration.**
- **Date:** 2026-10-04
- **Ratified by:** — nothing here exists in code. The format below is a design, and
  the tests that would falsify it have not been written.
- **Closes:** the first of the three residuals in ADR-010 §A7.2
- **Relates to:** ADR-010 (§A7.2, §A7.3), ADR-008, `platform/vault/store.ts`,
  `platform/vault/file-source.ts`

> **Read-before-build gate: OPEN.** Nothing in §3 may be implemented before
> ratification, because the byte layout is a contract and a contract changed after a
> file has been written is a migration nobody planned for.

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

That is achievable because the primitive already exists and costs nothing:
`fs.readFileSync(path)` with no encoding argument returns a `Buffer`. No decoder
runs, no string is allocated. What forces a string today is not the file API — it is
that **the file's content is JSON**, and JSON is a text format.

So this is a format change, not a reading change. That is the whole design.

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
| −32 | 32 | bytes | `DIGEST` | SHA-256 over `[0, EOF−32)` |

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

```
buf = fs.readFileSync(path)          // no encoding argument — a Buffer, no decode
if buf.length < 48:                        refuse  (too short to be valid)
if buf[0..4)   != "NFV1":                  refuse
if FORMAT_VERSION  != 1:                   refuse  (do not attempt to read a future file)
if HEADER_BYTES    != 16:                  refuse
if RESERVED        != 0:                   refuse  (unknown bits are not ignored)
if DIGEST(buf)    != buf[EOF-32..):        refuse  (corruption or truncation)
```

Then walk entries from offset 16 to `EOF−32`, and **before every read**:

```
if ENTRY_MAGIC != "NFE1":                  refuse  (misalignment, not a soft error)
if remaining < 28:                         refuse
if remaining < 28 + TENANT + KEY + PAY:    refuse  (truncated run)
```

And finally: **the number of entries parsed must equal `ENTRY_COUNT`**, or refuse.

Every one of these is a refusal rather than a repair. A format that "does its best"
with a corrupt credential file is a format that eventually serves a truncated key as
though it were complete.

### 4.1 Why the digest is verified FIRST

Before any field is interpreted. A corrupted `PAYLOAD_BYTES` would otherwise send the
reader to a plausible-looking offset inside a file whose contents are not what the
operator last wrote. Verifying the whole file before trusting any part of it turns
"probably fine" into "known", and it is one SHA-256 over a small buffer.

### 4.2 Tenant is checked on BYTES, not on a decoded string

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
5. **`fs.readFileSync` loads the entire file.** For a large vault, reading one
   credential means reading every credential. That is itself an exposure, and it
   argues for an index plus a per-entry read, or a stream with an explicit offset —
   both of which are more complex than the primitive this ADR is built on, and
   neither is designed here.

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
  Untrusted input arithmetic is §4's job, but a bound on the total is cheap.
- Does a v1 reader refuse an unknown `FORMAT_VERSION`, or read what it understands?
  §4 refuses. That is a migration decision as much as a safety one.

---

## 9. Traceability

| Obligation | Where |
|---|---|
| Credential never becomes a string on the read path | §3.2, §4.2 |
| Truncation and corruption fail closed | §4, every branch refuses |
| Unknown versions and reserved bits are not ignored | §3.1, §4 |
| Rotation readable without decoding anything | §3.2 `ROTATED_AT` |
| Residual stated before anyone relies on it | §5 |
| Not implemented | Status, §9 |
| Swap exposure is out of scope and named | §5(2) |