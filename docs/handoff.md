# Agent Harness Handoff Document

## Agent operating rules

Forged 2026-09-26 from three session deaths in one day (F-006, F-007, F-008). Mandatory for every agent session in this repo:

Plan first. Write the planned tool-call sequence before the first call. Budget ~20 calls against the 40-call limit (F-008).
Never read the same file region twice. One whole-file read is cheaper than three partial reads (F-008).
No backslash-leading tokens in shell text — not '\r', '\n', '\.git', no escape sequences at all. The path-boundary guard reads them as rooted paths and denies the whole command (F-007). Use file tools or git built-ins instead.
Prefer file tools over shell for reads and listings. Shell only for git and the test runner.
One-strike edits. A failed exact-match edit is never retried with the same oldText. One failure → full-file reconstruction, gated by git diff <file> showing changes only in the intended region (F-006).
A policy denial is never retried. Note it and move on; STOP if it was a required step. A denial is terminal or not according to the policy's `onViolation` setting, not according to the kernel — see "Policy-denial semantics" below (F-003, F-007).
Stay inside the repo. Never read outside the repo root; NEVER modify .pi/neurofebric-policy.json (D-004); no .ps1 files.
Stop and report on anything unexpected. Do not improvise.
If the brief contradicts the code, STOP and report. Do not expand scope on your own authority — the operator resolves scope conflicts.
Quote code in fenced code blocks in reports — inline backticks have been mangled in transport before.

## 0. Current finding status

As of `8f9f0c2` on `d-016-vault` (the D-016 build commit; `main` last at `d678435`, PR #24 merged). Full detail in `verification/findings/`.

| ID | Status |
| --- | --- |
| F-003 | **Partially resolved.** Lifecycle and re-entrancy protection are implemented and verified: a denial never binds an execution, `precheckToolCall` does not advance the lifecycle for a DENY, a blocked turn finalises as completed rather than as a dead stream, terminal refusals carry `refusal` and never `violation`, and any handler that yields re-checks task identity before mutating. Denial *continuation* is a separate matter and is configuration-driven — see the next section. |
| F-006 | **Phase 1 merged (PR #3).** `maxStepRetries` removed from `RecoveryLimits` and `DEFAULT_LIMITS`; `chooseRecoveryDetailed` returns a machine-readable `RecoveryReason`; `describeTerminalRecovery` names the budget actually exhausted; `TASK_FAILED` carries `reasonCode`, `strategy`, `failure`, and the live counters. **Remaining Phase 2 work:** real retryability propagation from Pi errors (`recordToolResult` currently forces `retryable: false`, so a genuinely transient failure is classified `TOOL_FAILURE` and the `TRANSIENT` retry path is never reached by a real tool error), and strategy-change-aware recovery (recovery still cannot distinguish "retry the same failing call" from "try a different strategy"). |
| F-008 | **Resolved (PR #2).** Advisory `BUDGET_LOW` at 75% and 90% of `maxToolCallsPerTask`, fired once per band per task, plus `TOOL_CALL_REPEATED` for repeated identical calls. Both are purely observational; the terminal limit denial is unchanged. |
| F-007 | Resolved. The violation-mapping question is answered — see below. Residuals accepted as backlog. |
| F-005 | Resolved. |
| F-000, F-001, F-002, F-004 | See their own documents. |

## 0a. Policy-denial semantics (separate from F-003 lifecycle protection)

These are two different things and are easy to conflate. Keep them apart.

**F-003 lifecycle/re-entrancy protection** is a kernel property. It is
implemented and verified, and it holds regardless of configuration: a denied
call never becomes an execution, preflight does not mutate the lifecycle, a
blocked turn is a completed turn, and a handler that resumes after a newer task
has replaced its own is refused rather than allowed to act.

**Policy-denial semantics** are a *configuration* choice, carried on
`PolicyDecision.violation`:

- `onViolation: "block"` — the denial is non-terminal and continuation is
  allowed. The call is refused, the task keeps running, and a later compliant
  call may proceed.
- `onViolation: "abort"` — the denial may terminate the task, with a `FAILED`
  transition traced as `POLICY_VIOLATION`, `POLICY_ABORTED`, `TASK_FAILED`.

The committed `.pi/neurofebric-policy.json` sets `"onViolation": "block"`, which
is why denials in this repository are survivable. **That is a configuration
choice, not a platform-wide guarantee.** A project configured with
`onViolation: "abort"` will see the same denial terminate its task, by design.

The legacy `evaluateToolCall` entry point follows the same rule (PR #4): `block`
leaves the task running, `abort` terminates it without a second transition, and
an *unlabelled* denial — for example a tier-policy approval refusal, which
carries no `violation` — still fails closed as it always did.

`KernelAdapter.diagnostics` separates `denialCount` (policy denials, whatever
`onViolation` they carried) from `terminalRefusalCount` (refusals because the
task was already terminal, which are not policy decisions).

## 0b. Current verification baseline

Measured on `d-016-vault` at `8f9f0c2` and re-run in CI on every pull request:

| Suite | Command | Result |
| --- | --- | --- |
| Platform .mjs | `node --test platform/*.test.mjs` | 22 / 22 |
| Core and Pi TypeScript | `node --experimental-strip-types --test platform/core/*.test.ts platform/pi/*.test.ts` | 320 / 320 |
| **Unit/integration total** | | **342 / 342** |
| F-006 live recovery proof | `node --experimental-strip-types verification/live-f006-proof.mjs` | 21 checks, 0 failed |

The 21 live-proof checks are **counted separately** from the 342. They are
assertions driven by a standalone script rather than `node:test` cases, so
342 + 21 is not a suite total of 363. The proof is headless and self-contained —
it drives the real `KernelAdapter` and the real recovery decision function with
stubbed tool results, uses no model and no network, and runs unchanged on a CI
runner.

The step labels in `.github/workflows/ci.yml` carry the test counts as of when
they were written and are cosmetic; a job passes or fails on each command's
exit code, not on the label.

## 0c. `workspace/head-baseline`

A **registered linked Git worktree** at `workspace/head-baseline`, listed by
`git worktree list`. It is **detached at its baseline commit** (`ce93aa4`), so
it has no branch of its own and will not be moved by commits made on `main`.

It is covered by the existing `workspace/*` rule at `.gitignore` line 17, so it
is untracked by design and never appears in `git status` or in a commit.

It is **not** part of the build, the test suites, or any verification run.

Operator-visibility implication: a repository-wide search will surface this
directory alongside real working files, and a directory listing of the workspace
will show a second, older copy of the platform sources. It is a deliberate
baseline for comparison, not a duplicate install, not a stray build artifact,
and not a defect. When reading or searching the repository, exclude it unless you
specifically want to diff against the baseline.

## 1. Directory Tree

```
agent-harness/
|-- .pi/
|   |-- extensions/platform-orchestrator.ts
|   |-- neurofebric-policy.json
|   |-- neurofebric.json
|   `-- settings.json
|-- policies/                # Historical provenance for the policy port (not read at runtime)
|-- platform/
|   |-- core/                # Orchestrator core modules
|   |-- pi/                  # Pi kernel integration
|   |-- orchestration.mjs / .test.mjs
|   |-- skill-conformance.test.mjs
|   `-- skill-registry.mjs / .test.mjs
|-- skills/
|   |-- file-analysis/SKILL.md
|   |-- log-analysis/SKILL.md
|   |-- report-writer/SKILL.md
|   `-- structured-data/SKILL.md
|-- policies/                # Historical provenance for the policy port (not read at runtime)
|-- memory/                  # Project-memory notes
|-- OmniRoute/               # Provider extension integration (local-only checkout)
|-- docs/
|-- reports/                 # All gauntlet results (A-H)
|-- tests/                   # Fixtures consumed by the TypeScript suites
|-- verification/
|   |-- findings/
|   |-- fixes/
|   `-- scenarios/
`-- workspace/
    `-- head-baseline/     # Linked git worktree, detached at its baseline commit; ignored by workspace/*
```

## 2. Orchestrator Core Contents (platform/core/)

- types.ts - Task, Plan, Skill/Tool Descriptors, Artifact, ValidationResult, PolicyDecision
- workspace.ts - Workspace boundary management and path validation
- tool-paths.ts - Path candidate extraction for security checks
- policy.ts - DefaultPolicy and TrustedProjectPolicy engines; destructive-command and credential-access pattern regexes; classifyTrustedOperation
- policy-config.ts - Policy configuration loader
- redaction.ts - Signature and field-based credential/data scrubbing at event bus / persistence / artifact / provenance boundaries
- configured-policy.ts - Policy wrapper
- tool-registry.ts - Tool registration and metadata
- skill-catalog.ts - toSkillDescriptor, skillsForCapabilities, assertUniqueSkills, assertResolvableDependencies
- skill-metadata.ts - parseFrontmatterFields, validateSkillMetadata, parseSkillDocument, SkillMetadataError, frontmatter validation
- planner.ts / plan.ts - PlannerInput, Plan, PlanStep interfaces and state
- validation.ts - Input/output validation
- limits.ts - Resource limits
- context-memory.ts - Context and memory integration
- recovery.ts - Error recovery and retry
- execution.ts - Execution tracking
- errors.ts - CoreError
- events.ts - Event bus
- state-machine.ts - Task status transitions (createTask, transitionTask, canTransition)
- artifact.ts - Artifact creation and integrity verification
- index.ts - Barrel exports

## 3. Skill Contract and Loader

Skill Contract (SKILL.md frontmatter):

| Field | Cardinality | Description |
|---|---|---|
| name | required | Lowercase kebab-case, must match directory |
| description | required | 2000 chars max |
| version | optional | semver |
| capabilities | optional list | capability tokens |
| supportedInputs | list | MIME types |
| supportedOutputs | list | MIME types |
| requiredTools | list | registered tool names |
| optionalTools | list | registered tool names (skipped if unknown) |
| dependencies | list | skill names (non-self-referencing) |
| constraints | list | plain-text bullet statements |
| examples | list | use-case strings, 500 chars max |
| riskLevel / risk | optional | READ_ONLY / CONTROLLED / WRITE (mutually exclusive spellings) |

Loader logic (skill-catalog.ts + skill-metadata.ts):
- parseFrontmatterFields: splits on --- delimiters, rejects tabs, control chars, duplicate keys, unknown keys, unsupported YAML constructs (anchors/aliases, block scalars, flow collections).
- validateSkillMetadata: validates name vs directory, version regex, risk level, capability/tool/dependency patterns, enforces max counts (2000 desc, 200 items, 400 total), normalizes risk/riskLevel into one field.
- parseSkillDocument: produces a SkillDescriptor with fallbackRisk = READ_ONLY.
- assertUniqueSkills, assertResolvableDependencies: guard catalog integrity.
- Non-strict discovery skips unknown optional tools and drops invalid required-tool skills without throwing.

## 4. Phase 2 Roadmap

From reports/REPORT.md and planning notes:

Priority 1 - Adaptive Write-Budget Thresholds:
- Issue: Fixed maxFileWritesPerTask caused halts during gauntlet bootstrap (F-001).
- Solution: Scope write-budget exemptions or higher burst limits for authorized harness generation scripts.

Priority 2 - Resilient Session State Recovery:
- Issue: Manual reconciliation between parent and child tasks after interruptions.
- Solution: Auto-snapshot and resume partial gauntlet workflows (checkpointing).

Priority 3 - Enhanced Policy Interception Diagnostics:
- Issue: Generic termination signals for blocked shell redirects.
- Solution: Structured JSON error payloads for policy violations instead of exit codes.

Long-term roadmap items:
- Model routing across multiple backends (D-001 gates full fallback removal).
- Persistent memory store (SQLite initially) for cross-session context.
- MCP server connectors for external tools/databases/Splunk.
- Optional human-approval gates for sensitive operations (currently fail-closed by design).
- Sub-agent spawning for delegated work.
- Dynamic replanning/adaptation based on execution feedback.

Note: Gate 1 of the D-001 migration is verified - a real Pi turn pinned to auto/gemini via OmniRoute completed successfully. Step 2 (fallback provider cleanup) is pending as Gate 2.

## 5. Configuration Defaults

.pi/settings.json:

```json
{ "skills": ["../skills"] }
```

.pi/neurofebric.json:

```json
{ "policyMode": "TRUSTED_PROJECT", "allowedRoots": ["."] }
```

.pi/neurofebric-policy.json (key points only - see the file for the full policy):
- deniedTools/allowedTools: [] - no name gating; tool risk tier governs.
- fileRules: catch-all allow read+write inside roots.
- Pattern lists - destructive command patterns and tokens, credential-filename rules, and the write-time credential guardrail - live in the policy file. Token spellings are intentionally omitted from this document, because persisting them is exactly what the write-time guardrail blocks.
- limits: maxToolCallsPerTask: 40, maxFileWritesPerTask: 10, maxBytesPerWrite: 2000000, onViolation: block.

### Kernel limits (as implemented)

Two independent limit surfaces exist. An earlier version of this table named
`maxFileReadsPerTask`, `maxFileWriteBytes`, and `maxToolExecutionMs`; those
settings do not exist anywhere in `platform/core` (grep verified 2026-09-26),
and the write budget was wrongly attributed to `platform/core/limits.ts`.

**Policy limits** — `PolicyLimits` in `platform/core/policy-config.ts`, loaded
from `.pi/neurofebric-policy.json` and enforced by `ConfiguredPolicy`
(`platform/core/configured-policy.ts`) before every tool call. If the policy
file is absent, the fallback `EMPTY_POLICY_LIMITS` is unbounded
(`Number.MAX_SAFE_INTEGER`): "no policy file" means tier-based policy only,
not zero limits.

| Setting | Meaning | Committed value |
| --- | --- | --- |
| `maxToolCallsPerTask` | tool calls per task, all tiers | 40 |
| `maxFileWritesPerTask` | write-tier calls per task | 10 |
| `maxBytesPerWrite` | bytes per write payload | 2,000,000 |

Operator-selected `limitProfiles` (D-007) can override any subset of these for
a given run via `activeLimitProfile`; the merged values are what enforcement
sees and what denial messages report.

**Core limits** — `CoreLimits` in `platform/core/limits.ts`, defaults in
`DEFAULT_LIMITS`, validated by `validateLimits`. These are declared as the
kernel's resource envelope and are independent of the policy file.

**Enforced versus declared — read this before assuming a bound exists.**

Five of the entries below are actually read by an enforcement decision today.
`chooseRecoveryDetailed` in `platform/core/recovery.ts` consumes exactly
`maxToolRetries`, `maxReplans`, and `maxRecoveryDepth`, and the kernel's
execution-time bound is `maxExecutionTimeMs`. `createArtifact` in
`platform/core/artifact.ts` enforces `maxArtifactBytes` against the real
on-disk size of the reference it is asked to register, and that path is live:
`KernelAdapter` calls it for every declared tool output. The remaining entries
in `DEFAULT_LIMITS` are declared but not yet consulted by any enforcement path:
implementing them is open work, not a latent guarantee. Do not rely on
`maxTaskDurationMs`, `maxStepDurationMs`, `maxToolDurationMs`,
`maxParallelTasks`, `maxParallelTools`, or `maxOutputBytes` to reject anything
today.

One caveat on `maxArtifactBytes`: it is enforced **only for a reference that
already exists on disk**. If the size cannot be read — because the file has not
been written yet, for example — the check deliberately does not reject, and
`verifyArtifact` is what later decides whether the reference exists at all. A
declared output that is never produced is therefore never size-checked.

| Setting | Default | Enforced? |
| --- | --- | --- |
| `maxToolRetries` | 2 | **yes** — task-wide retry budget in `chooseRecoveryDetailed` |
| `maxReplans` | 2 | **yes** — task-wide replan budget in `chooseRecoveryDetailed` |
| `maxRecoveryDepth` | 3 | **yes** — consecutive recovery rounds since the last success |
| `maxExecutionTimeMs` | 1,800,000 (30 min) | supplied to the recovery options; no independent timer is enforced |
| `maxArtifactBytes` | 10,485,760 (10 MiB) | **yes** — on-disk size check in `createArtifact`; skipped when the size cannot be read |
| `maxTaskDurationMs` | 1,800,000 (30 min) | no — declared only |
| `maxStepDurationMs` | 300,000 (5 min) | no — declared only |
| `maxToolDurationMs` | 120,000 (2 min) | no — declared only |
| `maxParallelTasks` | 1 | no — declared only |
| `maxParallelTools` | 1 | no — declared only; Pi owns tool-execution mode |
| `maxOutputBytes` | 2,097,152 (2 MiB) | no — declared only |

`maxContextTokens` was **removed** (D-016b). D-009 had wired it to
`selectContext`, but that function still had no production caller and the
`estimatedTokens` input it budgets has no producer, so the field advertised a
bound that could not occur. With no truthful default left, `selectContext` takes
its budget as a required argument again. It is a budget over the caller's own
`estimatedTokens` figures, not a token count: no tokenizer runs in it.

`maxStepRetries` was **removed** (F-006 Phase 1). It was declared but never read
by any recovery decision, so it advertised a bound that did not exist. Per-step
attempt budgets live on `PlanStep.retryPolicy.maxAttempts` and
`ToolDescriptor.retryPolicy.maxAttempts`; the recovery budgets above are
task-wide. The KernelAdapter derives its recovery limits from `DEFAULT_LIMITS`
rather than duplicating the literals (PR #4), so the two cannot drift.

Provider defaults:
- Canonical: OmniRoute via omni provider at http://localhost:20128 (omniroute-pi-ext-integration extension).
- Fallbacks (INSTALLED but DISABLED by default): pi-free, its git duplicate, @billjr99/pi-openai-compat.
- Gate 1 of D-001 is verified: OmniRoute is connected and carrying pinned auto/gemini traffic. Fallback removal is pending as Gate 2.

Policy mode (TRUSTED_PROJECT vs APPROVAL):
- TRUSTED_PROJECT resolves to ALLOW/DENY only (never prompts); dangerous ops are denied outright.
- APPROVAL (alternative) may return REQUIRE_APPROVAL for write/destructive ops via an ApprovalProvider.

---
*End of handoff document. Intended for external reviewer consumption.*

