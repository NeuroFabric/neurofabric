# F-006 Ledger

Consolidated state of the F-006 denial-delivery work: what is fixed and on what
evidence, what is found but gated, what stays under watch, and what debt remains.

Last updated: 2026-09-30 (guard measurement backfill; single-ledger designation).
Author: Pi (agent). Operator-measured figures are attributed as such; everything
else was measured in-repo or pinned by a test.

**This file is the single ledger of record.** Deaths, findings, defect classes,
standing annotations and environment facts are written here and nowhere else.
`docs/DECISIONS.md` records operator rulings by reference to this file.
`memory/` is not a ledger. See §7.

> **READ §0 FIRST.** §2.5 and §3 describe the D1 defect **as it was before the
> reversal of 2026-10-01**. Sections marked HISTORICAL below quote pre-reversal
> code in the present tense and are **evidence of a bug, not current law**. Do not
> cite them to justify a code change without reading §0.

### Provenance — environment claims, measured not asserted

Measured in this pass, on the host that ran it:

| Claim | State | How it was measured |
|---|---|---|
| OmniRoute version | **3.8.51** | `OmniRoute/package.json` `"version"`; the checkout is on `release/v3.8.51` at `a1baae7b0a` |
| `glab` (GitLab CLI) | **NOT INSTALLED** | `command -v glab` returns nothing |
| `gh` (GitHub CLI) | installed, **not the mechanism** | `command -v gh` resolves; the `origin` remote is `gitlab.com/neurofebric-group/neurofebric`, which `gh` cannot open an MR against |
| `main` | `625e59f`, in sync with `origin/main` | `git fetch origin` then `git status -sb` reports no ahead/behind |
| Suite on `main` | **green** — 480 tests, 478 pass, 0 fail, 2 skipped | `npm test` (typecheck + `platform/*.test.mjs` + `platform/{core,pi}/*.test.ts`) |

#### Host environment — re-measured 2026-09-30, and it is NOT Linux

The wrapper table in §2.2 is measured against a host whose shell semantics are
not Linux, and every row in it inherits that. Measured, not assumed:

| Claim | Measured value | How |
|---|---|---|
| Kernel / platform | `MINGW64_NT-10.0-26200 ... x86_64 Msys` | `uname -a` |
| bash | `5.3.15(2)-release (x86_64-pc-cygwin)` | `bash --version` |
| `find`, `xargs`, `env`, `nice`, `stdbuf`, `nohup`, `timeout` | present in `/usr/bin` | `command -v`, one per tool |
| `setsid` | **ABSENT** | `command -v setsid` returns nothing |
| `watch` | **ABSENT** | `command -v watch` returns nothing |
| `sudo` | resolves to a **Windows** binary, not GNU sudo | `command -v sudo` |

**Consequence, and it is a design constraint rather than a footnote.**
`setsid`, `watch` and `sudo` therefore **cannot be measured on this host** and
are **not** entered in `COMMAND_WRAPPERS`. Their option grammar is not invented.
An unrecognised wrapper is *unclassifiable*, and unclassifiable is **DENY** — so
the gap fails closed and costs false positives on a host where those wrappers are
not even installed. `sudo` is additionally under a standing instruction not to be
invoked until the resolution question below is closed.

Two standing rules were added because this host made the cost concrete: **scan
every measurement probe for absolute-path tokens before issuing it**, and
**never invoke `sudo` here**.

An earlier operator directive asserted `glab` was installed and asked for the
provenance line to be written on that basis. It was not written, because the
claim was not true on this host, and the directive has since been corrected:
**operator directives do not assert environment state.** Environment claims are
verified before they are recorded, and an unverified claim is recorded as
unmeasured rather than repeated. `glab` is dropped from the queue; branch, SHA,
suite status and a pre-built MR URL are the merge mechanism, recorded in
`docs/MANIFEST.md`.

### The commit guard is harness-side — measured, not inferred

The commit guard that refused a message earlier in this work is **not in this
repository and cannot be read from it.** Measured on this host, 2026-09-30:

| Probe | Result |
|---|---|
| `git config --get core.hooksPath` (repo) | unset |
| `git config --global --get core.hooksPath` | unset |
| `git config --get-regexp hooks` (all scopes, all levels) | no output |
| `.git/hooks/` contents | 14 `.sample` files only; Git never executes these |
| git patterns in `platform/core/policy.ts:70-113` | 4 — force-flag, plus-prefix refspec, delete-flag, colon refspec. **No commit-message rule.** |
| `.pi/neurofebric-policy.json`, `policies/default_policy.yaml` | no commit rule |
| `.pi/extensions/platform-orchestrator.ts` (read in full) | no commit rule |
| repo-wide search for commit-type regex forms | no matches |

**There is no accepted-type list anywhere in this repository.** A `commit-msg`
hook does not exist here in any form, and the only git control this repository
does own refuses force-push and refspec deletion — it never inspects a message.

This is the same shape as the §11 transport-guard divergence: an external control
that fires on repository commands. `docs/handoff.md:429` is the only commit-guard
rule measurable in-repo — a subject of 72 characters or fewer, refused outright
if longer — together with "guarded verbs run standalone".

**Misread trap, recorded because it cost a step.** `.pi-tools/commit-msg.txt`
and `.pi-tools/echo-commit-msg.txt` are prior commit-message **drafts**, not
guards. Their filenames invite the opposite reading.

#### The accepted-type hypothesis is WITHDRAWN, not filed

An earlier hypothesis held that an accepted-type list changed between sessions,
because `wip:` was accepted earlier in this project and refused later. **It is
not filed.** No such list exists here to have changed, and the premise is
contradicted by this repository's own history:

| Subject | SHA | Length | Outcome |
|---|---|---|---|
| `wip: item 2 mid-flight - configured-policy mid-rewrite` | `16aa07c` | 54 | accepted |
| `WIP: D1 red-first snapshot after third harness death - core half applied, adapter pending, 9/15 red. Do not merge.` | `6a68e37` | 113 | accepted |

Both spellings were accepted, and one subject is 113 characters — over the
72-character rule `docs/handoff.md:429` states. Filing a changed accepted-type list
would assert something measured to be absent.

#### Leading hypothesis — labelled, not asserted

The guards pre-scan the **whole command**, so a guarded literal appearing anywhere
in a commit message is judged as though it were the operation. The standing F-007
rule records that a backslash-leading token in shell text is read as a rooted path
and denies the entire command. A WIP message describing an escape/unescape fix is
a plausible carrier of exactly such a token.

**This is a hypothesis and is recorded as no cause.** It is unverified: the
refusal text from that attempt exists nowhere in this repository, and it was not
reconstructed after the fact.

**Blocked, not skipped.** The harness guard's source lies outside the repository
root, and the standing rule forbids out-of-root access until the operator's
restart is confirmed. The operator withdrew the read instruction until restart
and will re-issue it when the restart lands. The guard investigation is pending
restart, and `merged_not_restarted` is blocked on the same sole operator action.

### Label map — operator finding labels bound to repo anchors

The operator's running labels (D2, D4, G1) are not recorded anywhere in this
repository; they originate in conversation. Each is bound below to the artifact
it can be checked against, so a reader can challenge the binding rather than
take it on trust. The binding is the claim; the anchor is the evidence.

| Label | Bound to | Anchor |
|---|---|---|
| **D4** | §2.4, the path-boundary finding | `platform/core/configured-policy.ts:evaluatePaths`, `platform/core/workspace.ts:WorkspaceBoundary.check` |
| **D2** | §2.1, the path-candidate extractor | commit `7e5aeb9` "fix(extractor): shell-syntax tokens are never path candidates" |
| **G1** | §3, the typecheck-coverage finding, narrowed | commit `6ef26e9`; §1.4 below |
| **D5** | §2.5, the `onViolation` divergence | `.pi/neurofebric-policy.json:81`, `platform/core/recovery.ts:130`, `platform/pi/kernel-adapter.ts:1524` |

### Inventory scope — prior-measured, NOT re-verified in this pass

The declared-versus-implemented limits inventory (the probe artifacts
`.pi-tools/claimed-before.txt`, `.pi-tools/claimed.txt`, `.pi-tools/actual.txt`)
was measured in an **earlier** pass and is **not re-verified here**. It is
carried forward as prior-measured, with the artifacts named so the claim is
checkable rather than merely asserted. Re-verification is queued; until it runs,
no statement in this ledger depends on that inventory being current.

---

## 0. D1 CONTRACT REVERSAL — ratified 2026-10-01

**Merged as `066b2b4`** (branch `fix/f006-policy-deny-not-fatal`, merged to
`origin/main` at `fca77fc`).

### 0.1 The ratified decision

`POLICY_DENIED` returns **`CONTINUE` / `POLICY_SOFT_REFUSED`** — at **every**
violation label (`block`, `abort`, absent) and at **every** budget, including
exhausted retry, replan, strategy and recovery depth.

**A denial is a RESULT, not a death.** Rationale: a refusal is an *answer*, not a
*fault*, and only a fault may kill a task. No retry, replan or strategy change can
make a deterministically denied call permitted, so paying for any of them is
paying for a foregone conclusion.

This **reverses** D1, which made a marked `POLICY_DENIED` **TERMINATE**. That was
a deferral, not a fix: it stopped the replan death and replaced it with a
different one.

### 0.2 §2.5 is HISTORICAL

§2.5's findings table quotes `recovery.ts:130` returning
`{ strategy: "TERMINATE", reason: "POLICY_DENIED_TERMINATED" }` in the **present
tense**. That code **no longer exists**. Current code is
`recovery.ts:194-196`, returning `CONTINUE` / `POLICY_SOFT_REFUSED`.

§2.5 remains accurate as a **record of the defect it found**. It is **not** a
specification. Citing it to justify reintroducing termination on a denial would
revert a ratified operator decision on the authority of a bug report.

### 0.3 The §3 alarm is DISARMED — and this is a hazard, not a closure

§3 is armed with the standing condition:

> *"Any denial certificate reading `TOOL_FAILURE` → `REPLAN_BUDGET_EXHAUSTED`
> means a denial path bypassed the bridge."*

**That trigger can no longer fire.** `REPLAN_BUDGET_EXHAUSTED` is unreachable from
a denial under every label at every budget, and no terminal certificate is emitted
for a denial at all.

**An operator reading §3 as written believes they are covered and are not.** The
denial-delivery watch has no live trigger and must be re-armed against the
post-reversal surface — a refusal that is silently **unreported**, rather than one
that dies loudly. Until that is written, treat denial-delivery coverage as
**UNWATCHED**, not watched.

### 0.4 What did NOT change

Denial **classification** is untouched: a marked denial still classifies as
`POLICY_DENIED`, never `TOOL_FAILURE`. Collapsed to `TOOL_FAILURE` it would
REPLAN the very block that was denied and burn the replan budget re-proposing it —
that is the original F-006 defect and it is exactly as live as it was.

`abort` still ends a task, one layer out, in `precheckToolCall` → `abortTask`,
where it is reachable. Termination was never removed from the system; it was moved
off the table that could not legitimately reach it.

## 1. FIXED

### 1.1 Crash spiral — 93 `REPLAN_BUDGET_EXHAUSTED` deaths, zero since

A policy denial was being classified `TOOL_FAILURE`. The recovery table's row for
`TOOL_FAILURE` is `REPLAN`, so the kernel replanned the very call that had been
denied, spent the replan budget, and died. The outcome was determined in advance:
no retry or replan can make a denied call permitted.

**Evidence.** Operator-measured census: 93 pre-bridge `REPLAN_BUDGET_EXHAUSTED`
deaths; zero since the bridge landed. Pinned by
`platform/pi/f006-denial-certificate-shape.test.ts` — CERT.4 withholds the
denial reason and asserts the failure still `REPLAN`s, so the death shape cannot
return silently while a pin is green.

### 1.2 Bridge delivery — start-before-preflight

`.pi/extensions/platform-orchestrator.ts` carries a `pendingDenialReasons` map,
written at the `tool_call` deny site keyed by `toolCallId` and read back at
`tool_execution_end`, forwarded as `recordToolResult`'s sixth positional
parameter. It closes the limitation formerly documented at
`kernel-adapter.ts` (EXTERNAL-WIRING note).

Delivery depends on Pi's **event order**, measured on id `f4ce5cc7`
(operator-measured, confirmed in-repo):

```
tool_execution_start  -> beginToolExecution BINDS   (id not yet denied)
tool_call (preflight) -> precheckToolCall DENIES    (reason stashed by id)
tool_execution_end   -> recordToolResult DELIVERS   (binding exists, EXECUTING)
```

**The order is the finding.** Because start precedes preflight, the refused id has
already bound by the time the result is reported, so the denial reaches recovery.
The guard at `kernel-adapter.ts:964` — which refuses to bind an id already in
`deniedToolCallIds` — therefore **never fires in production**. It is a tripwire
against an emission-order change, not a live gate. Pinned by BRIDGE.C (asserts
zero `TOOL_EXECUTION_IGNORED` events in production order).

**Precondition for delivery:** a binding must exist, the task must be
`EXECUTING`, and the settling execution must be the last one
(`observeToolResult` returns early at `:1192` while a sibling is in flight —
pinned by BRIDGE.C2).

### 1.3 Negative test — destructive guard and delivery, live

`rm -rf tmpx` denied; `replanCount 0/2`; target survived. Closed 11:50:01.
`mkdir` and the `write` tool both cleared preflight in the same run, so the
refusal was specific to the destructive call, not a blanket block. No re-run
needed.

### 1.4 Typecheck gap — the enforcement layer was unchecked

`tsconfig.json` included only `platform/**/*.ts`, so
`.pi/extensions/platform-orchestrator.ts` — the file that refuses a denial and
captures its reason — was never typechecked. A duplicate `const denialReason`
in it (TS2451) reached runtime as a hard SyntaxError; the extension would not
have loaded, leaving the next session with **no policy enforcement at all**.

**Evidence.** `.pi/extensions/*.ts` added to `include`; the package's absent
types supplied by a shadow declaration at
`platform/pi/pi-coding-agent.d.ts`. Closed by demonstration, not assertion: the
TS2451 was reintroduced and `npm run typecheck` caught both occurrences.

---

## 2. GATED FINDINGS

None of these may be fixed without operator sanction. Each is a
**security-control change**: every candidate rule trades precision for coverage,
and relaxing a guardrail to reduce false positives is the dangerous direction.

### 2.1 Path-candidate extractor is over-broad — the active task-killer

**Mechanism (measured).** For a shell tool, `scanToolPathCandidates`
(`platform/core/tool-paths.ts:494`) walks *every* string value in the input except
`cwd` and `description`, routing each through `extractFromCommand`. Command
text is therefore tokenized into path candidates **by design**, and those
candidates are then subjected to the boundary check and the file-rule check.

**Per-call, not stateful.** `found` and `newScanState()` are constructed per call,
so there is no cross-call contamination. The apparent stickiness of the `\;`
denial was a terminal refusal echoing a dead task's stored `failureReason`, not a
contaminated scan. The originating command did contain `\;` (a `find -exec`
terminator).

**Live evidence of harm.**

| Command text | Denied as |
|---|---|
| `find … -exec … \;` | `\;` — path escapes the allowed root |
| `node -e "const { KernelAdapter } = await import('…')"` | `no matching file rule for 'const { KernelAdapter } …'` |

Both are code and shell syntax, not paths. Each denial is a dead task.

**Risk.** Highest of the three. Every compound command and every inline script
risks a false-positive denial, and the denial ends the turn. This is the direct
cause of the task deaths observed during the F-006 work itself.

**Next step.** Corpus-first, both directions, with MUST-DENY as a hard gate
(see §5, item 1).

#### D2 refinement — landed, and what it left behind

`7e5aeb9` "fix(extractor): shell-syntax tokens are never path candidates" is the
refinement. It added `SHELL_SYNTAX_TOKEN` / `CONTAINS_LINE_BREAK` in
`tool-paths.ts`, so a token made **entirely** of shell meaning (`\;`, `&&`, `{}`,
`|`) and any token containing a line break are no longer path candidates. Both
live false positives above are closed by it, and `platform/pi/path-extraction-corpus.test.ts`
is the gate that keeps them closed.

The rule is deliberately subtractive — it can only *remove* candidates, never add
one, so it cannot introduce a permission. That is also its limit, and it is where
the residual lives:

- It only recognises tokens that are *wholly* syntax. A token that mixes syntax
  with a real location — an escaped path — is still extracted in its **raw,
  escaped form**, and §2.4(a) is what happens next.
- It removes the candidate; it does not teach the extractor the difference
  between a command's own name, an argument, and a pattern position. That
  remains §5 item 1's hypothesis, unpinned.

**Residual, stated rather than left implicit:** the extractor still judges
candidates on the text the *shell* would resolve away, so the boundary is asked
about a path that does not exist. Filed as §2.4(a) and not folded into the
extractor work, per the no-silent-fold rule: they are different modules with
different owners and one fix would have hidden the other.

### 2.2 Destructive-command token guard is over-broad

`destructiveCommandTokens` (`rm`, `rmdir`, `del`, `erase`, `unlink`, `shred`,
`remove-item`) are matched as whole tokens **anywhere in command text**, not in
argument position. `matchCommandTokens` is called at
`platform/core/configured-policy.ts:341`, after the pattern rules at `:334`.

**Live evidence of harm.** `grep del <file>` is denied because `del` appears as a
bare token — a pattern being searched for, not a command being run.

**Note.** Quoting disambiguates: `grep "del" <file>` is allowed, `"del"` is not
the token `del`. That inconsistency is itself a symptom of the defect.

**Risk.** Medium. Denial is over-broad in one direction only; a genuinely
destructive command is still caught by the pattern rules and by the token rule
itself.

**Next step.** Corpus-first, separate branch, same MUST-DENY gate (§5, item 2).

#### Operator authorisation, 2026-09-30 — item 2 sanctioned, recursive parse AUTHORIZED

Recorded before any implementation code, so the authorisation and the reasoning
that produced it outlive the session that used it.

**What was ruled.** Item 1 is closed (ratified). Item 2's *stated fix* — bare
tokens match at word boundaries in command position — is **refused as written**,
and the recursive command-line parse that replaces it is **authorised**. The
refusal and the authorisation are one ruling: the head-only rule would un-break a
committed decision, so the alternative approved is the parse.

**Merge authority is unchanged.** The operator merges. Work is delivered as an
open MR and waits.

#### Step 0 — remote verification, recorded verbatim

The repository of record is operator-stated and authoritative:
`https://gitlab.com/neurofebric-group/neurofebric.git`.

`git remote -v`:

```
origin	https://gitlab.com/neurofebric-group/neurofebric.git (fetch)
origin	https://gitlab.com/neurofebric-group/neurofebric.git (push)
```

**Origin already equals the repository of record.** `git remote set-url` was
therefore **not run** — no before/after difference exists to record, because no
mutation was needed. Recorded as measured; an authorisation that went unused is
not a step that was skipped.

`git config --get-regexp '^branch\..*\.remote$'` — 18 branches, all on `origin`:

```
branch.main.remote origin
branch.ci/gitlab-gate.remote origin
branch.rescue/terminal-state-conformance.remote origin
branch.docs/d025-verified-empty.remote origin
branch.docs/core-limits-envelope-truth.remote origin
branch.fix/denial-classification.remote origin
branch.docs/f006-backlog-ledger.remote origin
branch.fix/extractor-precision.remote origin
branch.fix/terminal-refusal-echo.remote origin
branch.docs/f006-c3b-addendum.remote origin
branch.chore/f006-pin-hygiene.remote origin
branch.docs/a1.1-ledger-fold.remote origin
branch.docs/manifest.remote origin
branch.fix/d4-path-boundary.remote origin
branch.fix/d4a-boundary-unescape.remote origin
branch.fix/d4b-glob-prefix-scope.remote origin
branch.fix/f006-benign-nonzero-exit.remote origin
branch.fix/f006-argument-position.remote origin
```

#### The stranded-docs commit is NOT stranded — measured, not assumed

`git branch -r --contains d63cbc3` returns **five** refs, not zero:

```
  origin/HEAD -> origin/main
  origin/fix/d4b-glob-prefix-scope
  origin/fix/f006-argument-position
  origin/fix/f006-benign-nonzero-exit
  origin/main
```

`d63cbc3` is already contained in `origin/main`. **Nothing was pushed**, so the
conditional authorisation ("if empty, push it") did not fire. A push here would
have been an unnecessary write to a shared remote on the strength of an assumed
rather than measured premise; the probe is what prevented it.

#### Step 1 — branch base, measured

| Fact | Measured value | How |
|---|---|---|
| `origin/main` tip | `61c8177` "Merge branch 'fix/f006-benign-nonzero-exit' into 'main'" | `git fetch origin` then `git log origin/main --oneline -1` |
| `61c8177` is an ancestor of `origin/main` | **yes** | `git merge-base --is-ancestor 61c8177 origin/main` |
| Working branch | `fix/f006-command-position-parse`, created **from `origin/main`**, tracking it | `git checkout -b fix/f006-command-position-parse origin/main` |

#### Base verified before any security change — standing rule honoured

No security change lands on an unverified base, so the suite was run on the
freshly created branch, before any edit:

```
npm test   (typecheck && platform/*.test.mjs && platform/{core,pi}/*.test.ts)
# tests 517
# pass 515
# fail 0
# skipped 2
```

**Base green.** 517 tests, 515 pass, 0 fail, 2 skipped. Typecheck is part of
`npm test`, so the type gate is inside this figure.

#### Structural finding — this branch's base does NOT carry item 1

The directive says branch item 2 from the measured `origin/main` tip, and that is
what was done. Measured consequence, recorded because it is invisible later:

| Artifact | On `origin/main` (61c8177) | On `fix/f006-argument-position` (73a5fa6) |
|---|---|---|
| §2.2 "Item 2 enumerated" write-up | **absent** | present |
| `platform/pi/argument-position-corpus.test.ts` | **absent** | present, 338 lines |
| `GREP_FAMILY`, `takeNextAsPattern`, `patternFromFile`, `-e`/`-f` in `tool-paths.ts` | **present** | present |

`git diff --stat origin/main 73a5fa6` is `docs/F006_LEDGER.md | 115 +++++-` and
`platform/pi/argument-position-corpus.test.ts | 338 +++++`.

Two consequences, both benign but both real. The item-2 **reasoning** this work
depends on is written up on a branch that has not merged, so it will reach `main`
only when the operator merges item 1; the work does not depend on that text being
on `main`, only on the **tables**, and the tables *are* on `main` (verified at
`61c8177` by `git grep`, not assumed). And the two corpora are in **different
files**, so item 1's corpus and item 2's cannot collide when both merge.

### 2.4 D4 — the path boundary judges text the shell never resolves (TWO defects)

Found by Pi during the F-006 work and filed here as **D4**. It is not folded
into §2.1: the extractor fix and the boundary fix are separate defects in
separate modules, and folding one into the other would have made the second
invisible in the diff and in the corpus.

**Both corrections below are authorised for implementation.** The corpus gates
named with each are hard: a fix that cannot turn its gate green does not land.

#### (a) The boundary check evaluates shell-escaped text

`tokenizeShell` **preserves** backslashes rather than consuming them, so that a
Windows path such as `C:\Users\dev` survives tokenisation intact
(`tool-paths.ts`, the function's own doc). That preservation is correct for
extraction and wrong for containment: a candidate that came from
`cat notes/my\ file.md` reaches `WorkspaceBoundary.check` as the literal string
`notes/my\ file.md`, which is **not** the path the shell resolves. The guard is
therefore evaluating a path that does not exist and the file rules are matching
against its mangled form.

It fails in both directions, which is why one corpus gate is not enough:

- **False deny.** The relative form the file rules match is
  `notes/my\ file.md`, not `notes/my file.md`. A rule shaped
  `**/*.md` does not match the escaped spelling, so an ordinary in-root command
  falls through to the default-deny branch — a dead task for a file the policy
  would have allowed.
- **False allow.** `cat ..\outside.txt` is the escape written in the spelling the
  guard understands least. Resolved as a *literal* filename, `..\outside.txt` is
  a file **inside** the root, so the boundary permits it. The traversal is
  invisible. This direction is the dangerous one and it is why the fix must add
  candidates, never drop them.

**Correction authorised:** unescape the candidate before the boundary check, so
the guard evaluates the path the shell would resolve. The correction must fail
closed — the resolved form is checked **in addition to** the raw one, so it can
only ever deny more.

**Corpus gate.** A command naming an in-root path with an escaped space MUST
PASS; the same path outside the root MUST DENY, on the **resolved** path.

#### (b) Out-of-root discovery globs are terminal, and each one is a dead task

A glob is not a location. `ls ../../*` names no file; it asks the shell to
enumerate a span. It is refused today, correctly — the span is outside the root —
but the refusal inherits the full weight of a policy denial: the denial is
delivered as a failed result, `classifyFailure` returns `POLICY_DENIED`, and
`chooseRecoveryDetailed` returns `TERMINATE` / `POLICY_DENIED_TERMINATED`
(`recovery.ts:124-131`). The task dies. A second, independent witness to the
§2.1 turn-death path, and it is reached by ordinary work: looking around the
project is not a security event.

**Correction authorised:** an out-of-root **discovery** call becomes a
**non-terminal soft refusal**. The call is still refused and still carries **its
own** reason; what changes is that the task lives, so a follow-up in-root call
in the same task proceeds. Nothing is read, nothing is executed, and the refusal
is not a violation — it is a refusal of scope, so it must not carry
`violation: abort` semantics or be recoverable by retrying the same call.

**Corpus gate.** An out-of-root `ls` glob is refused with its own reason, and a
follow-up in-root call **in the same task** succeeds.

**Risk of the correction, stated before implementing.** A soft refusal is
strictly weaker than a terminal denial: it survives, so an agent that keeps
re-issuing the same out-of-root discovery spends its budget on refusals instead
of dying once. The refusal must therefore be counted and reported as a refusal,
never as a success, and the boundary check itself is untouched — the call is not
allowed, it is only allowed to end less permanently.

#### §2.4 filing reference

Filed as **§2.4** in this ledger; tracked as **D4** in the operator's running
labels; implemented on branch `fix/d4-path-boundary` with its corpus in
`platform/pi/path-boundary-corpus.test.ts`. The MUST-DENY entries of §2.1's
corpus remain the standing gate and are not weakened by this work.

### 2.5 D5 — the committed `onViolation` is honoured on one path and dropped on the other, so every denial terminates the task

> **HISTORICAL — see §0.** Everything in this subsection describes the defect as it
> stood **before** the reversal of 2026-10-01. The title says "every denial
> terminates the task"; that is no longer true and was never intended to remain so.
> The code quoted below is **pre-reversal**. Read §0 before citing any of it.

**Status: CONFIRMED by measurement, 2026-09-30. Not yet fixed.** Filed before any
fix attempt, per directive. This is the highest-priority open item: it is a
sufficient cause for every `POLICY_DENIED` death in this log, and two consecutive
sessions have died to it while queued to fix other things.

**The divergence.** The committed policy says denials are survivable. The live
code terminates them anyway, on the path that actually carries denials.

| # | Site | What it does |
|---|---|---|
| a | `.pi/neurofebric-policy.json:81` | `"onViolation": "block"` — the committed setting |
| b | `platform/core/configured-policy.ts:252` | `{ decision: "DENY", reason: denial, violation: this.config.onViolation }` — the setting is read and carried on the decision correctly |
| c | `platform/pi/kernel-adapter.ts:912` | `if (decision.violation === "abort") await this.abortTask(...)` — the precheck path **does** consult it, so under `block` it does not abort |
| d | `platform/pi/kernel-adapter.ts:1524` | `new CoreError("POLICY_DENIED", actualDenialReason!, { retryable: false, taskId, stepId, executionId: toolCallId })` — the result path rebuilds the refusal and **discards `decision.violation`** |
| e | `platform/pi/kernel-adapter.ts:1271` | `classifyFailure(error)` yields `"POLICY_DENIED"`; `recoveryOptions` at 1293–1308 carries `failure` and `denialReason` and **no violation field** |
| f | `platform/core/recovery.ts:130` | `if (failure === "POLICY_DENIED") return { strategy: "TERMINATE", reason: "POLICY_DENIED_TERMINATED" };` — unconditional, and the options interface at `recovery.ts:78`–`116` has no violation parameter to consult |

So there are two routes for one denial. The precheck route (c) honours
`onViolation`. The result route (d→e→f) throws the setting away one layer before
recovery, and recovery then terminates unconditionally.

**Live witness.** Two consecutive sessions, both on `fix/d4-path-boundary`,
both died with:

```
Recovery TERMINATE [POLICY_DENIED_TERMINATED]: failure=POLICY_DENIED,
denied=policy neurofebric-policy.json: path boundary violation: ...
```

against a committed policy whose `onViolation` is `block`. Session 2's own
conclusion — recorded here so the evidence outlives the session — was that this
was "not concluded" pending tools. It is now concluded: the setting is dropped at
`kernel-adapter.ts:1524`.

**Judgement (agent, under the granted authority).** The committed file is **not**
stale. Site (b) proves the loader reads it and site (c) proves one path honours
it, so `block` is live configuration that is being ignored on a second path.
The fix is therefore to bring live behaviour in line with committed behaviour:
thread the violation through `recordToolResult` → `observeToolResult` →
`chooseRecoveryDetailed`, and have `recovery.ts:130` terminate only when the
violation is `abort`. Failing closed on an absent violation is the correct
direction and must be the default.

**Scope of the claim, stated honestly.** D5 explains deaths whose terminal
certificate names a policy refusal. It does **not** explain every death in this
log: a death whose certificate names `TOOL_FAILURE`, a budget, or a timeout is
outside it. The operator's hypothesis that this is "the root cause of every
death" is supported for the `POLICY_DENIED` class and is **not established** for
the others. Counting both is the death counter in §5.

**Tension with an earlier observation, unresolved.** F-007 and F-003 record a
denial survived by 20+ subsequent calls. Under this code path that should be
impossible, since (f) terminates unconditionally. The historical observation is
carried forward as **prior-measured, not re-verified**; either the
configuration differed at the time, or the survivals took a path not exercised
now. A test that asserts `block` survives a denial received as a tool result is
the thing that settles it, and it is the first gate of the fix.

### 2.3 Benign non-zero exits spend recovery budget

A command that exits non-zero for an ordinary, successful reason — `grep` with
no match exits 1, as do `find` and `diff` in common cases — is treated as a tool
failure and spends replan budget.

**Risk.** Low per occurrence, high cumulatively: a long task doing normal work
can exhaust the budget without ever being blocked by anything.

**Next step.** Investigate and propose only (§5, item 3). This changes recovery
semantics and does not merge without explicit sanction.

#### Exhibit — the witnessed death, transcribed

**One session died to this class.** The terminal certificate, as supplied by the
operator from that session's death report:

```
Recovery TERMINATE [REPLAN_BUDGET_EXHAUSTED]: failure=TOOL_FAILURE, replanCount=2/2, retryCount=0/2
```

**Provenance of the exhibit, stated precisely.** The death report itself is
**not in this repository** — measured this session by searching
`.session-archive/`, `verification/findings/` and the tree for the certificate
string. The one certificate-shaped string the repository does contain,
`verification/findings/F-006-edit-failures-terminate-task.md:48`, is prefixed
`e.g.` and illustrates the `describeTerminalRecovery` format rather than
capturing an event. The certificate above is therefore transcribed from the
operator's record and is labelled as operator-supplied, not as something
verified in-repo.

**The mechanism is verified in-repo, and was read in order to write this entry.**
It is not inferred from the certificate:

| # | Site | What it does |
|---|---|---|
| a | `platform/core/recovery.ts:14-15` | `RETRY_ELIGIBLE` is exactly `TRANSIENT`, `TIMEOUT`, `RATE_LIMIT`, `MODEL_FAILURE`. `TOOL_FAILURE` is **not** in it, so a tool failure is never retry-eligible by category. |
| b | `platform/core/recovery.ts:80` | `classifyFailure` maps a `TOOL_ERROR` to `TRANSIENT` or `TOOL_FAILURE` on `error.retryable` alone. |
| c | `platform/core/recovery.ts:214-215` | Having missed the retry-eligible set and the two dedicated rows above it, `repeatAttemptDecision` falls through to `GENERIC_REPLAN` while `replanCount < maxReplans`, then returns `TERMINATE` / `REPLAN_BUDGET_EXHAUSTED`. |

That chain reproduces the certificate's shape exactly, `replanCount=2/2`
included: an ordinary non-zero exit becomes `TOOL_FAILURE`, is not
retry-eligible, spends the replan budget on replans that cannot help it, and
terminates. **Nothing in the code distinguishes a search with no match from a
command that genuinely failed.** The exit status is the only signal available and
it is not examined.

**Corroboration, independently measured in-repo.** F-006's event-level sweep
records 94 non-supersession `TASK_FAILED` entries across 54 session files, 82 of
them (87%) replan-budget exhaustion by `TOOL_FAILURE`, and states that all 41
structured-era certificates carry `retryCount=0/2` beside `replanCount=2/2` —
the retry budget was never spent, because the category is not retry-eligible.
That is a separate observation from the exhibit and it agrees with it.

**What the counter is and is not.** This row is 1 because a specific death was
witnessed and its certificate recorded. It is not 1 because a number was
asserted, and the 82/94 census above is explicitly **not** counted here: those
are replan exhaustions whose cause is not established to be a benign exit, and
§2.5 records that a certificate naming `TOOL_FAILURE` does not by itself
identify which mechanism produced it.

#### Second witnessed death — IN-SESSION, and it is this class exactly

Recorded before any fix work, because it happened to the session that was about
to write the fix. A death summarised only afterwards is the failure this ledger
exists to prevent. Certificate, quoted exactly as the harness reported it:

```
Recovery TERMINATE [REPLAN_BUDGET_EXHAUSTED]: failure=TOOL_FAILURE, replanCount=2/2, strategyCount=0/2, retryCount=0/2, recoveryDepth=1/3, elapsedMs=160097/1800000
```

The two attempts that spent the budget, both ordinary measurement, in order:

| # | Command | Exit | Why it was run |
|---|---|---|---|
| 1 | `ls node_modules/@earendil-works/` | 2 | Look for Pi's own type declarations. The directory does not exist. |
| 2 | `node -e "process.exit(1)"` | 1 | Run **deliberately**, to read how Pi surfaces an exit status. |

Neither is a fault in the task. The first found nothing because the thing looked
for is not installed; the second was *designed* to exit non-zero. Two benign
outcomes, two replans, and the certificate matches the operator-transcribed
exhibit above field for field, `retryCount=0/2` beside `replanCount=2/2`
included, because `TOOL_FAILURE` is not in `RETRY_ELIGIBLE` and so never reaches
the retry budget at all.

**Provenance, stated to the same standard as the exhibit above.** This death was
**not** operator-supplied and **not** transcribed. It was read off a live harness
refusal in the session that hit it, which quoted the task's original failure
verbatim. It is first-party measurement. The distinction is kept because the
counter's credibility rests on it.

**The refusal that followed is not a second defect.** The next tool call was
refused with the task already dead, and the refusal text says so in its own
words — the call "was NOT evaluated and no policy rule refused it". That is the
dead-task refusal behaving correctly: it names the call that triggered it and
carries the original cause. Recorded so a later reader does not misread a
refusal raised against a corpse as a policy false positive.

**Four facts measured while diagnosing it, recorded so the fix is not designed
blind:**

| # | Fact | Measured where |
|---|---|---|
| 1 | Pi's `tool_execution_end` carries `result: unknown` and `isError: boolean`. There is **no declared exit-code field** on the event. | `platform/pi/pi-coding-agent.d.ts`, `PiEventMap.tool_execution_end` |
| 2 | The exit status is nonetheless observable, but only as a **trailing annotation on the result text** — a non-zero command returns its body followed by `Command exited with code 1`. | first-party, from inside the consuming process |
| 3 | The **command text is not forwarded** at the record site: the result and the `isError` boolean are passed, the call's `input` is not. So at classification time the code cannot tell `grep` from `node`. | `.pi/extensions/platform-orchestrator.ts`, `tool_execution_end` handler |
| 4 | Exit 1 is **both** "found nothing" and an ordinary failure code. `node -e "process.exit(1)"` is a genuine failure and exits 1; so does a `cp` of a missing file. | first-party, same command |

**Consequence for the fix, stated before implementing it.** Facts 3 and 4 rule
out the obvious rule and one obvious-looking refinement. A classification keyed
on the exit code alone marks *every* exit-1 failure benign, and fact 4 is a live
genuine failure it would swallow — the exact weakening the standing rules forbid.
Nor does "non-zero exit with empty output" work: the `node` measurement produced
**no output at all** and still exited 1, so emptiness does not discriminate
either. A correct rule has to key on **which command** ran, as an enumerated
(command, exit-code) table, and fact 3 says the command is not threaded to the
classification site yet. Threading it is part of this defect, not a follow-on.
**"Examine exit status before classification" is necessary but not sufficient.**

**What the counter is now.** 2, and the second is first-party. The 82/94 census
remains excluded, on the same reasoning as before: cause unestablished.

#### The fix — `9bc4b75` on `fix/f006-benign-nonzero-exit`

**Red first, measured.** Gate `B1`–`B10` written before any code change and run
against the unfixed tree: **5 red, 5 green**. The five green ones were green
*before* the fix and are required to stay green after — they are the guard on
the obvious wrong fix, not the demonstration of the right one. After the change:
**10 green**, and those same five are unchanged, which is the evidence that the
retry-eligible set was not weakened.

| Red before — the new behaviour | Green before and after — the guard on the wrong fix |
|---|---|
| `B1` a no-match is not classified `TOOL_FAILURE` | `B3` a genuine failure that exits 1 still is, and still replans |
| `B2` a benign outcome books no budget at any counter state | `B4` the same command's *error* code is not benign |
| `B6` the table outranks the `retryable` flag | `B5` an absent exit status changes nothing |
| `B7` three ordinary no-matches leave the task alive | `B8` a genuine failure still spends budget exactly as before |
| `B10` a structured exit code is honoured | `B9` a mid-text mention of the words is not an exit status |

**One gate was corrected before it could mislead.** `B8` first asserted the
benign/genuine split on task status. Both branches end in `PLANNING`, because a
replan re-enters planning too, so the gate was **red for the wrong reason**: it
would have failed a fix that worked and passed one that did nothing. The
discriminators are the budget and the emitted event, and both are asserted now.
Recorded because a red-first gate wrong in the direction of *staying red* costs a
cycle, and one wrong in the direction of *staying green* costs the defect.

**The shape of the fix, and why it is not smaller.** Three mechanisms, because
the defect is three separate facts:

1. `platform/core/benign-exit.ts` (new) — the table, and two readers that both
   fail closed. `exitStatusFrom` prefers a structured numeric field and falls
   back to the trailing annotation, over a walk **bounded in depth and count**,
   for the same reason the path and destructive-command scans elsewhere in this
   codebase are bounded: an unbounded walk of an untrusted payload is its own
   defect.
2. `CoreError` gains `exitStatus` and `commandName`. **Only the bare program name
   is carried, never the command text**, which can hold paths and credentials
   and which outlives the call on an object that may be serialized.
3. `classifyFailure` examines the exit status **before** the classification, and
   `chooseRecoveryDetailed` answers `BENIGN_NONZERO_EXIT` with `CONTINUE` ahead
   of the depth and budget guards, so it books nothing and terminates nothing.

**A correction to fact 3 above, because the first measurement was incomplete.**
It is true that the command text is not forwarded *to the record site*. It is
**not** true that threading it needed a new parameter or any change to the
extension: `precheckToolCall` already receives the call's `input` and the
`toolCallId`, the extension already passes both, and its own comment records that
`tool_call` is the only event carrying the input. The name is taken at preflight
and carried by id, in the shape the denial-reason map already uses. The first
reading would have led to a signature change that was not needed.

**Why the table is narrow, stated as a choice.** Each row is a command whose
author defined a specific meaning for a specific code. `find` is absent on
purpose — it exits 1 on *error*, not on "nothing found". The asymmetry is
deliberate: a false negative costs the old behaviour, a false positive swallows a
real failure. The table grows only by measurement.

---

## 3. WATCH — armed

> **PARTIALLY DISARMED — see §0.3.** The standing trigger below is **unreachable**
> after the 2026-10-01 reversal and will never fire. Read §0.3 before relying on
> this section as coverage. §3.1 and §3.2 remain live and unaffected.

**Any denial certificate reading `TOOL_FAILURE` -> `REPLAN_BUDGET_EXHAUSTED` means
a denial path bypassed the bridge.** File it with the certificate.

Rationale: a delivered denial always terminates on the denial and names
`POLICY_DENIED_TERMINATED`. A certificate reading `TOOL_FAILURE` means the reason
never reached `recordToolResult`, and the crash spiral is running again.

Standing inventory: `~/.pi/agent/extensions` does not exist, so there is no
external interceptor on the project surface. `.pi/extensions/` contains only
`platform-orchestrator.ts`. The one `rm` certificate observed read
`POLICY_DENIED_TERMINATED` with the policy's own words — not a bypass.

**Amended condition.** A preflight denial producing *neither* a
`POLICY_DENIED` certificate *nor* a reason-bearing `TOOL_RESULT_IGNORED` trace
entry means delivery is broken. File it with the trace.

### 3.1 G1 — the guard worked loudly; the finding is re-filed, NARROWED

**G1 was the typecheck-coverage gap of §1.4**: `.pi/extensions/*.ts` was outside
`tsconfig.json`'s `include`, so the file that refuses a denial and captures its
reason was never typechecked, and a duplicate `const denialReason` (TS2451)
reached runtime as a hard SyntaxError.

**Operator ruling, accepted:** that was the guard **working loudly**. A hard
SyntaxError is the best available outcome — the extension refuses to load, the
failure is immediate, and nothing silently proceeds without enforcement. It is
not the failure class G1 was filed against, and treating it as one would have
dented a control that did its job.

**G1 stays filed on silent resets only.** The narrowed finding: a reset, reload,
or state change in the enforcement path that produces **no** loud signal — no
throw, no non-zero exit, no missing module, no event — and leaves the process
running with enforcement silently absent or reverted. That class is real, is not
covered by §1.4, and remains open.

**What this ruling does not do.** It does not close §1.4, does not revert the
`include` change, and does not license the shadow declaration to grow (see §6).

### 3.2 E1 — the terminal refusal echo: the death's second refusal, read from source

Recorded as an **open question with labelled hypotheses**, per instruction. One
hypothesis is falsified by the source and one survives as a real gap. The death it
follows is `merged_not_restarted` #2; its certificate is the §2.4 boundary
refusal, and the operator has measured the cause of the *termination* (the serving
process was never restarted, so D5 was not live). What follows concerns only the
*second* refusal, which quoted a path that the command I sent did not contain.

#### Hypothesis 1 — `sudo` resolves out-of-root, so the same resolution recurred

**FALSIFIED. Three independent sites, read in full, all say a bare command name
is not a path candidate and nothing resolves it against `PATH`:**

| Site | What it does to a bare token like `sudo` |
|---|---|
| `platform/core/tool-paths.ts:254-262` `looksLikePath` | returns **false** — no leading `/` or `~`, no `WINDOWS_DRIVE` match, no `./` or `../` prefix, and no embedded `/` or `\` |
| `platform/core/workspace.ts` `scanPathCandidates` | adds a token only if it is absolute, `./`/`../`-prefixed, or **contains a separator**; `sudo` is none of the three |
| `platform/core/workspace.ts` `resolveWithinRoot` | performs **no `PATH` lookup**; a relative candidate becomes `path.resolve(rootPath, candidate)`, which is inside the root by construction |

So the out-of-root candidate came from **my own command text**, which carried that
Windows path literally as the argument to `ls -l`. The agent-side half of the dual
cause is not merely the rule being broken; it is the *whole* mechanism. Recorded
because it closes the question rather than leaving it as "possibly a resolution".

#### Hypothesis 2 — can the stored-failure echo reach a LIVE task?

**Yes, and by exactly one state — but not the one in this death.**

`REFUSED_EXECUTION_STATES` (`kernel-adapter.ts:101-107`) is
`REPLANNING, ESCALATED, COMPLETED, FAILED, CANCELLED, TIMEOUT`. The adjacent
comment on `TERMINAL_TASK_STATES` (`kernel-adapter.ts:88-95`) says outright that
a `REPLANNING` task "is still live and is still owned by whoever started it", and
that is why it is excluded from the terminal set. **`REPLANNING` is the one live
state inside the refusing set.**

Of the three sites gated on that set, only one replays the stored reason:

| Site | Behaviour |
|---|---|
| `kernel-adapter.ts:835` | **replays** `failureReason` via `describeTerminalRefusal` |
| `kernel-adapter.ts:1024` `abortTask` | early return, emits `POLICY_VIOLATION`, no replay |
| `kernel-adapter.ts:1083` `beginToolExecution` | `TOOL_EXECUTION_IGNORED`, no replay |

**It is unpinned at `:835` for `REPLANNING`.** Measured counts:
`terminal-refusal-echo.test.ts` and `stream-termination.test.ts` contain **zero**
mentions of `REPLANNING`. The only pin is `I3` in `kernel-lifecycle.test.ts:276`,
which asserts that all six states refuse a new execution at `beginToolExecution` —
a different site, and it asserts no echo text and no precheck refusal reason.

Mitigating, and stated so the gap is not overstated: the replayed reason is
**labelled** ORIGINAL and the refusal states the call was NOT evaluated, so the
labelling defect that once cost a session is fixed. What is open is whether a
**live** `REPLANNING` task should replay a stored reason at all. **Not filed as a
defect; filed as an open question, with the two candidate answers being "yes, and
add the pin" and "no, and `REPLANNING` should refuse without replaying".**

#### Correction to the premise: the task was NOT alive

Measured, and it changes the finding. The certificate reads
`POLICY_DENIED_TERMINATED` with `recoveryDepth=1/3`, and the second refusal states
the reason was "recorded when the task terminated and unchanged since". The
**first** call terminated the task; the second was an ordinary dead-task replay,
which is precisely the behaviour `terminal-refusal-echo.test.ts` already pins. The
belief that the task was live was wrong on both sides — mine and the operator's —
and both had the same source.

#### The finding that survives — E1a: a terminal denial does not announce its own death

The first call's tool result was the **bare denial sentence** and nothing else —
no terminal banner, no "task is FAILED", nothing distinguishing it from a soft
refusal. Termination was disclosed only by the **next** call, whose text opened
with "Task is FAILED". A reader of the transcript cannot tell, from the call that
caused the death, that it caused a death.

This is a **different defect** from the echo, and a smaller one: it does not
misreport a cause, it withholds a status. The echo fix made a dead task's refusal
truthful; it did not make the *originating* refusal say the task died. That is the
gap, and it is what produced a wrong premise in this session's own report.

---

## 4. BRANCH MAP

| Branch | State |
|---|---|
| `main` | `34cd9ee` at time of writing. Carries the MR (tsconfig + shadow stub + pin rewrite). |
| `chore/tsconfig-g1-implicit` | `6ef26e9`. Reported open; **measured as already merged into `main`** — see note. |
| `feat/f006-c3-signature` | `2d8b64a`. Pin commits landed separately in C3b. |
| `feat/f006-c3b-pins` | `f2ae8c5`. Rebased to `34cd9ee`, no conflicts; commit already in `main`. |
| `feat/f006-c4-consumer`, `feat/f006-c4b-stale-anchor` | Part C follow-on. |

**Note.** The directive listed `chore/tsconfig-g1-implicit` as "MR open". Measured
state disagrees: `origin/main` contains `6ef26e9` and `800d3ae`, and
`origin/main:tsconfig.json` reads `"include": ["platform/**/*.ts",
".pi/extensions/*.ts"]`. Recorded as measured. This arose from an earlier
misreading of a stale local ref; the lesson is in §6.

---

## 5. QUEUED WORK

Each item is corpus-first, on its own branch, full suite green before push.
**No merges without operator sanction.**

#### Queue status — measured 2026-09-30, `origin/main` @ `bfc22e8`

Measured with `git branch -a --contains <sha>`, not inferred from prose. This
table supersedes any item numbering used outside this file; **anything not
defined in this section does not exist as work.**

| # | Item | Measured status | Evidence |
|---|---|---|---|
| 0 | D5 / `onViolation` divergence | **CLOSED — merged** | `f6c6bad` is in `origin/main`. Red-first gate `B4` is green in the corpus. |
| 1 | Extractor precision | **PARTIALLY OPEN** | Shell-syntax half `7e5aeb9` is in `origin/main`. The argument-position hypothesis remains unpinned. |
| 2 | Token guard scoping | **OPEN** | No branch carries it; not in `origin/main`. |
| 3 | §2.3 benign non-zero exits | **FIXED, UNMERGED** | Red-first gate written before the change. Five gates red, five green; after the fix ten green and the five pre-existing guards unchanged. Full suite **515 pass, 0 fail, 2 skipped** (`npm test`, typecheck included). `9bc4b75`. |

**Two side findings, cheap to record and not acted on.** Both are documentation
defects rather than behaviour, and neither belongs to this defect class, so
neither is fixed here — recorded so a later session does not re-derive them.

- `platform/pi/f006-strategy-fund-pins.test.ts` declares its `FAILURES` list as
  "every failure class the contract declares", and it does not: `POLICY_DENIED`
  is absent, as is now `BENIGN_NONZERO_EXIT`. The omission is harmless for those
  sweeps, which compare two calls of the same function, but the comment
  overstates what is covered. Measured while checking whether a new category
  would break them. It does not, because the list is hard-coded, not derived.
- The provenance table's `main` row records `625e59f`, which is no longer any
  ref in this repository. Stale in exactly the way the queue rows were, and
  recorded here for the same reason: a stale figure in a ledger is a claim about
  a tree that no longer exists.
| 4 | C3b rebase | **CLOSED as a rebase** | `320937f` is in `origin/main`. Only a content assessment of C3b is owed, which is a review, not queued implementation. |
| 5 | §2.4 / D4 path boundary | **CLOSED — both merged** | (b) via `f6c6bad`. (a) `b0ba4aa` on `fix/d4a-boundary-unescape`, **merged** — measured by `git merge-base --is-ancestor`, not read from prose. |
| 6 | Glob prefix scope-check | **DONE, MERGED** | `af7dc24` on `fix/d4b-glob-prefix-scope`, **merged** as `bee71e0`. Gates `G1`/`G2`. The disclosed widening is on the operator's merge checklist by name (ruling 4); a merge in the tree is not evidence that the checklist item was ratified deliberately, and that question is the operator's to answer, not the tree's. |

**Work order — RE-CUT on measurement, 2026-09-30.** Originally: item 1's
remaining half, then item 2, then item 3. Now: **item 3 first.** The class
behind it is the only one that has moved on live evidence — 1 to 2, the second
death first-party — while items 1 and 2 sit at 0 live deaths and unpinned. The
original order was correct on the evidence available when it was ruled; it is
superseded by evidence, not by preference. Items 1 and 2 follow, unchanged.

**Items 5 and 6 are no longer waiting on anything.** Both merged; the rows above
are measured from the tree.

**Operator-ordered work not numbered here:** the glob prefix scope-check, ordered
directly. It is authorised, and its boundary statement lives in the `N6` gate
rather than in this table; it is recorded as item 6 when the work is filed so
that this table remains the single queue.

0. **D5 / onViolation divergence.** **CLOSED — merged at `f6c6bad`.** Retained
   below for the decision record, not as open work. §2.5 for the mechanism.

### Death counter — sessions lost per defect class

Standing record. The purpose is falsifiable: after items 0–2 land, a class that
does not fall has falsified the plan, and the plan is re-cut on that evidence
rather than defended.

| Defect class | Sessions lost | Note |
|---|---|---|
| Path-boundary false DENY / out-of-root scratch (§2.4) | **2** | Sessions 1 and 2 of this log; both died on a `path boundary violation` |
| `onViolation` dropped on the result path (§2.5) | **2** | The **same two sessions** — the counter is per class, not per session, and the overlap is the finding |
| Benign non-zero exit (§2.3) | **2** | Death 1: witnessed, certificate **operator-transcribed**. Death 2: **first-party**, read off a live harness refusal — two ordinary measurement commands, `replanCount=2/2`. Was 0 before the exhibit, 1 between the two. |
| Token guard over-breadth (§2.2) | 0 | Not measured live |

**Session record — the session that measured the §2.3 fix site died to §2.3.**
It is entered here rather than left in a transcript, because the whole purpose
of this table is that a counter cannot be quietly wrong. The four measured
facts recorded with the certificate above are that session's first real progress
on the fix, and they outlive it. A practical consequence is recorded with the
work order: the class moved from 1 to 2 on live evidence, so §2.3 is pulled
ahead of items 1 and 2, which sit at 0 live deaths.

**Prior session proof, 2026-09-30.** That session added **zero deaths and zero
rows** to
the table above, and is the first live evidence that the standing rules are
load-bearing rather than advisory. A WIP rescue that had previously drawn four
rephrasings completed in **one attempt with zero retries**, after reading the
guard before writing the message. Commit `b0a8cdf` on
`fix/d4a-boundary-unescape`, pushed and verified by SHA.

1. **Extractor precision.** Corpus in both directions. MUST-DENY (hard gate):
   `rm -rf`, `.env` credential read, paths escaping the workspace root.
   MUST-PASS: `find -exec … \;`, `mkdir -p x && echo "h" > x/t.txt`,
   `const { KernelAdapter } = await import('…')`, `mkdtemp` paths,
   `git grep … | grep -v "\.test\."`.
   Hypothesis to verify against the corpus: a token is a path candidate only if
   in argument position, not shell syntax, and not consumed by a flag that takes
   a pattern; `-exec` introduces a nested command whose body is command text.
   *Status: the shell-syntax half landed as `7e5aeb9` (see the D2 refinement
   note in §2.1). The argument-position hypothesis is unpinned and remains open.*
2. **Token guard scoping.** Enumerate the policy's token rules first, corpus
   second. Bare tokens must match at word boundaries in **command position**, not
   anywhere in any string. Same MUST-DENY gate.
3. **Benign non-zero exits.** Enumerate legitimately non-zero commands, propose a
   classification rule, implement on a branch with pins, flag for review.
4. **C3b rebase.** Gated on the operator's merge signal. Already rebased onto
   `34cd9ee` with no conflicts; C3b's commit was already in `main`, so the
   predicted `kernel-adapter.ts` comment conflicts did not arise. A content
   assessment of C3b is still owed.
5. **§2.4 / D4 path-boundary fix.** Authorised and in progress; see §2.4 for
   both defects, both corpus gates, and the branch.
6. **Glob prefix scope-check.** **DONE, unmerged** — `af7dc24` on
   `fix/d4b-glob-prefix-scope`. A glob names no file, so its pattern TEXT was
   being matched against a file rule, which is a coincidence of spelling rather
   than a permission and fails in whichever direction the rule is shaped. A
   pattern is now judged on its literal prefix, the directory the expansion is
   confined to; containment was already and still is decided on the full
   spelling.

   **Two gates, both written before the change.** `G1` was measured red — an
   in-root glob refused by the default-deny branch under a specific rule — and
   `N6` could not catch it, because `N6` runs under the catch-all where every
   in-root spelling matches by accident. `G2` is the guard against the obvious
   wrong fix: skipping the rule matcher for a pattern turns `G1` green while
   unbinding a deny rule from the subtree the glob sits in. `G2` was green
   before and green after.

   **The widening, stated rather than buried.** A pattern whose prefix matches no
   rule is now scoped by containment alone instead of falling through to default
   deny. That is a deliberate widening of one branch, for patterns only. Real
   locations are untouched, a rule that denies the prefix still denies, and
   containment is unchanged, so the widening cannot reach outside the roots. It
   is recorded here rather than described as a tightening, because it is not
   one.

---

## 6. DEBT

- **Delete the shadow declaration.** `platform/pi/pi-coding-agent.d.ts` is a
  hand-written stand-in for a package that ships no types. Delete it when
  `@earendil-works/pi-coding-agent` publishes its own. Do not grow it: an
  unverified surface that looks verified is worse than a missing one.
- **Local `main` is stale** (`975d167` vs `origin/main` `34cd9ee`). Fast-forward
  before starting local work from `main`.
  *Resolved 2026-09-30, measured: `git fetch origin` then `git status -sb`
  reports local `main` at `625e59f` with no ahead/behind divergence. Kept as a
  standing obligation, not as an open defect — the fetch is what closed it.*
- **Fetch before concluding anything about merge state.** A confident wrong
  claim — "the MR did not carry the work" — came from reading a stale
  `origin/main`. One fetch first would have prevented it.

## 7. STANDING POLICY

**Never pin a shape you cannot explain.** Pins written before the mechanism was
understood were wrong about production while green, which is worse than absent.
Read first, then pin, and name the event order in every test so an
order-assumption cannot hide in a test body.

**One command one purpose. No stash.**

**One ledger.** `docs/F006_LEDGER.md` is the single ledger of record — deaths,
findings, defect classes, standing annotations and environment facts are written
here by the agent. `docs/DECISIONS.md` records operator rulings only, by
reference. `memory/` is not a ledger. An earlier instruction named three
candidate writers; that was a defect in the instruction, it is closed, and it is
recorded here so the single-writer rule has a stated origin.

**No out-of-root scratch, ever.** Inline pipes (`git show X | sed -n 'a,bp'`) or
in-repo scratch paths only. Written after session 2 died to `/tmp` scratch under
a root the boundary guard correctly refuses; the guard was right and the agent
was the cause.

**Commit on measure is enforced.** Every measurement batch and every ledger
write commits immediately; push on green. Two sessions in a row held evidence
only in a report that died with them.

**Report per item.** Each queue item gets its own report, with its measurement,
so a death costs one item rather than the session's whole output.
