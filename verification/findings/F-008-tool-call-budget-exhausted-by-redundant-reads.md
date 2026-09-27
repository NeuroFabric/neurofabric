# Finding F-008: Tool-call budget exhausted by redundant reads; no low-budget telemetry

- **ID:** F-008
- **Status:** **Resolved** (observed live 2026-09-26 during the D-007 docs replay;
  merged in PR #2)
- **Component:** Limits telemetry (maxToolCallsPerTask), trace diagnostics, agent discipline

## Description
During a docs task, the agent re-read the same file region roughly 15-20 times
(offsets 138/118/130 repeatedly, whole-file reads x3) while locating an edit
anchor, consuming about half of the 40-call budget. The task then died at the
next call with "policy neurofebric-policy.json: maxToolCallsPerTask exceeded
(40)" — with both planned edits already applied but the third step and the
commit never reached. The counter counts calls, not progress, and the agent
received no signal about the remaining budget until the terminal denial.

## Impact
A task can die with its work half-done and uncommitted purely from wasted
reads. Unlike F-006 (retry exhaustion) this is not a tooling failure — the
budget did its job — but the harness gave the agent no chance to course-
correct: no low-budget warning, no signal that reads were being repeated.

## Expected behavior
- Surface remaining budget to the agent (e.g., a warning in tool results at
  75% and 90% of maxToolCallsPerTask) so degradation is graceful, not terminal.
- The trace should make repeated identical reads visible (feeds P3a).
- Agent-side mitigation (now a standing rule): never read the same region
  twice; plan the call sequence before starting.

## Resolution

Merged in PR #2 and verified. The limit itself is unchanged — the 41st call is
still denied, with the same reason, by the same check in the same place. What
was added is signal, so degradation is graceful rather than terminal:

- **Low-budget telemetry.** `ConfiguredPolicy.toolBudget` reports position
  (`used`, `limit`, `remaining`, `level`) and the `repeatCount` for the call just
  evaluated, so a task is told while it still has room to act.
- **Two advisory bands.** `BUDGET_LOW` fires at 75% and 90% of
  `maxToolCallsPerTask`, **once per band per task**, so ten identical "you are
  low" messages cannot bury the signal. Bands are cleared by `beginTask`, because
  a new turn has a new budget.
- **Repeated-read visibility.** `TOOL_CALL_REPEATED` reports how many times an
  identical call has been made, using a stable structural signature. The
  signature is derived from call input and is never itself emitted, traced or
  logged — only the count is returned.
- **Purely observational.** Neither event can deny a call or move a task. The
  terminal limit denial is untouched.

Tests: `platform/pi/f008-budget-telemetry.test.ts` (A–K), including that a
warning changes nothing about the call or the task, and that a new turn gets a
fresh budget and fresh warnings.

Agent-side mitigation remains a standing rule in `docs/handoff.md`: never read
the same region twice; plan the call sequence before starting.

## Related
F-006 (different exhaustion mechanism: edit-retry budget), F-003 (denial
handling).