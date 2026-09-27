# F-003: Policy violation kills task prematurely

- **ID:** F-003
- **Status:** Partially resolved. The lifecycle/re-entrancy half is implemented
  and verified; the policy-denial-semantics half is configuration-driven and
  partially closed. See "What remains" below.
- **Component:** Task lifecycle, policy preflight, denial handling

## Description

A single policy rejection is escalated to a terminal "Task is FAILED" state with
no mechanism for recovery or path-correction. After one denial, every
subsequent tool call returns "Task is FAILED; no further tool calls are
accepted", so a legitimate task dies on a minor, fixable violation.

## Impact

Fail-closed policy should reject the specific offending call, not terminate the
entire session or task execution flow.

## Expected Behavior

Fail-closed should only reject the single call that violated policy. Subsequent
calls should be allowed to proceed, provided they comply with policy.

## Resolved: lifecycle and re-entrancy protection

The lifecycle half is implemented and covered by tests. What was wrong, and what
now holds:

- **A denial never binds an execution.** `precheckToolCall` records a refused
  `toolCallId`, and `beginToolExecution` refuses to build a plan for it
  (`TOOL_EXECUTION_IGNORED`, reason `policy_denied`). A blocked call cannot
  become a fake successful execution.
- **`precheckToolCall` does not move the lifecycle for a DENY**, except when the
  decision carries `violation: "abort"`. It is a preflight hook and may fire
  several times before anything executes, so it must not create a plan, bind a
  step, or advance the task.
- **A blocked turn is a completed turn, not a dead stream.** A turn whose only
  actions were blocked still produced an assistant action, so finalising it
  completes rather than failing. Previously this misread as stream death.
- **Refusals are not violations.** A task that is already terminal refuses
  further calls with `refusal: "task_terminal"`, which is a lifecycle refusal and
  never carries `violation`. Policy denials and terminal refusals are counted
  separately (`denialCount` vs `terminalRefusalCount`).
- **Re-entrancy is safe.** `this.task` is a single mutable slot shared by every
  Pi event handler, and `beginTask` replaces it. Any handler that yields
  re-checks task identity before mutating; a stale handler records a refusal
  rather than acting on the newer task. The `transitionLog` is bounded at 500
  entries and spans turns, so a supersession stays explainable.
- **The legacy entry point no longer fails on every denial.** `evaluateToolCall`
  now honours `decision.violation`: `block` refuses the call and leaves the task
  running, `abort` returns without a second transition, and an unlabelled denial
  still fails closed as before (PR #4).

Tests: `platform/pi/f003-block-lifecycle.test.ts` (no-tool finalisation, blocked
turn completes, a later valid call still executes, abort is terminal, refusal
carries no violation, legacy `block` vs `abort` vs unlabelled).

## Remaining: denial semantics are configuration-driven, not a kernel guarantee

This is the part of the original finding that is *not* a universal guarantee, and
the distinction matters:

- `PolicyDecision` carries `violation: "block" | "abort"`. The behaviour follows
  the **policy configuration's `onViolation`**, not a fixed kernel rule.
- The committed `.pi/neurofebric-policy.json` sets `"onViolation": "block"`, so in
  this repository a denied call is refused and the task continues. That is a
  *configuration choice*, and it is why most live denials here are survivable.
- If a project's policy sets `onViolation: "abort"`, the same denial terminates
  the task with a `FAILED` transition, traced as `POLICY_VIOLATION` +
  `POLICY_ABORTED` + `TASK_FAILED`. That is intended, not a bug.
- The legacy `evaluateToolCall` path still fails closed on an **unlabelled**
  denial (for example a tier-policy approval refusal, which carries no
  `violation`). This preserves the pre-existing behaviour and keeps the
  approval-denial expectation in `platform/pi/kernel-adapter.test.ts` valid.

So "a policy denial never kills the task" is true for this repository's
configuration, and is **not** a platform-wide invariant. Any project that
configures `onViolation: "abort"` will see denials terminate tasks.

## Related

F-007 (path-extraction false positive that produced the denial observed live),
F-006 (a different task-death mechanism: recovery budget exhaustion).
