# Agent Harness & Pi Analysis Platform — Project Summary

## 1. Project Overview

This project is a **personal, local agent platform** built on **Pi** (the general-purpose agent runtime). It adds a domain‑agnostic orchestration layer, reusable skills, and controlled tool integration around Pi.

- **Primary runtime:** Pi (agent loop, context management, model calls, tool execution)
- **Orchestrator:** A thin Pi extension (`platform-orchestrator.ts`) that provides workflow guidance, skill discovery, execution tracing, and a conservative permission gate.
- **Model provider:** **OmniRoute** is the canonical provider (via `omniroute-pi-ext-integration`). Non‑default fallbacks (`pi-free`, `@billjr99/pi-openai-compat`) are documented as escape hatches and kept off by default.
- **Old Python harness:** Remains as a reference implementation under `core/`, `agents/`, `tools/`, and `policies/` — not loaded by Pi.

## 2. Architecture

```
User → Pi agent runtime → platform-orchestrator extension → native Pi skill discovery → 
   → Pi built‑in or registered tools → validation & final response → model provider (OmniRoute)
```

### Key Layers

| Layer | Responsibility |
|-------|----------------|
| **Pi agent runtime** | Agent loop, context, sessions, model calls, tool calling, retries, provider streaming |
| **Orchestrator extension** | Generic workflow guidance, skill discovery, execution tracing, permission gate |
| **Skills** | Declarative procedures (`SKILL.md`) that describe when/how to use tools and what to do |
| **Tools** | Deterministic operations (file read/write, log search, structured‑data processing, reporting) |
| **Model provider** | OmniRoute (canonical); fallback providers (`pi-free`, `pi-openai-compat`) are off by default |
| **Memory** | `AGENTS.md`, architecture docs, decisions, and project memory (long‑term) |

### Design Decisions (from DECISIONS.md)

1. **Pi is the single general‑purpose agent runtime** — no second agent loop, LLM client, or filesystem toolset.
2. **Start with file, log, CSV, JSON, and report‑generation skills** — these are the first proof‑of‑concept skills.
3. **OmniRoute is the canonical provider** — all model calls go through `localhost:20128`; fallbacks are documented escape hatches.
4. **Trust model is `TRUSTED_PROJECT`** — dangerous operations are denied outright (fail‑closed), not prompted.
5. **Redaction is centralized** — enforced at the event bus, artifact layer, and orchestrator; never relies on the model to hide credentials.
6. **Max file writes per task = 10** — the committed policy keeps the conservative base budget. A temporary global bump to 50 (D-006) was reverted; per-run overrides now use operator-selected `limitProfiles` (D-007).
7. **Standing git rules are recorded, not remembered** — three rules govern agent-driven git operations, and a blocked command earns a deliberate recorded decision change, never an improvised workaround (D-008; rule 3 mechanized by D-010, rule 4 added by D-013).
8. **A declared limit is an enforced limit** — a limit on the public interface with no choke point was removed rather than documented, and the six that remain are enforced in code (D-009).
9. **Merge authority is mechanized, not delegated** — `main` is protected and advances only by a pull-request merge whose required checks have passed; agents request auto-merge and the operator keeps post-hoc review and revert authority (D-010).
10. **A claim about remote state names the endpoint it came from** — two of D-010's claims were false when written, and the correction is recorded rather than the superseded text reworded to look right (D-011).
11. **Operator rulings on the residual findings** — the `+refspec` force-push gap is accepted and open with a fix specified but unimplemented, the scratch-file deletion permit is rejected in favour of the deny-only design, and the operator-only policy boundary is a convention rather than an enforced control (D-012; spec in `docs/REFSPEC_GUARD_SPEC.md`).
12. **Local-state claims require same-session evidence** — the ruleset status-check dedup is closed, and two inventory defects of opposite sign produced a standing rule that branches, files, and working tree are asserted only from same-session command output (D-013).
13. **D-014** — refspec guard verified post-merge (9/9 blinded re-run + spot-check); spec reconciled to shipped pattern, §2 literal restored under operator clearance; guard false-positives adjudicated by rewording, no policy change; delete-refspec gap OPEN (D-014).

## 3. Current State

### Code Health
- **All tests pass: 314 total.**
  - `node --test platform/*.test.mjs` — **22/22**
  - `node --experimental-strip-types --test platform/core/*.test.ts platform/pi/*.test.ts` — **292/292**
  - `verification/live-f006-proof.mjs` — **21 checks, 0 failed** (headless, runs in CI)
- **Verification Gauntlet (Phase 1) is COMPLETED** — all 8 scenarios (A–H) passed with detailed reports in `reports/`.
- Core/Pi coverage includes approval, policy enforcement and porting, redaction and the persistence boundary, artifact verification, workspace boundaries, lifecycle and re-entrancy (F-003), recovery budgets and diagnostics (F-006 Phase 1), and budget telemetry (F-008).

### Finding status

Full detail in `docs/handoff.md` §0 and `verification/findings/`.

| ID | Status |
| --- | --- |
| F-003 | Lifecycle and re-entrancy protection implemented and verified. Denial *continuation* is configuration-driven (`onViolation`), not a kernel guarantee. |
| F-006 | **Phase 1 merged (PR #3).** `maxStepRetries` removed; structured failure diagnostics and specific terminal reasons implemented. **Phase 2 remains open:** real retryability propagation from Pi errors, and strategy-change-aware recovery. |
| F-007 | Resolved. |
| F-008 | Resolved (PR #2). |

Only three `DEFAULT_LIMITS` entries are enforced by the recovery decision:
`maxToolRetries` 2, `maxReplans` 2, `maxRecoveryDepth` 3. The remaining
declared limits are not yet read by any enforcement path.

### Current status board

Every GREEN and ORANGE entry cites its grounding: a merged PR, a decision ID, a
findings document, or a verified test count. Entries that cannot be grounded in
merged reality are WHITE and name-only.

**GREEN — done and verified**

- **Pi-based runtime with a thin orchestrator extension** — skill discovery, execution tracing, and a permission gate. No second agent loop or LLM client (design decision 1; `AGENTS.md`, `docs/DECISIONS.md`).
- **TRUSTED_PROJECT fail-closed policy; artifact verification; centralized redaction; tool and path security** — traversal, symlinks, and destructive/credential denial (`platform/core/policy.ts`, `artifact.ts`, `redaction.ts`, `workspace.ts`; covered by `trusted-execution.test.ts`).
- **Skills** — file-analysis active proof of concept; log-analysis, report-writer, and structured-data ready (§4).
- **OmniRoute canonical provider, D-001 Gate 1 verified** — a real Pi turn pinned to auto/gemini completed (`docs/handoff.md`).
- **Verification Gauntlet Phase 1** — scenarios A–H passed, reports in `reports/`.
- **F-003 lifecycle and re-entrancy protection** — implemented and verified (`verification/findings/F-003-policy-violation-kills-task.md`, `platform/pi/f003-block-lifecycle.test.ts`). Denial *continuation* is configuration-driven via `onViolation`, not a kernel guarantee.
- **F-006 Phase 1 (PR #3)**, **F-007 resolved**, **F-008 resolved (PR #2)**.
- **PR #4 hardening** — production artifact boundary, provenance propagation, and policy recovery semantics.
- **PR #5 documentation sync** — merged and verified.
- **CI green on every pull request and on push to `main`** — 22 `.mjs` + 292 core/Pi `.ts` + 21 live-proof checks.
- **Decisions D-001 through D-007 recorded**; `limitProfiles` (D-007); `maxFileWritesPerTask` = 10.

**ORANGE — partially done, or awaiting an operator decision**

- **Declared-but-unenforced `CoreLimits`** — 8 of the 12 `DEFAULT_LIMITS` entries are read by no enforcement path: `maxTaskDurationMs`, `maxStepDurationMs`, `maxToolDurationMs`, `maxParallelTasks`, `maxParallelTools`, `maxOutputBytes`, `maxArtifactBytes`, `maxContextTokens`. Only `maxToolRetries`, `maxReplans`, and `maxRecoveryDepth` are consulted by `chooseRecoveryDetailed`. Wire them into enforcement, or remove them from the contract.
- **F-003 policy-denial semantics** — the distinction between the kernel property (lifecycle and re-entrancy protection) and the configuration choice (`onViolation`) is documented but not yet codified in the contract.
- **Provenance persistence and audit boundary** — hardening landed in PR #4; where provenance persists and where the audit boundary sits is still undefined.
- **APPROVAL-mode policy composition** — less exercised than `TRUSTED_PROJECT`.
- **Windows CI coverage** — CI runs `ubuntu-latest` only.
- **OmniRoute credential in `models.json`** — D-002 accepted risk; migration to Pi's credential store is pending.

**WHITE — not started**

- **F-006 Phase 2** — retryability propagation from Pi errors; strategy-change-aware recovery.
- Capability routing — name only, pending operator definition.
- Multi-step planning — name only, pending operator definition.
- Delivery — name only, pending operator definition.
- Git checkpointing — name only, pending operator definition.
- Deferred per `docs/handoff.md` §4: MCP connectors, persistent memory store, optional human-approval gates.

Next implementation priority (operator-set): CoreLimits enforcement / source-of-truth cleanup.

### Project Structure

The platform is TypeScript under `platform/`. The Python directories below are a
**legacy reference implementation** — retained for comparison, not loaded by Pi,
and not part of the build or the test suites (see §1 and `AGENTS.md`).

```
agent-harness/
├── platform/             # The platform (TypeScript) — this is what runs
│   ├── core/             # Pi core: planner, validation, tool registry, redaction
│   ├── orchestration.mjs / orchestration.test.mjs
│   └── pi/               # Orchestrator extension (kernel adapter, lifecycle, etc.)
├── .pi/                  # Project config, policy file, orchestrator extension
├── verification/         # Findings, scenarios, and the headless F-006 proof
├── docs/                 # Architecture, SKILL_SPEC, SECURITY, handoff, etc.
├── skills/               # file-analysis, log-analysis, report-writer, structured-data
├── core/                 # LEGACY Python reference: LLM client, policy engine, agent loop
├── agents/               # LEGACY Python reference: agent definitions
├── tools/                # LEGACY Python reference: tool implementations
├── policies/             # LEGACY Python reference: YAML rule files
├── config/               # LEGACY Python reference: settings.yaml
├── main.py               # LEGACY Python reference: CLI entry point
└── SUMMARY.md            # This document
```

### Key Files

- **`README.md`** — High‑level overview, architecture diagram, quick‑start guide.
- **`AGENTS.md`** — Operating rules, plugin guidelines, and best practices.
- **`DECISIONS.md`** — Canonical design decisions (OmniRoute canonical, D‑001 migration gated, D‑002 key risk accepted, etc.).
- **`docs/REFSPEC_GUARD_SPEC.md`** — PROPOSED fix spec for the `+refspec` force-push gap in `DESTRUCTIVE_PATTERNS`. Proposes an anchor, a measured behavior matrix, an implementer protocol, and a rollback. Implements nothing (D‑013).
- **`platform/core/`** — The heart of the platform: `planner.ts`, `validation.ts`, `tool-registry.ts`, `redaction.ts`, `workspace.ts`, `skill-catalog.ts`.
- **`platform/pi/`** — Kernel adapter, lifecycle, policy port, trusted execution, and tool adapters.
- **`skills/file-analysis/SKILL.md`** — Initial proof‑of‑concept skill: uses Pi's built‑in `read`, `bash`, `grep`, `find`, `ls` to inspect files, identify defects, and produce evidence‑based reports.

## 4. Skills

| Skill | Description | Status |
|-------|-------------|--------|
| **file-analysis** | Inspect and analyze local files; identify defects, credentials, malformed content; produce markdown reports. | ✅ Active (initial PoC) |
| **log-analysis** | Diagnose log files — format, timestamps, error bursts, correlation, sample extraction. | ✅ Ready |
| **report-writer** | Persist analysis findings into structured Markdown reports. | ✅ Ready |
| **structured-data** | Answer questions about CSV/JSON/structured data — schema inference, quality checks, anomaly detection. | ✅ Ready |

All skills follow the pattern: a `SKILL.md` with frontmatter (name, description, purpose, inputs/outputs, tools, workflow) and are registered through Pi's skill discovery.

## 5. Configuration & Deployment

- **LLM Backend:** `OmniRoute` (default) via `~/.pi/agent/models.json` with `omni` provider at `http://localhost:20128`.
- **Workspace Isolation:** the project config sets `allowedRoots` to the **project root**, so agents may write anywhere inside the repository and writes outside it are denied with a reason. (`workspace/**` is not the boundary; `workspace/head-baseline` inside it is a linked worktree, not a write target.)
- **Policy Mode:** `TRUSTED_PROJECT` — dangerous operations are denied outright (fail‑closed), not prompted for approval.
- **Max File Writes per Task:** **10** in the committed policy. The temporary Verification Gauntlet bump to 50 (D-006) was reverted under D-007; an operator selects a `limitProfiles` override for a run instead of editing the policy file.
- **Provider Setup:** `omniroute-pi-ext-integration` extension handles provider metadata; Pi owns the model call chain.

## 6. Verification & Testing

- **Platform .mjs suites:** 22/22 pass.
- **Core and Pi TypeScript suites:** 292/292 pass.
- **F-006 live recovery proof:** 21 checks, 0 failed. Headless and self-contained, so it runs unchanged on a CI runner.
- **Canonical total: 314 tests**, up from the 253-era baseline as F-003, F-006 Phase 1, F-007, F-008 and the PR #4 hardening landed.
- **CI:** `ci.yml` runs all three commands above on every pull request and on push to `main`. The step labels carry the test counts as of when they were written and are cosmetic; the job's verdict comes from each command's exit code.
- **Verification Gauntlet (Phases A–H):** All passed — coverage includes cross‑skill chained analysis, parallel multi‑file analysis, structured‑data audits, policy bypass protection, prompt‑injection defense, skill conformance, artifact integrity, and resiliency/error recovery.
- **Gauntlet Report:** `reports/REPORT.md` confirms **READY FOR PHASE 2** with operational hardening recommendations.

## 7. Roadmap

The gauntlet-era items below are closed or superseded; current open work is
tracked against the findings. The write-budget item is addressed by D-007
(`limitProfiles`), not by a global raise.

1. **F-006 Phase 2** — real retryability propagation from Pi errors, and strategy-change-aware recovery. Not started; not claimed as done.
2. **Declared-but-unenforced `CoreLimits`** — eight limits in `DEFAULT_LIMITS` are documented but read by no enforcement path.
3. **APPROVAL-mode policy composition** — `ConfiguredPolicy` is composed in front of the tier policy; the APPROVAL-mode path is less exercised than TRUSTED_PROJECT.
4. **Model routing across backends** — D-001 Gate 2, fallback provider removal, remains pending.

The longer-horizon items in `docs/handoff.md` §4 (MCP connectors, a persistent
memory store, optional human-approval gates) are unchanged and remain deferred.

## 8. Key Takeaways

- The platform is **fully tested** (314 tests pass) and **verified** (gauntlet A–H all PASSED).
- **OmniRoute** is the sole production‑ready model provider; fallbacks are documented escape hatches.
- **Pi** is the central runtime — the orchestrator is a thin extension that never makes model calls directly.
- The **file‑analysis skill** is the first proof‑of‑concept and demonstrates the bounded‑inspection philosophy (read only, no full‑file loading).
- The project follows a **strict security posture**: fail‑closed on policy violations, redaction at every boundary, and workspace isolation.
- The next steps are the **F-006 Phase 2 recovery work** and the unenforced-limit backlog, and optionally migrating the **OmniRoute credential** from `models.json` to Pi's credential store (currently an accepted risk).

---

*Summary last synchronized 2026-09-28, against `main` at `4bca4f2` (PR #21 merged). Test counts reflect the verified 314 unit/integration baseline plus 21 separately-counted live-proof checks, re-measured locally on that anchor.*
