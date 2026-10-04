# ADR-004 — Recollection is reconciliation against persisted history, and multi-tenancy arrives at Phase 5

- **Status:** accepted — **direction only**. The MEMORY decision record that
  specifies the mechanism is a separate document, published before it is built.
- **Date:** 2026-10-04
- **Relates to:** ADR-003 (interim), `docs/PRODUCT-VISION.md`, `platform/core/context-memory.ts`

---

## Context

Two things arrived at once and they are not the same thing.

**The product is verified alive and correct but forgets everything.** The
operator's own note frames it precisely: *with no persistence, a restart is a
stranger's arrival.* Every cold boot is a first meeting. The agents are gone, the
demo agent is gone, the history is gone, and the front door has to be pressed
again. That is tolerable for a demo and disqualifying for a product.

**The engine is already multi-tenant and the product pretends not to be.** The
registry namespaces every agent as `tenant/schemaId`, and D-042 established that
this is deliberate and load-bearing: the tenant comes from the *proven
credential*, never from the request, and reverting it would trade a correctness
property for test convenience. But the screen presents a single tenant, and
`docs/PRODUCT-VISION.md` currently lists multi-tenancy in the UI as out of
scope.

## What "recollection" means here — and what it does not

**This is the part worth writing down, because the word is doing a lot of work.**

The temptation is to call persistence "memory": an agent that remembers. That
framing imports an obligation this product has not accepted and should not. A
system that *remembers* must answer "what do you remember about me, and how do I
correct it", and that is a user-data problem with retention, export and deletion
attached.

**What this product actually needs is reconciliation.** On restart, the platform
rebuilds its state from a durable record and tells the operator **exactly where
the rebuilt state and the record disagree**. Not a narrative of what happened —
a diff, with the disagreement named and the operator asked which is true.

Three properties follow, and they are the whole decision:

1. **Reconciliation is not recall.** The system does not "remember" a verdict; it
   reads a persisted verdict. The distinction matters because it decides whether
   memory can be *wrong* in the way a human's can, and whether correcting it is a
   conversation or a migration.
2. **The diff is the product.** A silent reload that quietly discards a change is
   worse than a crash: it is the class of bug this whole project exists to refuse.
3. **Rebuild is from the record, not from the event log.** Replaying events to
   reconstruct state would make every restart a replay and every replay a chance
   to differ from last time.

## Decision

1. **Durable history is the source of truth for display; the live window is the
   source of truth for the current reading.** Two truths, each for its own job.
   The screen shows both and never merges them into a single number.
2. **On restart the platform reconciles and REPORTS.** Divergence is surfaced with
   the operator as the resolver. It is never resolved silently in either direction.
3. **Multi-tenancy in the UI is a Phase 5+ destination, not an exclusion.**
   `docs/PRODUCT-VISION.md` is amended accordingly. The engine is already correct
   here and the screen is not — the gap is presentation, not architecture, which
   is the cheapest possible place for that gap to live.

## Consequences

- **The vision changes.** "Multi-tenancy in the UI: out of scope" becomes "not
  yet; the engine is tenant-scoped and the screen is not". That is a weaker claim
  and a more accurate one.
- **ADR-003's interim note is now load-bearing.** It says Phase 1 MEMORY revisits
  "live" semantics. With history, the state set changes: *"arrived, nothing since"*
  stops being a dead end and becomes *"last arrived 4 hours ago"*, which is a
  **fact about the record** and not a statement about the wire. The MEMORY DR
  specifies that change; this ADR only commits to making it.
- **Cold boot stops being a stranger's arrival.** That is the operator's stated
  test for this work, and the only thing that makes it pass is durable state.
- **Restoring the operator's `boot.mjs` credential is now a data question**, not a
  provisioning one: agents persist, so re-bootstrapping with a different credential
  produces a tenant that cannot see them. That interaction is explicitly **not**
  solved here and is named in the MEMORY DR as a question to answer before it is
  built.

## What this ADR deliberately does NOT decide

The mechanism. Storage engine, schema, migration story, retention, and the alert
subscription transport are all in the MEMORY decision record, which is **published
before any of it is built** and ratified by reading. Writing those decisions here
would produce a document nobody could review against a working thing.

## Verification

Falsified by this ADR if the system ever resolves a restart divergence silently,
or if the UI presents multi-tenancy as out of scope after Phase 1 memory ships.
The second is checked by a test that reads `docs/PRODUCT-VISION.md` and fails on
the stale phrase once Phase 1 is recorded — which is not yet, and this ADR says so.