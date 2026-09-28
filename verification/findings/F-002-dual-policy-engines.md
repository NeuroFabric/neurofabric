# F-002 — Dual Policy Enforcement Implementations

## Problem
Two divergent policy/limits implementations exist and enforce write
budgets independently:
- core/policy_engine.py (Python, legacy harness: main.py, agents/)
- platform/core/ (TypeScript kernel, loaded via .pi/extensions/platform-orchestrator.ts)
Fixes must target the system the gauntlet actually exercised (see F-000
STEP 0 evidence).

## Status
RESOLVED (D-016c). The Python sample engine has been removed from the
repository: `main.py`, `core/agent_runner.py`, `core/llm_client.py`,
`core/policy_engine.py`, `agents/deep_research_agent.py`,
`tools/file_tools.py`, `requirements.txt` and `config/settings.yaml`
were deleted. `platform/` (TypeScript) is the single active
implementation.

The original problem statement above is preserved as written. Two
verifications backed the removal:

- **No active dependency.** Nothing under `platform/`, `.github/`, or
  `.pi/` imported, invoked, or referenced the Python tree. CI ran only
  the TypeScript suites.
- **`policies/default_policy.yaml` retained deliberately.** It is the
  documented provenance of the TypeScript policy port (see
  `docs/POLICY_PORT.md` and the comments in `platform/core/policy-config.ts`
  and `platform/pi/policy-port.test.ts`). It is no longer read by any
  runtime, so removing the engine that consumed it does not remove the
  record of where the rules came from.

There is now one enforcement path rather than two competing engines.
