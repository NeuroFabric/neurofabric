# Platform Architecture

## Scope

This project is a general-purpose analysis and automation platform built on Pi. Pi is the agent runtime and harness. The platform adds a domain-agnostic orchestration layer, reusable skills, controlled tools, memory conventions, and connector boundaries around Pi.

The existing Python harness remains a separate legacy/reference implementation for now. It is not embedded in the Pi runtime and will not be duplicated in the orchestrator.

The first live adapter is in `platform/pi/kernel-adapter.ts`. It observes Pi lifecycle events, maps Pi tool metadata into the kernel registry, creates tasks, validates one-step plans derived from model-requested tool calls, gates tools through policy, validates Pi results, and persists structured trace events. See [PI_INTEGRATION.md](PI_INTEGRATION.md).

## Runtime Boundaries

```text
User
  -> Pi agent runtime
     -> platform-orchestrator extension
        -> native Pi skill discovery
        -> selected skill instructions
        -> Pi built-in or registered tools
        -> validation and final response
     -> model provider
        -> OmniRoute or another compatible provider
```

Pi owns the model conversation, tool calling, context compaction, sessions, retries, provider streaming, and tool execution. The platform extension does not implement another agent loop.

## Components

### Agent runtime

Pi provides the agent loop, model calls, tool calls, context management, session persistence, and automatic retries. Platform code must integrate through Pi extensions, skills, configuration, and tools.

### Orchestrator

The orchestrator is a thin Pi extension. It supplies generic workflow guidance, discovers project skills through Pi's resource discovery event, records execution metadata, and applies a small permission gate for destructive shell commands.

The model performs intent understanding, planning, skill selection, tool selection, reasoning, and follow-up. The orchestrator contains no business-domain branches and does not route requests with hard-coded skill names.

### Skills

Skills are declarative procedures. Each skill is a directory containing `SKILL.md` with frontmatter and focused instructions. Pi advertises skill names and descriptions, then loads full instructions only when relevant.

The initial project skill is `file-analysis`. It uses Pi's existing `read`, `bash`, `grep`, `find`, and `ls` tools.

### Tools

Tools are deterministic operations with explicit schemas. Pi built-in tools are preferred for filesystem, shell, and search operations. Future project tools should be registered through `pi.registerTool()` and should:

- validate inputs;
- return bounded results;
- declare required permissions;
- avoid embedding policy checks in business logic;
- emit useful error messages without leaking secrets.

A skill describes when and why to use a tool. A tool performs the operation.

### Memory and context

- **Session context:** Pi's current conversation, tool results, and compaction state.
- **Project memory:** `AGENTS.md`, architecture notes, decisions, and conventions in the project.
- **Long-term memory:** a future external store, initially likely SQLite. A vector database is not introduced without a demonstrated semantic-retrieval requirement.

### Model/provider layer

**OmniRoute is the one canonical provider path.** Pi's `models.json` declares a
single provider, `omni`, at `http://localhost:20128`, with the
`omniroute-pi-ext-integration` extension supplying provider metadata. A provider
extension is reserved for authentication, streaming, or discovery that the
supported Pi provider APIs cannot represent. The orchestrator must not depend on
a particular model ID, must not call a provider directly, and must not register
one.

**Non-default fallback.** `@billjr99/pi-openai-compat` is installed and
registers providers at its own third-party endpoints. It is a documented
escape hatch for a gateway-down run and is **off by default**; it is not a
supported path and not part of this architecture. Enabling one is an explicit
operator choice with an egress consequence, and it does not require any change
to platform code. See [DECISIONS.md](DECISIONS.md) (D-001).

The `pi-free` provider family, which D-001 found installed twice
(`npm:pi-free` and `git:github.com/apmantza/pi-free`) and which registered ~25
further third-party providers, **has been uninstalled and is no longer
present**. It was the path recent sessions were actually taking when D-001 was
written, so closing it is what makes "one canonical provider path" a statement
about the running system rather than only about the configuration file.

Provider choice is therefore a *configuration* concern, held entirely outside
the platform layer. Nothing in `platform/` or `.pi/extensions/` may read, set,
or infer a provider.

### Data-source integrations

Future connectors are isolated behind tools or MCP servers: files, databases, log systems, Splunk, APIs, and other services. A connector exposes narrow, typed operations and declares its permission level. Domain-specific workflows belong in skills, not in the orchestrator.

### Configuration

Pi user configuration lives under `~/.pi/agent`. Project configuration lives under `.pi`. Project resources may be loaded only after project trust is granted. Secrets belong in environment variables or Pi's credential store, never in skills or source control.

### Security and permissions

Permission levels are assigned to tool capabilities:

- **Read:** file reads, metadata inspection, database reads, and log search.
- **Controlled:** shell, Python, SQL, and other execution tools; require policy checks and bounded inputs.
- **Write:** file changes, database mutations, and external API mutations; require explicit policy or human approval.

Pi's project trust is not an operating-system sandbox. The extension therefore uses a conservative destructive-command gate by default, and future deployments should add OS-level isolation, path allowlists, secret isolation, and approval workflows.

### Observability

The extension records a bounded execution trace with task metadata, discovered skill names, tool activity, and lifecycle state. It must never record credentials or complete sensitive payloads. The trace is intended to answer why a skill or tool was selected and where execution stopped.

### Error handling

Errors are surfaced as tool failures or bounded orchestrator events. The runtime must distinguish policy denial, invalid input, unavailable provider, tool failure, and user cancellation. It should preserve the original cause in internal diagnostics while returning sanitized context to the model.

## Extension Points

| Concern | Pi mechanism |
| --- | --- |
| Agent loop and context | Pi runtime |
| Declarative procedures | `SKILL.md` skills |
| Custom deterministic operations | `pi.registerTool()` |
| Workflow metadata and traces | `before_agent_start`, `agent_end`, `appendEntry()` |
| Permission interception | `tool_call` event |
| Dynamic tool activation | `pi.setActiveTools()` |
| Project resources | `resources_discover` and project settings |
| Provider configuration | `models.json` or a provider extension |
| Human interaction | Pi UI context and command handlers |

## Future Work

The architecture leaves room for parallel plans, replanning, sub-agents, persistent memory, model routing, MCP servers, database and Splunk connectors, and human approval. None of those are implemented in this first phase.
