# F-003: Policy violation kills task prematurely

- **ID:** F-003
- **Status:** RESOLVED. The lifecycle and re-entrancy protections are
  implemented and verified, and the denial-semantics half is now settled:
  it is a **configuration-driven** behaviour, pinned by tests on both the
  legacy and the approval path. No unexplained terminal-state anomaly
  remains. See "Final disposition" below.
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

## Final disposition: EXPECTED ARCHITECTURAL BEHAVIOR, plus one TEST GAP now closed

The originally observed symptom was real: a single policy rejection reached a
terminal `Task is FAILED` state. Its mechanism is now fully established, and it
was **not one cause but two**, which is why it looked inconsistent.

**Cause 1 — unlabelled denials fail closed (the actual bug, now fixed).**
On the approval path an approval provider used to be handled by *substituting* a
bare tier policy for the installed one. A declarative denial therefore arrived
with **no `violation` label at all**. An unlabelled denial is the one case the
legacy `evaluateToolCall` entry point still fails closed on, so the original F-003
complaint was reachable on exactly the path an interactive operator uses: one
boundary violation during an `APPROVAL`-mode run ended the whole task.

This was the same root cause as the approval-policy-composition defect fixed in
PR #28. With the installed policy authoritative again, a declarative denial
carries the configured `onViolation` again, so `block` blocks and `abort`
aborts. The interaction is now tested end to end through the real composition,
not a stub policy:

- `H` — a declarative `block` denial on the approval path leaves the task
  alive, and a later compliant call is still allowed. This is the exact
  expectation in "Expected Behavior" above.
- `H2` — a declarative `abort` denial on the approval path is terminal, and
  traces `POLICY_VIOLATION` + `POLICY_ABORTED` + `TASK_FAILED`.
- `H3` — an approval *refusal* deliberately carries no `violation` and still
  fails closed on the legacy path. This asymmetry is intentional and is now
  pinned, so the labelling is not "tidied up" into a block and silently changed
  into different terminal behaviour.

**Cause 2 — `onViolation: "abort"` is intended, not a defect.** When a project
configures abort, the same denial is *meant* to end the run. That is the
documented contract, it is traced, and `H2` pins it.

**Interaction with the tool-call budget.** None causes a terminal state. A
budget exhaustion is a separate mechanism with its own reason code
(`TOOL_CALL_BUDGET`), counted per task by the installed policy. Before the
composition fix the budget was not even metered on the approval path; it is now,
and the budget denial is an ordinary policy denial subject to the same
`onViolation` semantics rather than a special case.

**Disposition:** EXPECTED ARCHITECTURAL BEHAVIOR for the abort semantics, and a
TEST GAP that is now closed for the block semantics on the approval path. No
unexplained anomaly survives.

## Related

F-007 (path-extraction false positive that produced the denial observed live),
F-006 (a different task-death mechanism: recovery budget exhaustion).
