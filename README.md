# Agent Harness and Pi Analysis Platform

A personal, local agent platform built on Pi. Pi is the underlying agent runtime; this project adds a domain-agnostic orchestration layer, reusable skills, and controlled tool integration around it.

The single active implementation is the TypeScript platform under `platform/`, driven by the Pi extension. The older Python sample harness that once lived alongside it has been removed (see `verification/findings/F-002-dual-policy-engines.md`); there is no second engine and no Python in the execution path.

## What We Are Building

The platform will support reusable analysis and automation skills over controlled tools for files, logs, structured data, databases, APIs, Splunk, research, and future MCP integrations. This first phase establishes the foundation and proves the pattern with one file-analysis skill.

## Architecture

```text
User
  -> Pi agent runtime
     -> platform-orchestrator extension
        -> native Pi skill discovery
        -> relevant SKILL.md
        -> Pi built-in or registered tools
        -> validation and final response
     -> model provider
        -> OmniRoute or another compatible provider
```

Pi owns the agent loop, context, sessions, model calls, tool calling, retries, and provider streaming. The orchestrator is intentionally thin: it provides generic workflow guidance, project skill discovery, execution traces, and a conservative permission gate. It does not hard-code business domains or create a second agent framework.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for boundaries, security, memory, observability, and future extension points.

## Skills

Skills are reusable procedures in `skills/<name>/SKILL.md`. Pi advertises each skill's name and description, then loads the full instructions when a task matches. Skills describe reasoning and workflow; tools perform deterministic operations.

The initial proof-of-concept skill is [skills/file-analysis/SKILL.md](skills/file-analysis/SKILL.md). It uses Pi's built-in filesystem and search tools and does not implement a separate runtime.

To add a skill:

1. Create `skills/<name>/SKILL.md`.
2. Follow [docs/SKILL_SPEC.md](docs/SKILL_SPEC.md).
3. Include routing metadata, purpose, boundaries, inputs, outputs, tools, workflow, constraints, and an example.
4. Run the project tests and verify the skill appears in Pi's discovery.

The extension advertises the project `skills/` directory to Pi and validates the catalog for the `/platform` command. Pi remains the native source of truth for skill discovery and loading.

## Running Pi

From this repository, start Pi with project trust enabled:

```bash
pi --approve
```

The project configuration is in `.pi/settings.json`, the Neurofebric trust model is in `.pi/neurofebric.json`, and the orchestrator extension is in `.pi/extensions/platform-orchestrator.ts`. After changing Pi resources, use `/reload` or restart Pi.

This project runs with `"policyMode": "TRUSTED_PROJECT"`, so ordinary development tool calls — `read`, `bash`, `write`, `edit`, `grep`, `find`, `ls` inside the project — execute without a confirmation prompt. Destructive commands, credential access, and paths outside the project root are denied outright. See [docs/SECURITY.md](docs/SECURITY.md#trust-models). Set `"policyMode": "APPROVAL"` to restore per-operation confirmation.

Project trust is separate and unrelated: it only controls whether project resources load, and is already saved for this directory in `~/.pi/agent/trust.json`, so startup does not prompt.

Use the command below to inspect the loaded platform resources, the active policy mode, and recent trace:

```text
/platform
```

## Running Tests

The first-phase registry tests use Node's built-in test runner:

```bash
node --test platform/*.test.mjs
node --experimental-strip-types --test platform/core/*.test.ts
node --experimental-strip-types --test platform/pi/*.test.ts
```

The policy and trust-boundary suites are `platform/core/policy.test.ts` (boundary resolution, traversal, symlinks, destructive and secret denial) and `platform/pi/trusted-execution.test.ts` (multi-tool execution with no approval prompt, plus denial enforcement).

The first live kernel path is covered by `platform/pi/kernel-adapter.test.ts` and the domain-neutral smoke test `platform/pi/smoke.test.ts`. The smoke test exercises task creation, planning, plan validation, policy approval, execution observation, validation, provenance, and completion without a real model or credentials.

## Python Sample Harness (removed)

The older Python implementation — its CLI entry point, agent runner, LLM
client, policy engine, agents, and file tools — has been **deleted from this
repository**. It is not present, not loaded by Pi, and not part of any build or
test path. `platform/` (TypeScript) is the single active implementation.

One artefact is retained deliberately: `policies/default_policy.yaml` is the
provenance record of where the kernel's declarative rules were ported from. No
runtime reads it. See [docs/POLICY_PORT.md](docs/POLICY_PORT.md) and
[verification/findings/F-002-dual-policy-engines.md](verification/findings/F-002-dual-policy-engines.md).

## Configuration

Pi user configuration is stored under `~/.pi/agent`. Project configuration is stored under `.pi`. Keep credentials in environment variables or Pi's credential store, never in skills, source files, or traces.

## Model provider

**OmniRoute is the one canonical model provider for this project.** Pi reaches it
through the `omni` provider declared in `~/.pi/agent/models.json` and served by the
`omniroute-pi-ext-integration` extension, at `http://localhost:20128`. Start the
gateway with `omniroute` and leave it running before using Pi:

```powershell
omniroute
```

The platform orchestrator never makes a model call. Pi owns the agent loop and the
model call; the orchestrator observes lifecycle events and gates tools. See
[docs/PI_INTEGRATION.md](docs/PI_INTEGRATION.md).

> **Non-default fallback (not canonical).** `pi-free` and `@billjr99/pi-openai-compat`
> are installed and register ~25 further third-party providers of their own
> (`cline`, `llm7`, `zenmux`, `groq`, `kilo`, …). They exist only as an escape hatch
> for a gateway-down run. They are **off by default** and are not the supported path:
> using them sends model traffic to third-party endpoints rather than through the local
> gateway. An audit found recent sessions taking the `cline` path while the docs
> claimed OmniRoute, which is why the fallback is now explicitly demoted. See
> [docs/DECISIONS.md](docs/DECISIONS.md) (D-001) for the evidence, the decision, the
> exact migration commands, and how to verify a call went through OmniRoute.

Credentials belong in Pi's credential store or an environment variable, never in
`.pi/`, never in `~/.pi/agent/models.json`, and never in a skill, source file, or
trace.

## Folder layout

```
agent-harness/
  platform/            the Neurofebric implementation (TypeScript)
    core/              policy, boundary, artifacts, recovery, redaction
    pi/                Pi kernel adapter, tool descriptors, vault tools
  .pi/                 project config, policy, and the orchestrator extension
  skills/              reusable SKILL.md procedures
  docs/                architecture, security, policy port, handoff
  verification/        findings, live proofs, gauntlet scenarios
  policies/            historical provenance for the TypeScript policy port
  tests/fixtures/      test fixtures consumed by the TypeScript suites
  reports/             gauntlet output
  memory/              project-memory notes
```

## 1. Requirements

- Node.js 22 or newer. The project has **no runtime dependencies** and no
  install step; the suites run on bare node.
- A model provider. See the backend options below.

## 2. Run the test suites

The same three commands CI runs:

```bash
node --test platform/*.test.mjs
node --experimental-strip-types --test platform/core/*.test.ts platform/pi/*.test.ts
node --experimental-strip-types verification/live-f006-proof.mjs
```

## 3. Set up a model provider

Pi owns the model call. The provider is configured in Pi, not in this
repository — credentials belong in Pi's credential store or an
environment variable, never in a file in this project.

### OmniRoute (default)

OmniRoute is a self-hosted gateway that gives you access to 200+ LLM
providers — many with free tiers — through one local endpoint. This
is the default backend so you're not limited to whatever model your
laptop can run.

1. Install Node.js (needed to run OmniRoute) from
   https://nodejs.org if you don't already have it.
2. In PowerShell:
   ```powershell
   npm install -g omniroute
   omniroute
   ```
   This starts the gateway at `http://localhost:20128`. Leave this
   terminal window open/running while you use the harness.
3. Open the OmniRoute dashboard it prints on startup to connect
   free-tier providers (it walks you through this).

### Alternative backends

**Ollama** — fully local, no gateway, no internet needed once the
model is downloaded:
1. Download from https://ollama.com/download, install, then:
   ```powershell
   ollama pull llama3.1:8b
   ```
   (needs ~8GB free RAM; use `llama3.2:3b` on tighter laptops)
2. Configure Pi to use it (see Pi's own model configuration)

**Anthropic API** — direct to Claude, has a per-token cost:
1. Get a key from console.anthropic.com
2. In PowerShell: `setx ANTHROPIC_API_KEY "sk-ant-..."` then restart
   the terminal
3. Configure Pi to use it

## 4. Run it

Start Pi from this repository with project trust enabled:

```bash
pi --approve
```

See [Running Pi](#running-pi) above for the policy modes and the
`/platform` inspection command.

## 5. Tightening or changing the security layer

Edit `.pi/neurofebric-policy.json`:
- `deniedTools` / `allowedTools` — what the agent can call at all
- `fileRules` — ordered, first match wins; a `**` catch-all means
  "somewhere inside an allowed root"
- `destructiveCommandPatterns` / `destructiveCommandTokens` — refuse
  state-destroying commands
- `secretWritePatterns` — block writes carrying certain strings
- `limits` — `maxToolCallsPerTask`, `maxFileWritesPerTask`,
  `maxBytesPerWrite`
- `onViolation` — `block` (the call is refused, the task continues) or
  `abort` (the whole run stops)

The loader fails loudly at startup on a malformed policy file, and
ignores unrecognised top-level keys. `policies/default_policy.yaml` is
kept only as the historical provenance of this port; it is not read at
runtime. See [docs/POLICY_PORT.md](docs/POLICY_PORT.md).

## 6. Adding a new skill

Skills are data, not code — see [Skills](#skills) above and
[docs/SKILL_SPEC.md](docs/SKILL_SPEC.md). No agent or tool registration
step is involved.

## Dependency status

The platform has no external runtime dependencies and no network calls
of its own. Model access is entirely Pi's concern.

OmniRoute/ is a local-only checkout and is not part of this repository.
