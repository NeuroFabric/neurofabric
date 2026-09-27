# Agent Harness Handoff Document

## Agent operating rules

Forged 2026-09-26 from three session deaths in one day (F-006, F-007, F-008). Mandatory for every agent session in this repo:

Plan first. Write the planned tool-call sequence before the first call. Budget ~20 calls against the 40-call limit (F-008).
Never read the same file region twice. One whole-file read is cheaper than three partial reads (F-008).
No backslash-leading tokens in shell text — not '\r', '\n', '\.git', no escape sequences at all. The path-boundary guard reads them as rooted paths and denies the whole command (F-007). Use file tools or git built-ins instead.
Prefer file tools over shell for reads and listings. Shell only for git and the test runner.
One-strike edits. A failed exact-match edit is never retried with the same oldText. One failure → full-file reconstruction, gated by git diff <file> showing changes only in the intended region (F-006).
A policy denial is never retried. Note it and move on; STOP if it was a required step. Denials have been observed both terminal and non-terminal (F-003, F-007).
Stay inside the repo. Never read outside the repo root; NEVER modify .pi/neurofebric-policy.json (D-004); no .ps1 files.
Stop and report on anything unexpected. Do not improvise.
If the brief contradicts the code, STOP and report. Do not expand scope on your own authority — the operator resolves scope conflicts.
Quote code in fenced code blocks in reports — inline backticks have been mangled in transport before.

## 1. Directory Tree

```
agent-harness/
|-- .pi/
|   |-- extensions/platform-orchestrator.ts
|   |-- neurofebric-policy.json
|   |-- neurofebric.json
|   `-- settings.json
|-- core/                    # Legacy Python harness internals
|-- agents/                  # Agent definitions
|-- tools/                   # Tool implementations
|-- policies/                # YAML rule files
|-- config/                  # settings.yaml
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
|-- main.py
|-- memory/
|-- OmniRoute/               # Provider extension integration
|-- docs/
|-- reports/                 # All gauntlet results (A-H)
|-- requirements.txt
|-- tests/
|-- verification/
|   |-- findings/
|   |-- fixes/
|   `-- scenarios/
`-- workspace/
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
`DEFAULT_LIMITS`, validated by `validateLimits`. These govern kernel execution
(durations, retries, replans, recovery depth, parallelism, output and artifact
sizes, context budget) and are independent of the policy file.

| Setting | Default |
| --- | --- |
| `maxTaskDurationMs` | 1,800,000 (30 min) |
| `maxStepDurationMs` | 300,000 (5 min) |
| `maxToolDurationMs` | 120,000 (2 min) |
| `maxToolRetries` | 2 |
| `maxReplans` | 2 |
| `maxRecoveryDepth` | 3 |
| `maxExecutionTimeMs` | 1,800,000 (30 min) |
| `maxParallelTasks` | 1 |
| `maxParallelTools` | 1 |
| `maxOutputBytes` | 2,097,152 (2 MiB) |
| `maxArtifactBytes` | 10,485,760 (10 MiB) |
| `maxContextTokens` | 200,000 |

Provider defaults:
- Canonical: OmniRoute via omni provider at http://localhost:20128 (omniroute-pi-ext-integration extension).
- Fallbacks (INSTALLED but DISABLED by default): pi-free, its git duplicate, @billjr99/pi-openai-compat.
- Gate 1 of D-001 is verified: OmniRoute is connected and carrying pinned auto/gemini traffic. Fallback removal is pending as Gate 2.

Policy mode (TRUSTED_PROJECT vs APPROVAL):
- TRUSTED_PROJECT resolves to ALLOW/DENY only (never prompts); dangerous ops are denied outright.
- APPROVAL (alternative) may return REQUIRE_APPROVAL for write/destructive ops via an ApprovalProvider.

---
*End of handoff document. Intended for external reviewer consumption.*

