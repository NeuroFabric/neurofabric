# ADR-010 — CAPABILITIES ARE PROVED, AND CREDENTIALS TRAVEL AS REFERENCES

- **Status:** **RATIFIED and IMPLEMENTED.** Closes the blocker named in ADR-009 §4.
- **Date:** 2026-10-04
- **Ratified by:** operator instruction — "build the missing capability verification
  seam and implement the Operator Standing Instruction"
- **Closes:** ADR-009 §4 (who mints capabilities), ADR-008 §5.3 (redacted-by-default)
- **Amends:** ADR-008 §4.1 (the store verifies nothing — still true, but the
  verification now exists *outside* it, which is where §4.1 said it had to be)
- **Relates to:** ADR-008, ADR-009, D-016, D-017, `docs/SECURITY.md` residual
  limitations 7 and 8

---

## 1. What changed, and why it was the last piece

A capability was, until this record, an object a caller handed to the store. "This
capability names tenant `acme`" was a **sentence**, not a check. ADR-008 §4.1
refused to verify inside the store on the grounds that a store which signs its own
capabilities is an authority on its own isolation, and pushed verification outward.
ADR-009 §4 named that as the blocker for wiring the vault at all.

There is now a `capability.ts` that mints and verifies, and a `reader.ts` that sits
between the gateway and the store. The store still verifies nothing — §4.1 stands —
but it now receives a capability **extracted from a verified signature**.

---

## 2. Binding, and why a capability is not a label

The signature covers the payload. That is the entire difference between a capability
and a label: a token that *carries* `tenant: acme` proves nothing, and a token whose
HMAC *covers* it proves it. Change the tenant in the payload and verification fails
**before the verifier reads the field it would have believed** — which is why a
tampered tenant refuses with `BAD_SIGNATURE` rather than `WRONG_TENANT`.

Genuine-but-wrong-tenant is a separate code, because reusing a valid capability
across a tenant boundary is the actual attack and it produces no forgery at all.

### 2.1 HMAC, and the one thing this design does not defend against

Symmetric, because there is no second party verifying: the verifier already holds
the signing key by construction of the deployment. A public/signature pair would
publish the ability to **mint**, which is precisely the authority being kept in one
place.

The consequence is stated rather than left for someone to discover:

> **Possession of the key is minting authority.** Anything holding it can mint any
> capability this verifier would accept. There is a test that pins exactly this —
> a widened capability signed with the real key **does** verify — because it is
> load-bearing, and because a future edit must not "harden" the verifier by
> refusing well-formed capabilities, which would break every outstanding grant.

So the key must live in exactly one process. That is an operational constraint, not
a code property.

---

## 3. The reader, and the order that matters

**Verify, then read.** Always. Anything that can refuse does so before the store is
touched, because a refusal decided after the value is in hand is a filter over a
read, not a gate. The tests assert this by checking the store's **source was never
loaded**, not by checking the store returned nothing — the former is the property,
the latter is a symptom.

The tenant handed to the store is the **verified** one, asserted directly. Making
those two values differ would be the worst bug in the file, and it is now a test.

The capability handed down is scoped to the entry that was **asked for**, not to the
grant's full scope. Widening it would let one approved read reach every entry the
grant covers — precisely the over-broad read an approval was supposed to bound.

---

## 4. Redacted by default, and why masking would not have been enough

ADR-008 §5.3 named the missing operator standing instruction. This is it, in code.

The default answer **does not contain the value at all**. It is a salted digest of
tenant, entry name and value, which is:

- **stable**, so a reader can be told "that is the one already rotated" without
  anybody handling bytes;
- **non-reversible**, so the reference cannot be used to recover the value;
- **scoped**, so two tenants with a same-named entry cannot be correlated from a
  transcript;
- **rotation-sensitive**, because the value is an input to the digest — so "same
  reference" means "same credential", not merely "same slot". A digest of the name
  alone would be a dictionary: anyone guessing `payments/api-key` could predict it.

**Why not mask characters, or warn the model, or rely on redaction downstream.**
Each leaves the bytes in the context window, and a model asked not to say a thing is
a model that has been told a thing. Redacting at the edges does not move the secret
out of the place that leaks.

### 4.1 Raw, and what it costs

A tool that can never return a value has no use, and an option nobody can reach is
not an option — it is a limitation waiting to be worked around somewhere less
careful. So raw exists and is expensive on purpose:

1. a caller flag (`exposure: "raw"`), enforced at the call **and** published;
2. a warning block, in prose, above the fold, naming the specific mechanism;
3. a **separate** acknowledgement field, required in the schema for raw and not for
   reference.

The check is in the **gate**, not the reader. By the time a reader saw an
unacknowledged raw request, the decision would already be granted and written to the
trail — and a refusal that leaves a granted approval on the record is worse than one
that never happened. A raw answer missing the box is treated as **no answer at all**.

The two prompts are deliberately unalike. The tests assert the raw-only artefacts
are **absent** from the reference prompt, not merely present in the raw one: a
warning on every request is a warning people learn to skip.

---

## 5. What this does NOT fix

In **both** modes the value transits the reader's process, because `store.ts`
returns it. The reference protects the **context window and nothing else** — it does
not reduce this process's exposure.

Closing that needs a **metadata-only read path** in the store: a capability that
answers "does this exist, and when was it rotated" without materialising the bytes.
Until that exists, the default mode still loads a credential to produce a label.

Also open, carried from ADR-008 and unchanged by this record:

| # | Question | Status |
|---|---|---|
| 1 | Where does the signing key come from and how is it rotated? | **Open.** §2.1 makes this load-bearing. |
| 2 | Should the operator-supplied location sit inside the workspace boundary? | Open — ADR-008 §5.2 |
| 3 | Does every deploy actually mint capabilities, or does one fall back? | **New.** A gateway with no reader wired refuses, which is correct and untested in production. |

---

## 6. Alternatives considered

1. **Verify inside `store.ts`.** Rejected, on ADR-008 §4.1's original reasoning.
   Verification stays outside; the store keeps its single job.
2. **Asymmetric signatures.** Rejected. One process, no second verifier; publishing
   a public key distributes minting authority for no benefit here.
3. **Encrypt the payload.** Rejected for this artefact. An operator auditing a
   capability needs to see which tenant and scope it exercises, and a signature
   already prevents *changing* it. A grant descriptor is not a credential and the
   two are never confused here — if it ever held one, this choice must be revisited.
4. **Mask the value instead of referencing it.** Rejected, §4.
5. **Let raw be the default and reference be opt-in.** Rejected. It is reachable and
   expensive, which is the opposite ordering.

---

## 7. Traceability

| Obligation | Where it comes from |
|---|---|
| Verification lives outside the store | ADR-008 §4.1, upheld |
| The missing seam now exists | ADR-009 §4 |
| Redacted by default | ADR-008 §5.3, implemented in `reader.ts` |
| Refuse before the read, not after | `reader.ts`, asserted via "source never loaded" |
| One refusal, every cause | `reader.ts` single code; distinct codes kept internal |
| Capability is bound, not labelled | `capability.ts`, `verifyCapability` order |
| Key possession is minting authority | §2.1, pinned by a test that asserts it is TRUE |
| Raw needs its own acknowledgement, checked in the gate | `elicitation.ts` |
| No vault import from the gateway | import-graph scan in `stdio.test.ts` |
| The value still transits this process | §5, stated rather than implied |