# Roadmap

Working document for F-006 post-reversal work. Sourced from `docs/F006_LEDGER.md`
and the operator rulings of 2026-10-01.

## Status

Branch `fix/f006-policy-deny-not-fatal` is merged into `origin/main` at `fca77fc`
(merge commit `066b2b4`, `gate recovery depth on non-CONTINUE strategies`).

| Suite | Result |
|---|---|
| `platform/pi` | 336 pass / 0 fail |
| `platform/core` | 189 pass / 0 fail / 2 skipped |
| `platform/*.test.mjs` | 22 pass / 0 fail |

## Operator blockers — restated at every status report

None of these are agent-resolvable. Each one is a person pressing a key.

| # | Blocker | What it holds |
|---|---|---|
| 1 | **Push pending** | Branch `fix/f006-post-reversal-ledger` is local only. Nothing on it is visible to CI or to the MR. |
| 2 | **Restart pending — now blocking C2** | The operator's restart confirmation does not exist in `docs/MANIFEST.md`. Until it does, C2 cannot start and the merge stays un-ratified. |
| 3 | **Item-1 MR merge** | Awaiting operator merge. A merge in the tree is not a ratified checklist item. |
| 4 | **Docker gate run on B1** | The container suite gate is `UNVERIFIED` — Docker is not installed in the authoring environment. It must be run by the operator, and no UI work starts before it is green. |

## Operator rulings, 2026-10-01

**R1 — the D1 contract reversal.** A denied call is a **result, not a death**.
`POLICY_DENIED` returns `CONTINUE` / `POLICY_SOFT_REFUSED` at every violation label
and at every budget. Rationale: a refusal is an answer, not a fault, and a fault is
what a task is allowed to die of. `abort` still ends a task, one layer out, in
`precheckToolCall` → `abortTask`, where it is reachable.

**R2 — `REPLANNING` stays an open question.** See "Human decision required".

**R3 — the ledger gets a reversal entry.** `docs/F006_LEDGER.md` §2.5 quotes
pre-reversal code as present tense. It is evidence of a bug, not current law, and
must be marked as such before the ledger is used as a corrective authority again.

## Human decision required

**`REPLANNING` and the stored-failure echo** — ledger §3.2.

`REFUSED_EXECUTION_STATES` includes `REPLANNING`, which the ledger's own
`TERMINAL_TASK_STATES` comment calls "still live and still owned by whoever started
it". Of the three sites gated on that set, only `kernel-adapter.ts:835`
(`describeTerminalRefusal`) replays the stored reason. **That replay is unpinned for
`REPLANNING`.**

Two candidate answers, both live:

- **yes** — a live `REPLANNING` task should replay a stored reason, and the pin
  should be added;
- **no** — `REPLANNING` should refuse without replaying a stored reason.

**Deliberately not pinned.** A pin must assert one of these, and choosing silently
would launder an open design question into settled law. Requires an operator
decision. No code change.

## P1 — caller-boundary fix: a refusal is indistinguishable from a tool fault

Measured on `fca77fc`. `recordToolResult` returns to its caller:

```json
{"status":"INVALID","validator":"pi-result","message":"policy denied: refused by rule X"}
```

The reason reaches the caller verbatim, so attribution is intact. But
`validator: "pi-result"` with `status: "INVALID"` is **byte-identical to a genuine
tool failure**. Any caller branching on `validator` to decide whether to retry
treats a policy refusal as a fault and retries it — the D1 defect reborn one layer
out, at the return boundary, where the kernel's own `POLICY_DENIED` classification
can no longer reach in to correct it.

This is a behaviour change at a **public boundary**. It gets its own review cycle
and is not bundled with the reversal.

Documenting pin: `platform/pi/f006-policy-denied.test.ts`, `D1.1c`. It asserts the
preconditions (the refusal is classified `POLICY_DENIED` internally, and the reason
reaches the caller verbatim) and names the gap in a comment. **It does not assert
`validator` is undefined** — a permanently red pin breaks CI and trains people to
ignore red. The pin inverts when the fix lands.

## Phase 5 split — operator ruling, effective immediately

Phase 5 previously ran as one gated item. It is now split:

- **5a — scaffolding. AUTHORIZED. Track B, new branch `docker-ui-scaffold`.**
  Dockerfile + compose for the green baseline, and a frontend shell built on
  mock data. Contracts only; no dependency on any unbuilt plane. Track B
  commits directly to its own branch, MR per milestone, operator merge
  ratifies. **Track B must not modify `platform/` internals.**
- **5b — production integration. STILL GATED** on the acceptance test. Not
  un-gated by this ruling.

The two tracks, and the only things gating production integration:

- **Track A (unchanged, continues here):** Phase 1 queue → State plane →
  Observability plane.
- **Track B (scaffold only):** 5a above.

Track A items are the only gate on production integration.

**Phase numbering is externally sourced.** Neither `roadmap.md` nor
`docs/F006_LEDGER.md` contained a `Phase N` construct before this entry; the
numbering comes from a plan held outside this repository. Recorded as stated, not
reconstructed.

**5a's own gate is stated and currently UNVERIFIED:** the container must run the
full test suite green before any UI work. Docker is not installed in the authoring
environment, so the gate cannot be evaluated there. See Track B item 1 below.

**Track B forks from `12c89d5`,** not `fca77fc`. The delta is docs and one comment;
both are green, and forking from the tip avoids a rebase later. Fork SHA recorded
in the MR.

## Work order of record — operator, 2026-10-01

**The work order is a multi-session plan, not a session plan.** The honest unit
of work is a *completed* item: complete items, leave nothing half-assessed.
That is why the confirmed ordering is not the full plan and why the items
below are the whole of what was authorised this session.

| Order | Item | State | Outcome |
|---|---|---|---|
| 1 | F006 work-order record (docs-only) | unblocked | done — F006 §5, and this table |
| 2 | **C1** echoed-refusal | self-contained | **done — read, measured, FILED** as F006 §5 item 7. Not closed: it is a live defect, and the fix needs its own branch. |
| 3 | **B2 item 1** — Dockerfile + compose | unblocked | done on `docker-ui-scaffold`, status `UNVERIFIED` pending the operator's Docker run |
| 4 | Full status report, both tracks | this document's sibling | done |

**Explicitly not started, and why.**

- **The frontend shell scaffold.** Multi-milestone. Starting it this session
  would end it half-built, which is the failure mode the ordering exists to
  avoid. It is next-session work and nothing depends on it existing.
- **C2.** Blocked on blocker 2. Not started.
- **E1–E8 assessments.** Next session. No assessment branch was opened,
  because an assessment that cannot be finished is worse than no branch: it
  reads as progress in the tree and is nothing in the ledger.

## Standing rules

**Shell `grep` is prohibited; the harness `grep` tool is the sanctioned
mechanism.** The prohibition is on grep *pipelines inside shell one-liners* —
the ones that bypass the harness's own tooling and produce output no tool call
logged. The `grep` tool is compliant and is the mechanism to use. Ratified
2026-10-01 after the reading was challenged and upheld.

**Commit messages paraphrase a gate command when a guard rejects the literal.**
When the deletion guard conflicts with writing the command in a commit message,
describe the command and never quote it. The gate command itself lives in
`roadmap.md` and the CI config, which is where a reader can execute it — not in
prose, where it would be a dead end and a way to trip the guard again. This
closes the rule conflict rather than leaving it to be rediscovered. Ratified
2026-10-01.

**No agent may claim verified-green for a gate this harness cannot execute.**
Label the result `UNVERIFIED`, name the executor who must run it, and move on.
Ratified 2026-10-01 after Track B's container gate was found to be unrunnable here.

The rationale is not ceremony. An agent-authored "verified green" for an
environment it never started is the same defect as a caller told `pi-result` for a
policy refusal: a truthful-looking value that is not what it claims to be, sitting
exactly where a later reader will not re-check it. `UNVERIFIED` plus a named
executor is cheap. A fabricated green is not.

## Track B interface ownership

All Track B wire-point interfaces are marked **`@provisional`** in code, with a
comment naming the owning plane (State / Observability).

**Track A is not bound by them.** If Track A's real contracts diverge, **Track B
updates to match — never the reverse.** Track B may not constrain Track A's
design; these interfaces are scaffolding, not a contract.

## Remaining work

| # | Item | State |
|---|---|---|
| 1 | This roadmap | done |
| 2 | Stale comment, `kernel-adapter.ts:1620-1623` | done (`d25ee8e`) |
| 3 | Documenting pin D1.1c | **blocked — awaiting operator paste** |
| 4 | Ledger reversal entry | pending, diff first |
| 5 | Caller-boundary fix (validator threading) | deferred — own review cycle |
| C1 | Echoed refusal: a sibling refusal fails the task | **FILED** — F006 §5 item 7, measured, unfixed |
| B1 | Dockerfile + compose, green baseline | authored, **`UNVERIFIED`** — operator's Docker run |
| B2 | Frontend shell, mock data | pending B1 |
| B3 | Typed wire points for State + Observability | pending B2 |

## Standing hazards

- **The §3 alarm is disarmed.** Its trigger — a denial certificate reading
  `TOOL_FAILURE` and dying of `REPLAN_BUDGET_EXHAUSTED` — is now unreachable: a
  denial returns `CONTINUE` under every label at every budget. An operator reading
  §3 believes they are covered and are not. Corrected by the ledger reversal entry.
- **`docs/F006_LEDGER.md` is not a specification.** It is an incident record. Using
  it to justify a code change, without first reading the section's framing, will
  revert the reversal.