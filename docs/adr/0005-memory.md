# ADR-005 — MEMORY: what persists, and how the system tells you when it disagrees with itself

- **Status:** proposed — **published for ratification before any of it is built**
- **Date:** 2026-10-04
- **Ratified by:** *pending. The operator reads this before implementation begins.*
- **Relates to:** ADR-003 (**interim — resolved by §6 below**), ADR-004,
  `docs/PRODUCT-VISION.md`, D-017 (vault stays dark)

> **Read-before-build gate.** No `node:sqlite` code, schema, or migration ships
> until this document is ratified. Nothing here is implemented. Where a choice is
> genuinely open it says so rather than picking quietly.

---

## 1. Scope — what persists

Five things, and a deliberate sixth absence.

| Persists | Why | Retention |
|---|---|---|
| **Agents** (schema documents) | The operator authored them. Losing them loses work, and re-authoring is not something to ask for after a restart. | Indefinite, until the tenant deletes them. |
| **Schemas** (versioned rule bodies) | Same documents, version history retained. | Every version, indefinitely. |
| **Verdicts** | The reason an alert exists after the window has moved on. A verdict nobody can look up is an alert nobody can act on. | Bounded window, then **summarised**, not deleted. §1.1. |
| **Alerts** | A raised alert that vanishes on restart is not an alert. | Indefinite, with acknowledgement state. |
| **Audit traces** | Who did what, when, under which credential. This is the project's thesis: git, tests and oversight. A system that forgets its own history cannot be audited. | Append-only, indefinite. |
| ~~Transient samples~~ | **Does not persist.** Individual ingested events are the wire's business, not the record's. Persisting them is retention we have not accepted. | n/a |

### 1.1 Why verdicts are summarised rather than kept whole

A verdict is a distribution over a window. Keeping every one forever is a growth
problem with no product answer. Keeping none makes every alert unactionable.

**Decision:** the *latest* verdict per (tenant, agent, column) is kept whole, plus
**hourly rollups** for a rolling window. §7's two-truths contract depends on the
latest one existing.

---

## 2. The restart story

Five steps, and the order is the argument.

1. **Open the database.** If it does not exist, create it and write the current
   schema version into `PRAGMA user_version`. **An empty database is not an error**
   — it is a first run, and the operator is told so plainly rather than shown an
   error.
2. **Migrate** if `user_version` is behind. §8.
3. **Rehydrate the registry** from persisted schema documents. Same
   `DynamicAgentRegistry`, same validation — a document that would be refused now
   was never allowed in, so a refusal here is **corruption**, not drift, and it is
   reported as such rather than skipped.
4. **Attach the live gateway and begin an empty window.** The live window is
   *never* restored; it is a measurement of now.
5. **Reconcile and report.** Anything the record and the rebuilt state disagree
   about is surfaced, with the operator as the resolver. §7.

**What a restart is NOT:** a replay. Events are not re-ingested and state is not
recomputed from them. A replay makes every restart a chance to differ from last
time, which is the failure this project exists to refuse.

**The operator's framing is the acceptance test:** *with no persistence, a restart
is a stranger's arrival.* After this, a restart is a colleague coming back.

---

## 3. UI behaviour when history exists

Three additions, each of which is a new way to be wrong, so each is named with the
risk it carries.

**3.1 The list is no longer empty after a restart.** A stranger and a returning
operator see different screens. That is correct and it must look correct — the
returning operator should see *their* agents and nothing should suggest the demo
data is theirs.

**3.2 A "last seen" column.** For each agent: when it last produced a verdict.
This is the first thing a returning operator asks and today the screen cannot
answer it.

**3.3 History is opt-in per panel, never the default.** The default view stays
live. History is what you open when the live answer is not enough — a burst chart,
an alert's lineage, an agent's last week. **Risk: a screen that defaults to
history shows stale numbers as if they were current.** That is F1 again, and it is
the reason history is never the default.

---

## 4. Zero-dependency: `node:sqlite`

**Verified on this machine, not assumed:**

```
$ node -e "const s=require('node:sqlite'); ..."
node:sqlite available: DatabaseSync, StatementSync, constants, backup
roundtrip: [{"id":"a","v":"1"}]
user_version supported: {"user_version":0}
(node:1256) ExperimentalWarning: SQLite is an experimental feature...
```

**Zero npm dependencies. Zero lockfile entries. The kernel's D-018 claim is
untouched.**

Three consequences stated plainly rather than discovered later:

- **It is EXPERIMENTAL and node prints a warning on every boot.** Suppressing that
  warning would be hiding a real status from the operator, so it is **not**
  suppressed — and the boot line will say why it is there.
- **It requires Node ≥ 22.5.** That is a floor the repository does not currently
  declare. It becomes one, or the feature is behind a version check.
- **It is synchronous.** Writes block the event loop. §7 is about exactly how
  little is written, and that constraint is the reason.

**Rejected:** `better-sqlite3` (a native npm dependency, contradicting ADR-001),
a JSON file (no atomicity, no query, and a corrupt write loses everything),
and `node:fs` append logs with hand-rolled indexing (reimplementing a database,
badly).

---

## 5. Alerts — subscription over HTTP with token auth

**Decision: Server-Sent Events on an authenticated HTTP endpoint.** Not
WebSocket, not long polling.

- **SSE is one-directional**, which is all this needs — the platform raises alerts,
  it does not receive them.
- **It is plain HTTP**, so the existing token guard applies unchanged. There is no
  second authentication path to get wrong, and **the same proven credential is the
  same tenant**, so an alert can never cross a tenant boundary by a transport
  detail.
- **It is built on `node:http`**, which the platform already uses. Zero
  dependencies follows from the choice, and it is the reason for the choice.

**Three rules, because a live alert channel is the most dangerous surface here:**

1. **Authenticate at connect, not per event.** The tenant is fixed for the life of
   the connection, derived from the proven credential. A stream cannot be
   re-scoped mid-flight.
2. **Back-pressure is explicit.** A consumer that cannot keep up is told and
   disconnected, **never silently buffered**. A silently buffered alert queue is
   a queue that eventually delivers stale alerts as though they were new.
3. **The subscription is not the record.** Alerts are persisted *before* they are
   pushed. A dropped subscriber loses a notification, never an alert — which is
   why §7 writes at decision time.

---

## 6. "Live" semantics when history exists — ADR-003's interim, resolved

ADR-003 committed that MEMORY would revisit this. **This section resolves it.**

ADR-003's rule — *live requires a non-zero rate* — **stands unchanged.** What
changes is the meaning of the states that are *not* live, and this is the whole
reframe:

| ADR-003 interim | With history | Why |
|---|---|---|
| `empty` = "arrived, nothing since" | `quiet` = "nothing arriving since 14:32" | A **fact about time**, answerable and checkable, rather than a state of being. |
| — | **`last seen 4 hours ago`** | The single most useful fact a returning operator has, and impossible without history. |
| `stalled` = the feed is too old | **unchanged** | Still means *something is wrong*. History does not excuse a stalled feed. |

**The distinction that matters and that the states must never blur:**

> **A feed that is quiet is a condition. A feed that is stopped is a fault.**
> History tells you *when* it was last alive. It does not make the silence okay.

This is why `stalled` survives the refactor unchanged, and why "no data for four
hours" must not be rendered in the same ink as "no data for four seconds".

---

## 7. The persistence boundary — and where disagreement *legally* arises

### 7.1 What is written synchronously, at decision time

`node:sqlite` is synchronous, so **every write blocks**. That is the constraint
that decides this section.

**Written before the alert is raised, in the same transaction:**

1. The **verdict** for the window.
2. The **alert**, if the verdict breached.
3. The **audit trace** entry.

**Never written synchronously:** individual events, rollups, read-side state, the
live window. Everything else is derived and recomputable.

**The rule, in one sentence: *we pay the blocking cost only for facts that change
what a person does next.*** An alert is that. A rollup is not.

### 7.2 What a crash can eat — stated, not minimised

- **The live window, entirely.** By design: it is a measurement of now and no
  historical fact depends on it.
- **Events in flight.** The sender's problem, and honest — an ingest that was
  acknowledged is durable; one that was not was not received, and the client is
  told the difference.
- **Nothing that has been acted on.** If an alert is on screen, it is in the
  database. That is the ordering above and it is the whole guarantee.

### 7.3 Where disagreement legally arises — so the diff has a *defined* meaning

A reconciliation that can report anything is a reconciliation nobody reads.
**Disagreement is legal in exactly five places**, and the rest is corruption:

| # | Legal disagreement | Why it is not a bug |
|---|---|---|
| **1** | A schema in the record that the **current** validator refuses | The grammar tightened after it was written. The operator decides: migrate or retire. |
| **2** | A schema in the record with **no** matching live window | Expected between a restart and the first reading. |
| **3** | A live window whose **provider** is not in the record | The wedge was pointed somewhere new. |
| **4** | The record's **schema version** is behind the code's | Migration pending or interrupted. Named, resumable. |
| **5** | A **verdict** in the record newer than anything live | The live window was reset. History is ahead; that is expected. |

**Everything else is corruption** and is reported as such — loudly, with the row —
rather than being folded into a "differences" list where it would be skimmed.

**Why this matters:** without a defined set, "the diff" is a diff a human has to
interpret from scratch on every restart. With it, five known shapes are recognised
automatically and anything else is an alarm.

---

## 8. Schema versioning — migrations when data outlives the code

`PRAGMA user_version`, which `node:sqlite` exposes and which was verified above.

**Rules:**

1. **One number, one meaning.** `user_version` is the migration the database has
   had applied. The code carries the list.
2. **Migrations are numbered, ordered, and never edited after release.** A shipped
   migration is a historical fact; changing one silently corrupts databases that
   already ran it.
3. **Each is one transaction.** An interrupted migration leaves the version
   unchanged and re-runs cleanly. There is no half-migrated state.
4. **Forward-only.** A downgrade would mean discarding a customer's data. If the
   code is older than the record, the record wins and the operator is told to
   upgrade — **the platform refuses to start rather than silently reverting.**
5. **A migration that cannot be expressed is not a migration.** Rebuildable derived
   data (rollups) is dropped and recomputed, never migrated.

**And one deliberate absence: there is no `down`.** Reverting code while the data
is ahead is a real operational situation, and the answer is *restore a backup* —
which is why §10 requires one before any migration runs.

---

## 9. The two-truths visual contract

ADR-004 set the rule: **history is the truth for display; the live window is the
truth for the current reading.** The risk is F1 — two surfaces, both true, a reader
forced to reconcile them. So the distinction must be **structural, not a caption**.

**Three rules, each one preventing a specific F1:**

1. **They never appear in the same block.** No panel mixes a recorded number and a
   live number. Two panels, two headers, each stating its own source in words —
   **"From the record"** and **"Live"**.
2. **Every figure carries its age.** `recorded 14:32` is not a number a reader can
   mistake for `live now`. This is F1's actual shape: the F1 bug was a panel with
   no data beside a panel with data, and nobody could tell they were the same
   question.
3. **A recorded breach and a live breach look different, deliberately.** A recorded
   one is dated and calm; a live one is current and carries the pulse. Rendering
   them identically would let a four-hour-old alert read as a thing happening now —
   which is the specific dishonesty this contract exists to prevent.

**Perceived, not stored** (project law 3): the tests assert on what a reader is
*shown*, and a timestamp in a machine attribute is not sufficient evidence.

---

## 10. The tenant migration question

**The general answer, for a tenant whose credential changes.**

The operator's credential rotation has already made this concrete, so it is
answered against the real case rather than an abstract one.

### 10.1 The problem

Identity in this system is `tokenId` — the **id** in the credential, not the
credential value. That is deliberate and load-bearing: rotating a credential's
*value* must not change who you are, or every rotation would orphan a customer's
records.

**So: rotating the value changes nothing. Changing the `id` would orphan
everything**, because the tenant's records are namespaced by it.

### 10.2 What the system does, and does not do

- **Credential value rotation → automatic and correct.** The id is unchanged, so
  the tenant is unchanged. Nothing to migrate. **This is the design working.**
- **Credential id change → refused at boot, with the answer.** The platform
  detects an existing record belonging to an id that no longer authenticates, and
  **refuses to start with an explicit "these records belong to an identity that no
  longer exists" message naming the records.** It does not reassign them silently,
  and it does not start empty and pretend the history was never there.
- **The migration itself is an explicit operator act**, never automatic, because
  reassigning a customer's audit history to a different identity is a claim about
  provenance that only the customer can make.

### 10.3 Why automatic reassignment was refused

It is the one operation in this design that could **falsify an audit trail**. Every
other write preserves what happened; this one would change who it happened to. An
audit trace that can be silently reattributed is not an audit trace.

---

## 11. What this DR does not decide, and what it explicitly refuses

- **Retention periods in wall-clock terms.** §1 gives shape; numbers need volume
  data this system does not have yet.
- **Encryption at rest.** D-017 keeps the vault dark; this is the same question
  asked about a different store and gets the same answer — deferred, not decided.
- **Any model call.** D-034 first, and none is proposed.
- **Multi-tenancy in the UI.** Still Phase 5+, still presentation-only (ADR-004).

## 12. Verification this DR is accountable to

| Claim | How it is checked |
|---|---|
| `node:sqlite` works with zero npm deps | **Verified above, on this machine.** A test asserts the kernel manifest has no `dependencies` field. |
| The five legal disagreements are recognised | TDD: five cases in §7.3, and a sixth asserting corruption is NOT folded in. |
| Two truths never share a block | A rendered-markup test, **perceived not stored**. |
| No live figure is shown without an age | A census assertion. |
| The stale vision phrase is gone | **Added in this MR** — §13. |

## 13. The honest limit, closed in this MR

ADR-004 said a test *should* fail on the superseded "multi-tenancy is out of scope"
phrase once Phase 1 is recorded, and that **it did not exist**. It exists now:

**`frontend/src/vision-claims.test.ts`** reads `docs/PRODUCT-VISION.md` and
`docs/adr/0004-recollection-is-reconciliation.md` and fails if the superseded
claim reappears, or if ADR-004 is missing.

**A vision document is not code, and a document that drifts is how this one
drifted.** It is asserted in the same place as everything else.