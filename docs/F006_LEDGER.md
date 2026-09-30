# F-006 Ledger

Consolidated state of the F-006 denial-delivery work: what is fixed and on what
evidence, what is found but gated, what stays under watch, and what debt remains.

Last updated: 2026-09-30. Author: Pi (agent). Operator-measured figures are
attributed as such; everything else was measured in-repo or pinned by a test.

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
2. **Token guard scoping.** Enumerate the policy's token rules first, corpus
   second. Bare tokens must match at word boundaries in **command position**, not
   anywhere in any string. Same MUST-DENY gate.
3. **Benign non-zero exits.** Enumerate legitimately non-zero commands, propose a
   classification rule, implement on a branch with pins, flag for review.
4. **C3b rebase.** Gated on the operator's merge signal. Already rebased onto
   `34cd9ee` with no conflicts; C3b's commit was already in `main`, so the
   predicted `kernel-adapter.ts` comment conflicts did not arise. A content
   assessment of C3b is still owed.

---

## 6. DEBT

- **Delete the shadow declaration.** `platform/pi/pi-coding-agent.d.ts` is a
  hand-written stand-in for a package that ships no types. Delete it when
  `@earendil-works/pi-coding-agent` publishes its own. Do not grow it: an
  unverified surface that looks verified is worse than a missing one.
- **Local `main` is stale** (`975d167` vs `origin/main` `34cd9ee`). Fast-forward
  before starting local work from `main`.
- **Fetch before concluding anything about merge state.** A confident wrong
  claim — "the MR did not carry the work" — came from reading a stale
  `origin/main`. One fetch first would have prevented it.

## 7. STANDING POLICY

**Never pin a shape you cannot explain.** Pins written before the mechanism was
understood were wrong about production while green, which is worse than absent.
Read first, then pin, and name the event order in every test so an
order-assumption cannot hide in a test body.

**One command one purpose. No stash.**
