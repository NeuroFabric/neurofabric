# Concurrency and Recovery Hardening — operator spec (DRAFT)

- **Status:** DRAFT, awaiting operator approval. Nothing in section 3 is
  implemented, and nothing in it may be implemented before approval.
- **Origin:** the "Phase M1–M4" label, de-scoped by **D-021** because no written
  specification existed for it. This document is that specification, drafted so
  the decision can be made on evidence rather than on a label.
- **Scope:** the concurrency and recovery surface of the harness kernel and its
  Pi extension.

The purpose of this split is deliberate. A large part of what "M1–M4 concurrency
hardening" would have meant is **already implemented and already tested**, and
re-deriving it would be waste. A smaller part is genuinely new semantics that
only the operator can decide. Conflating them is how an uncheckable reference
becomes shipped behaviour, so they are separated here.

---

## 1. What is already enforced, and pinned

The races that actually exist in this codebase are not hypothetical. They are
**stale-event races** between a superseded task and the events still in flight
from it, and they are pinned by
`platform/pi/kernel-adapter-reentrancy.test.ts` — 19 cases across eight groups.
This surface is covered, not open:

| Group | Surface | Cases |
|---|---|---|
| A | `agent_end` overlapping `before_agent_start` must not finalise the new task | A, A2 |
| B | Two racing `before_agent_start` events must not corrupt the lifecycle | B, B2 |
| C | A tool result completing after a new task starts is refused | C, C2 |
| D | A stale precheck cannot record a decision against the newer task | D, D2 |
| E | Sequential turns work; a new task may follow a terminal one | E, E2 |
| F | Normal, blocked, and genuinely dead stream outcomes | F, F2, F3 |
| H | A stale ALLOW and a stale DENY are both refused, and neither pollutes the newer task's bookkeeping | H, H2–H6 |

**H is the load-bearing group.** It is what makes the rest safe: a stale decision
is refused, and a refused stale decision increments no counter, mutates no set,
and does not advance the newer task's lifecycle.

**Consequence:** there is no uncovered race in the stale-event surface. Any
proposal to "harden concurrency" here that does not name a specific uncovered
case is proposing work that already exists.

## 2. The recovery surface, and what is already pinned

Recovery is already specified and verified by
`verification/live-f006-proof.mjs` — 21 checks, 0 failed, run unchanged in CI.
It drives the real `KernelAdapter` and the real recovery decision function with
stubbed tool results, with no model and no network.

Pinned and enforced: deterministic non-retryable failures never select `RETRY`;
`PERMISSION` and `INVALID_INPUT` fail closed with `ESCALATE`; transient failures
select `RETRY` only under budget; the spent replan budget is visible on the task;
a post-terminal precheck is refused as `task_terminal` rather than as a violation;
and a terminal task reports a specific `reasonCode` rather than a generic
sentence.

## 3. Genuinely uncovered surface — REQUIRES OPERATOR APPROVAL

Everything in this section introduces **new semantics**: new limits, new state, or
new tools. None of it may be implemented on agent initiative.

### 3.1 True parallel tool execution — is it in scope?

`maxParallelTools` and `maxParallelTasks` were **removed** from `CoreLimits` in
D-009 because nothing scheduled tasks concurrently; a value of one described a
constraint the platform did not enforce and could not today violate. So parallel
execution does not exist as a feature.

The open question is whether it *should* exist, and if so what a limit means when
two tool calls in one step are genuinely in flight at once. Every bounded-recovery
guarantee in section 2 was reasoned about a single in-flight call. That is a real
gap between what the tests pin and what a parallel executor would need — and it
is a design question, not a bug.

**Decision needed:** is parallel tool execution in scope for the harness at all?
If no, this section closes as not-applicable and the limit stays removed. If
yes, it needs a concurrency model, a limit with a real meaning, and a
reconsideration of whether stale-event fencing generalises to N in-flight calls.

### 3.2 Strategy-change recovery

From F-006 Phase 2 (open): recovery cannot distinguish "retry the same failing
call" from "try a different strategy". A deterministic exact-match-edit failure
can consume the entire retry budget with zero probability of success on retry,
killing a healthy task.

**Decision needed:** does repeated same-class failure admit a replan, or does the
retry budget remain a hard stop by design? The latter is defensible — bounded
recovery is intentional and tested — and is not obviously a defect.

### 3.3 Real retryability propagation

From F-006 Phase 2 (open): `recordToolResult` builds
`CoreError(..., { retryable: false })` for every tool error, regardless of what
the tool layer reported. `classifyFailure` already honours
`CoreError.retryable`, so the `TRANSIENT` retry path is never exercised by a real
tool error.

**This one is plausibly mechanical, and is the highest-value item on this page.**
But "the real value from the tool error" depends on the external tool-error
contract, which is not defined in this repository. Guessing that contract would be
inventing an interface, so it is listed here rather than implemented.

**Decision needed:** confirm the tool-error shape, then this becomes conformance
work with red-first evidence.

## 4. What this spec deliberately does not propose

- No new limits. D-009 removed six paper limits; a seventh should not be added
  before the mechanism that would enforce it exists.
- No new persisted state.
- No change to any fenced semantics: `selectContext` (D-020), the vault's
  jurisdiction (D-022/D-023), or the descriptor contract (M2 fence).
- No roadmap. Sequencing after approval is the operator's call.

## 5. Recommendation

Approve **3.3 first** — it is a small, testable, conformance-shaped item with the
largest correctness gain. Decide **3.2** as a product question with a stated
preference rather than leaving it open. Treat **3.1** as a scope question to be
answered explicitly either way, so the removed limits stay deliberately removed
rather than quietly pending.
