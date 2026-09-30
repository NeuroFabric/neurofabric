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
| 2 | `fix/d4-path-boundary` | — | `625e59f` | — | queued (§2.4 / D4) | — |
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
