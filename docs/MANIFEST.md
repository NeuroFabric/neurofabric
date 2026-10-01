# MANIFEST — the merge interface

**Everything the operator needs to merge, restart and verify without asking a
question.** Maintained by Pi on branch `docs/manifest`, updated on **every**
push. This file is the whole interface between the agent's work and the merge
session.

Measured in-repo. Operator-measured figures are attributed. **Environment claims
are measured, never asserted** — an unverified claim is recorded as unmeasured.

- Generated: 2026-09-30, from local repo root
- Base: `main` = `625e59f`, in sync with `origin/main` (measured after `git fetch origin`)
- Suite command: `npm test` = `typecheck` + `platform/*.test.mjs` + `platform/{core,pi}/*.test.ts`
- Baseline on `main`: **480 tests, 478 pass, 0 fail, 2 skipped — GREEN**
- **This branch (`fix/d4-path-boundary`, based on `docs/manifest` @ `1f2bc1d`): 497 tests, 495 pass, 0 fail, 2 skipped — GREEN**, measured `npm test`. The 2 skips are the pre-existing Windows permission-bit cases in `platform/core/vault.test.ts`, not a gap. The +17 over baseline is the new `platform/pi/path-boundary-corpus.test.ts`.

## 2026-10-01 — inherited state and the session's disposition

Recorded here because the manifest is the operator's interface, and a stash left
in a tree is state the operator did not put there and has not ruled on.

**`stash@{0}` — DROPPED, this session, on operator ruling.** It held the Track A
task-4 ledger reversal entry, and that content is now committed as `927fdb1e`.
Verified before dropping, not assumed: the stashed patch and `git show
927fdb1e` were byte-identical, so nothing unique was destroyed. Its base was
`12c89d5`, a commit that predates the `9d5dea0` docs entry — the ledger half was
simply carried forward and committed later, which is why the two patches match
exactly. The hazard was the redundancy, not the stash.

**`stash@{0}` (formerly `stash@{1}`) — INHERITED, NOT TOUCHED.** `part-c-
unrequested-2026-09-30`, on `fix/lifecycle-refusal-truth`. It predates this
session's work and is **left intact for operator disposition**. No agent has
read it, applied it, or assessed it. It is listed so it cannot be discovered
later as a surprise.

**The disclosed violation is closed.** A prior session left uncommitted work
and created a stash without disclosing it. Disclosed, ruled on, and closed by
the drop above; no further action.

**Filed this session, unfixed — two defects fell out of closing C1:**

- **F006 §5 item 8 — a refusal that settles as a SIBLING kills the task.**
  Measured: two executions bound as siblings, the refused one settling first.
  `observeToolResult` takes the early return at `kernel-adapter.ts:1300`,
  appends an `INVALID` validation and sets `attemptBlocked = true`, and returns
  **before** the recovery block — so `SOFT_REFUSAL_CONTINUED` never runs and
  `denialReason` is never read. The last sibling then succeeds,
  `lastValidation` is `VALID`, and `finishTask:1807` fails the task with *"One
  or more results in this attempt failed or could not be verified"*: **no rule,
  no policy, no path**, and nothing failed verification at all. Live, reachable,
  unfixed. The lone-denial path is intact — measured, task returns to
  `PLANNING`. Full transcript in F006 §5.
- **F006 §5 item 9 — the `REPLANNING` refusal text tells a live task that it
  terminated** (`kernel-adapter.ts:795`). One sentence, one site. Deferred
  because it changes a public refusal string.

**C1 itself is CLOSED**, by measurement and a green pin, not by prose: a
`REPLANNING` task cannot hold a `failureReason` (all eight sites that write one
target `FAILED`, which is terminal; `REPLANNING` is transient), so the replay
tail is unreachable and the "should it replay?" question has no live answer to
give. `platform/pi/c1-replanning-stored-failure.test.ts`, `C1.1`–`C1.4` — the
invariant is pinned, and `C1.3` guards the terminal replay so the closure
cannot later be satisfied by deleting the attribution.

**Operator blockers, restated:** **restart pending (blocks C2)**; the Docker
gate run on Track B item 1 outstanding. Push and the item-1 MR merge are both
cleared as of 2026-10-01. Roadmap §"Operator blockers" is the table of record.

**Two leftovers for the operator to delete.** Both are untracked, dot-prefixed
scratch, so the suite glob `platform/pi/*.test.ts` matches neither and neither is
in any commit or MR. Neither could be removed from here because the deletion
guard denied the operation, and routing around that guard is precisely what it
exists to prevent.

- `platform/pi/.c1-probe.test.ts` — a throwaway probe. Its header now reads
  **"SPENT PROBE — kept rather than deleted, on purpose"**; the earlier quote in
  this manifest ("TEMPORARY PROBE. Not a pin. Deleted after the C1 read") was
  stale and is corrected here. Its findings are pinned in
  `platform/pi/c1-replanning-stored-failure.test.ts`.
- `platform/pi/.s8-probe.test.ts` — a scratch probe used to measure the item 8
  sibling path directly. Its findings are pinned in
  `platform/pi/f006-sibling-refusal-kill.test.ts`.

## §2.4(a) RE-FILED — the old mechanism was wrong, measured

The filed mechanism claimed a mangled escaped spelling fails to match the file rules and falls through to default-deny. **That cannot occur**, and the correction is to the filed claim, not to the code:

- `normalizeForMatch` (`platform/core/policy-config.ts:351`) replaces `\` with `/`, and it is applied to BOTH the rule pattern (`platform/core/configured-policy.ts:216`) and the candidate before matching. The rule side is already normalised.
- So the false DENY did not reproduce under either policy shape. Corpus `A1` (catch-all) and `A1p` (specific rule) both pass against unmodified code.
- **Real defect 1 — the boundary side is the unnormalised one.** `resolveWithinRoot` (`platform/core/workspace.ts:98`) receives the raw escaped candidate. The unescaping fix survives, aimed at the boundary check only.
- **Real defect 2 — false ALLOW is host-dependent.** `..\outside.txt` is a literal in-root filename on POSIX, so the boundary permits it; Windows denies it via the backslash reading at `workspace.ts:120`. Corpus gate `A2` therefore passes on this Windows host and would fail on Linux. It is host-conditional by construction.

**Design amendment, ratified:** DROP the file-rule-matching change (that side is already correct). KEEP boundary unescape + glob-as-pattern + soft refusal + plumbing. The design gets smaller because the measurement says so.

## Merge mechanism

`glab` is **NOT INSTALLED** on this host (`command -v glab` → nothing). `gh` is
installed but cannot open a GitLab MR. So the mechanism is:

1. branch is pushed (below)
2. open the **pre-built MR URL** (below) — GitLab fills source and target
3. squash-merge in one batched session

MR create URL pattern (verified from the push output, not assumed):

```
https://gitlab.com/neurofebric-group/neurofebric/-/merge_requests/new?merge_request%5Bsource_branch%5D=<url-encoded-branch>
```

## Branches

| # | Branch | Commit | Base | Suite | State | MR |
|---|---|---|---|---|---|---|
| 1 | `docs/a1.1-ledger-fold` | `923d855` | `625e59f` | not re-run (docs-only; base was green) | **pushed** | [create MR](https://gitlab.com/neurofebric-group/neurofebric/-/merge_requests/new?merge_request%5Bsource_branch%5D=docs%2Fa1.1-ledger-fold) |
| 2 | `fix/d4-path-boundary` | `f6c6bad` | `1f2bc1d` (`docs/manifest`) | **497 tests, 495 pass, 0 fail, 2 skipped — GREEN** | **pushed** | [create MR](https://gitlab.com/neurofebric-group/neurofebric/-/merge_requests/new?merge_request%5Bsource_branch%5D=fix%2Fd4-path-boundary) |
| 3 | `feat/token-guard-corpus` | — | `625e59f` | — | queued (§2.2) | — |
| 4 | `fix/token-guard-position` | — | branch 3 | — | queued (§2.2 MR) | — |

Merge order: **1 → 2 → 3 → 4**. Each is independent of the others; none is a
prerequisite of the next, so a merge session may take them in any order or all
at once.

## DEFERRED-OPERATOR

Physical limits that are the operator's alone. **None blocks the stack.** Exact
steps are given so no judgment is required to act on them.

| Item | Why deferred | Exact steps |
|---|---|---|
| Merging any branch to `main` | Irreversible from the agent seat | Open each MR URL above, squash-merge in the order given, then `git fetch origin && git log --oneline origin/main -12` and confirm the SHAs above are ancestors: `git merge-base --is-ancestor <sha> origin/main && echo present` |
| Restarting the serving process / Pi session | Same | After merging, restart Pi so the extension reloads. The extension reads `.pi/neurofebric-policy.json` and `.pi/neurofebric.json` at `session_start` only, so a policy change is not live until restart |
| Anything outside the workspace root | Out of scope by construction | Nothing in this manifest requires it. Corpus commands are all in-root by construction; see each item's note |

## Per-item record

### 1. A1.1 LEDGER FOLD — **DONE**, pushed

- Branch `docs/a1.1-ledger-fold`, commit `923d855`, one commit, docs only.
- Contents: §2.4 / D4 filing with both defects and both corpus gates; D2
  refinement (`7e5aeb9`) with its residual stated; G1 narrowed to silent resets
  on operator ruling; §5 queue status; §6 stale-main resolved by measurement.
- Provenance line, measured this pass: OmniRoute **3.8.51**
  (`OmniRoute/package.json`, on `release/v3.8.51` at `a1baae7b0a`); **glab NOT
  INSTALLED**; gh installed but not the mechanism. The earlier directive
  asserting glab was present was not written into the ledger and is corrected.
- Inventory scope: carried forward as **prior-measured, not re-verified this
  pass**, artifacts named.
- Label map: D2/D4/G1 bound to repo anchors so the binding is challengeable.
- Suite: documentation-only change; base `625e59f` was green and is unchanged
  apart from `docs/`. Not re-run for this commit — stated rather than implied.

### 2. D5 + §2.4 path boundary — **DONE**, pushed

- Branch `fix/d4-path-boundary`, based on `docs/manifest` @ `1f2bc1d` (the
  manifest has to be updatable from the working branch; sequencing settled
  before the work started, not mid-task).
- Commits, in order: `c2a99a7` D5 ledger filing, `b64c379` red-first corpus,
  `16aa07c` WIP rescue, `f6c6bad` the fix.
- **D5.** Committed policy says `onViolation: block`
  (`.pi/neurofebric-policy.json:81`) and live behaviour terminated anyway:
  `platform/pi/kernel-adapter.ts:1524` discarded `decision.violation` and
  `platform/core/recovery.ts:130` terminated on `POLICY_DENIED` unconditionally,
  with no violation field in the options interface at all. Now threaded
  `recordToolResult` -> `observeToolResult` -> `chooseRecoveryDetailed`.
  `block` continues, `abort` and **absent** terminate. Absence fails closed, so
  every pre-existing call site keeps its exact previous behaviour.
- **§2.4(b).** An out-of-root ENUMERATION of a PATTERN is refused as
  `out_of_scope_discovery` — still a DENY, still reading nothing, but marked, so
  the task lives and a same-task in-root call proceeds. Three conjunctive
  conditions keep the class narrow; `B2b` and `B2c` pin that a read and a write
  cannot inherit it.
- **Corpus** `platform/pi/path-boundary-corpus.test.ts`, 17 cases, 17 green.
  Sections A (boundary) and B (what happens to the task) are separate so a soft
  refusal and a survivable denial can never be conflated later.
- **F-007/F-003, now settled by measurement:** the red-first D5 gate
  `B4` asserts a block violation arriving as a tool result does not terminate,
  and it was RED before the fix and GREEN after. The historical "survived 20+
  calls" observation is therefore **superseded** — it could not have happened
  under this code path. Not deleted; re-labelled in the ledger.
- **Suite:** `npm test`, 497 tests, 495 pass, 0 fail, 2 skipped, measured.

### 3. §2.4(a) boundary unescape — **DONE**, pushed

- Branch `fix/d4a-boundary-unescape`, based on `main` @ `bfc22e8`. Commits, in
  order:
  - `86d948c` red-first section N gates (inherited; was local-only)
  - `b0a8cdf` WIP rescue — additive unescape, **N1 measured red**
  - `0e4b6e2` F006 backfill — guard measurement, withdrawn type hypothesis,
    single-ledger designation
  - `b0ba4aa` **the fix** — both backslash readings
- **Red-first, and the red was real.** Before the fix: 25 cases, 24 pass, 1
  fail, failing by name with `unescaped spelling absent`. After: 25 pass, 0
  fail. The 25/24/1 figure matches the baseline recorded in `86d948c`, so the
  WIP was measured-neutral and was never a fix.
- **The cause was a wrong transformation, not a missing one.** The WIP consumed
  the backslash as a shell escape, so a dotdot-backslash operand resolved to a
  bare filename with no separator at all — not path-shaped, so it was dropped
  before the boundary ever saw it, and the traversal stayed invisible. Reading
  the same character as a separator is what turns it back into a traversal.
- **Both readings are added, neither is chosen.** A backslash in a shell operand
  is ambiguous and the caller is absent to disambiguate it, so escape semantics
  and separator semantics are both produced.
- **Additive.** The raw spelling is still in the set and still checked, so
  containment is evaluated on all three forms. A reading that turns out wrong
  costs a redundant check, never a denial.
- **Scope held exactly as ruled.** One function, `addUnescapedSpelling`. Only the
  shell command path calls it, so a structured field never gains a spelling.
  Drive-letter and UNC prefixes still return early. `looksLikePath` is **not
  modified**. `N2`/`N3`/`N4` (exclusions) and `N5` (no new false deny) all
  still pass.
- **Suite, measured on this branch:** typecheck exit 0; corpus 25 pass / 0 fail;
  core and pi TypeScript 505 total, 503 pass, 0 fail, 2 skipped; platform mjs
  22 pass / 0 fail. The two skips are the pre-existing Windows-only vault
  permission-bit cases. The +8 over the 497/495/0/2 base is exactly the eight
  section N cases.
- **F006 ledger is the single ledger of record.** `DECISIONS.md` holds operator
  rulings by reference; `memory/` is not a ledger.
- **MR** (glab NOT installed, so a pre-built URL):
  <https://gitlab.com/neurofebric-group/neurofebric/-/merge_requests/new?merge_request%5Bsource_branch%5D=fix%2Fd4a-boundary-unescape>
- **Restart is still pending.** It blocks the merge, the harness commit-guard
  investigation, and `merged_not_restarted` alike.

### NOT DONE — carried forward honestly

- **§2.4(a) boundary unescape is DONE** — see section 3 above, commits
  `b0a8cdf` and `b0ba4aa` on `fix/d4a-boundary-unescape`. Drafted and recorded
  on the branch; **not merged**, and the merge waits on the operator restart.
- **Glob prefix scope-check is DONE, unmerged** — `af7dc24` on
  `fix/d4b-glob-prefix-scope`, gates `G1` (red to green) and `G2` (the deny
  guard, green throughout). Filed as item 6 in the F006 §5 table. A pattern
  whose prefix matches no rule is now scoped by containment alone rather than
  default-denied; that widening is recorded in F006 rather than smoothed over.
- **§2.3 benign non-zero exits stays queued**, now with its exhibit. The
  witness certificate is transcribed into F006 §2.3 and the death counter is
  corrected from 0 to **1** — corrected by exhibit, not by count. The mechanism
  is separately verified against `recovery.ts:14-15`, `:80` and `:214-215`.

### The authoritative queue is F006 §5, not this manifest

The item numbering used previously in this manifest is **superseded**.
`docs/F006_LEDGER.md` §5 is the queue of record, with a status table measured
2026-09-30 against `origin/main` @ `bfc22e8`. **Anything not defined in F006 §5
does not exist as work.** As measured, that table holds:

| # | Item | Status |
|---|---|---|
| 0 | D5 / `onViolation` divergence | CLOSED — merged (`f6c6bad`) |
| 1 | Extractor precision | PARTIALLY OPEN — `7e5aeb9` merged; argument-position hypothesis unpinned |
| 2 | Token guard scoping | OPEN |
| 3 | §2.3 benign non-zero exits | OPEN — exhibit recorded |
| 4 | C3b rebase | CLOSED — `320937f` merged; content assessment owed |
| 5 | §2.4 / D4 path boundary | (b) CLOSED — merged; (a) DONE, unmerged (`b0ba4aa`) |
| 6 | Glob prefix scope-check | DONE, unmerged (`af7dc24`) |

Statuses were measured with `git branch -a --contains`, not read off prose.
Work order as ruled: item 1's remaining half, then item 2, then item 3 — with the
operator-ordered glob prefix scope-check ahead of them.
