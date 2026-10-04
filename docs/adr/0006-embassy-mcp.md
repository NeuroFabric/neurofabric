# ADR-006 — EMBASSY: the Model Context Protocol surface, and what it is allowed to touch

- **Status:** **PROPOSED — awaiting operator ratification. NOT IMPLEMENTED.**
- **Date:** 2026-10-04
- **Ratified by:** — *nothing in this document has been built. No
  `platform/embassy/` directory exists. No tool handler has been written.*
- **Relates to:** ADR-001 (minimalism as the audit trail), ADR-003 (live
  semantics), ADR-005 (memory, the two-truths contract), ADR-006 §7 (D-017,
  vault stays dark), `docs/TOOL_SPEC.md`, `docs/ARCHITECTURE.md` §"future
  connectors"

> **Read-before-build gate: OPEN.** The operator has not yet read and accepted
> this document. Per Project Law 1 and the gate ADR-005 established, nothing in
> §4, §5 or §6 may be implemented before ratification. What is open is named
> per section in §12 rather than left to be discovered.

---

## 1. Context — why an embassy exists at all

Neurofebric is currently reachable by exactly two kinds of caller: a browser
holding a portal token, and an agent running **inside** this process through the
Conductor. Both reach the same `LiveGateway` and the same `DynamicAgentRegistry`,
but they are both *inside the trust perimeter by construction*.

An external AI agent — a Claude, a GPT, a local model driving a terminal — is
neither. It wants to ask "is anything breaching right now?", "install this
schema", "send these events", and it wants to ask from a process we do not
control, in a runtime we do not own, with a lifecycle we cannot observe.

**The embassy is that door, and a door is the single highest-value attack
surface this platform will ever have.** ADR-001 made minimalism the audit
trail: every capability is a line you can read. An embassy that reintroduced a
dependency, a hidden capability, or an authentication shortcut would undo that
for every future reader.

So this ADR is deliberately narrow in what it *proposes* and unusually specific
about what it *refuses*. It is a design, not a build.

### 1.1 The two truths this must not break

ADR-005 §9 established the **two-truths contract**: a recorded value and a live
value never appear in the same surface, and a recorded figure never appears
without its age. An MCP response is a **surface**, and it is read by a language
model rather than by a person — which makes the contract *more* load-bearing
here, not less, because a model given a mixed response will confidently
reconcile it into a wrong sentence.

Second, the **tenant boundary**. `portal-routes.ts` says it in three lines:

```
// THE TENANT IS THE PROVEN TOKEN ID. Nothing in the request chose it, and it
// arrived from the one door rather than from four lines repeated here.
const tenant = proven.tokenId;
```

Every tool below must be built so that sentence is still literally true.

---

## 2. Decision summary

| Question | Decision |
|---|---|
| Transport | **JSON-RPC 2.0 over stdio**, hand-written on `node:readline`. Zero dependencies. |
| Tool surface | **Three tools**: `get_verdict`, `install_schema`, `ingest_events`. |
| Auth | **Per-launch capability token**, minted by the kernel, presented on `initialize`, bound to one tenant. **No token in any tool argument, ever.** |
| Concurrency | **Same process, cooperative.** The gateway calls are already synchronous, so "blocking" cannot block. |
| Dependencies | **None.** `@modelcontextprotocol/sdk` is rejected; §3.3 gives the reasons. |

---

## 3. The Transport

### 3.1 The shape

MCP's stdio transport is **newline-delimited JSON**: one JSON-RPC 2.0 message per
line on `fd 0`, one response per line on `fd 1`.

```
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{…}}\n
{"jsonrpc":"2.0","id":1,"result":{…}}\n
```

This is already in the repository. `platform/ingestion/jsonl-tokenizer.ts:133`
does exactly this with `createInterface({ input: stream, crlfDelay: Infinity })`,
and `log-tokenizer.ts:240` does it for a second format. **The embassy reuses the
existing, tested primitive rather than introducing a second JSON-line reader** —
which is the single strongest argument that the zero-dependency stance costs
almost nothing here.

Node provides: `node:readline` for framing, `node:fs` for the descriptor,
and `JSON.parse` / `JSON.stringify` for the envelope. There is no other moving
part.

### 3.2 What must be handled that a naive reader gets wrong

These are the four things that turn "zero dependencies" into "zero defects", and
each is a place where a hand-rolled implementation is *more* likely to be wrong
than a battle-tested SDK. They are listed as obligations, not as warnings.

1. **Framing by line is only correct while no message contains a raw newline.**
   `JSON.stringify` escapes them, so this holds — **but only if every outbound
   message is produced by `JSON.stringify` and never by hand.** A hand-built
   JSON string containing a literal `\n` inside a message does not split where
   the reader thinks it does, and the reader will silently resynchronise onto
   garbage. The rule is therefore: *no string is concatenated into an outbound
   envelope, ever.*

2. **stdout is the protocol channel, so nothing else may write to it.** One
   stray `console.log` in the embassy corrupts the stream for the host agent, and
   the symptom appears on the *agent's* side as a parse error pointing at our
   code. The embassy therefore must not use `console.log` — and the existing
   codebase already has a structured logger (`platform/pi/`) that must be used
   instead, or `process.stderr`, which is safe.

3. **A partial line at EOF is not a message.** A host that closes the pipe
   mid-write leaves a truncated JSON object. That must be a clean shutdown, not a
   `SyntaxError` on shutdown.

4. **Errors are typed, not thrown.** JSON-RPC distinguishes a *protocol* error
   (unknown method, malformed params → error object, id preserved) from an
   *internal* error (a bug → error object with a generic message). A thrown
   exception that escapes the dispatcher kills the server and takes the host
   agent's connection with it.

### 3.3 Why NOT `@modelcontextprotocol/sdk`

Rejected on three grounds, in order of weight:

1. **It is the only runtime dependency this platform would ever have.** ADR-001's
   minimalism is not asceticism — it is the audit trail. A transitive dependency
   tree in a security boundary is a supply-chain surface that no test in this
   repository can inspect and that no reviewer here can read.

2. **The protocol surface we need is genuinely small.** Three tools, four
   lifecycle methods, one transport. That is a few hundred lines of
   well-specified framing. The SDK's value is breadth — transports, sampling,
   elicitation, resources, prompts — and **none of it is in scope.** Adopting the
   breadth to obtain the narrow core is a poor trade.

3. **It is a moving target.** Protocol revisions would arrive as dependency
   upgrades, and "we upgraded and the agent's view of our tenant boundary
   changed" is not a sentence this project wants to be able to say.

**Recorded, because it is a fair question: `@modelcontextprotocol/sdk` IS a
dependency of the sibling `OmniRoute` project in this workspace.** That project
is untracked by this repository and is a different codebase with a different
posture. It is recorded here so the inconsistency is a decision on the record
rather than something discovered in a review later — the operator may well
decide the two projects should agree, and that is a ruling, not an oversight.

**The honest counter-argument, recorded because it is real:** the SDK encodes
subtleties this ADR has not enumerated, and hand-rolling will eventually miss
one. §3.2 is this document's answer, and §11 proposes a conformance test rather
than pretending the reasoning is exhaustive.

---

## 4. The Tool Surface

### 4.1 The three tools, and why exactly three

| Tool | Effect | Mirrors |
|---|---|---|
| `get_verdict` | **read** | `GET /api/portal/live` |
| `install_schema` | **write** | `POST /api/portal/schema` |
| `ingest_events` | **write** | `POST /api/portal/ingest` |

Each maps **one-to-one onto an existing portal route**. This is the central
constraint of the design: **the embassy adds no capability the portal does not
already have.** If a tool cannot be expressed as a portal call, it does not
belong in the embassy — and the reason is that the portal routes have already
been reviewed for the tenant boundary, and a second code path to the same
capability is a second thing to get wrong.

Note what is **absent**, deliberately:

- **No `ingest_from_file`.** It would accept a path, and a tool-supplied path is
  the class of input the workspace boundary exists to refuse.
- **No `list_agents` / `delete_agent`.** Read-your-own-roster is convenience;
  deletion is irreversible. Neither is required for the agent to be useful.
- **No credential or vault tool.** D-017 keeps the vault unwired, and an embassy
  is not a reason to re-open it.
- **No tool that returns a *raw* event.** At a real rate, a line per event is a
  heap problem. The aggregated columns **are** the log, read as statistics.

### 4.2 `get_verdict`

```jsonc
{
  "name": "get_verdict",
  "description": "Current measured anomaly verdict for this tenant. Read-only. Aggregated, never per-event.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "provider": {
        "type": "string",
        "description": "Omit for the connected provider. No provider name is guessed.",
        "minLength": 1
      }
    },
    "additionalProperties": false
  }
}
```

**No `tenant` parameter.** This is the load-bearing omission of the whole
document. §5 explains where the tenant comes from instead.

The result mirrors `LiveVerdict` (`platform/conductor/live-anomaly.ts`) with one
addition, and the addition is required by §1.1:

```jsonc
{
  "ok": true,
  "source": "live",            // always "live". There is no other value, ever.
  "at": "2026-10-04T14:32:05.000Z",
  "records": 20000,
  "synthetic": false,          // provenance, per live-contracts.ts
  "columns": [ … ],
  "breachedColumns": 0
}
```

**`source` is not decoration.** A tool named `get_verdict` that could return a
recorded value would be a two-truths surface with no visual separator — a model
would read it as current. `get_verdict` reads the running window and returns
`"source": "live"` or refuses. It never returns the record. If a future
`get_recorded` is ever proposed, it carries its own name and its own `source`.

`synthetic` travels because ADR-005's provenance rule is not a UI-only concern:
a model handed a simulated figure without that flag will report it as measured.

### 4.3 `install_schema`

```jsonc
{
  "name": "install_schema",
  "description": "Register or replace an agent schema. Destructive to the previous version of the same id.",
  "inputSchema": {
    "type": "object",
    "required": ["schema"],
    "properties": {
      "schema": {
        "type": "object",
        "description": "An agent schema. Validated by the same validateSchema the portal uses.",
        "required": ["id", "title", "streams", "rules"]
      }
    },
    "additionalProperties": false
  }
}
```

It delegates to `validateSchema` and `registry.register` **unchanged**. The
registrar is the same object the portal holds; a schema accepted by one is
accepted by both, and the tenant is supplied by the caller, never read from
`schema`. The response echoes `agent.describe()` and `replacedVersion` so the
agent can see whether it replaced something — a silent replace is the kind of
surprise this project's other half exists to prevent.

### 4.4 `ingest_events`

```jsonc
{
  "name": "ingest_events",
  "description": "Submit already-formed events for this tenant. Counted and refused per event, never merged.",
  "inputSchema": {
    "type": "object",
    "required": ["events"],
    "properties": {
      "events": {
        "type": "array",
        "description": "Events to admit. Each is validated before admission.",
        "minItems": 1,
        "maxItems": 1000,
        "items": { "type": "object" }
      }
    },
    "additionalProperties": false
  }
}
```

Three bounds are not negotiable and each has a reason:

- **`minItems: 1`.** An empty array is not a no-op, it is an unanswered question
  about whether the call worked.
- **`maxItems: 1000`.** This is **not a new bound chosen here.** The portal
  already enforces it: `MAX_INGEST_EVENTS = 1000` at `portal-routes.ts:466`,
  checked at `:499`, refusing with an issue path rather than silently truncating.
  The embassy adopts the number the product already ships with, so the same call
  is admitted or refused identically through either door. An unbounded array over
  stdio would in any case be an unbounded allocation in a process holding a live
  window.
- **No `provider` parameter.** The provider is the tenant's connected provider,
  resolved server-side. A caller that could name its provider could push into
  another provider's window.

The response is the portal's: `{ accepted, refused, provider }`. **A partial
accept is reported as a partial accept.** `ingest_events` returning
`accepted: 900, refused: 100` is a true and useful answer; rounding it to success
would make the refusal invisible to the only party that could act on it.

---

## 5. The Auth Boundary

### 5.1 The threat model, stated before the answer

The MCP host launches this process **as a child**. That means, unavoidably:

- The host **chooses** the argv and the environment.
- The host **can** write to our stdin at any time.
- **stdin is not a trust boundary.** Anything arriving on stdin is
  *unauthenticated input from a party we do not control*.

So the embassy cannot authenticate the *host*. It must instead make the token
**unforgeable to anyone who did not receive it from the kernel**, and scoped so
that a leaked one is bounded. That is a weaker but honest claim, and §5.4 states
it precisely.

### 5.2 The mechanism

**A capability token, minted by the kernel, bound to one tenant, passed once on
`initialize`.**

```
host                          kernel                        embassy
 │                              │                              │
 │  spawn(argv, env)            │                              │
 │ ───────────────────────────────────────────────────────────► │
 │                              │  mint(tokenId, tenant)      │
 │                              │ ──────────────────────────► │
 │                              │                              │
 │  initialize({token})  ────── stdio ──────────────────────►  │  prove(token)
 │                              │                              │ ─────────►
 │                              │                              │  tenant := proof
 │                              │                              │
 │  tools/call(get_verdict) ── stdio ──────────────────────►  │  ← no token
 │                              │                              │  tenant is known
```

Rules, each of which is a rule and not an aspiration:

1. **The token is presented exactly once**, on `initialize`. Every subsequent
   message is authenticated by *being on that established session*.
2. **`tenant` is derived from the token at `initialize` and stored on the
   session.** It is read from the kernel's proof, never from a request.
3. **No tool takes a tenant, a token, or a credential argument.** Not as a
   parameter, not as an optional one, not "for testing". The schema in §4 would
   not admit one, and `additionalProperties: false` enforces that at the edge
   rather than by review.
4. **Every call passes the session's tenant to the same function the portal
   calls.** One code path. The embassy does not get its own authorisation logic,
   because a second one is a second thing to be wrong.
5. **A session with no valid token accepts no tool call.** `initialize` either
   succeeds and establishes a tenant, or the embassy does not answer tool calls
   at all.
6. **One token, one tenant, one process lifetime.** There is no refresh and no
   token exchange mid-session. A long-lived session with a rotating credential
   is a revocation mechanism, and **a revocation mechanism that cannot be
   tested is not a mechanism.** Scope is enforced by lifetime instead, and that
   is a real limitation rather than a solved problem.

### 5.3 Why the token is passed on stdin at all

The obvious objection: `initialize` arrives on the same channel as everything
else, so the token proves only that the caller *has* the token.

**Yes — and that is the correct standard for a bearer capability.** The token
does not authenticate the host; it scopes what the host may do once it holds
one. The threat it answers is a *second* agent, or an agent connected to the
wrong kernel, being handed a session that can reach another tenant's data. It
does not answer "the host process is malicious", and §5.4 says so.

The strengthening that costs nothing: **the kernel mints the token at spawn and
never writes it to disk, never logs it, and never includes it in any response.**
D-016's redaction discipline applies to this token exactly as it applies to
gateway tokens — it is a credential, and it is treated as one.

### 5.4 What this boundary does NOT claim

Stated plainly, because the failure mode of a security section is a reader
assuming more than was built:

- **It does not protect against a compromised host process.** A host that has the
  token can call every tool the tenant can.
- **It does not protect against a local attacker who can read the kernel's
  memory or the process environment.**
- **It does not survive token theft.** Possession is authority, for the process
  lifetime. That is what a bearer capability *is*.
- **It does not rate-limit.** An embassy client inside its tenant may call as
  often as it likes. Rate limiting belongs to the edge
  (`platform/omniroute/edge-security.ts`), and duplicating it here would create
  the second authorisation path §5.2 rule 4 exists to prevent.

**A denial-of-service surface is accepted knowingly**, not overlooked: an agent
holding a token can spend CPU in this process. The mitigation is process
lifetime (§5.2 rule 6) and the kernel's existing limits — not a quota invented
for the embassy.

---

## 6. The Concurrency Rule

### 6.1 The measured fact that settles it

`LiveGateway` (`platform/api/portal-routes.ts:417`) is **synchronous**:

```ts
export interface LiveGateway {
  verdict(provider: string): LiveVerdict | undefined;
  push(provider: string, event: OmniRouteEvent): void;
  connected(provider: string): boolean;
  evaluate?(provider: string): void;
}
```

None of these return a promise. `verdict` is **arithmetic over a window that is
already in memory**, and `push` is an append. **There is no blocking read to
stall the streaming engine, because there is no I/O in the call.**

So the question as posed — "how do blocking reads avoid stalling the core" —
**does not arise on this interface.** Saying so is not a way of dodging the
design work; it is the finding, and it is the reason the concurrency answer is
short. The alternative designs were still considered:

| Design | Why not |
|---|---|
| **Separate process + IPC to the kernel** | Adds a serialisation boundary, a second authority for the tenant, and a failure mode where two processes disagree about the current verdict. The two-truths contract would gain a *third* truth: what the kernel remembers versus what the embassy last saw. **This is the strongest argument against it.** |
| **Worker thread** | The gateway state is not shared across threads without copying. Copying a live window per call buys isolation we do not need for a synchronous arithmetic function, at the cost of making the window *stale by construction*. |
| **Event-loop yielding between messages** | Correct and cheap: the readline loop already processes one message at a time, so a slow handler delays only the next tool call. It never delays the *kernel's* streaming, because streaming is not in this process unless the operator embedded it — which §6.3 forbids. |

### 6.2 The rule

> **The embassy runs in its own process, reads through the existing synchronous
> gateway interface, and never shares an event loop with the streaming engine.**

Stated as obligations:

1. **The embassy never imports the streaming engine.** It receives a `LiveGateway`
   and a `DynamicAgentRegistry` by injection. There is no import path from
   `platform/ingestion/` or the live anomaly writer into `platform/embassy/`.
   This is checkable by a test that walks the import graph.
2. **The dispatcher is single-threaded and re-entrant-safe.** One message is
   processed to completion before the next is read. A handler that is slow delays
   the *next tool call*, which is visible and bounded — rather than interleaving
   two calls into an inconsistent read.
3. **`get_verdict` copies the window it returns.** The `LiveVerdict` it hands the
   model must not be a live reference into a window the next `push` will mutate,
   or the JSON could be assembled from a half-updated window.
4. **No unbounded buffering.** §4.4's `maxItems` and the line-length cap in §8
   exist for the same reason: this process has a fixed memory budget and no
   supervisor that would restart it.

### 6.3 What "own process" costs, stated honestly

The kernel runs the embedding application; an embassy is typically *spawned by*
that application's host. Two consequences the operator should weigh:

- **If the operator embeds the kernel in the same process as the host agent, this
  rule is violated by construction.** §12 records this as the one deployment
  shape this ADR forbids, because it reintroduces exactly the stall the rule
  exists to prevent.
- **A verdict read through the embassy is current as of the read.** It is not a
  subscription. An agent polling `get_verdict` sees the same window the browser
  would, and never a fresher one. That is correct — there is one window — and
  agents needing change-notification should use `resources/list` semantics or
  poll, which §10 leaves open.

---

## 7. The vault, and why D-017 is not re-opened

D-017 keeps the credentials vault unwired. **The embassy does not change that,
and this section exists so that "Phase 2" cannot be read as permission.**

- The embassy exposes **no vault tool**. The three tools in §4 are the whole
  surface.
- The embassy **does not mint vault credentials**. It receives one capability
  token at spawn, which is a process-lifetime handle, not a stored credential.
- The token is **never persisted**, so the embassy introduces no new secret at
  rest — which is the property D-017 was protecting.

The vault stays dark. Nothing in Phase 2 needs it lit.

---

## 8. Limits — the bounds are part of the design

| Bound | Value | Reason |
|---|---|---|
| Max request line | 1 MiB | One oversized line must not exhaust the reader's buffer. Longer → request-too-large error, connection stays up. |
| Max events per call | 1000 | `MAX_INGEST_EVENTS`, already shipped at `portal-routes.ts:466`. §4.4. |
| Session lifetime | Process lifetime | §5.2 rule 6. Bounds token authority. |
| Response size | **Truncated, never silently** | A verdict with 10,000 columns must say it was cut. Truncation without a marker is the "no reading yet" failure in a new costume. |

The last row is the important one and follows this project's own rule: **a
partial answer that does not announce itself is worse than a refusal.** If a
response cannot fit, the response says so and reports what was withheld.

---

## 9. Error shape

Every failure is a JSON-RPC error object with a stable `code`, and **no internal
message ever crosses the boundary**:

| Condition | Code | Message |
|---|---|---|
| Unknown method | -32601 | "no such method" |
| Malformed params | -32602 | "the arguments did not match the schema" |
| Tenant refused | -32001 | "this session is not authorised for that tenant" |
| Schema refused | -32002 | "the schema was refused", **with the validator's issue paths** |
| Provider not connected | -32004 | "no provider with that name is connected" |
| Over a bound | -32003 | "the request exceeds a stated limit" |

The schema-refusal row carries the validator's **issue paths** because a schema
author is exactly the party who can act on them, and a generic "invalid schema"
sends them to a log instead. This is the portal's existing behaviour and is
preserved deliberately.

**Internal exceptions never surface.** An unexpected throw becomes a generic
internal error and is written to the structured log — never to the agent, whose
only tool is to report the message onward.

---

## 10. Deliberately out of scope

Recorded so Phase 2 cannot grow by silence:

- **Resources, prompts, sampling, elicitation.** None are required by the three
  tools, and each is a new protocol surface to keep honest.
- **HTTP/SSE transport.** stdio is what the MCP host launches. A second
  transport is a second auth story.
- **A roster or `delete_schema` tool.** Read-only inspection is a convenience;
  deletion is irreversible and unrequested.
- **Any credential, vault, or file-path capability.** §7.
- **Multi-tenant multiplexing in one process.** One process, one tenant, one
  token. A second tenant means a second process.

---

## 11. What must be true before this is implemented

Not "acceptance criteria" — a list of things whose absence would make the
implementation wrong in ways a code review would not catch:

1. **A conformance test** for framing: split messages, an oversized line, a
   truncated final line, a message containing an escaped newline. The test must
   use a pipe, not a mock, because the failure mode is in the framing.
2. **An import-graph test** proving `platform/embassy/` reaches neither the
   streaming engine nor the ingestion pipeline (§6.2 rule 1). A comment is not a
   control.
3. **A tenant-isolation test**: two sessions, two tenants, one tool call each,
   asserting neither can read the other's verdict — **and a negative test with
   `additionalProperties` smuggling a `tenant` argument**, which must be refused
   at the schema edge rather than ignored.
4. **A test that `console.log` is unreachable from the embassy** — either a lint
   rule or a static scan. §3.2 item 2 is the kind of defect that only appears in
   someone else's error message.
5. **A partial-refusal test**: `ingest_events` with one bad event reports
   `refused: 1` and does not report success.
6. **A truncation test**: a response over the cap carries its marker.

---

## 12. Open questions for the operator

Named rather than left to be discovered at build time:

1. **RATIFICATION.** This document is not accepted. Nothing may be implemented.
2. **Deployment shape.** §6.3 forbids the embassy sharing a process with the
   streaming engine. Is the intended topology the kernel as a long-lived service
   with the embassy spawned per host agent? If the operator intends to embed, the
   concurrency rule must be renegotiated rather than bent.
3. **Token delivery.** Passing the token on `initialize` over stdin (§5.3) is the
   weakest link. Acceptable as scoped, or should the kernel write it to a
   pipe/file descriptor the host never reads?
4. **Read-only mode.** Should an embassy session be *incapable* of the two write
   tools — a read-only embassy for third parties? It would cost one flag and
   would make the tool surface answerable to a stranger's question.
5. **Discovery naming.** `get_verdict` returns `source: "live"` always. If a
   recorded read is ever wanted, it needs its own tool name before it needs code.

---

## 13. Traceability

| Obligation | Where it comes from |
|---|---|
| Zero dependencies | ADR-001, `package.json` `dependencies` is absent |
| JSON-lines framing is not new | `platform/ingestion/jsonl-tokenizer.ts:133` |
| Tenant is the proven credential | `platform/api/portal-routes.ts:633` |
| One authorisation path | §5.2 rule 4 |
| Bounds already exist, adopt not invent | `MAX_INGEST_EVENTS = 1000`, `portal-routes.ts:466` |
| No raw events over the wire | ADR-002 (high-frequency series), `LiveStreamView` header |
| Provenance must travel | ADR-005 §9, `live-contracts.ts` `synthetic` |
| Structured logging, never stdout | ADR-005 §9 rule 3 discipline, §3.2 item 2 |
| Vault stays dark | D-017 |
