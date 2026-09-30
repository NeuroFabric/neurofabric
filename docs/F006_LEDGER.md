# F-006 Ledger

Consolidated state of the F-006 denial-delivery work: what is fixed and on what
evidence, what is found but gated, what stays under watch, and what debt remains.

Last updated: 2026-09-30 (ledger fold A1.1). Author: Pi (agent). Operator-measured
figures are attributed as such; everything else was measured in-repo or pinned by
a test.

### Provenance — environment claims, measured not asserted

Measured in this pass, on the host that ran it:

| Claim | State | How it was measured |
|---|---|---|
| OmniRoute version | **3.8.51** | `OmniRoute/package.json` `"version"`; the checkout is on `release/v3.8.51` at `a1baae7b0a` |
| `glab` (GitLab CLI) | **NOT INSTALLED** | `command -v glab` returns nothing |
| `gh` (GitHub CLI) | installed, **not the mechanism** | `command -v gh` resolves; the `origin` remote is `gitlab.com/neurofebric-group/neurofebric`, which `gh` cannot open an MR against |
| `main` | `625e59f`, in sync with `origin/main` | `git fetch origin` then `git status -sb` reports no ahead/behind |
| Suite on `main` | **green** — 480 tests, 478 pass, 0 fail, 2 skipped | `npm test` (typecheck + `platform/*.test.mjs` + `platform/{core,pi}/*.test.ts`) |

An earlier operator directive asserted `glab` was installed and asked for the
provenance line to be written on that basis. It was not written, because the
claim was not true on this host, and the directive has since been corrected:
**operator directives do not assert environment state.** Environment claims are
verified before they are recorded, and an unverified claim is recorded as
unmeasured rather than repeated. `glab` is dropped from the queue; branch, SHA,
suite status and a pre-built MR URL are the merge mechanism, recorded in
`docs/MANIFEST.md`.

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

### Inventory scope — prior-measured, NOT re-verified in this pass

The declared-versus-implemented limits inventory (the probe artifacts
`.pi-tools/claimed-before.txt`, `.pi-tools/claimed.txt`, `.pi-tools/actual.txt`)
was measured in an **earlier** pass and is **not re-verified here**. It is
carried forward as prior-measured, with the artifacts named so the claim is
checkable rather than merely asserted. Re-verification is queued; until it runs,
no statement in this ledger depends on that inventory being current.

---

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

### 2.3 Benign non-zero exits spend recovery budget

A command that exits non-zero for an ordinary, successful reason — `grep` with
no match exits 1, as do `find` and `diff` in common cases — is treated as a tool
failure and spends replan budget.

**Risk.** Low per occurrence, high cumulatively: a long task doing normal work
can exhaust the budget without ever being blocked by anything.

**Next step.** Investigate and propose only (§5, item 3). This changes recovery
semantics and does not merge without explicit sanction.

---

## 3. WATCH — armed

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
