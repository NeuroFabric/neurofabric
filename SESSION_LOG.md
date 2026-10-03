# Session log — autonomous run, 2026-10-04

The operator was away. This is the first thing they read on return: what was
completed, what was decided, what is blocked, and what is unfinished.

---

## COMPLETED — MRs ready to merge

| MR | What | Verify with |
|---|---|---|
| **!82** | MR template + ADR-001 "minimalism as the audit trail" | `type .gitlab\merge_request_templates\default.md` |
| **!83** | README rewritten as a one-page onboarding doc | `npm run dev`, then the flood command in it |
| **!84** | Demo runbook, failure-first | `type docs\demo-runbook.md` |

Merge order is **!82 → !83 → !84**. No dependencies between them.

---

## BLOCKERS — operator only

### B1. `main`'s pipeline is red: `npm` is not on the runner service PATH

**Every job fails before a test executes.** Not a code failure.

```
ERROR: Job failed: exit status 1
npm : The term 'npm' is not recognized as the name of a cmdlet, function,
      script file, or operable program.
      FullyQualifiedErrorId: CommandNotFoundException
```

**Cause.** Node is installed per-user:

```
C:\Users\Rishabh Sharma\AppData\Local\pi-node\current\node.exe
```

GitLab Runner runs as a Windows service and loads the **machine** PATH. A
user-scoped install is not on it. This is why `image: node:22` in the CI file does
not help — a shell executor ignores `image:`, and there is no container here.

**Fix (operator):**

```powershell
# machine-level PATH entry, readable by the service account
$nodeDir = "$env:LOCALAPPDATA\pi-node\current"
[Environment]::SetEnvironmentVariable("Path",
  [Environment]::GetEnvironmentVariable("Path","Machine") + ";$nodeDir", "Machine")

# then bounce the runner so it picks the machine PATH up
Restart-Service gitlab-runner
```

**Verify:** re-run the pipeline. Expect `test-mjs`, `test-ts`, `typecheck` to
execute for the first time in this project's history.

**Note:** the earlier `pwsh` → `powershell` fix **worked**. `measure-wrappers` is
now correctly *skipped* rather than failed, which was its own defect and is fixed
in !81 (merged).

### B2. The demo screenshot is still owed

The P1 mandate says "verify every item against the actual screenshot before
coding". I did not have it, so P1 Phase 1 re-derived every finding **from the
code** and cited the code. Two mandate items are confirmed from code; **any item
that is visual-only is re-derived, not confirmed.** The screenshot would close
that gap.

### B3. Runner token rotation

The runner authentication token has now appeared in a transcript **four** times,
three of them before P2 named it. `config.toml` and `.runner_system_id` are now
gitignored (in `main` via !81), so the repository is closed — but the token itself
has still been exposed. **Rotate once the pipeline is green.**

Rotation also structurally moves the config out of the repository root; a runbook
for that is T11 and is not written yet.

---

## DECISIONS MADE (with reasons)

- **Main-red fix before TASK 1's MR.** !80 landed first, because everything else
  would have been built on a red base. Same reasoning applies to the ordering here.
- **Severity encoded by shape, weight and fill — not hue.** All three severities
  previously differed in exactly two properties, both a thin stroke
  (`color` + `border-color`). Three pills in three hues are indistinguishable on a
  projector, in greyscale, and to a colour-vision difference.
- **The roster keeps tenant-qualified ids; the schema route was changed instead.**
  The tenant comes from the proven credential, never the request, so a bare id is
  not addressable. Recorded in `docs/DECISIONS.md` D-042.1.
- **A composite id naming another tenant is a 404, not a 403** — a 403 would make
  the endpoint an oracle for enumerating another customer's agent names.
- **CI state is reported as a job table, never as a summary.** Twice now a
  pipeline failed before any test ran, and "CI failed" would have said nothing
  useful while a reader assumed the code had been judged.

## SELF-CORRECTIONS (recorded, not quietly amended)

1. **Withdrew a charge against the !78 gate.** I implied it was misreported. It
   was not: `259931c` and `d221f3d` are both **not** ancestors of the tip that was
   gated. The gate was honest; the *merge* changed the result. Now standing rule:
   **state the merge-base whenever citing a commit count.**
2. **Caught the README claiming a feature `main` does not have.** The quickstart
   said both `--flag=value` and `--flag value` work. Running the command proved
   the space form binds an empty credential on `main`. Corrected in place, and the
   cause explained, because "this will work soon" is the optimism this repository
   keeps being bitten by.
3. **Guessed a `SchemaStore` interface in a test and was wrong.** `ingestAgents`
   and `patchStatus` do not exist. Read the real API. Recorded in the test file so
   the next person reads it too.
4. **Invented two `StoreStatus` values.** The real union is `idle | loading |
   ready | degraded`. `statusWord` is now keyed on the union, so a state added
   there fails the type gate instead of shipping untranslated.

---

## UNFINISHED

### U1. P1 Slice 1 — the UI overhaul (STOPPED, NOT PUSHED)

**Working tree only. Not committed, not pushed, because the suite is red.**

Done and individually verified (`product-identity.test.tsx`, **13/13 green**):
- **Neurofebric** as the wordmark, in its own centring region
  (`grid-template-columns: 1fr auto 1fr` — `space-between` cannot centre)
- **Severity as a signal**: critical = fill + weight 700 + uppercase; warning =
  fill + weight 600; info = outline only. Verified by a guard that *fails if any
  severity is distinguished by colour alone again*
- **`prefers-reduced-motion`** — genuinely absent, found by asserting the mandate's
  own criterion rather than by looking for it
- **Status words**: `idle → "Not loaded"`, `degraded → "Partial data"`, keyed on
  the real `StoreStatus` union

**Two assertions in `src/App.test.tsx` fail** and I hit the two-failure stop rule:

```
expected '... Neurofebric schema-driven · 0 agents …' to contain 'data-status="degraded"'
expected '... Neurofebric schema-driven · 0 agents …' to contain 'degraded'
```

Both are in the pre-existing "garbage payload" and "reflects the status" tests,
which asserted the raw word `degraded` because the header used to print the
store's status verbatim. They now print "Partial data", which is the intended
change — **but I could not establish which status those two fixtures actually
produce** within budget, and I will not guess an attribute into a test and push
it. The fix is a one-line change once someone reads what
`loadedStore(...)` produces for that scenario.

**To finish:** run `cd frontend && npx vitest run src/App.test.tsx`, read the
actual `data-status` value, correct the two assertions, then
`npx vitest run && npx tsc --noEmit`, commit and push.

**Two of the mandate's acceptance criteria cannot be verified in this
environment and are not claimed:** 60fps sustained and a flat heap over 30
minutes. Both need a browser and a profiler; there is no DOM here. The design log
says so rather than leaving a green run implying more than it measured.

### U2. Slices 2–6 of P1 — not started

Liveness (pulse, last-updated), stat interactivity, the agent list replacing the
`<select>`, the count-vs-rate explanation, and surface separation. All triaged with
evidence in `docs/ux-overhaul-design-log.md` (uncommitted).

**The sparkline is deliberately deferred.** Redrawing canvas on a 500ms poll is
exactly what would break "≤1 React render per frame" and the flat-heap criterion —
the two places a naive implementation actually fails. It needs a design decision
before it is code.

### U3. T9 — port/process startup check
Depends on P1's startup path. Waits for Slice 1. **Not stacked.**

### U4. T10 — Linux gate for `measure-wrappers`
Not written. The CI change is `tags: [linux]`, which then needs a shared Linux
runner — approval that is the operator's.

### U5. T11 — runner config relocation runbook
Not written. Operator-only steps.

---

## RECEIPTS

**Worktrees (T7 — pre-approved, git porcelain only, no `--force`):**

All four removed cleanly, no refusals.

```
D:/Agent-Harness/agent-harness_omni/agent-harness                         [branch]
D:/Agent-Harness/agent-harness_omni/agent-harness/workspace/head-baseline ce93aa4 (detached HEAD)
```

**Probe wedge on 8096 (T8):** **nothing is listening.** The probe process exited
with the session that started it. No PID to report; no process was killed.

---

## WHAT I WOULD DO NEXT, IN ORDER

1. **B1** — the pipeline fix. Everything else is downstream of having a gate.
2. **U1** — two failing assertions. Ten minutes with a terminal.
3. **U2** — Slice 2 (liveness). The data already exists in `useLiveTelemetry` and
   the UI renders none of it, so it is the cheapest remaining mandate item.
4. **B3** — rotate the runner token once the pipeline is green.
5. **T9, T10, T11** — in the order they appear on the backlog.