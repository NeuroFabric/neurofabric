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

### NOT DONE — carried forward honestly

- **§2.4(a) boundary unescape is NOT built.** §2.4(a) was re-filed this pass
  (see above) and the design was amended to drop the file-rule change, but the
  surviving boundary-side unescape is **authorised and not yet implemented**.
  Corpus gates `A1`/`A1p`/`A2` exist and are green against current behaviour;
  `A2` is host-conditional. Do not read the green corpus as "§2.4(a) is fixed".
- **Glob prefix scope-check is NOT built.** `A3` passes today because the
  boundary denies only genuinely out-of-root candidates; the prefix scoping
  itself is not implemented.
- Item 3 (§2.3 benign non-zero exits) has a live witness and stays queued.
- Items 4–7 untouched.
