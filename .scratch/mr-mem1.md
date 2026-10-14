## What changes

**Phase 1, steps 1A and 1B**, built to ADR-005. `platform/memory/store.ts` and
`platform/memory/reconcile.ts`, with 18 tests.

**Zero dependencies, and not a slogan.** `node:sqlite` is a Node built-in — no npm
entry, no lockfile line, no native build. D-018 and ADR-001 are untouched.

**Verified on this machine, not assumed:**

```
node:sqlite available: DatabaseSync, StatementSync, constants, backup
roundtrip: [{"id":"a","v":"1"}]
user_version supported: {"user_version":0}
```

## 1A — the write boundary

A decision writes its **verdict, alert and audit trace in ONE transaction**, before
anything is pushed to a subscriber.

**One transaction is the whole point.** Three separate writes leave a window in
which an alert exists with no verdict behind it — exactly the corruption the DR says
must be an alarm rather than a line in a list. A failing write rolls back **all
three**, and the test asserts the verdict did not advance either.

**The rule that decides what is written, rather than how:** *we pay the blocking
cost only for facts that change what a person does next.* An alert qualifies.
Events, rollups, read state and the live window do not, and never touch a decision
path.

**A crash therefore eats the live window entirely** — by design, it measures *now* —
and events in flight, which is the sender's problem and is said to be so. **It cannot
eat anything that has been acted on**: if an alert reached a person it is already
durable. That ordering *is* the guarantee, and a test proves it by closing the store
and reopening the **file**.

Re-decisions **replace** the verdict rather than growing a row per 500 ms poll — a
table that appended would gain 120 rows a minute and answer "the current reading" by
reading all of them.

**Migrations** follow ADR-005 §8 exactly: `PRAGMA user_version`, numbered and
ordered, **never edited after release**, one transaction each with the version
written inside it, **forward only**. There is no `down` — reverting code while the
data is ahead is answered by restoring a backup, and the platform says so rather
than silently reverting.

## 1B — boot reconciliation, and why the five are enumerated

**A reconciliation that can report anything is one nobody reads.** If every
difference looks possible, the operator learns to skim — and the day real corruption
appears, they skim past it.

Each of the five legal disagreements gets its own case. **Corruption is not a
difference**, and three cases prove it stays that way:

- an unreadable document
- a live agent the record has never heard of
- **a validator that *throws* rather than returning a verdict** — otherwise every schema is reported invalid the first time a validator changes shape, and the list is skimmed forever

Differences carry **what the operator can do**, not a repair. The system presents
the difference and does not choose: a reconciliation that silently migrates a
customer's records is making a claim nobody asked for. The summary **leads with
corruption**, because it is the only category that means something is *wrong*
rather than something *changed*.

## What could break

- **`node:sqlite` is experimental.** The `ExperimentalWarning` on boot is **not
  suppressed**, deliberately — a platform that hides its own warnings eventually
  hides real ones. Expect a line in the wedge's output and know why it is there.
- **Node ≥ 22.5 is now a floor** for this feature, enforced with a clear message.
- **WAL mode is set** for durability, not performance. A consequence: the database
  is now a directory of files rather than one file, and the directory is not
  atomically replaceable.
- **The corruption test reaches no private fields.** It opens the real file with a
  second connection, because corruption is something that happened to a file and
  testing it through a private handle would have tested the test.
- **One test was wrong and the code was right.** My first tenant-isolation case
  seeded one tenant and asserted "no differences" for another — which correctly
  failed, because an empty tenant seeing an unknown provider **is** difference 3.
  Both tenants are now seeded.
- **Nothing calls this yet.** The store is not wired into `start-ui.mjs` in this MR.
  That is the next step, and shipping an unwired persistence layer is deliberate:
  a store nobody opens cannot corrupt anything, and this one is proven before it is
  trusted with a boot.

## Verification labels

| Claim | Label |
|---|---|
| 1574 passing, 0 fail; 18 memory tests | **test-verified** |
| The record survives close and reopen, alert intact | **test-verified** |
| One transaction rolls back all three writes | **test-verified** |
| Each of the five legal differences is provoked and recognised | **test-verified** |
| Corruption is not folded into differences | **test-verified**, three cases |
| Whether the boot line reads acceptably with the warning | **unverified — operator** |
| Reconciliation surfacing in the UI | **not built.** This is the next MR |
