# ADR-007 — TELEMETRY NAMESPACES: `gen_ai.*` for agents, `neurofebric.*` for breaches

- **Status:** **PREPARATION ONLY. NOTHING IN THIS DOCUMENT IS BUILT.**
- **Date:** 2026-10-04
- **Ratified by:** — *nothing here has been built. There is no OpenTelemetry
  dependency, no SDK, no exporter and no instrumentation. This document fixes
  which namespace owns which signal, before anything emits one.*
- **Relates to:** ADR-001 (minimalism as the audit trail — zero runtime
  dependencies), ADR-003 (live semantics), ADR-005 (memory, the two-truths
  contract), ADR-006 §7 (D-017, vault stays dark), MR !112

> **Read-before-build gate: OPEN.** Per Project Law 1, nothing in §4 or §5 may
> be instrumented before ratification. What remains open is named per section in
> §8 rather than left to be discovered.

---

## 1. Context — why a namespace decision is needed at all

MR !112 pivots Neurofebric toward an agentic control plane, and a control plane
is judged on its telemetry. So the question of *which attribute vocabulary this
platform emits* stops being hypothetical.

The temptation is to reach for the OpenTelemetry **GenAI semantic conventions**
(`gen_ai.*`) for everything, because they are the most widely adopted convention
for "AI system telemetry" and because a reader who has seen one OTel
instrumentation will recognise the names immediately.

That would be wrong, and it would be wrong in a way that is expensive to undo
once a dashboard depends on it. This ADR records the split **before** the first
signal ships, because a namespace that has been read once is very hard to
renumber.

### 1.1 Two kinds of telemetry, and they are not related

Neurofebric emits two structurally unrelated things:

| | **Agent/model telemetry** | **Stream telemetry** |
|---|---|---|
| What happened | a model was invoked, a tool ran, an agent was planned | a partition's `elapsed_time` went past its quartile fence |
| Produced by | `Conductor`, `DynamicAgentRegistry`, agent execution | `stream-broker.ts`, `live-anomaly.ts` |
| Unit | one operation, one span | a window over many records |
| The interesting question | which model, which agent, which conversation | how far past the fence, on which column |
| Natural OTel home | `gen_ai.*` spans and metrics | **nothing standard** |

The second column's last row is the whole ADR. OpenTelemetry has no convention
for statistical outlier detection over an inbound business event stream, and it
is not missing one by accident — there is no shared vocabulary to standardise,
because the thresholds are tenant configuration and every platform that does this
invented its own.

### 1.2 What `gen_ai.*` actually describes

The GenAI conventions live in their own repository,
[`open-telemetry/semantic-conventions-genai`](https://github.com/open-telemetry/semantic-conventions-genai),
split out from the main `semantic-conventions` repo. They cover:

- **Generative client spans** — `chat`, `generate_content`, `text_completion`,
  `embeddings`, with `gen_ai.request.model`, `gen_ai.response.id`,
  `gen_ai.response.finish_reasons`, `gen_ai.input.messages`,
  `gen_ai.output.messages`.
- **Agent and framework spans** — `invoke_agent`, `create_agent`, `execute_tool`,
  `plan`, `invoke_workflow`, with `gen_ai.agent.id` / `.name` / `.version`,
  `gen_ai.conversation.id`, `gen_ai.system_instructions`,
  `gen_ai.tool.definitions`.
- **Memory and retrieval** — `create_memory`, `search_memory`,
  `upsert_memory`, `retrieval`, with `gen_ai.data_source.id`.
- **MCP** — its own `mcp.*` namespace.

Span naming is specified too: `{gen_ai.operation.name} {gen_ai.request.model}`
for generative client spans, `invoke_agent {gen_ai.agent.name}` for agent
invocation.

Every one of those is a description of **a model call or an agent step**. None of
them is a description of a data point in somebody's telemetry.

---

## 2. The decision

1. **`gen_ai.*` is adopted for agent/model telemetry only.** When Neurofebric
   invokes a model, plans, runs a tool, or manages agent memory, it emits
   `gen_ai.*` attributes and does not invent names for them.
2. **Stream telemetry uses a `neurofebric.*` namespace.** Breach detection,
   window statistics and throughput are our own vocabulary, under our own prefix.
3. **The two never share a span, a metric, or an attribute.** A dashboard reads
   them side by side; a query does not join them.

### 2.1 The category error, stated plainly

`gen_ai.input.messages` is specified as a **chat history** conforming to a JSON
schema: an array of messages, each with a `role`, typed `parts`, and — for
tool calls — a call id, a function name and arguments.

A breach is not that. A breach is:

```
partition "app.log"  column "elapsed_time"  measured 401
q1 1005   q3 1090   iqr 85
extremeUpper 1345   observed 999999   breached
```

There is no honest way to render that as a chat message. The available bad
options are all worse than having no convention:

- encode the fence statistics as a `tool_call_response` part, which is a **lie
  about what happened** and would be read by an agent as if a tool had returned
  it;
- stuff the numbers into a string attribute and lose the types, so a backend
  cannot aggregate and a reader cannot trust it;
- invent a `gen_ai.` prefix that does not exist in the registry, which makes the
  namespace lie about what it contains and breaks any collector validating
  against the registry.

The first is the dangerous one. A downstream agent reading telemetry is
indistinguishable from an agent reading a tool result, and a fabricated tool
result in a monitoring surface is exactly the sort of thing this platform's
whole ADR history exists to prevent. ADR-001 made minimalism the audit trail:
every capability is a line you can read. A fabricated `tool_call_response` is a
capability nobody declared.

### 2.2 The `provider` collision

This one is a trap rather than an abstraction.

Throughout this codebase **`provider` means a telemetry source**: `pega`,
`webhook`, `app.log`. It is the ingest door, set at boot, and it is what the
tenant boundary is keyed on.

In `gen_ai.*`, **`gen_ai.provider.name` means an AI vendor**: `openai`,
`anthropic`, `aws.bedrock`, `gcp.vertex_ai`, `mistral_ai`, and so on. The
convention document describes it as a *discriminator identifying the telemetry
format flavour for that provider*.

So the same identifier would mean "which AI vendor answered" in one namespace and
"which upstream system sent these events" in the other, and both are named
`provider`. Mapping `alert.provider` onto `gen_ai.provider.name` would put
`"pega"` into a field whose entire job is to say which model vendor served the
request. Nothing would break loudly; a backend would simply report every
Neurofebric span as an unknown-vendor span, forever.

**Rule: `neurofebric.telemetry.source` names the ingest door. It is never
`gen_ai.provider.name`.**

---

## 3. Mapping

### 3.1 Agent/model telemetry → `gen_ai.*`

| Neurofebric | Attribute | Notes |
|---|---|---|
| agent invoked | `gen_ai.operation.name = "invoke_agent"` | Conductor run |
| agent created / installed | `gen_ai.operation.name = "create_agent"` | schema registration |
| planning / decomposition | `gen_ai.operation.name = "plan"` | |
| tool execution | `gen_ai.operation.name = "execute_tool"` | |
| durable record write | `gen_ai.operation.name = "upsert_memory"`, `create_memory_store` | ADR-005 |
| session / conversation | `gen_ai.conversation.id` | the session store id |
| agent identity | `gen_ai.agent.id`, `.name`, `.version` | schema id and version |
| Conductor run | `gen_ai.input.messages`, `gen_ai.output.messages` | **Opt-In**; may carry tenant data |
| tool inventory | `gen_ai.tool.definitions` | **Opt-In** |

The Opt-In attributes are the sensitive ones. `gen_ai.input.messages` and
`gen_ai.output.messages` carry conversation content, which in this platform may
be tenant data and may, if D-017 is ever revisited, be credential-adjacent. They
are Opt-In in the convention and they must stay **off by default** here — a
telemetry backend is a third party, and ADR-005's two-truths contract plus D-017
both point the same way. This is listed as open work in §8.1 rather than
decided here, because deciding it silently would be the mistake this ADR is
about.

### 3.2 Stream telemetry → `neurofebric.*`

| Signal | Proposed name | Type | Source |
|---|---|---|---|
| ingest door | `neurofebric.telemetry.source` | attribute | `alert.provider` |
| window records | `neurofebric.window.records` | attribute | `LiveVerdict.records` |
| column measured | `neurofebric.window.column` | attribute | `LiveColumnStanding.column` |
| lower fence | `neurofebric.fence.lower` | attribute | `fenceLower` |
| upper fence | `neurofebric.fence.upper` | attribute | `fenceUpper` |
| observed extreme | `neurofebric.fence.extreme` | attribute | `extremeLower` / `extremeUpper` |
| how far past | `neurofebric.breach.multiple` | attribute | `extremeMultiple` |
| breached | `neurofebric.breach.active` | attribute | `breached` |
| quantiles sampled | `neurofebric.window.quantiles_sampled` | attribute | `quantilesSampled` |
| records per window | `neurofebric.throughput.rate` | metric | the per-router meter |
| loop ticks | `neurofebric.evaluation.ticks` | metric | `EvaluationScheduler.stats()` |
| loop failures | `neurofebric.evaluation.failures` | metric | `EvaluationScheduler.stats()` |
| refused decisions | `neurofebric.evaluation.refused` | metric | `refusedDecisions()` |

Two of these are load-bearing beyond telemetry. `evaluation.ticks` and
`evaluation.failures` come straight from MR !112's scheduler, and they exist
because **a monitor that is silently dead looks exactly like a healthy one**.
A deployment reporting zero breaches with a flat tick count is reporting a
broken instrument, and the number that says so must be on the same dashboard.

The metric names above are **proposals**. They are not a registry, they are not
ratified, and no collector reads them yet.

---

## 4. What this ADR does NOT authorise

- **No OpenTelemetry dependency.** ADR-001 and `package.json` hold
  `dependencies` absent. `gen_ai.*` is a set of *names*; emitting them needs no
  SDK. If an exporter is ever wanted, that is its own ADR with its own
  dependency argument.
- **No instrumentation of the breach path.** `neurofebric.*` names what a
  future collector would carry. Nothing emits them yet.
- **No migration of the durable record.** ADR-005's SQLite record stays
  SQLite. The record is the product's memory; it is not a telemetry backend and
  is not being replaced by one.
- **No change to the SSE frame.** `frame(id, event, data)` stays as it is. It is
  a live notification to a connected browser, and a notification is not a metric.
- **No vault work.** D-017 keeps the vault unwired. Telemetry carries tenant
  identifiers and nothing else; no credential, token or secret is emitted by
  anything described here.

---

## 5. The stability caveat, which is the real reason this is preparation only

**Every attribute in the `gen_ai.*` namespace is at `Development` stability.**
That is stated in the registry for `gen_ai.provider.name`, `gen_ai.operation.name`,
`gen_ai.agent.*`, `gen_ai.conversation.id`, `gen_ai.input.messages`,
`gen_ai.output.messages`, `gen_ai.tool.definitions` and the rest. Only the
general-purpose attributes such as `server.address` and `server.port` are
`Stable`.

Development stability means the names and values may change without a
deprecation window. Concretely: `gen_ai.provider.name` already **replaced**
`gen_ai.system`, and `text_completion` is already marked Legacy.

So this ADR adopts `gen_ai.*` **knowing the vocabulary is still moving**, and it
therefore commits to the *decision* rather than to a frozen copy of the names:

1. Instrumentation targets the `gen_ai.*` namespace, never a private
   reimplementation of it.
2. The registry version in use is pinned and recorded, so a rename is detected
   rather than discovered in a dashboard.
3. `neurofebric.*` names carry no such dependency, because they were never
   standard. They are ours, and we can version them.

This is the strongest argument for doing the split *now*, while the numbers are
still cheap to change.

---

## 6. Consequences

**Good.**

- A reader who knows OTel can read the agent half without a glossary, and the
  breach half cannot be misread as model telemetry by anyone, including an agent.
- The backend can aggregate both without a custom parser per signal.
- No fabricated tool results, and no ingest door masquerading as an AI vendor.
- A rename in `gen_ai.*` is a version bump, not a data migration.

**Bad, and honestly so.**

- Two namespaces means two things to learn. The mitigation is that the split
  follows a real distinction — a model call versus a statistic — not an
  arbitrary one, and it is visible on the face of every payload.
- `neurofebric.*` is a private namespace, so this platform carries the cost of
  naming its own telemetry. Accepted: there is no standard to adopt.
- The `provider` collision (§2.2) will be attempted by someone who has not read
  this. It is called out here precisely because it is the obvious mistake.

---

## 7. Alternatives considered

1. **`gen_ai.*` for everything.** Rejected. §2.1 — the category error, with a
   fabricated tool result as the worst case.
2. **A private namespace for everything, ignoring OTel.** Rejected. It throws
   away the agent half, which *is* standard, and it is the half where a shared
   vocabulary genuinely exists.
3. **`mcp.*` rather than `gen_ai.*` for agent spans.** Rejected as premature.
   Correct for the Embassy MCP surface if and when it is built (ADR-006), wrong
   for the in-process Conductor, which is not an MCP client.
4. **Emit nothing until the conventions reach `Stable`.** Rejected. The split is
   what makes adoption safe, so waiting for stability buys nothing and costs the
   chance to fix names while they are cheap.
5. **Adopt `gen_ai.*` and alias the breach payload onto `gen_ai.output.messages`
   to avoid a second namespace.** Rejected outright. This is §2.1's worst
   option with the reasoning removed.

---

## 8. Open — and it stays open until ratified

### 8.1 Opt-In content attributes

Whether `gen_ai.input.messages` / `gen_ai.output.messages` may ever be emitted
with real conversation content, given tenant data and D-017, is **not decided
here**. Default is off. Any future change needs its own decision with the tenant
and credential consequences named.

### 8.2 Metric versus attribute

Whether the breach signals are attributes on a span or first-class metrics is
**not decided here**. §3.2 lists names, not a signal shape. Counters and gauges
want different shapes from the same reading, and this ADR does not pretend to
have thought that through.

### 8.3 Registry pinning

Where the pinned `gen_ai.*` registry version is recorded, and what checks it
against upstream, is **not decided here**.

### 8.4 Naming the breach signals

`neurofebric.*` in §3.2 is a proposal for review, not a ratified registry. The
particular names are cheap to change now and expensive after a dashboard exists.

---

## 9. Traceability

| Obligation | Where it comes from |
|---|---|
| Zero runtime dependencies | ADR-001, `package.json` has no `dependencies` |
| No fabricated capability in a surface | ADR-001 (minimalism as the audit trail) |
| Ingest door is never an AI vendor | §2.2, `LiveGateway.connected(provider)` |
| Record is not a telemetry backend | ADR-005 §9 (two truths) |
| Opt-In content stays off | §4, D-017 |
| Vault stays dark | D-017 |
| Evaluation loop is observable | MR !112, `EvaluationScheduler.stats()` |
| Names are pinned because they move | §5, `gen_ai.provider.name` replaced `gen_ai.system` |

**Sources for the `gen_ai.*` facts in §1.2 and §5:**

- <https://github.com/open-telemetry/semantic-conventions-genai>
- <https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md>
- <https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/registry/attributes/gen-ai.md>