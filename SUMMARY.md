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

## 3. Current State

### Code Health
- **All tests pass: 284 total.**
  - `node --test platform/*.test.mjs` — **22/22**
  - `node --experimental-strip-types --test platform/core/*.test.ts platform/pi/*.test.ts` — **262/262**
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
- **Core and Pi TypeScript suites:** 262/262 pass.
- **F-006 live recovery proof:** 21 checks, 0 failed. Headless and self-contained, so it runs unchanged on a CI runner.
- **Canonical total: 284 tests**, up from the 253-era baseline as F-003, F-006 Phase 1, F-007, F-008 and the PR #4 hardening landed.
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

- The platform is **fully tested** (284 tests pass) and **verified** (gauntlet A–H all PASSED).
- **OmniRoute** is the sole production‑ready model provider; fallbacks are documented escape hatches.
- **Pi** is the central runtime — the orchestrator is a thin extension that never makes model calls directly.
- The **file‑analysis skill** is the first proof‑of‑concept and demonstrates the bounded‑inspection philosophy (read only, no full‑file loading).
- The project follows a **strict security posture**: fail‑closed on policy violations, redaction at every boundary, and workspace isolation.
- The next steps are the **F-006 Phase 2 recovery work** and the unenforced-limit backlog, and optionally migrating the **OmniRoute credential** from `models.json` to Pi's credential store (currently an accepted risk).

---

*Summary last synchronized 2026-09-27, against `main` after PR #5. Test counts reflect the verified 284 unit/integration baseline plus 21 separately-counted live-proof checks.*
