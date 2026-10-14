## What changes

`docs/adr/0004-recollection-is-reconciliation.md` *(new)*, one amended row in
`docs/PRODUCT-VISION.md`, and the third project law written into the census
docstring. **Direction only — no mechanism, no code.**

## The decision, and the part worth arguing about

**"Recollection" is not "memory", and that is the whole ADR.** The temptation is
to call persistence an agent that remembers. That framing imports an obligation
this product has not accepted: a system that *remembers* must answer *"what do you
remember about me, and how do I correct it"* — a user-data problem with retention,
export and deletion attached.

What this needs is **reconciliation**. On restart the platform rebuilds from a
durable record and tells the operator **exactly where the rebuilt state and the
record disagree**. Not a narrative — a diff, with the disagreement named and the
operator asked which is true.

Three properties follow, and they are the decision:

1. **Reconciliation is not recall.** The system does not *remember* a verdict, it
   **reads** one. That decides whether memory can be wrong the way a human's can,
   and whether correcting it is a conversation or a migration.
2. **The diff IS the product.** A silent reload that quietly discards a change is
   worse than a crash — it is the class of bug this project exists to refuse.
3. **Rebuild is from the record, not from replaying events.** A replay makes every
   restart a chance to differ from last time.

**Durable history is the source of truth for DISPLAY; the live window is the source
of truth for the CURRENT READING.** Two truths, each for its own job, and the
screen never merges them into one number.

## The vision amendment

`"Multi-tenancy in the UI: out of scope"` was **weaker than the truth**. The
engine is *already* tenant-scoped — every agent namespaced `tenant/schemaId`, the
tenant from the **proven credential**, D-042 refusing the revert because it would
trade a correctness property for test convenience. Only the **screen** presents one
tenant.

That gap is presentation, not architecture — the cheapest place for it to live. The
row now reads **"a Phase 5+ destination, not an exclusion"**, amended in place with
a pointer to the ADR.

## ADR-003's interim note is now load-bearing

With history, **"arrived, nothing since" stops being a dead end** and becomes
**"last arrived 4 hours ago"** — a fact about the *record*, not a statement about
the wire. The MEMORY DR specifies that change; this ADR only commits to making it.

## Named and deliberately NOT solved

**Restoring the operator's `boot.mjs` credential is now a DATA question, not a
provisioning one.** Agents persist, so re-bootstrapping with a different credential
produces a tenant that cannot see them. That interaction is carried into the MEMORY
DR as a question to answer **before** it is built, because the credential guard is
absolute and a design that assumed the operator could just re-provision would be
assuming the one thing nobody may do.

## What this MR does NOT decide

Storage engine, schema, migrations, retention, and the alert subscription
transport — all in the MEMORY decision record, **published before any of it is
built**. Writing those here would produce a document nobody could review against a
working thing.

## Third project law, now written down

In the census docstring beside the other two:

> **Guards assert on what the USER PERCEIVES, not what the machine stores.**
> An `<option value="dev/sla-monitor">` must carry the real id or selection breaks,
> and must never be spoken. The obvious tightening would have been demanding a bug.

## Verification

| Claim | Label |
|---|---|
| 316 tests pass, `tsc` clean | **test-verified** |
| The three laws are recorded in code | **test-verified** (docstring is in a test file) |
| The vision amendment is accurate | **operator-verified** — you wrote the founder's statement, I did not have it verbatim |
| Whether reconciliation is the right *word* | **unverified** — this is a judgement, and you may read it differently |

**One honest limit:** the ADR-004 verification section says the stale vision phrase
should fail a test once Phase 1 is recorded. **That test does not exist yet**, and
the ADR says so rather than implying it does.
