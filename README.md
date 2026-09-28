# Agent Harness and Pi Analysis Platform

A personal, local agent platform built on Pi. Pi is the underlying agent runtime; this project adds a domain-agnostic orchestration layer, reusable skills, and controlled tool integration around it.

The repository also retains an older Python harness as a separate reference implementation. New general-purpose agent work should use Pi and the project resources under `.pi/` and `skills/`.

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

## Existing Python Harness

The older Python implementation remains available under `core/`, `agents/`, `tools/`, and `policies/`. It has its own JSON action loop, LLM client, and policy engine. It is not loaded by Pi and is not the target of the new orchestrator implementation.

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
  core/               harness internals (LLM client, policy engine, agent loop)
  agents/             agent definitions (e.g. deep_research_agent.py)
  tools/              tool implementations agents can call
  policies/           YAML rule files — the security layer
  config/             settings.yaml — pick your LLM backend here
  workspace/          sandbox — the ONLY folder agents can touch
  main.py             CLI entry point
```

## 1. Install Python (Windows)

1. Download Python 3.11+ from https://python.org/downloads (check
   "Add Python to PATH" during install).
2. Confirm it worked — open **PowerShell** and run:
   ```
   python --version
   ```

## 2. Set up the project

Open PowerShell in this folder and run:

```powershell
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

You'll need to run `venv\Scripts\activate` every time you open a
new terminal to work on this project.

## 3. Set up the LLM backend: OmniRoute (default)

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

`config/settings.yaml` is already set to `llm_backend: omniroute`
with `model: "auto"`, which lets OmniRoute pick a capable free
model automatically. To pin a specific model or preset instead
(e.g. a cost-optimized coding preset), change the `omniroute.model`
value.

### Alternative backends

**Ollama** — fully local, no gateway, no internet needed once the
model is downloaded:
1. Download from https://ollama.com/download, install, then:
   ```powershell
   ollama pull llama3.1:8b
   ```
   (needs ~8GB free RAM; use `llama3.2:3b` on tighter laptops)
2. In `config/settings.yaml`, set `llm_backend: ollama`

**Anthropic API** — direct to Claude, has a per-token cost:
1. Get a key from console.anthropic.com
2. In PowerShell: `setx ANTHROPIC_API_KEY "sk-ant-..."` then restart
   the terminal
3. In `config/settings.yaml`, set `llm_backend: anthropic`

## 4. Run it

A sample document is already in `workspace/sample.txt`. Try:

```powershell
python main.py analyze sample.txt
```

You'll see step-by-step logs of what the agent does (reads the
file, thinks, writes `workspace/report.md`) and which actions, if
any, get blocked by the policy layer. Open
`workspace/report.md` afterward to see the output.

To analyze your own document, drop it into `workspace/` and run:
```powershell
python main.py analyze your-file.txt
```

## 5. Tightening or changing the security layer

Edit `policies/default_policy.yaml`:
- `allowed_tools` / `denied_tools` — what the agent can call at all
- `file_rules` — what paths can be read/written (default: only
  `workspace/**`)
- `denied_content_patterns` — block actions containing certain
  strings (e.g. `rm -rf`, `password`)
- `limits` — rate limits per run
- `on_violation` — `block` (agent gets told no, tries again) or
  `abort` (whole run stops)

Nothing here is agent-specific — the same policy engine governs any
agent you add under `agents/`.

## 6. Adding a new agent

Copy the pattern in `agents/deep_research_agent.py`:
1. Write a system prompt describing the agent's job and the tools
   it should use.
2. Wrap it in a small `run_x(settings, ...)` function that builds
   an `AgentRunner` and calls `.run(task)`.
3. Add a CLI hook in `main.py` if you want to run it directly.

New tools go in `tools/`, then get registered in the `TOOL_IMPL`
dict in `core/agent_runner.py`, and added to `allowed_tools` in the
policy file.

## What's intentionally left as a stub

- `web_search_stub` in `tools/file_tools.py` returns a placeholder.
  Wire up a real (free-tier) search API here when you want live
  search — until then the harness runs with zero external
  dependencies or costs.

OmniRoute/ is a local-only checkout and is not part of this repository.
