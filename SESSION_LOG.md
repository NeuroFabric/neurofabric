# Session log — priority-insert run, 2026-10-04

Read this first. **A real bug was found in `main` by the operator and fixed, plus
the mechanism that makes its whole class provable.** Everything else from the last
two sessions is listed at the end.

---

## THE BUG — your report, confirmed and fixed

`start-ui.mjs` referenced `WEDGE_PORT` at line 48 with **no import and no
definition**. The comment directly above it claimed the number was imported and
that the file held no copy. The import was never added.

```
$ env -u PORT -u WEDGE_PORT node --experimental-strip-types start-ui.mjs --help
WEDGE_PORT is not defined
```

**MR !93.** Your reading was exact: bare identifier, missing import, `--port`
cannot bypass it because argv parsing runs after the options object is built, and
`Select-String` finding one occurrence is what identified it as a reference rather
than a definition.

### The part that matters most

**My earlier receipt for this exact line was green.** `node --experimental-strip-types
start-ui.mjs --port 1` printed "The wedge is up". That run had `WEDGE_PORT` in
its environment, so `??` short-circuited before the bare reference was evaluated.
**The receipts were honest; the environment flattered the code.** That is now the
standing rule: *the environment that verifies must not be the environment that
flatters.*

---

## The mechanism: no undeclared identifier in shipped entry scripts

**Your call on mechanism, my decision: `checkJs` via a second tsconfig.**

`tsconfig.entries.json` type-checks `start-ui.mjs` with `allowJs` + `checkJs`,
wired into `npm run typecheck` as `tsc --noEmit && tsc -p tsconfig.entries.json`.

**No new dependency** — `typescript` is already the kernel's static gate; this is
the same binary with different flags. Your ADR condition ("if it adds a
dependency") therefore does not trigger, and I did not write one. `noImplicitAny`
is deliberately off: these files are plain JavaScript, and demanding annotations
would bury the one error that matters.

**Proven, not promised.** Deleting the import and re-running the gate:

```
start-ui.mjs(53,64): error TS2304: Cannot find name 'WEDGE_PORT'.
```

### It found a second real defect on its first run

```
start-ui.mjs(100,20): error TS18046: 'error' is of type 'unknown'.
```

`error.message` on an un-narrowed catch binding. It ships fine when the binding is
an `Error` and prints `undefined` when it is not — so it fails **quietly, on the
rare path, and only when the thing is already going wrong.** Fixed.

**Your systemic note is the right one and I will keep it: this is the second
invented reference this week** (`StoreStatus` union, now this import). Both were
statically visible. The first was caught by a type; this one had no type gate at
all. That asymmetry is why the mechanism matters more than the fix.

---

## B1 — the POSIX vault gate, fixed in the SCRIPT

**MR !94.** Your framing was right and I took it: `exit(0)` with a loud
`SKIPPED (not verified)`, never a silent pass.

The reason it mattered more than a red job: it ran as the **last step of
`test-ts`**, so one POSIX assertion was overriding `1..1535 / pass 1533 / fail 0`.
That trains people to see red and not read it — the exact habit that hides a real
failure.

The log now says, every time:

```
SKIPPED (not verified) ... Do not read a green test-ts as proof that
secrets at rest are not world-readable.
```

**D-037 caveat two stays open in configuration only** until a Linux runner runs
it and the log is read. The POSIX path is byte-for-byte unchanged.

**`.gitlab-ci.yml` untouched.** Moving the step into a tagged job would have been
tidier and it is not mine — a failing step *relocated* rather than *answered* is
closer to skipping than to fixing.

---

## MRs ready to merge

**This table is the queue, and it is corrected against the repository rather than
against this file's memory.** !99–!104 are merged and accepted. **!98, !93 and !94
are not open in the repository** — they are struck rather than left listed, because
a queue that names MRs which do not exist is a queue nobody can trust to be a
queue.

| # | MR | Verification |
|---|---|---|
| 1 | **!105** The record, wired: store in the boot path, and the diff for the operator | `node --experimental-strip-types .scratch/boot-proof.mts` |

### Struck — merged and accepted

| MR | What it was |
|---|---|
| !99 | Product identity, and the vision the delivery is judged against |
| !100 | CSS collision guard, and the assembled-tree census |
| !101 | Liveness strip and the front door |
| !102 | Install loop — a form, not a description of one |
| !103 | The MEMORY decision record (ADR-005) and the vision amendment |
| !104 | Phase 1A/1B — `node:sqlite` store, and the five legal disagreements |

### Struck — not open in the repository

**!98, !93, !94.** Closed or never landed there. They are removed rather than
carried, and the receipts below are kept only because they describe work that is
in `main`, not because the MR is available to re-check.

**Receipts for !93 (in `main`):** `test:mjs` 22/22 · `test:ts` 1558 tests / 1556
pass / 0 fail / 2 skipped · `typecheck` clean including the new entries project ·
`entry-contract` 4/4.

**Receipts for !105 (this tree):** `test:mjs` 22/22 · `test:ts` 1589 tests /
1587 pass / 0 fail / 2 skipped · `tsc --noEmit` clean ·
`tsc -p tsconfig.entries.json` clean · frontend `tsc --noEmit` clean · frontend
vitest 384 passed / 6 skipped / 0 fail, 24 files · memory suites 31/31 ·
`.scratch/boot-proof.mts` against a real booted process.

### The queue is one line long, and that is the point

Everything else in this table used to be work waiting on a merge. **The only
thing left is the thing that could not be done without the record first being
merged**, which is the dependency this table exists to make visible.

---

## Budget ruling — confirmed, not changed

**≤50KB gzipped, raw logged beside.** ADR-002 states both: uPlot is **145KB raw,
~45KB gzipped**. Neither number was rounded in the direction that helps.

---

## The design log

Its live content is now in **ADR-002** — the finding-to-slice table, the
deferral argument for the hand-rolled sparkline, and the acceptance criteria that
travel to Slice 3.

`docs/ux-overhaul-design-log.md` is **untracked and now disposable.** It was never
committed, so deleting it removes nothing from history — it just stops being a
document that reads as current with nobody maintaining it. **I did not delete it.**
That is your call, and the deletion guard has been right twice now.

---

## `boot.js` / `boot.mjs` / `builds/` — identified, decision yours

| Path | Size | Tracked | Ignored | What it is |
|---|---|---|---|---|
| `boot.js` | 161 B | no | **no** | the operator's wedge bootstrap; **contains a credential** |
| `boot.mjs` | 154 B | no | **no** | same, minified variant |
| `builds/` | **8.9 MB** | no | **yes** (`.gitignore:88`) | GitLab Runner's build directory, named after the runner |

**My read:** `builds/` is handled — already ignored, never tracked, 8.9MB of
runner scratch that would be a mistake to commit. `boot.js` and `boot.mjs` are
**yours, contain a credential, and are not ignored.** Recommend **gitignoring them
rather than deleting**: they are configuration that carries a value, deleting is
yours, and an ignore rule costs nothing while a deleted file has to be
reconstructed from memory. **Either way they should not be committed, and I have
not staged them in any MR.**

---

## Blockers — all yours

**B1 — Linux runner.** !94 turns `test-ts` green on Windows. **That is not the
POSIX gate passing; it is the POSIX gate not running.** Runbook in !91 §T10.

**B2 — runner token.** Four transcript appearances, one of them mine. !91 §T11 is
the moment; rotation is yours.

**B3 — 60fps and flat heap over 30 minutes.** No browser, no profiler here.
**Logged operator-verified, never claimed.**

---

## What I would do next

1. **Merge !105.** The record is durable and the diff is on screen; the operator
   can acknowledge, and nothing else.
2. **!106 — SSE, and only after this lands.** The subscription is not the record:
   alerts are persisted *before* they are pushed (ADR-005 §5 rule 3), and
   `recordDecision()` still has no caller in the running server. Wiring SSE to
   `gateway.subscribe()` today would push alerts nothing has written, which is the
   one design failure that section names.
3. **B1**, with the runbook in `docs/operator-runbooks.md` §T10.
4. **Decide on `boot.js` / `boot.mjs`** — gitignored rather than deleted is my
   recommendation; they carry a credential and neither is tracked nor ignored.
5. **Slice 3** — uPlot and its first consumer in the same commit, against the
   ADR-002 criteria.