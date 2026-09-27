# Finding F-006: Consecutive edit failures terminate the task before strategy can change

- **ID:** F-006
- **Status:** Phase 1 merged (PR #3). Phase 2 open — see "Remaining work".
- **Component:** Recovery/limits, recovery diagnostics

## Description

Two edit calls failed atomically with "Could not find the exact text" (no
changes applied). Immediately after, every tool call returned "Task is FAILED;
no further tool calls are accepted". The original hypothesis was that a recovery
budget (`CoreLimits maxStepRetries = 1`, `maxToolRetries = 2`) was exhausted by
the two failures, terminating the task before the agent could change strategy —
re-reading the exact bytes, or rewriting the file wholesale.

## Impact

Bounded recovery is intentional and tested, but the boundary sat at "same
strategy, another attempt". A deterministic failure mode (exact-match edit vs
CRLF/whitespace mismatch) can consume the entire budget with zero probability of
success on retry, killing an otherwise healthy task.

## Expected behavior

Either recovery distinguishes "same failing call retried" from "new strategy
attempted", or repeated same-class tool failures admit a replan instead of
terminal failure. At minimum the trace must record a structured reason for the
task failure.

## Phase 1 — merged in PR #3

Merged and verified. What changed:

- **`maxStepRetries` was removed** from the recovery surface (`RecoveryLimits` in
  `platform/core/recovery.ts`) and is gone from `DEFAULT_LIMITS`. It was
  declared but never read by any recovery decision, so it advertised a bound
  that did not exist. Per-step attempt budgets live where they belong, on
  `PlanStep.retryPolicy.maxAttempts` and `ToolDescriptor.retryPolicy.maxAttempts`.
  Recovery budgets are task-wide and named accordingly.
- **Structured failure diagnostics.** `chooseRecoveryDetailed` returns a
  `RecoveryDecision` carrying a machine-readable `RecoveryReason`
  (`RECOVERY_DEPTH_EXHAUSTED`, `PERMISSION_FAILURE_ESCALATED`,
  `TRANSIENT_RETRY_EXHAUSTED_REPLAN`, `RETRY_AND_REPLAN_BUDGET_EXHAUSTED`,
  `REPLAN_BUDGET_EXHAUSTED`, and others), so the trace distinguishes "the replan
  budget ran out" from "the depth guard tripped" instead of one generic message.
- **Specific terminal reasons.** `describeTerminalRecovery` names the budget
  actually exhausted and the failure category, e.g.
  `Recovery TERMINATE [REPLAN_BUDGET_EXHAUSTED]: failure=TOOL_FAILURE, replanCount=2/2, retryCount=0/2, recoveryDepth=3/3`.
- **`TASK_FAILED` carries structured context**: `reasonCode`, `strategy`,
  `failure`, `retryCount`, `replanCount`, `recoveryDepth`.
- **Recovery defaults have a single source of truth.** The KernelAdapter
  derives `maxToolRetries` / `maxReplans` / `maxRecoveryDepth` /
  `maxExecutionTimeMs` from `DEFAULT_LIMITS` instead of duplicating the literals
  (PR #4), so changing the defaults cannot silently leave recovery enforcing the
  old numbers.

Enforced values are unchanged: `maxToolRetries = 2`, `maxReplans = 2`,
`maxRecoveryDepth = 3`.

Verification: `verification/live-f006-proof.mjs` — 21 checks, 0 failed. It drives
the real `KernelAdapter` and the real recovery decision function with stubbed
tool results, uses no model or network, and runs unchanged in CI.

## Remaining work (Phase 2 — not implemented)

- **Real retryability propagation from Pi errors.** `recordToolResult` builds
  `CoreError(..., { retryable: false })` for every tool error regardless of what
  Pi reported. A transient failure is therefore classified `TOOL_FAILURE`, not
  `TRANSIENT`, so the `TRANSIENT` retry path is never exercised by a real Pi
  error. `classifyFailure` already honours `CoreError.retryable`; the missing
  piece is carrying the real value from the tool error into the `CoreError`.
- **Strategy-change recovery.** Recovery still cannot tell "retry the same
  failing call" from "try a different strategy". The deterministic
  exact-match-edit failure can consume the whole budget with no chance of a
  different approach. A replan admission for repeated same-class failures is not
  implemented.
- **Trace evidence for the original observation** was never supplied
  out-of-band, so the original mechanism hypothesis remains unconfirmed at the
  event level even though the Phase 1 diagnostics now make it observable.

Also still open and out of scope for Phase 1: the nine declared-but-unenforced
`CoreLimits`, and policy-budget to recovery-semantics mapping.

## Related

F-003 (a denial terminating a task — a different mechanism), F-007 (path
extraction false positive), F-008 (budget exhaustion by redundant reads).
