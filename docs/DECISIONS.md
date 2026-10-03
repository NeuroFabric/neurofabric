# Decision Records

Format: context → decision → rationale → alternatives → consequences →
migration → verification. Chronological order — append new decisions at the end.

**This file is the canonical decision log for the project.** The former
`memory/decisions.md` carried five earlier dated decisions; they were merged into
D-000 below and that file now only points here. Add new decisions here.

---

## D-002: The OmniRoute API key stays in `models.json` as an accepted risk

- **Date:** 2025-09-26
- **Status:** accepted (deliberately not remediated)
- **Affects:** model call authentication for every Pi session

### Context

`~/.pi/agent/models.json` stores the `omni` provider key in plaintext. The
obvious remediation — move it to Pi's credential store (`auth.json`) or an
environment variable — was investigated and found to break model access for no
security gain.

### Decision

**The key stays where it is.** It is an accepted, documented risk, mitigated by
rotation rather than relocation.

### Rationale

1. **Moving it guarantees an outage.** The `omniroute-pi-ext-integration`
   extension reads the key *only* from `models.json` (`getApiKey()`) and hardcodes
   `apiKey: provider.apiKey || "omniroute-public"` when registering the provider.
   With the key removed, every Pi model call would send `omniroute-public`, which
   was verified to return **401**.
2. **`auth.json` would not be read.** Pi's own `docs/models.md` lists credential
   precedence (`--api-key`, then `auth.json`, then `models.json`, then provider
   environment variables), but that extension supplies an explicit `apiKey` on
   `registerProvider`, which bypasses credential resolution entirely. Writing the
   key to `auth.json` would store a secret nothing reads.
3. **Zero security gain.** `auth.json` and `models.json` live in the same
   directory, `~/.pi/agent/`, with the same permissions. Pi's documentation treats
   them identically ("keep `auth.json` and any credential commands private").
   Relocating between two files in one directory is security theatre.
4. **The repository is already clean.** The key is present in **0 of 107 tracked
   files**, so the "no credentials in the repository" rule is already satisfied.
   The remaining exposure is local disk only.

### Mitigations

- **Rotate periodically.** The exposure is bounded by rotation interval, not by
  file location.
- **Never in the repository or in traces.** No key material may appear in source,
  skills, configuration committed to the repository, or the execution trace. The
  redactor in `platform/core/redaction.ts` is enforced at the event bus, the
  persistence sink, artifact creation, and provenance construction for exactly
  this reason.

### Root cause and follow-up

The real problem is **upstream extension design**: a provider extension that
hardcodes its credential source as `models.json` and cannot read Pi's credential
store. Tracked as a known issue below. If a future version of the extension
resolves credentials through Pi, this decision should be revisited immediately —
at that point the move becomes free.

### Alternatives rejected

- Remove the key and rely on `auth.json`: breaks every model call (point 1).
- Patch the third-party package: not worth maintaining a local fork of an
  auto-updating npm dependency for this.
- Proxy the gateway: adds a component to protect a localhost key.

---

## D-003: D-001 migration is gated, not executed

- **Date:** 2025-09-26
- **Status:** accepted; **Gates 0 and 1 verified done, Gate 2 open** (corrected 2026-09-29 — see the gate table)
- **Affects:** the provider-duplication cleanup described in D-001

### Context

D-001 declares OmniRoute canonical and the pi-free providers a non-default
fallback. The audit found `pi-free` installed twice (npm and git) and recent
sessions running on `cline`. A raw HTTP probe confirmed the `omni` path works
(200, `openai/gpt-oss-120b`, ~11.2 s cold), but a raw probe is not the same as a
real Pi session.

### Decision

Execute the migration in three gates, in order, with an explicit flip condition.
**Do not perform steps 2 and 3 until step 1 has actually been run by the
operator.**

| Gate | Action | Status |
| --- | --- | --- |
| **0** | Remove the duplicate `pi-free` install (the git checkout). Reversible, removes double registration, and does not affect the working provider. | **DONE** — verified 2026-09-29: `~/.pi/agent/settings.json` `packages` contains no `pi-free` entry from either source. Not merely demoted; **both** the `npm:` and `git:` installs are gone |
| **1** | One real headless Pi turn pinned to the `omni` provider, completing a small real task. | **DONE** — verified 2026-09-29: the live session performing the M2 closeout ran with `PI_PROVIDER=omni`, `PI_MODEL=kg/stealth/space-bunny-alpha`. A real Pi turn, on the canonical provider, completing real work |
| **2** | Full removal of the remaining fallbacks and the openai-compat package. | **NOT DONE — operator action, and now the only open gate.** `@billjr99/pi-openai-compat` is still in `packages` |

### Gate status verification, 2026-09-29

The gate table above was stale until now: it read "PENDING" for Gates 0 and 1
while the machine had already moved past both. It is corrected here against
observed state rather than assumption.

**Evidence.**

- `~/.pi/agent/settings.json` declares `defaultProvider: "omniroute"`,
  `defaultModel: "auto"`, `router.baseUrl: "http://127.0.0.1:20128/v1"`, and a
  `packages` array of `omniroute-pi-ext-integration`,
  `@billjr99/pi-openai-compat`, `pi-claude-bridge`, `@bacnh85/pi-router`,
  `pi-web-access`, `bigpowers`, `@bacnh85/pi-obsidian`. **No `pi-free` entry of
  any source.** Gate 0 satisfied.
- The session that closed M2 ran with `PI_PROVIDER=omni` and
  `PI_MODEL=kg/stealth/space-bunny-alpha`. This is the strongest available
  signal for Gate 1, which is what D-003 asked for: not a raw HTTP probe, but a
  real Pi turn that produced real work on the canonical provider. The
  pre-migration Context above recorded the opposite — 94 messages on
  `provider=cline` and zero on `omni` — so the path demonstrably changed.

### What is still open, and why it was not executed

Gate 2 is **not** done. The only remaining fallback is
`@billjr99/pi-openai-compat`.

It was not executed here, for three reasons that are recorded rather than
worked around:

1. **D-001 reserves these commands for the operator.** It states plainly: "These
   commands are for the operator to run. Nothing below was executed by the
   agent, and nothing was uninstalled or disabled automatically."
2. **The precondition cannot be inferred from the repository.** D-001 step 5 is
   conditional — "Remove the openai-compat package **if you are not using it**".
   Whether this operator uses it for some workflow outside this repository is
   not answerable from inside it.
3. **It is global runtime configuration, not repository configuration.** The
   file is the operator's agent install, shared by every session on the machine,
   and it contains the package supplying the provider this very work runs on.

The exact remaining operator commands are unchanged from D-001 and are not
restated here; see step 3 (third-party credentials) and step 5 (openai-compat)
above. Steps 3 and 4 remain open on the same terms: the unused third-party
credentials should be inspected before deletion, and the plaintext `omni` key
should move to Pi's credential store.

### Flip condition

**If Gate 1 fails** — a real Pi turn on `omni` errors, hangs, or the session
trace does not show `provider=omni` — then **do not proceed to Gate 2**. Flip
D-001 instead: pi-free becomes the documented canonical path, and the OmniRoute
default is retired. The reason must be recorded here, because it would mean the
gateway path is not actually usable in practice despite the raw probe passing.

### Why gated rather than executed

Gate 0 is safe and reversible. Gates 1 and 2 are not: removing the fallbacks
removes the route recent sessions were actually using. A raw HTTP probe proves
the gateway authenticates and answers; it does not prove Pi's extension
registration, model picker, and streaming path all work end to end. The current
session's provider is the strongest available signal that the fallback path is
in active use, so it should not be removed before the canonical path is
demonstrated inside Pi.

---

## D-004: Known issues

- **`/v1/models` is admin-scoped.** The `omni` API key authenticates inference
  (`POST /v1/chat/completions` returned 200) but is refused on `GET /v1/models`
  with `401 invalid_api_key`. A missing header yields
  `401 "Authentication required"`, a rejected one yields
  `401 "Invalid API key"`, so the header shape is correct and the scope simply
  differs. **Impact:** the extension's model-*sync* command (`/v1/models` sync
  and the `/omni setup` flow) cannot authenticate with the user key, so provider
  metadata may go stale. **Inference is unaffected**, which is what matters for
  model calls. Not a blocker for D-001; track separately.
- **Extension credential source.** See D-002: `omniroute-pi-ext-integration`
  cannot read Pi's credential store, which is the root cause of the accepted
  plaintext-key risk. Revisit if an upstream release changes this.
- **Kernel binding contract.** Fixed in the commit "bind execution only on
  ALLOW": an execution now binds only on `ALLOW`, so an unresolved
  `REQUIRE_APPROVAL` cannot acquire an execution identity. The extension
  already blocked non-`ALLOW` decisions; the kernel is now independently safe.

---

## D-000: Trust model, artifacts, and redaction (merged from `memory/decisions.md`)

- **Date:** 2025-09-24 / 2025-09-25
- **Status:** accepted
- **Affects:** trust model, task completion, artifact trust, trace contents
- **Source:** merged verbatim in substance from the five entries that previously
  lived in `memory/decisions.md`, so that one file is the decision log.

### Context

Five decisions were recorded incrementally while the kernel was being built, and
their reasoning is load-bearing for reading the current code. They are collected
here so the reasoning is not lost when the old file is reduced to a pointer.

### Decisions

1. **2026-09-24 — Keep Pi as the single general-purpose agent runtime.** The
   platform is a thin orchestration layer around Pi, never a second agent loop,
   LLM client, or filesystem toolset.
2. **2026-09-24 — Start with file, log, CSV, JSON, and report-generation skills.**
   Database, Splunk, vector memory, and multi-agent components stay deferred
   until the local file-and-shell workflow is verified.
3. **2026-09-25 — Project trust and tool approval are separate concerns.** Pi
   project trust never gates a tool call, so the repeated confirmation prompt
   came from the orchestrator, not from Pi's trust model. Fixed by a
   `TRUSTED_PROJECT` policy mode that resolves to `ALLOW` or `DENY` and has no
   code path to a dialog.
4. **2026-09-25 — `TRUSTED_PROJECT` is a fail-closed boundary, not a relaxed
   one.** Dangerous operations are denied outright rather than prompted, so a
   hostile or mistaken request fails immediately and visibly instead of stalling
   the run. Denials are reported to the model with a reason.
5. **2026-09-25 — Model completion is not task completion.** Artifacts are
   first-class and verified on disk before a task may complete; a tool that
   reports success without producing its declared output is `INVALID`, not
   `VALID`. Artifact declaration is derived from a tool's `sideEffect`/`riskLevel`
   classification rather than from tool names, so new and remote/MCP tools need
   no core changes.
6. **2026-09-25 — Redaction is centralized and enforced at every boundary.**
   `platform/core/redaction.ts` is applied at the event bus, the persistence
   sink, artifact creation, and validation/provenance construction. It is
   signature- and field-based rather than length-based, so digests and paths
   survive while credentials do not. Never rely on the model to avoid exposing
   a secret.

### Consequences

- Decisions 3 and 4 together justify why no approval dialog is constructed in
  the default configuration, and why `platform/pi/write-approval.test.ts`
  asserts that a non-interactive run fails closed.
- Decision 5 is the reason `artifact-flow.test.ts` exists and why a write whose
  declared output is missing cannot complete a task.
- Decision 6 is why `redaction.ts` is imported by the event bus, the artifact
  layer, and the orchestrator. It is load-bearing code, not a convenience.

### Verification

`platform/pi/trusted-execution.test.ts` (trust model),
`platform/pi/artifact-flow.test.ts` (artifacts and completion), and
`platform/pi/redaction-boundary.test.ts` (redaction) together pin all of the
above.

---

## D-001: OmniRoute is the one canonical provider path

- **Date:** 2025-09-26
- **Status:** accepted
- **Affects:** model calls for every Pi session in this repository

### Context

An audit of the provider configuration found two provider paths installed
side by side, and evidence that they are not equivalent.

**What is configured**

| Source | Finding |
| --- | --- |
| `.pi/settings.json` (project) | `{"skills": ["../skills"]}` only. **No provider configuration at all.** |
| `~/.pi/agent/models.json` | Exactly **one** provider: `omni`, `baseUrl: http://localhost:20128`, `api: omni-prompt-tools`, **363 models**. It also carries a **plaintext `apiKey`** for the local gateway. |
| `~/.pi/agent/settings.json` → `packages` | **Four** packages installed: `npm:omniroute-pi-ext-integration` (2.0.1), `npm:pi-free` (2.8.2), `git:github.com/apmantza/pi-free` (2.8.2), `npm:@billjr99/pi-openai-compat` (1.1.34). |
| `~/.pi/agent/auth.json` | Credentials present for four providers: `kilo`, `groq`, `cline`, `llm7`. No credential for `omni` beyond the models.json value. |
| `~/.pi/agent/models-store.json` | Pi's runtime model store contains **`google`, `llm7`, `cline`, `fastrouter`, `kilo`, `groq`** — and **no `omni` entry**. |

**Which path model calls actually take**

The most recent session in this project
(`~/.pi/agent/sessions/--D--Agent-Harness-.../2026-09-26T05-18-57-695Z_*.jsonl`)
records 94 assistant messages with `"provider":"cline"` and 92 with
`"model":"stealth/space-bunny-alpha"`, plus one `provider=groq`. **Zero** calls
to `omni` / `localhost:20128`.

So the path documented as the default in `README.md` is not the path in use.
Calls are going direct to a third-party endpoint via **pi-free**, bypassing the
local OmniRoute gateway entirely.

**Conflicts between OmniRoute and pi-free**

1. **Provider surface.** pi-free registers ~25 additional providers (ollama,
   cline, llm7, zenmux, deepinfra, sambanova, novita, fastrouter, tokenrouter,
   requesty, and more) at their own remote `baseUrl`s. The model picker lists
   them alongside `omni`, so switching model is enough to change where data goes
   — with no code change and no project-level record of it.
2. **pi-free is installed twice.** `npm:pi-free` and `git:github.com/apmantza/pi-free`
   are the same package at the same version (2.8.2), from two sources. Both load
   as extensions, so provider registration, commands, and telemetry are
   duplicated.
3. **Credentials for the non-canonical path are live.** `auth.json` holds keys
   for `cline`, `groq`, `kilo`, and `llm7`, which is what makes the switch to a
   third party frictionless.
4. **`@billjr99/pi-openai-compat`** is a fourth route to any OpenAI-compatible
   endpoint, configured ad hoc.
5. **A credential is in a plain config file.** `models.json` stores the `omni`
   key in the clear rather than in Pi's credential store.

### Decision

**OmniRoute, reached through the `omni` provider declared in
`~/.pi/agent/models.json` and served by the `omniroute-pi-ext-integration`
extension, is the one canonical provider path for this project.**

`pi-free`, its git duplicate, and `pi-openai-compat` are **not** removed by this
decision. They are demoted to a **clearly-marked, non-default fallback** that
is off unless explicitly re-enabled, and documented as such in `README.md` and
`docs/ARCHITECTURE.md`.

The platform orchestrator is unaffected either way: it never calls a provider.
It only records trace events, and Pi owns the model call (see
`docs/PI_INTEGRATION.md`).

### Rationale

- It is what the project's own documentation already promises. The README, the
  architecture diagram, and `PI_INTEGRATION.md` all name OmniRoute.
- **One egress point is auditable.** All traffic to a model goes through
  `localhost:20128`, which is a boundary that can be observed. Four
  simultaneously-configured third-party providers are not.
- **Provider metadata is better.** The `omni` provider carries 363 models with
  enriched metadata (context window, max tokens, reasoning, vision, and
  per-model `tool_calling` flags that Pi strips from its own model type). pi-free
  does not write this metadata into `models.json` at all, which is why `omni` is
  absent from `models-store.json`.
- **Cost and entitlement stay in one place.** Free-tier and trial accounting is
  a single gateway's concern, not five providers'.
- It keeps the "never call OmniRoute directly" rule intact: the platform still
  never makes a model call; it only inherits whichever provider Pi is
  configured with.

### Alternatives considered

| Alternative | Why not |
| --- | --- |
| **Keep pi-free as the default** (make `cline`/`llm7` canonical) | Rejected. It contradicts the documented architecture, it sends data to third parties by default, and it is installed twice. If this becomes the desired direction, it should be a new decision record that updates the architecture docs, not a silent drift. |
| **Keep both, document neither** | Rejected. That is the status quo that produced this record. Ambiguity about where model data goes is the problem, not the solution. |
| **Have the orchestrator force a provider** | Rejected, and it is already forbidden: Pi owns the agent loop and the model call. The orchestrator must not depend on a model ID, and it must not call a provider directly. A project-level *default* in Pi's settings is the correct lever if one is ever needed. |
| **Delete the fallbacks outright** | Rejected for now, because an air-gapped or gateway-down run needs an escape hatch. They are demoted and off, not removed. |

### Consequences

**Good**

- One documented path, one place to change the model, one place to audit egress.
- `models-store.json` regains the `omni` metadata, improving the picker.
- The duplicate `pi-free` install can go, removing double registration.

**Bad / accepted costs**

- OmniRoute must be running on `localhost:20128` for the project to work. If it
  is down, the canonical path fails. That is a deliberate single point of
  failure, chosen over an ambiguous multi-provider default.
- The fallbacks stay installed, so a future model switch can still leave the
  gateway. The verification step below is what detects that.

**Follow-ups this creates**

- The plaintext `apiKey` in `models.json` should move to Pi's credential store.
  The value is deliberately not reproduced in this document, in source, or in
  any trace.

**D-003 gates this migration.** Do not execute the steps below out of order.
Gate 0 is the only step safe to run now; Gates 1 and 2 are blocked until a real
Pi turn has been verified on the `omni` provider. See
[D-003](#d-003-d-001-migration-is-gated-not-executed).

### Migration steps for the non-canonical path

**These commands are for the operator to run. Nothing below was executed by the
agent, and nothing was uninstalled or disabled automatically.** The
`settings.json` edit is a prerequisite for the other two, so do it first.

**1. Demote the fallbacks (reversible, no uninstall).** Edit
`~/.pi/agent/settings.json` and reduce `packages` to just the OmniRoute
extension. Back the file up first:

```bash
cp ~/.pi/agent/settings.json ~/.pi/agent/settings.json.bak
```

Target content for `packages`:

```json
"packages": [
  "npm:omniroute-pi-ext-integration"
]
```

**2. Remove the duplicate `pi-free` installs** (optional; the demotion in step 1
already stops them loading, this just cleans up):

```bash
pi packages remove pi-free
pi packages remove github.com/apmantza/pi-free
```

**3. Remove the unused third-party credentials** once the fallbacks are off and
you have confirmed nothing needs them. Inspect first, edit second — do not
blind-delete:

```bash
cat ~/.pi/agent/auth.json          # review what is stored
```

**4. Move the `omni` credential out of `models.json`.** Delete the `apiKey`
field from the `providers.omni` object in `~/.pi/agent/models.json` and store
the value through Pi's credential store instead, then restart Pi and confirm
model calls still succeed.

**5. Remove the openai-compat package** if you are not using it:

```bash
pi packages remove @billjr99/pi-openai-compat
```

**6. Restart Pi** (`/reload` may suffice) and confirm the model picker shows
`omni` models.

**To go the other way (revert to the fallback),** restore the backup and
restart:

```bash
cp ~/.pi/agent/settings.json.bak ~/.pi/agent/settings.json
```

### How to verify a model call went through the canonical provider

**1. A new session records the provider.** The most recent session file must
name `omni`, not a third party. Replace `<session>` with the newest file:

```bash
ls -t ~/.pi/agent/sessions/--D--Agent-Harness-*
grep -oE '"(provider|model)":"?[^",}]{0,40}' <session> | sort | uniq -c | sort -rn | head
```

The healthy result is `provider=omni` and no `cline` / `groq` / `llm7` entries.
Compare against the pre-migration evidence in the Context table above.

**2. The OmniRoute gateway sees the traffic.** While a Pi turn is running, the
gateway must show a request from `localhost`. Check the OmniRoute dashboard
started by `omniroute`. No request in the dashboard means the call did not go
through the gateway, whatever the config claims.

**3. The model store contains `omni`.** After a restart and one model call:

```bash
node -e "const j=require('fs').readFileSync(process.env.USERPROFILE+'/.pi/agent/models-store.json','utf8');console.log(JSON.parse(j)['omni']?'omni present':'omni MISSING')"
```

**4. The project trace shows the run.** The orchestrator records
`session_start` with `policyMode`, `allowedRoots`, and `policyConfig`, and a
`policy_decision` per tool call. The trace proves the *kernel* path. It does
not record the model provider — by design, since the orchestrator must not
depend on one. Provider verification is steps 1-3.

---

## D-005: Verified OmniRoute models and Phase 2 stability rule

- **Date:** 2025-09-26
- **Status:** accepted
- **Affects:** benchmarking and reproducibility

### Context

An audit of the 363 OmniRoute upstream models revealed that many prefixes (`aug/*`, `cfp/*`) either require browser sessions, return 502/STREAM_EARLY_EOF errors, or fail due to unconfigured container transports. Only a small subset of upstreams are stable and functional for headless batch workflows.

### Decision

**All Phase 2 performance benchmarks and headless tasks MUST pin `--provider omni --model auto/gemini`.**

### Rationale

1. **`auto/gemini` is fully verified.** It succeeds headlessly with consistent performance and warm latency around ~11–32 seconds.
2. **Alternative prefixes are brittle.** `aug/*` upstreams fail with early stream termination, `cfp/*` require headless browser sessions, and other prefixes (`dva`, `cxa`) throw environment or transport errors.
3. **Reproducibility.** Relying on generic `auto` without pinning can route to different upstreams unpredictably. Explicitly pinning `auto/gemini` ensures deterministic test runs.

### Model Prune

- **Date:** 2025-09-26
- **Backup:** `~/.pi/agent/models.json.backup-2026-09-26`
- **Result:** Pruned 363 models down to 1 (`auto/gemini`).
### Addendum: Stream-Death Failure Mode & Benchmark Runner Retry Rule

- **Date:** 2026-09-26
- **Observation:** Upstream stream death ("Stream ended without finish_reason") observed on `auto/gemini` during long runner sessions, triggering the F-000 zombie-session incident.
- **Decision:** The platform kernel fails closed on stream death (transitions task directly to `FAILED` with explicit stream error reason) and intentionally does **not** self-heal stream interruptions. Consequently, the Phase 2 benchmark runner MUST implement retry-with-exponential-backoff for stream-death flakiness.


---

## D-006: Verification-phase-only raise of `maxFileWritesPerTask` (10 -> 50)

- **Date:** 2026-09-26
- **Status:** Superseded (mechanism) by D-007 — the temporary global bump was reverted; per-run overrides now use `limitProfiles`
- **Affects:** gauntlet construction and Step 2 incremental result-recording

### Context

During the construction phase of the Verification Gauntlet (Step 1), the strict default file write budget (`maxFileWritesPerTask = 10`) was exhausted twice (F-001) while bootstrapping scenarios A through H and their supporting fixtures, task files, and expected pass criteria. Furthermore, Step 2 execution requires incremental recording of session results, telemetry, and metrics reports across 8 scenarios, which exceeds 12-20 file writes.

### Decision

**The operator has raised `maxFileWritesPerTask` from 10 to 50 exclusively for the duration of the Verification Gauntlet.**

### Rationale

1. **Operational Necessity.** Legitimate batch generation and comprehensive gauntlet fixture creation cannot be artificially compressed below 10 file writes without violating the master generator specification.
2. **Policy Boundary Integrity.** Policy changes are strictly operator decisions; the agent never edits its own policy configuration. The operator manually updated the policy limit.
3. **Revert or Recalibrate.** Upon completion of the gauntlet and post-gauntlet analysis, policy limits will be reviewed and recalibrated based on observed write counts.

## D-007: Limit profiles replace the global write-budget bump

- **Date:** 2026-09-26
- **Status:** Accepted
- **Relates to:** D-012 (operator-only policy changes), D-006 (temporary global bump), F-001 (write-budget saturation), F-005 (policy file inside allowed roots)

D-006 raised `maxFileWritesPerTask` globally (10 → 50) by temporarily editing
the committed policy file, then reverted it. That pattern trades the
conservative baseline for throughput on every run, and hand-editing a single
number is exactly the kind of invisible drift this project keeps catching.

The policy file instead supports operator-defined `limitProfiles` — named
partial overrides of `limits` — and an `activeLimitProfile` selector
(`platform/core/policy-config.ts`; commits 5f0b52a and c09be26):

- Profiles merge into `limits` at load time, so enforcement, denial messages,
  and traces always show effective values. Proven by the policy-port tests:
  without activation the base budget binds and call #11 is denied at 10; with
  activation the same call is allowed and call #51 is denied with the merged
  50 in the message.
- Validation fails closed: an unknown `activeLimitProfile`, unknown keys,
  invalid values, or non-kebab-case names are load errors, never silent no-ops.
- An inactive profile is inert.
- Selection is operator-only (D-012). At gauntlet start the operator sets
  `activeLimitProfile`; the committed file keeps the conservative base budget
  at all other times.

Known residual: the policy file itself sits inside the agent-writable boundary
(F-005), so D-012 records this as a convention rather than an enforced
boundary.


## D-008: Three standing rules for agent-driven git operations

- **Date:** 2026-09-27
- **Status:** accepted
- **Affects:** any agent session authorized to act on this repository

### Context

Merging PR #6 required the agent to push a merge commit to a protected `main`.
A direct push was blocked by the transport guard, and closing the task required
several rounds of verification against operator action claims. Those rounds
surfaced recurring failure modes worth codifying rather than leaving to session
memory.

### Decision

**Three standing rules govern every agent action on this repository.**

1. **The guard outranks authorization.** A blocked action stops the task. It is
   never routed around — not by retrying with different flags, not by choosing a
   different transport, not by locating a path the guard does not cover.
2. **Operator confirmations are claims to verify, not facts to assume.** A
   reported action is unverified until the resulting state is read back with the
   authoritative instrument for that state. A discrepancy is reported, never
   reconciled on the operator's behalf.
3. **Nobody pushes `main` directly.** `main` advances only via a merge of a pull
   request whose required checks have passed. The guard is the transport boundary
   by design, not an obstacle to be defeated. **(Amended by D-010: `main` is now
   protected by branch protection, so the rule is enforced by the platform rather
   than by discipline, and an agent may request auto-merge instead of waiting for
   an operator to press the button. D-010 supersedes the "or an operator push"
   clause and the "agents" qualifier. The rule as originally written is retained
   below as the record of the state at D-008.)**

   > **Rule 3 as written at D-008:** Agents never push `main` directly. `main`
   > advances only via a PR merge or an operator push. The guard is the transport
   > boundary by design, not an obstacle to be defeated.

### Rationale

Each rule is grounded in a specific event, not in general caution.

1. **Rule 1 — the blocked push of `5b6eaa7`.** The agent created the PR #6 merge
   commit locally and was refused by the direct-push guard. Authorization to
   merge was explicit and the merge itself was fully verified, which is exactly
   the condition under which a guard is most tempting to work around. Stopping
   preserved the work: the merge commit survived intact and became the merge
   commit of record once the operator landed the push. A rule that only holds
   when the work is already lost is not a boundary.
2. **Rule 2 — three deletion rounds that failed verification.** The operator
   reported the merged branches deleted on three consecutive closeout rounds.
   `git ls-remote --heads origin` and `git fetch --prune` showed both branches
   live and unchanged every time. Reporting the discrepancy three times cost more
   wall-clock time than reconciling it would have, and reconciling would have been
   the worse outcome: the unverified claim would have become the recorded fact,
   and the one commit on the hardening branch that was unreachable from `main`
   would have been deleted before its safety was established. That commit's tree
   was later proven byte-identical to `194e03c` on `main` — but only because the
   deletion was held, not assumed.
3. **Rule 3 — the same event as rule 1.** The blocked push is the concrete
   evidence that the guard is doing its job, and is the reason rule 1 exists.

### Consequence: branch deletion is optional housekeeping

Following rule 2, the operator reclassified post-merge branch deletion as
**optional, non-blocking housekeeping**. As of close, both branches are recorded
as **PRESENT on the remote**, which is the verified state — not a claim that any
deletion occurred:

- `docs/followup-corrections` — fully merged; second parent of `5b6eaa7`.
- `fix/platform-small-hardening` — tip tree byte-identical to `194e03c` on
  `main`, so deletion is content-safe whenever the operator chooses.

Neither deletion blocks anything.

### Attribution correction: PR #4, not PR #5

The single commit on the hardening branch that was unreachable from `main` was
initially attributed to PR #5. It is the squash-merge artifact of **PR #4**,
commit `194e03c` on `main`, verified against the live PR page. PR #5 is the
later merge `28660de` (`docs/current-status-sync`), an unrelated change. The
correction affects only the audit trail — `194e03c` is on `main` either way — but
it is recorded so the branch-naming history is not wrong in writing.

### Merge record

PR #6, merge commit `5b6eaa7`, `MERGED` at 2026-09-27T10:40:41Z. The facts live in
git history and on the PR page and are not duplicated here.

### Alternatives rejected

- **Write the rules into `memory/decisions.md`.** That file is a pointer stub and
  states that decisions belong here. Adding to it would re-scatter what the
  2026-09-26 consolidation deliberately centralized.
- **Codify the rules only in operator config.** Considered while the agent could
  not read `gh` from `PATH`; the failure mode behind rule 2 was a
  tool-availability misdiagnosis, which argues the rules belong where a reviewer
  finds them.

## D-009: A limit declared on `CoreLimits` is a limit that is enforced

- **Date:** 2026-09-27
- **Status:** accepted
- **Affects:** `platform/core/limits.ts` and every consumer of `DEFAULT_LIMITS`

### Context

F-006 found `maxStepRetries` declared on the recovery surface and read by no
recovery decision. It advertised a bound that did not exist, and it was removed
in PR #3. The same finding recorded that eight more limits on `CoreLimits` were
in that state and listed them as Phase 2 work. Until now all eight were still
there: declaring a limit on `CoreLimits` cost one line, and nothing connected
the declaration to any code that honoured it.

The failure mode is not a missing feature. It is a documented promise the
platform does not keep. A reader of `limits.ts` cannot distinguish a real bound
from a decorative one, and the enforcement, if it exists at all, lives in some
other file that the interface does not name. The total was nine
declared-but-unenforced limits: `maxStepRetries` plus the eight below.

### Decision

**Every field on `CoreLimits` is read by live code on the production path. A
field that cannot be enforced is removed rather than left declared.**

The nine unenforced limits split two ways, six removed and three wired.

**Removed — no natural choke point, so no honest cap exists:**

| Limit | Why it is gone |
| --- | --- |
| `maxTaskDurationMs` | Subsumed by the wired `maxExecutionTimeMs`, which now covers the task wall clock. Keeping both would be two names for one bound, one of them dead. |
| `maxStepDurationMs` | A per-step clock needs a step boundary that times out independently. No such boundary exists, so the enforcement would have been decorative. |
| `maxToolDurationMs` | Same shape at tool granularity. Tool time is bounded by the task clock and the adapter's own execution bookkeeping, not by a field of this interface. |
| `maxParallelTasks` | Nothing schedules tasks concurrently. A value of one described a constraint the platform does not enforce and cannot today violate. |
| `maxParallelTools` | Same. The adapter serialises tool calls structurally, so the cap would restate an implementation fact already true by construction. |
| `maxOutputBytes` | Output size is governed per write by the policy byte cap `maxBytesPerWrite`, enforced at the policy layer where the payload is actually produced. A second number in a different layer would be a second, disagreeing truth. |

**Wired — a real choke point exists, so the cap becomes real:**

- **`maxExecutionTimeMs` to `recovery.ts` and `kernel-adapter.ts`.** The
  adapter takes a monotonic (`hrtime`) task start in `beginTask` and passes
  elapsed milliseconds to `chooseRecoveryDetailed`, which terminates the task
  with the new `EXECUTION_TIME_EXHAUSTED` reason when the budget is spent.
  Monotonic rather than wall-clock deliberately: a system clock adjustment must
  not be able to extend or prematurely cut a task's budget.
- **`maxArtifactBytes` to `artifact.ts`.** `createArtifact` is the one place
  every artifact passes through, and it now rejects a reference whose file
  already exceeds the budget. The policy byte cap could not catch this: it
  governs tool payloads, not the files those payloads produce. Size is read only
  for a path that already exists, is skipped for directories, and fails open
  when the size cannot be read — a reference that does not exist yet is not an
  oversize artifact, and `verifyArtifact` is what decides whether it exists at
  all. Hardcoded to the default; configurability is a separate decision and is
  not implied by this one.
- **`maxContextTokens` to `context-memory.ts`.** `selectContext` took its budget
  as a required argument and had no production caller, which is precisely why
  the field was dead. The budget now defaults to
  `DEFAULT_LIMITS.maxContextTokens`.

Six limits remain on the interface, all six enforced: `maxToolRetries`,
`maxReplans` and `maxRecoveryDepth` (read by `recovery.ts`), plus
`maxExecutionTimeMs`, `maxArtifactBytes` and `maxContextTokens`.

### Rationale

1. **The F-006 application is the ground for the whole decision.** The original
   finding is proof the defect class is real and not hypothetical: a limit sat
   on a public interface, in a live default block, enforcing nothing. Any later
   reader of `DEFAULT_LIMITS` would have taken `maxStepRetries = 1` at face
   value. Removal was the correct response then and is the correct default
   response now. This decision does not improve on F-006; it applies F-006's
   own conclusion to the eight limits F-006 listed and did not touch.
2. **The six removals are removals, not deferrals.** Each names a capability the
   platform does not have: an independently timing-out step boundary, a
   concurrent scheduler, a per-tool output accountant. Writing enforcement for
   any of them would have produced a check that fires only on paths nothing
   exercises, which is the same defect wearing a new hat. The interface is
   narrowed to what the platform can actually promise, so the next reader is not
   misled.
3. **Wiring beats removal wherever a choke point genuinely exists.**
   `maxExecutionTimeMs`, `maxArtifactBytes` and `maxContextTokens` each name a
   bound the platform really should honour, and each had exactly one place where
   honouring it is not a simulation. A cap that fires is worth more than a cap
   that is documented, and a working default is more useful to callers than a
   correct absence.
4. **The tests pin the cap, not the intention.**
   `platform/core/corelimits-enforcement.test.ts` asserts that the declared key
   set is exactly the six enforced limits, that each removed limit is absent
   from both the defaults and the validated shape, and that each wired cap
   fires at the boundary and not one unit past it. A future edit that
   reintroduces a paper limit fails in CI rather than in production. The
   execution-time cap is separately covered against the real decision function
   in `platform/pi/corelimits-execution-time.test.ts`.

### Consequence: declared equals enforced equals six

`CoreLimits` now carries six fields, all six read on the production path, zero
dead. The F-006 Phase 2 item "the nine declared-but-unenforced `CoreLimits`" is
closed. Removing a field from this interface is now a behaviour change for its
consumers, and adding one without a choke point to enforce it reopens the exact
defect this decision closed — which is why the enforcement tests assert the key
set rather than only the presence of each key.

> **SUPERSEDED IN PART (D-016b).** The decision above is preserved as the record
> of what was decided then and is not rewritten. One of its six fields has since
> been removed: `maxContextTokens` went the way F-006 established for
> `maxStepRetries` — a bound with no reachable consumer. D-009 wired it to
> `selectContext`, but that function still had no production caller and the
> `estimatedTokens` input it budgets has no producer, so the field advertised a
> guarantee that could not occur. `selectContext` now takes its budget as a
> required argument again. The current state is **five** declared fields, all
> five enforced: `maxToolRetries`, `maxReplans`, `maxRecoveryDepth`,
> `maxExecutionTimeMs`, `maxArtifactBytes`. The rationale at point 3 below
> ("wiring beats removal wherever a choke point genuinely exists") is
> deliberately NOT overturned: a choke point existed, but nothing called it.
> See the Task C note below, whose status this changes from outstanding
> CoreLimits work to a known `selectContext` defect.

### Open items

Both findings below are properties of code this decision deliberately did not
change. They are fenced, tested as-is, and carried forward.

1. **`validateLimits` passes an unknown key through instead of rejecting it —
   Task B.** `validateLimits` merges the caller's object over
   `DEFAULT_LIMITS` with a spread and range-checks only the merged entries. A
   key that is not on `CoreLimits` is therefore neither rejected nor dropped: it
   rides through into the returned object, and the range check even applies to
   it. So removing a limit from the interface is *not* enforced at the
   validation boundary — a caller can still build a limits object carrying a
   field the platform no longer claims to honour. `validateLimits` was fenced
   because changing it alters the shape every caller receives. The behaviour is
   pinned by test `D009.1d` as current behaviour with the defect stated in the
   test; Task B owns the fix and must update that test to assert rejection.
2. **`selectContext` drops a required source that does not fit the budget —
   Task C.** The function guards each source twice, and the first guard exempts
   a required source while the second, unexempted, catches it one line later, so
   the exemption is dead. A required source is dropped exactly like an optional
   one, and a budget below its estimated size yields an empty selection. This
   was not visible before D-009: wiring `maxContextTokens` to this function is
   what made the path reachable and the defect observable. `selectContext`
   semantics are fenced because the correct behaviour is a product answer, not
   a code one — a required source may have to be admitted over budget,
   truncated, or reported as unsatisfiable, and those differ. The current
   behaviour is pinned by test `D009.2c` with the defect stated; Task C owns the
   decision and has a pinned case to turn green.

   **D-016b:** the operator ruled that Task C is NOT a CoreLimits implementation
   requirement and that the existing behaviour may stand unchanged, so this is no
   longer outstanding CoreLimits work. The pin in `D009.2c` is retained, now
   documenting a known `selectContext` defect and still failing relative to the
   intuitive behaviour, so a future decision on the required-source policy is a
   deliberate change rather than a silent one.

   > **[Resolved — D-020, 2026-09-28.]** Task C is decided: a required source is
   > admitted over budget, so `maxTokens` is a soft cap for required sources and a
   > hard cap for optional ones. The second guard was deleted. D-016b is
   > superseded on this point only — "may stand unchanged" was permission, not
   > prohibition. One factual correction to the paragraph above: the `D009.2c`
   > pin was a **passing** test that asserted the defect, not a failing one, so
   > the suite read green throughout. It now asserts the D-020 behaviour.

### Alternatives rejected

- **Implement the six removed limits properly.** Each would have required a new
  enforcement mechanism — a per-step timer, a scheduler, a per-tool output
  accountant — and those are features, not honesty fixes. Declaring the cap
  before building the mechanism is what produced F-006.
- **Keep the removed fields marked as unenforced or reserved.** This preserves
  the exact ambiguity that caused the finding. A reader still cannot tell
  whether a cap is real, and the marker becomes a place where dead fields
  accumulate.
- **Make `validateLimits` strict as part of D-009.** It is the obvious place to
  close the unknown-key hole, and it was rejected because it changes the
  contract of a shared exported function for every caller, not just this
  interface. Recorded as Task B so the change gets its own decision instead of
  riding along as a side effect of a limits cleanup.
- **Fix `selectContext` in the same change.** Same reason in product terms: the
  right behaviour for an over-budget required source is not yet decided, and
  guessing it inside a limits-honesty change would mix a product decision into
  a mechanical one.
## D-010: Merge authority is mechanized, not delegated

- **Date:** 2026-09-27
- **Status:** accepted
- **Amends:** D-008, standing rule 3
- **Affects:** any agent session authorized to act on this repository, and the operator's merge step

### Context

D-008 rule 3 read: agents never push `main` directly; `main` advances only via a
PR merge or an operator push. As written, that rule was held by nothing but the
agent's own discipline. The transport guard blocks a direct push by an agent
session, which is real, but the merge itself was performed by a human reading
the agent's summary. Every PR in this repository therefore cost a manual
operator step, and the rule's enforcement stopped at the push — the decision to
land the commit was unmechanized.

The cost is visible in the record. One session verified a branch, corrected two
tests, authored a decision record, ran four suites, committed, and pushed — and
then exhausted its tool-call budget on the command that would have opened the
pull request. The work was complete and correct; the merge was the only thing
missing, and it was missing because the last mile required a human who was not
otherwise in the loop. A workflow whose final step is a human being present is a
workflow whose final step sometimes does not happen.

### Decision

**Standing rule 3 is mechanized. `main` is protected by branch protection, and
merge authority moves from the operator's button to the platform's checks.**

1. `main` is protected by branch protection. It accepts no direct push from
   anyone — no agent and no human. The D-008 escape clause "or an operator push"
   is withdrawn: it was the one path around the rule that the rule could not
   police.
2. `main` advances only by merge of a pull request whose **required checks — the
   CI suites — have passed.** The gate is the test result, not a reviewer's
   confidence.
3. **Agents may open pull requests and request auto-merge**
   (`gh pr merge --auto --squash`). The platform performs the merge once the
   required checks pass. The agent does not perform the merge and need not be
   present when it happens.
4. **The operator retains post-hoc review, revert authority, and the right to
   revoke auto-merge for any class of change**, at any time, without consulting
   anyone. Revocation is expected to be routine, not exceptional.

Auto-merge is requested with `--squash` so `main` history stays linear and each
change lands as one commit whose message says what it did.

### Rationale

1. **This is an operator delegation decision, and it is recorded as one.** The
   operator holds the authority being delegated and chose to exercise it. A
   delegation that no record captures is indistinguishable from an agent having
   decided to take the authority, which is the failure this decision exists to
   make impossible.
2. **Pi's guard-stop record is the evidence that the unmechanized rule did not
   hold.** Twice in two sessions the task stopped at the merge boundary: once on
   a blocked direct push, once on an exhausted tool-call budget immediately
   before the pull request could be opened. Both stops were correct. The pattern
   they show is not that the guard misfired — it is that a correct stop and a
   complete piece of work can still end with nothing landed, because the only
   remaining step needed a person. A boundary that produces unrecoverable stalls
   gets bypassed eventually; the honest repair is to remove the need for the
   person, not to lower the boundary.
3. **The F-006 principle, applied to the workflow itself, is the whole
   argument.** F-006 found a limit declared on a public interface and enforced
   by nothing — a promise the platform did not keep. D-009 closed that by
   removing what could not be enforced and wiring what could. Rule 3 as written
   was the same defect one level up: a boundary declared in a document and
   enforced by the reader's good intentions. A rule enforced only by convention
   is not a weaker rule; it is a rule with a countdown. Branch protection is the
   enforcement mechanism, the required checks are the enforcement mechanism, and
   the platform refusing the push is the report that the rule was violated —
   the property D-008 asserted without having.

### Consequence: post-hoc review replaces pre-merge review

There is no human review before a merge. That is the deliberate trade, and the
remedy is named rather than assumed: the required checks must pass for the merge
to happen, and the operator reviews afterwards and reverts if the review
disagrees with the merge. Revert is cheap on a squash-merged, linear history
and the operator holds that authority unconditionally. Review moves from blocking
the merge to correcting it, which is a different distribution of risk, not the
absence of the control.

The corollary is that the required checks must actually be required. A check
marked optional on the branch rule is decoration, and the next honest reading of
D-010 will be that the protection was never configured.

**If the policy scanner blocks the merge command, the operator makes a
deliberate, recorded policy change — never an improvised workaround.** This
restates D-008 rule 1 for the new boundary, and it is stated here because
auto-merge gives an agent a new way to encounter a guard it is not authorized to
move. The correct response to a block is a new decision record naming the limit
that was changed and why. The incorrect response is the one already forbidden: a
different flag, a different transport, or a path the guard does not cover.

### Alternatives rejected

- **Trust-based delegation without branch protection.** Let the agent request
  merges and rely on the operator to notice and revert the bad ones. Rejected
  because it is D-008's defect unfixed: the boundary is then whatever the
  operator's attention happens to be, which is a variable, not a control. It
  also fails exactly when it matters most — a hurried session on a plausible
  change.
- **A permanent operator merge gate.** Keep every merge manual and simply accept
  that work sometimes sits unlanded. Rejected because the stop record shows the
  gate is already the most common terminal state of a correct task, and a gate
  that is routinely the last step is a queue, not a control. It converts a
  missing human into a stalled pull request, which is a worse failure to
  diagnose than a bad merge the operator can see and revert.

## D-011: The mechanization is verified, and two of its claims were false

- **Date:** 2026-09-27
- **Status:** accepted
- **Amends:** none; corrects the factual basis of D-010
- **Affects:** the merge pipeline on `main`, and the standing rule that a
  recorded claim names the thing it verified

### Context

The first end-to-end run of the D-010 pipeline surfaced four gaps. Two of
them were not gaps in the sense the draft assumed — they were claims about
the remote that were **false when written**.

1. `allow_auto_merge` was `false` on the repository, so the lane D-010
   delegated was never armed.
2. Protection on `main` did not exist. The classic branch-protection endpoint
   returned `404 Branch not protected`. This was found by a Step 0 stop
   condition, not by inspection.
3. The force-push pattern was said to punish the lease variant.
4. Deletion control was said to deny legitimate scratch-file cleanup.

Gaps 1 and 2 are real and are now closed. Gaps 3 and 4 did not survive
contact with the code, and the record says so rather than the other way
round:

- **Gap 3 was already closed.** The force-push control is not in
  `.pi/neurofebric-policy.json` at all. It is an entry in
  `DESTRUCTIVE_PATTERNS` at `platform/core/policy.ts:74`, and it already
  carries the negative lookahead the draft asked to have added. Verified by
  evaluating the exported array against both forms: the bare form is DENIED
  and the with-lease form is ALLOWED. The draft's ground — "the bare pattern
  punished the safest variant identically to the dangerous one" — describes a
  state the repository had already left.
- **Gap 4 is a design property, not a defect.** `destructiveCommandTokens` is
  a deny-only whole-token list, evaluated at step 4 of 6 in
  `platform/core/configured-policy.ts`, before `fileRules` is reached. The
  schema has no permit concept, and the policy file's own comment states the
  rule these rules obey: they "can only ever REMOVE a permission." A
  narrow scratch-file allowance is therefore not a config amendment; it is a
  new capability in the engine.

### Decision

1. **`allow_auto_merge` is enabled.** An operator action, recorded here as the
   operator action it was. Verified `true` on the repository.
2. **Protection on `main` is a ruleset, not classic branch protection.**
   Ruleset `24072761`, "Protect main branch", `enforcement: active`, condition
   `refs/heads/main` and nothing else. Four rules: `deletion`,
   `required_status_checks`, `pull_request` (zero required approvals, all
   review flags false, merge/squash/rebase allowed), `non_fast_forward`.
   Bypass actor `5`, `RepositoryRole`, `always`. D-010's substantive claim —
   `main` is protected and accepts no direct push — **is now true on the
   remote**. Its wording named the classic endpoint; the mechanism is the
   rulesets API. The claim holds; the vocabulary did not.
3. **The force-push with-lease allowance is a verification, not an
   amendment.** It is in effect, it is correct, and nothing was changed. See
   Open item 1 for the part of the force-push surface that is not covered.
4. **The narrow scratch-file deletion allowance is dropped from this decision
   and escalated to the operator as a D-012 candidate.** No policy file edit,
   no engine change. An agent does not add a permit concept to a guard it is
   trying to widen.

No file other than this record was changed by this decision. In particular
`.pi/neurofebric-policy.json` and `platform/core/policy.ts` are untouched.

### Rationale

1. **A correction that leaves the original text alone is still a
   correction.** D-010 was written before the protection existed and
   described the intended state as though it were the actual one. That is the
   F-006 defect one level up: a limit declared on a public interface and
   enforced by nothing. The honest fix is not to re-word D-010 into looking
   right, but to record the difference and let the reader see that it
   happened.
2. **The halt was the control system working.** The draft asked for two
   policy edits. One had no target in the file it named; the other was not
   expressible in the format it named. Neither was a guard failure and
   neither was a reason to improvise — the correct response to an
   unsatisfiable instruction is to stop, which is what happened. The task was
   then ended by `maxToolCallsPerTask: 40` with the scratch file from that
   verification still uncommitted, which is the same control working again,
   independently.
3. **"Verified" is a stronger word than "amended" and should be rarer.**
   Recording an amendment for a control already in force would inflate the
   change history with edits that changed nothing, and would train the reader
   to expect policy churn where the accurate answer is that the control was
   already correct.

### Consequence

**Every claim about remote state names the endpoint it was read from, and
the endpoint is checked for existence before its answer is believed.** The
legacy branch-protection endpoint returning `404` is not evidence that
protection is absent; it is evidence that protection is absent *from that
endpoint*. The same run also expected three merged branches to have been
auto-deleted, and the correct explanation was that only branches merged after
`delete_branch_on_merge` was enabled are deleted. Both errors were naming
errors, and neither would have been caught by a check that assumes the answer
it expects.

### Open items

1. **The `+refspec` force-push form is ALLOWED.** `git push origin +main`
   carries no force flag, so `DESTRUCTIVE_PATTERNS` does not match it.
   Combined with the ruleset's `always` bypass actor, the TypeScript pattern
   is the only force-push control acting on the agent identity. The with-lease
   form is safe by mechanism; the `+refspec` form is safe by accident.
   D-012 candidate.
2. **`required_status_checks` in ruleset `24072761` lists the same context
   twice**, once with an `integration_id` and once without. Benign — the
   check exists and passes on `main`. Operator cleanup, not an agent task.
3. **The auto-merge lane is armed and unexercised.** PR #10 was merged by
   the operator via a direct merge while CLEAN, so the auto-merge path has
   never actually gated on a check. The first auto-merge against a non-CLEAN
   head is its first real test. **Closed by D-012:** the lane was exercised
   by PR #11 — auto-merge armed at 13:11:13Z, `mergeStateStatus` BLOCKED while
   `platform test suites` was IN_PROGRESS, fired unattended at 13:11:34Z on
   SUCCESS, merge commit `b618aff`, head branch auto-deleted. The lane worked
   as a gate, not as a formality.
4. **The `D-004` cross-references are dangling.** D-007 cites "D-004
   (operator-only policy changes)", but D-004's body is "Known issues" — the
   OmniRoute API key, the extension credential source, and the kernel binding
   contract. It does not state the operator-only principle it is cited for.
   The same D-007 passage already carries the honest version of the point as
   a known residual: the policy file sits inside the agent-writable
   boundary, so the operator-only rule is a convention rather than an
   enforced boundary. That residual is the substantive D-012 question;
   repairing the citation is bookkeeping.

### Alternatives rejected

- **Amending D-010's wording to say "ruleset" instead of "branch
  protection."** Rejected: the claim was never wrong about behaviour, only
  about vocabulary, and rewriting a superseded decision to read correctly
  destroys the evidence that the claim was once unverified.
- **Permanent operator force-push relief.** Rejected: the mechanism already
  distinguishes the safe variant from the dangerous one, so widening it would
  remove the control that works in order to relieve one that does not.
- **A blanket deletion allowance, or a narrow one implemented in the engine
  by the agent that needs it.** Rejected: the second is the exact shape of
  the incident D-010 names, where a guard blocking a task is the moment its
  boundary is most worth attacking. The narrow version is also not a config
  amendment, and recording it as one is how a real gap gets written down as
  closed.
- **Leaving protection unconfigured while claiming it.** Rejected as the
  standing alternative. It is what the pre-mechanization state was, and it
  is why the `404` was worth a stop condition in the first place.

## D-013: Operator rulings on the ruleset dedup, and a standing rule on verified inventory

- **Date:** 2026-09-27
- **Status:** accepted
- **Amends:** D-008 (new standing rule 4)
- **Affects:** every agent session that reports on this repository's state

### Context

Three findings reached the operator after D-012. One is closed housekeeping,
one is a correction to the agent's own reporting, and the third is a rule
that generalises the first two.

1. **The duplicated status-check context in ruleset 24072761** was tracked as
   operator action in D-012 ruling 4.
2. **A second inventory defect in the agent's own housekeeping.** D-012's
   closeout stated that two local branches remained from merged pull
   requests. That statement was asserted without a same-session enumeration.
   The branches had in fact been deleted before that run began; the first
   commit of that session would have shown it. The operator's cross-check
   caught it.
3. **The two inventory defects point in opposite directions.** D-011's
   enumeration omitted two stale branches, which flattered the report by
   implying a cleaner state than existed. The D-012 claim asserted branches
   that were no longer there. Both were caught only by operator cross-check,
   and both were about local repository state rather than about any control
   the platform enforces.

D-008 established standing rules for agent-driven git operations because a
guard that is not consulted gets bypassed. The pattern here is different and
needs its own rule: nothing enforced these two statements, and the platform
had no opportunity to catch either one.

### Decision

1. **The ruleset dedup is CLOSED.** The operator completed an API write on
   2026-09-27 at 19:07:56 +05:30. Ruleset 24072761 now carries exactly one
   required status check: the context `platform test suites` with
   `integration_id` 15368. Evidence is the operator's full-state dump taken
   after the write. This closes D-012 ruling 4 and its open item 2. Operator
   action; no agent work.
2. **The second inventory defect is recorded and closed.** No remediation.
   `chore/d011-mechanization-completion` was deleted before the D-012 run
   began, at the first command of that session, and the closeout stated its
   presence anyway. The attribution is the agent's: the claim was made from a
   prior read rather than from same-session output.
3. **Standing rule 4 is added to D-008.** Claims about local repository state
   — branches, files, working tree — require same-session command output. No
   assertion about that state is made from memory or from a prior session's
   read. The rule applies to the agent immediately and without exception,
   including inside an operator brief that supplies such a claim as settled.
   Rationale: two inventory defects in one day, of opposite sign, neither
   caught by any automated control, both caught by operator cross-check.

### Rationale

1. **A closed item should say so once and stop.** The dedup was operator work
   with operator evidence. Recording the closure with the timestamp and the
   surviving check identity is enough; re-deriving it would repeat the
   mistake D-010 corrected, where a remote claim was recorded without naming
   the endpoint it came from.
2. **The two defects are worth recording together, not separately.** Neither
   is serious on its own. Together they show that a report about local state
   has no enforcement behind it at all, which is the condition a standing rule
   is the right response to. One omission and one stale assertion, in
   opposite directions, both surviving to the operator, is a reliability
   finding about the agent's reporting rather than about either repository.
3. **The rule is about evidence, not about caution.** The failure is not that
   the agent was careless; it is that a confident sentence and a checked
   sentence look identical to the reader. Requiring the output to exist
   before the claim does removes the ambiguity, and it is verifiable: the
   claim either has command output behind it in the same session or it does
   not.

### Consequence

**A statement about local state is either accompanied by same-session command
output or it is not made.** The burden falls on the claim, not on the reader
who might otherwise verify it. This applies to closeout summaries, PR
descriptions, decision records, and anything a later session would rely on.

**An operator brief does not launder an unverified claim.** Rule 4 binds the
agent even where a brief presents a local-state claim as pre-verified, for
the same reason the fences bind: the claim is either evidenced or it is
nonsense, and a brief cannot supply evidence the session did not produce.

### Open items

1. **The `+refspec` force-push hole remains open.** D-012 accepted it; the
   fix is operator-coded and pending. This decision does not change that
   state. A specification for the fix is recorded in
   `docs/REFSPEC_GUARD_SPEC.md`, which proposes an anchor, a measured
   behavior matrix, an implementer protocol, and a rollback. It implements
   nothing.
2. Nothing else. Rulings 1 and 2 are closed, and the third is a rule rather
   than a task.

### Alternatives rejected

- **Leave the standing rules as they were, on the grounds that a convention
  was enough.** Rejected: a convention is what the two defects were written
  against, and neither was caught by the platform. The rule's whole content is
  that the evidence must exist, and that is checkable.
- **Record the two inventory defects as one entry.** Rejected: they have
  opposite signs, and collapsing them would hide the more useful half — that
  the agent's own closeout can over-report as easily as it under-reports.
- **Re-verify the ruleset dedup as part of this record.** Rejected: it is
  operator-completed with operator evidence, and re-deriving a settled
  operator action is the habit D-010's correction was about.


## D-012: Operator rulings on the residual force-push, deletion, and boundary findings

- **Date:** 2026-09-27
- **Status:** accepted
- **Amends:** D-007 (citation repair), D-011 (Open item 3 closed)
- **Affects:** the force-push control acting on the agent identity, the
  configured policy schema, and the standing claim that an agent does not
  edit its own policy file

### Context

D-011's verification run, and the halt that preceded it, produced five
findings. The operator has ruled on all five. One is a defect that is
accepted but **not fixed**; one is a design proposal rejected on the merits;
one is a limitation accepted permanently and honestly; one is operator
housekeeping; and one is a correction to the agent's own reporting.

1. **A hole in the force-push control.** The `+refspec` force-push form
   carries no force flag, so it is not matched by `DESTRUCTIVE_PATTERNS`.
2. **Scratch-file deletion is denied by design.** The configured policy has
   no permit concept, so a narrow allowance could only be added by building
   one into the engine.
3. **The operator-only boundary is a convention.** The policy file sits
   inside the agent-writable boundary, so the rule that agents do not edit it
   is honoured rather than enforced.
4. **A duplicated status-check context** in ruleset 24072761.
5. **An inventory defect in the agent's own halt report.** That report
   enumerated the local branches and omitted two that predated it and were
   tracking refs to since-deleted remotes. Both are resolved: the corrections
   pull request was merged, and the hardening commit was squash-merged as
   `194e03c`, verified by the operator via `git cherry`.

Findings 1 through 4 are statements about the engineering. Finding 5 is about
the accuracy of the record, and it is written down for the same reason
D-010's correction is: a verification that is wrong about what it checked is
worse than no verification, because the next reader trusts it.

### Decision

1. **The `+refspec` force-push hole is accepted as real and left open.**
   The fix is to extend `DESTRUCTIVE_PATTERNS` in `platform/core/policy.ts`.
   That work is operator-coded, outside agent scope, and pending. This
   decision records the acceptance, not a fix, and the repository makes no
   claim to be closed.
2. **The permit concept for scratch-file deletion is rejected.** The
   configured policy stays deny-only. The operator's rationale is auditability
   over convenience, and the price of the denial is one manual removal per
   scratch file.
3. **The operator-only boundary is accepted as a convention, and recorded as
   one.** The policy file remains inside the agent-writable boundary. Agents
   are expected not to edit it. Nothing enforces that, and this record does
   not pretend otherwise. D-007's residual note already said so; that note is
   now the ruling rather than a known issue.
4. **The duplicated status-check context is operator API cleanup**, tracked
   separately. No agent work.
5. **The inventory inaccuracy is recorded and closed.** No remediation and no
   branch cleanup: both omitted branches are already resolved.

### Rationale

1. **An accepted finding and a fixed finding are different states, and the
   record must not blur them.** The force-push surface shows why the
   distinction is load-bearing. The ruleset carries an `always` bypass actor,
   so platform-level protection does not constrain the agent identity on this
   path, and the TypeScript pattern is the only control acting there. Today
   the with-lease form is refused by mechanism and the `+refspec` form is
   permitted by accident. One of those is a decision and the other is an
   oversight that happens to be harmless, but only one of them is doing the
   work. Writing "closed" would put a claim in the permanent record for a
   change that does not exist in the tree.
2. **A deny-only schema is a defensible design, not a missing feature.** The
   absence of a permit concept is what makes the policy file auditable by
   reading it: every rule in it can only remove access, so the file cannot
   contain a hidden allowance. Adding a permit path for scratch files trades
   that property for the convenience of not asking an operator to remove a
   file.
3. **A convention recorded as a convention is worth more than one recorded as
   a control.** The earlier temptation was to write that agents may not edit
   the policy and let the reader assume the boundary held. D-011 declined to
   amend the citation that implied otherwise. The honest form costs nothing,
   and it is the only form a reader can act on.
4. **The agent's own inventory was wrong, and the error ran in the flattering
   direction.** Both omitted branches were merged and stale, so leaving them
   out implied a cleaner state than existed. Errors that understate what is
   outstanding are the ones worth writing down.

### Consequence

**An accepted finding is reported as open everywhere it appears**, including
in the summary a later session reads first. Until `DESTRUCTIVE_PATTERNS`
covers the `+refspec` form, the force-push control for the agent identity is
known to under-cover, and a session deciding whether that is safe is told it
is not fully covered rather than left to infer completeness from a pattern
list that reads as exhaustive.

**The operator-only boundary is now stated in three places and enforced in
none.** The citation that misattributed it to a decision about known issues
has been repaired, and the residual is recorded as a residual.

### Open items

1. **The `+refspec` hole is open.** Operator-coded implementation pending.
   The control is to be treated as incomplete until that change lands.
2. **Status-check context cleanup** in ruleset 24072761 is operator action,
   tracked outside this record.

### Alternatives rejected

- **Record finding 1 as fixed, pending implementation.** Rejected: it would
  place a completed-looking claim in the permanent record for a change not in
  the tree, and the next session to read it would have no reason to check.
- **Add a narrowly scoped permit for scratch files, since the boundary case
  is easy to state.** Rejected on the operator's rationale, auditability over
  convenience. The denial costs one manual removal per scratch file — paid
  rarely and visibly — against a property that would be given up silently and
  permanently.
- **Enforce the operator-only boundary by moving the policy file out of the
  agent-writable boundary.** Not rejected on merit, but not adopted here. The
  ruling is to record the boundary as a convention, and relocating the file
  is a separate decision with its own costs to the gauntlet workflow.
- **Leave the dangling citation in place as a known issue.** Rejected: it is
  a one-line repair, the dangling pointer actively misdirects a reader away
  from the residual that already states the position correctly, and that
  residual is what this decision now rules on.

## D-014: Refspec guard verification, spec reconciliation, halt inventory

- **Date:** 2026-09-27
- **Status:** Accepted
- **Amends:** D-012 ruling 1 (compensation executed — ruling 1)

### Rulings (operator, verbatim)

1. D-012 ruling 1 AMENDED: the +refspec fix was agent-coded. Compensation
   held: PR #15 did not ride --auto; the operator reviewed the diff and
   merged manually.
2. Matrix extended 8 -> 9 rows; row 9 (quote-wrapped "+main" must DENY) is
   the operator addendum, implemented and CI-enforced.
3. Adjacent gap remains OPEN for operator ruling:
   `git push origin :refs/heads/main` (delete-refspec) is unguarded.
4. The matrix is committed as `platform/core/refspec-guard.test.ts`; the
   ruleset's required check enforces all 9 rows from merge onward.
5. Shipped pattern stands over spec §2's proposal: `.*` was mandated in
   place of `[^|]*`; the pipe-guard design point is superseded.
6. §5 staleness corrected: nine rows; matrix lives in
   `platform/core/refspec-guard.test.ts`.
   [Superseded — survey #4 N-3: the D-014-era nine-row figure gives way to
   the eleven-row final state recorded in D-015.]
7. Grep self-denial recorded: the guard denies mentions, not only acts.
   Deny-safe; refinement deferred, no action.
8. Implementation-run halt recorded: budget exhaustion at PR creation;
   verbatim reporting; no identifiers invented; drafted PR body overclaim
   ("local run + CI") self-flagged and corrected pre-open.
9. Count settled via PR #14: six entries (D-008 through D-013).

### Implementation and verification

- PR #15, squash-merged by the operator without --auto after diff review.
  Pattern added to `DESTRUCTIVE_PATTERNS` (26 -> 27):

  `/\bgit\s+push\b.*(?:\s|["'])\+\S/i`

- CI on PR #15: green (operator-attested) — the witnessed after-column.
- Blinded re-run (D-014 v1 session, operator-attested; clean checkout at
  2301760; expected results derived from the spec before evaluating the
  landed code; standalone script in .git/ importing the exported patterns;
  27 entries confirmed): all 9 rows measured on target.
- Spot-check (D-014 v2 session, verbatim): 9/9 pass, 0 fail
  (`node --experimental-strip-types --test platform/core/refspec-guard.test.ts`).
- Spec reconciled (D-014 v2 session): §2 documents the shipped pattern and
  supersedes the pipe-guard design point; §5 corrected to nine rows and
  `platform/core/refspec-guard.test.ts`.

### Independence statement

The implementation was agent-authored; this verification rests on the
operator's pre-merge diff review plus this clean-checkout re-run. This
record does not claim two independent agent proofs.

### Session events

- Leftover throwaway verification script `.git/verify_refspec.ts`: removal
  was blocked by policy (`rm` denied); disclosed proactively by the agent;
  removed by the operator post-halt. Recorded as a known property:
  deny-safe policy creates operator cleanup debt; sandbox with allowlisted
  cleanup is a deferred improvement.
- Second artifact of the same class, `.lit.tmp` (35 bytes, the canonical
  literal extracted from spec line 39 for byte-verification): removal
  likewise blocked by policy; disclosed proactively; removed by the operator
  before this transcription.

### Halt inventory (terminal session halts, project to date)

1. Pre-D-012 integrity halt: halted rather than write unsubstantiated
   claims into the record.
2. Implementation run: budget exhaustion at PR creation.
3. D-014 v1: task 3, spec edit (edit-anchor failure; remedied by reading
   exact bytes and reissuing).
4. D-014 v2: task 3, record write (self-reported as "halt #3"; corrected
   here — this inventory governs).
5. D-014 v4: record write — refused twice by the policy guard (two
   different matched words, both false positives); session terminated by
   the harness before the verification battery ran.

All five: verbatim reporting, no identifiers invented. Zero fabricated
claims across five terminations. Voluntary guard and check stops that did
not terminate a session are recorded in the §2 fidelity section and the
transcription note.

### §2 fidelity check and operator amendment

- The v3 finish session stopped per brief at the §2 check: the contiguous
  delimited literal was absent from the spec — the fenced block carried the
  pattern body without delimiters or flag, and the design-point bullet's
  code span lacked the leading `/`. The agent declined to adjudicate between
  strict and substantive readings and reported verbatim; correct.
- Operator ruling: strict reading upheld. The remedy reported as applied and
  committed by the operator was absent from this checkout at the task-1
  re-check — the agent stopped and reported verbatim; no amendment commit
  existed on `chore/d014-refspec-verification` and HEAD was unchanged at
  2301760. The operator, unable to apply the remedy directly, explicitly
  cleared the agent to apply it in this checkout. Applied by the agent
  under that clearance: fence relabeled 'Shipped pattern:' and given the
  full literal `/\bgit\s+push\b.*(?:\s|["'])\+\S/i`; leading `/` restored in
  the design-point bullet. The pre-existing uncommitted spec diff (4
  insertions, 5 deletions, on record from the prior session) was committed
  unchanged beforehand (94e5501). Re-verified by fixed-string grep (2 hits)
  and committed on `chore/d014-refspec-verification` (19ef8d5) immediately
  before transcription.
- Also recorded: a POSIX-style `cd` was blocked by the path-boundary guard
  in the v3 session and re-issued with the native path — same class as the
  `/tmp` block; guard functioning as designed.
- Transcription note (operator-supplied, second revision): The policy guard
  refused the first two attempts to write this record: a write-pattern rule
  matched words from the guard's own detection vocabulary, which appeared in
  the operator-supplied note as ordinary governance prose — false
  positives; nothing the rule exists to catch was present. Per the D-008
  standing rules the agent did not obfuscate or work around the guard; it
  stopped and reported verbatim both times, and the operator adjudicated.
  No guard rule was modified. The operator supplied two successive
  meaning-preserving rewordings of the note; this second revision is the
  text of record. The matched words are preserved verbatim in the
  operator's session archive and are deliberately not reproduced here, so
  that this record does not re-trigger the guard. Separately: operator-side
  instruction text at one point rendered the pattern literal with a lost
  backslash before the plus — a channel rendering artifact, not a change to
  the pattern; the canonical literal is the one transcribed above, and it is
  what the fixed-string check verified.

## D-015: Refspec guard: branch-removal coverage and spec sync

- **Date:** 2026-09-27
- **Status:** CLOSED
- **Amends:** D-014
- **Affects:** `platform/core/policy.ts`, `platform/core/refspec-guard.test.ts`,
  `docs/REFSPEC_GUARD_SPEC.md`

Terminal state: main at `c2e2a9f`. PRs: #17 — implementation and spec sync, five
commits, merged at `ab43f84`. #18 — line-54 remediation, one word, merged at
`c2e2a9f`. Coverage at close: 29 `DESTRUCTIVE_PATTERNS` entries, 11 evaluation
rows, 314/314 platform suite measured locally on merged main, matching CI.

### Shipped
Pattern 28 (0-based 27): the --delete branch-removal flag form.
Pattern 29 (0-based 28): the empty-source colon form (:main).
Rows 10 and 11 as assertions in platform/core/refspec-guard.test.ts.
docs/REFSPEC_GUARD_SPEC.md synced to shipped state: section 2 heading, opening paragraph, closing sentence, counts, and vocabulary reconciled across five commits; voice sweep closed verified.
### The eleven rows (final state)
plain push allowed; 2. +main denied; 3. +refs/heads/main denied; 4. +HEAD:main denied; 5. --force denied; 6. --force-with-lease on a plain refspec allowed; 7. with-lease does not license a + refspec; 8. + inside a branch name allowed; 9. quote-wrapped "+main" denied; 10. --delete denied; 11. empty-source colon form denied.
### Process record
Defect classes, operator-authored briefs, with remediations:

Logic — the X1 contradiction (D-014): contradictory test assertions in an operator-authored brief, caught by the suite. Remediation: contradiction checks before assertion.

Location — file indentation read from a rendered report instead of the raw file. Remediation: raw-file reads for file claims.

Environmental — PowerShell 5.1 mangle lane (quote and backtick stripping, lost characters). Remediation: channel-defensive ASCII composition for the shell lane.

Vocabulary — "measured" written where "target" was the defined term. Remediation: the vocabulary-class rule — check term definitions before inserting a word.

Channel taxonomy: mangle / misauthor / mistarget, with parse-safety and scratch-script sub-lessons.

Four-layer self-catching chain: the guard caught a self-synthesized plus; the suite caught X1; the read-back caught the vocabulary error; process verification caught the premature closure. Each layer caught its own author once.

Self-guarding milestone (D-014): zero guard blocks across a session of self-authored patterns.

Positive-control rule (canonized this arc): a clean result is evidence only from an instrument that has demonstrated it can detect a known hit. First self-caught instance: an anchored class-(a) regex silently missed the two lines that matter; caught mid-pass before a false clean could close the sweep. Prior instances of the measures-nothing class: eyeball-26, the premature sweep closure.

Closure predicate (corrected this arc): a sweep closes when every hit is fixed or covered by a standing adjudication — not when the raw pass is empty. The original predicate was unreachable while standing-ruled items remain, and is acknowledged as an operator drafting defect.

Standing rules reaffirmed: flag-don't-decide; fence-as-maximum; care with conditional instructions; report discipline — deviations at top, verbatim read-backs, state checks before and after; rollback prose is required-behavior wording, not instruction — classified no-hit, standing.

Count verification graduated from attestation to verification: every count checked against the tree before reporting.

Contradictions cluster: three commits reconciled one section — at its heading, its opening, and its closing.

The line-54 gap: the adjudicated fix was absent from PR 17's merge. Found by diffstat audit: 109 insertions and 15 deletions equals the exact sum of the five reported commits; no sixth-commit report exists; the branch tip at deletion was b9d8b05. Ruled a sequence jump on the measured facts: the merge ran ahead of its stated gate and the sixth session never ran. Whether the skip was deliberate was not specified by the operator; observable facts and remediation are identical either way. Remediated by PR 18 (proposes to states, discipline clause verbatim). Third member of the closure-claims family: premature closure, unreachable predicate, merge ahead of the final fix.

Platform facts: delete_branch_on_merge is enabled — remote branch cleanup is retired from every merge sequence. Objective-already-achieved failure class canonized: an error reports the command's failure, not the goal's status; verify the goal state before treating an error as a problem.

Halts: six.

Record-session defects: this record was composed without first surveying the
house D-record format, and its merge ran ahead of its restyle. Both are logged
here rather than corrected silently; the restyle is the second commit on the
entry.

Timeline: measured from commit and CI timestamps — PR 17 CI completed 2026-09-27T16:14:42Z; PR 18 merged the same day at c2e2a9f. Operator timeline testimony was not supplied at close; addenda may ride on this plane.

## D-016: Credentials Vault — intake record, config-amendment provenance, and the fixture carve-out

- **Date:** 2026-09-28
- **Status:** IMPLEMENTED (closes on merge)
- **Plane:** Safety (home); touches Execution, Knowledge, Control
- **Amends:** none
- **Affects:** `platform/core/vault.ts`, `platform/core/vault.test.ts`,
  `platform/core/vault-redaction.test.ts`, `platform/core/policy-config.ts`
  (limit-profile surface), `platform/pi/vault-tools.ts`,
  `platform/pi/vault-boundary.test.ts`, `platform/pi/kernel-adapter.ts`,
  `.gitignore`, `docs/DECISIONS.md`, `memory/standing-clauses.md`,
  `docs/handoff.md`, `SUMMARY.md`
- **Not affected, by design:** `platform/pi/policy-port.test.ts` — see the
  fixture ruling and the limit saga below

### Task

Vault for credential material: storage, retrieval, redaction integration, and
tool-registry wiring. This record is opened by the floor-repair PR; the build
itself follows the D-016 intake issue.

### Prerequisites

- PR #20 MERGED.
- PR #21 MERGED at `4bca4f2` (config amendment; survey #3 set S6 — the third
  entry of the write-pattern list scoped).
- Session restart complete.
- This record opens in the floor-repair PR.

### Rulings (operator; verbatim literal source: PR #21's diff)

Abstract transcription only. The literal shape is not reproduced here; cite
PR #21 to read it. Siblings are cited as entries one, two, and four.

1. The third entry of the write-pattern list is scoped by a trailing colon
   character.
2. Deny coverage D1 through D4 is preserved.
3. Residual documentation-prose shapes stay blocked. Where a shape is
   conceded, the author discloses it and rewords; it is not silently
   admitted.
4. A missed deny is worse than a blocked sentence.
5. The redaction plane backstops the conceded shape.

### Fixture ruling

`platform/pi/policy-port.test.ts:35` (`LEGACY_RULES`) retains the un-scoped
third entry BY DESIGN. It is an engine-behavior fixture, not a copy of the
committed config. It is consumed by tests 3a, 3b, 3c, 3d, and 6, pinning
deny-on-write / allow-on-read-search semantics against the maximally-strict
legacy shape, independent of the committed config. It is never synchronized
with the config.

### Open-question rulings (operator; abstract transcription)

Abstract transcription only, in the same form as the ruling set above. The
literal shape is not reproduced here; cite the source to read it. The
sequence is OQ-1 through OQ-4.

1. **OQ-1 — residual risk is accepted.** The residual exposures named in the
   survey are not remediated in this arc and are carried knowingly. The
   acceptance is scoped to the vault file and to nothing else.
2. **OQ-2** — the reveal path stays split; see R-2.
3. **OQ-3** — the stored-file lifecycle stays as built; see R-3.
4. **OQ-4 — retired.** The whole-object pin question is closed as a question.
   The disposition is stated plainly, because it is not the same as done:
   `platform/pi/trusted-execution.test.ts` was **not touched** in this arc —
   it is a zero-touch path — so the survey #4 S-1 narrowing of the pin at
   line 182 was **not performed**. The question retires; the narrowing stays
   unperformed backlog, and the corresponding open item below stays open.

### Acceptance criteria A1 through A7

1. **A1** — the store persists credential material to the operator-designated
   path. The file is created on first store, never at construction: an empty
   vault has no file on disk.
2. **A2** — metadata is free. Listing and describing return names and
   metadata and never expose a value.
3. **A3** — retrieval is gated twice over, by mode and by approval; see R-1
   and R-2.
4. **A4** — enablement is a vault block in the committed policy, and the
   block **ships absent**. The vault is dark on merge.
5. **A5** — every event surface the vault writes to is redaction-sink-wrapped.
6. **A6** — the tools are registered through the kernel adapter and run under
   policy tier like any other tool.
7. **A7 — reconciled OUT.** The full sequence is recorded, since this one
   moved five times: the criterion was **original**ly proposed as an
   acceptance requirement; it then met a **P-1 contradiction** when the
   ported surface did not support it; it was **amended by R-1** to a form
   the surface did support; an **unruled scan** was run to test whether the
   amended form was already ruled on elsewhere in this record, and it was not
   — the scan returned nothing governing it, so **silence was not authority**
   and the item was not closed on the scan; it was finally **reconciled OUT**
   on operator ruling. A7 is not an acceptance criterion of the shipped
   build. It is recorded here because the path to "no" is the auditable
   part.

### Rulings from the build round (operator)

**R-1 — the reveal path is split, and one branch of the split is absolute.**
A reveal is a distinct operation from a retrieve. A retrieve in redacted mode
returns a masked form and stays masked.

**R-2 — mode outranks approval.** When `retrieveMode` is `redacted`, the
store **refuses the reveal**, and it refuses it *even after* a per-call
approval has been granted. Approval is a gate on a permitted operation, not
a key that unlocks a forbidden one; granting approval cannot raise the mode.
This is a mode-level refusal, not a policy denial, and the two are
distinguished in the tool's reason output.

**R-3 — as built.** The file is created on first store and never before; a
vault that has stored nothing has no file, and `vault_list` over a
never-written vault returns empty rather than inventing a source.

### Enablement runbook (operator hands)

Enablement is operator work. The agent does not perform it, and D-004 holds
throughout.

1. Add a vault block to the committed policy, with `enabled: true` (per A4).
2. Point the block at the store path. Configuration reaches the store either
   through the `setVault` constructor argument or the equivalent setter; both
   are operator-supplied choices, and neither has an agent-side default that
   silently activates a store.
3. The file is **created on first store**. Until something is stored there is
   no file, and that is correct — **the vault starts EMPTY and must not carry
   a stray file.**
4. `retrieveMode` semantics are R-1/R-2: `redacted` masks and refuses a
   reveal even under per-call approval. The revealed branch is the only path
   to a value, and it is the one the redaction plane does not cover — by
   design, and by ruling.

### Limit saga (disclosed)

The operator raised `maxToolCallsPerTask` from **40 to 80** by operator
hands, and committed the change on this branch **together with the paired pin
update**, dated and disclosed here. `maxFileWritesPerTask` (10) and
`maxBytesPerWrite` (2,000,000) were not raised.

**The pin break was the pin working.** The raise collided with the legacy
limit pin; the agent correctly refused both available remedies — the first
under D-004, the second as a zero-touch violation — and the resolution was
operator hands on both counts. The refusal was the correct outcome, and it is
recorded here rather than smoothed over.

`platform/pi/policy-port.test.ts` was touched **by operator hands only**, in
the chore commit `d417a6d`. The line-35 fixture is **untouched**; the clause
1 ruling and the fixture ruling above stand without exception.

**Stray-file cleanup.** Two stray synthetic files had been written into
`workspace/vault/`, and phantom `vault_list` entries were once enabled by
them. The sandbox-root harness fix stands; the operator deleted the
droppings. `workspace/vault/` is verified empty on this branch.

**check-ignore disposition:** operator-executed, result pending. The
`.gitignore` entries (+5) are committed in this arc; the operator appended
the result of the `check-ignore` run against them, and this record is updated
on receipt.

**Budgets derive from the measured limits, not from a carried number.** The
two supplier budget defects are named, as in prior rounds: a budget quoted
from an unmeasured figure, and a budget quoted from a stale anchor after a
count moved. Both are the same kind of defect, and the remedy is the same —
re-measure, then state the number.

**Seal 17.**

### Open items

- D-016b — loader survey, to follow D-016.
- D-017 — loop, parked.
- CI has no Node pin.
- `platform/pi/trusted-execution.test.ts:182` — whole-object pin, to be
  narrowed at D-016's first touch of the project config (survey #4 S-1).
- OmniRoute — RESOLVED local-only via PR #22 (`d0c061f`). The stale local
  worktree is retained by design, ignored, and its untracked content is
  preserved.
- Guard path-extraction false-positives on prose inside bash command text —
  three occurrences (D-014 v4 x2, floor-repair x1). Candidate remedy in the
  guard layer's command-text path scanning; scope: D-016b loader survey or a
  dedicated micro-task; not addressed here.

### Process notes

(i) **Write-lane rule, canonized.** A denial is never routed around on the
agent's own initiative. The only permitted path is operator-directed,
verbatim, and disclosed. "I worked around it" is itself the violation.
Operator-supplied commands use the least-destructive sufficient form.

(ii) **D-004 carve-out.** The note-line tab alignment executed under an
explicit one-time operator grant: the command was operator-authored, the
agent executed it verbatim, and the action is disclosed here. The alignment
copied four spaces from a sibling measurement, and the JSON was re-validated
afterwards. D-004 otherwise stands.

(iii) **Provenance.** PR #22 was executed by operator hands between briefs. It
merged at `d0c061f`, was reconciled in pre-flight, and was re-verified in the
floor-repair PR's own pre-flight.

(iv) **Supplier-side defect ledger** — five entries this arc, all disclosed:
a single-quote assumption (PRE-CHECK A); asserted indents, which forced a
sibling-measurement rewrite; an uncounted 73-character commit subject, caught
by the guard layer; a JSON-shaped replacement issued into a TypeScript array
literal, which passed every diff gate and surfaced only in CI (the local-test
gate is now canonized in consequence); and a force-delete where safe-delete
sufficed, caught by the deletion guard at zero cost.

**Canonized:** operator-supplied verbatim text is code. It is measured before
issuance and executed only after local verification.

(v) **Channel grant.** The record, clause, restamp, and hygiene writes in this
PR were executed via the write-tier tool under an explicit one-time operator
grant, after the bash-heredoc channel was denied by a `fileRules` false
positive: the guard path-scanned command text and extracted a prose
possessive as a path candidate. Third occurrence of the class; D-014 v4 logged
two. The write-tier channel applies the checks the policy designs for content
payloads; the grant is channel-scoped and dies with this PR; the systemic
guard fix is an open item.

(vi) **Rewording disclosure.** Every ruling above is an abstract transcription
of operator text, not the operator's own words. The transformations are:
literal shape to bracketed or abstract description; the deny-coverage range
given as a named span; and the sibling sequence given as entries one, two,
and four. No ruling was changed in substance, added, or dropped.

### Cross-references

- D-016 intake issue.
- PR #21 (`4bca4f2`) — config amendment, S6 provenance.
- PR #22 (`d0c061f`) — OmniRoute local-only.
- Pin chain: `72412c7`, `77ae3fd`, `d1e9157`.
- Survey #4.

---

## D-017: The credentials vault stays unwired — ARCHITECTURAL DECISION, INTENTIONALLY UNWIRED

- **Date:** 2026-09-28
- **Status:** architectural decision — intentionally unwired
- **Affects:** `platform/core/vault.ts`, `platform/pi/vault-tools.ts`, the
  production extension, and any future claim that the vault is a live control
- **Supersedes:** nothing. D-016 built the vault; this decides its deployment.

### Context

D-016 built a credentials vault: five tool descriptors, per-call approval on
unredacted reads, redaction on every audit event, and a boundary around the
declared output. Phase L of the hardening backlog asked two questions: can
enabling the vault bypass the core security model, and is it actually
reachable in production.

### Decision

**The vault is NOT wired into the production extension. Leave it exactly as it
is.** The capability remains built, tested, and safe by construction. No wiring
is to be implemented.

### Rationale and evidence

**1. Enabling it cannot bypass the core security model.**

- Vault tools are ordinary `ToolDescriptor` values registered in the kernel
  registry. They reach execution through the same `precheckToolCall` choke
  point as every other tool, so no control is skipped by being a vault tool.
- `vault_reveal` is declared CONTROLLED tier. The measured policy engine
  therefore returns `REQUIRE_APPROVAL` for it on every call, and the approval is
  recorded in the precheck trace before the handler runs.
- **No vault tool accepts a path parameter.** The vault file location comes
  from operator configuration, never from tool input, so there is no
  tool-supplied path for the workspace boundary to miss.
- The value field of `vault_store` sits outside the engine's content write scan
  by design. This is not reopened here: a local deny-scan could only fire on a
  store the operator had already approved, so the approval is the sanction. It
  was reasoned in D-016.

**2. It is doubly unreachable in production — two independent conditions, both
holding.**

- The extension constructs `new KernelAdapter()` with no vault wiring and never
  calls `setVault`.
- The committed policy document carries no `vault` block.

Because the conditions are independent, adding a `vault` block to the policy
alone would still not make the tools reachable. This is stronger than "ships
dark by configuration".

**3. No product requirement justifies the exposure.** Wiring a
credential-revealing surface into the default execution path is a security
posture change. The vault is safe today precisely because it is unreachable.

### Consequences

- **The vault is NOT a live production control and must never be described as
  one.** Any documentation, report, or operator briefing implying the vault
  currently protects credentials is wrong and must be corrected.
- The capability is retained deliberately. It is not accidental dead code: it
  is a built, tested, deliberately undeployed capability.
- **Enabling it requires explicit future operator sign-off plus a security
  review of the wiring itself.** That review must cover at minimum: the
  `setVault` call site, whether the operator-supplied vault path should itself
  be subject to the workspace boundary, and whether the `retrieveMode` default
  is safe for a live deployment.

### Alternatives considered

- **Wire it now.** Rejected. It would put a value-disclosing tool on the default
  path with no product requirement behind it, converting a safe capability into
  an active one.
- **Delete the vault.** Rejected. The capability is correct and its tests are an
  asset. Deleting reviewed, tested security code to solve a documentation
  problem is the wrong trade; this record addresses the documentation instead.
- **Leave the status ambiguous.** Rejected. Ambiguity is what let the question
  go unanswered through two hardening phases.

### Migration

None. This record changes no behaviour and no code. It closes Phase L.

### Verification

- Reachability: `platform/pi/kernel-adapter.ts` builds the vault descriptor list
  from `vaultToolsEnabled(this.vault)`, and `this.vault` is only ever set by
  the constructor option or by `setVault`. Neither is reached from the
  extension.
- Control posture: `platform/pi/vault-boundary.test.ts` drives the descriptors
  through `precheckToolCall` and pins the CONTROLLED-tier approval.
- Residual limitation 7 in `docs/SECURITY.md` records the same fact for
  operators who read the security document rather than the decision log.

### Cross-references

- D-016 — the vault intake record this decision disposes of.
- `docs/SECURITY.md` residual limitations 7 and 8.
- `docs/handoff.md`, "Enforced versus declared".

## D-018: Harness budgets raised to 120 tool calls and 30 file writes

- **Date:** 2026-09-28
- **Status:** harness policy — operator-owned, agent-read-only
- **Affects:** `.pi/neurofebric-policy.json`, `platform/pi/policy-port.test.ts`
- **Supersedes:** nothing. This raises the ceilings that were previously
  fixed at 80 calls and 10 writes.

### Context

The harness ran each agent unit under a ceiling of 80 tool calls and 10 file
writes, recorded in `.pi/neurofebric-policy.json`. A per-unit budget is a
guardrail rather than a target, but a guardrail that is reached during normal
work halts correct progress instead of catching a runaway. The typecheck
increment reached both ceilings while doing ordinary analysis and repair, and
the resulting stop was a false positive: the budget, not the work, was the
constraint.

The operator therefore raised the ceilings to 120 tool calls and 30 file
writes in commit `74fa0b8`, directly on `main`, before the typecheck unit was
resumed.

### Decision

- **`maxToolCallsPerTask` is 120. `maxFileWritesPerTask` is 30.** The shipped
  values are those and not the earlier 80 and 10.
- **`.pi/neurofebric-policy.json` remains operator-owned.** Agents read it and
  verify it; they never edit it. This is unchanged by the raise and is not
  relaxed by it. The file carries `secretWritePatterns` literals, which makes
  it a self-tripping write-scan target, so guard self-modification is
  forbidden on those grounds independently.
- **An agent whose work is blocked by a ceiling parks and reports.** Raising a
  budget to unblock an agent is the operator's decision, never the agent's.
- **`platform/pi/policy-port.test.ts` pins the shipped values as tamper
  evidence.** Test 7 asserts the committed policy file parses and carries the
  values the project intends to ship. A budget change is therefore not
  complete until that test is updated in the same cycle; otherwise `main` is
  red and every later merge is blocked.
- **A future budget change must update that test in the same cycle.** The test
  is not a stale-value casualty to be updated opportunistically.

### Consequences

- **Main was red between `74fa0b8` and the fix that followed it.** The raise
  alone does not keep the tree green; the test update is part of the change.
- **The assertion message is part of the contract.** When the pinned value
  changed from 80 to 120, the message "the legacy limit is preserved" became
  false, because 120 is precisely the value that replaced the legacy limit. A
  tamper-evidence assertion that misdescribes what it pins is a defect in its
  own right, so the message was amended to name the operator-raised budget.
- **This is a harness-policy change only.** It does not alter product
  `CoreLimits`, and the standing rule that product limits must not be raised
  to make a test pass remains fully in force.

### Alternatives considered

- **Raise the ceiling from inside the agent session.** Rejected. It would make
  the guardrail self-modifying and would let a workload that overruns a budget
  quietly raise it.
- **Split the work into smaller units to fit the old ceiling.** Rejected. The
  increment was correctly scoped; shrinking the work to fit a guardrail
  degrades the work rather than correcting the guardrail.
- **Raise only the call ceiling and not the write ceiling.** Rejected. Both
  were reached, and a partial raise would predictably stall again on the next
  file-heavy unit.

### Migration

None. No runtime behaviour changes. The shipped configuration values and the
test that pins them move together in this commit.

### Verification

- `platform/pi/policy-port.test.ts` test 7 asserts `maxToolCallsPerTask` is
  120 and `maxFileWritesPerTask` is 30, and the assertion message names the
  operator-raised budget.
- The full suite is green on this commit: 22 platform `.mjs` tests, 359
  TypeScript tests, and the 21-check F-006 live recovery proof.
- No agent edit of `.pi/neurofebric-policy.json` is present in this change;
  both the policy file and the test were applied by the operator and verified,
  not written, by the agent.

### Cross-references

- Commit `74fa0b8` — the operator's budget raise on `main`.
- D-019 — the typecheck gate whose unit work motivated the raise.
- `platform/pi/policy-port.test.ts` — test 7, the shipped-value pin.




## D-019: A real static type gate

The harness executes TypeScript by type erasure: the --experimental-strip-types
flag discards types without checking them. Nothing in CI ever read
`platform/` sources as source, so a green suite established only that the
executed paths behaved.

D-018 raised the tool budgets because this work kept reaching them.
This records the gate that work produced.

### What was added

- `tsconfig.json` — `strict: true` over `platform/**` non-test sources.
- `npm run typecheck` — `tsc --noEmit`.
- A `typecheck` job in `.github/workflows/ci.yml`, kept separate from the
  required `platform test suites` check so neither gate can mask the other.

### Scope

Production sources only. `**/*.test.ts` is excluded because the suite
already executes those files at runtime under strip-types. The exclusion is a
measured boundary, not a blanket suppression: no `@ts-ignore` is used
anywhere to reach green, and this change introduced no `as any`.

Two pre-existing `as any` remain at `platform/pi/kernel-adapter.ts` lines 175
and 1490, in `isCleanTerminal` and the no-tool stream-death branch. Both
predate this gate and are not touched by it. They are recorded here rather
than silently fixed, because narrowing them is its own increment and not a
side effect of a build change.

### One documented exception

`platform/pi/model-planner.ts` retains a double cast. Genuine narrowing
there needs a full shape validator ahead of the cast, which is not cheap. The
cast is justified in a code comment.

### Value, immediate

The gate surfaced a getter-shadowing bug on its first run: a defect that
type erasure had hidden and that the runtime suite had not reached.

### Migration

None. Dev-time tooling only. No runtime dependency is added and nothing
under `platform/` imports typescript.

### Cross-references

- D-018 — the budget raise this work motivated.

## D-020: A required context source is admitted over budget

- **Date:** 2026-09-28
- **Status:** accepted
- **Amends:** D-009 (item 2, Task C), D-016b
- **Affects:** `platform/core/context-memory.ts`, `selectContext`

### Context

`selectContext` guarded each source twice:

```ts
if (used + source.estimatedTokens > maxTokens && !source.required) continue;
if (used + source.estimatedTokens > maxTokens) continue;
```

The first guard exempts a required source. The second carries no exemption, so
it caught the same source one line later and the exemption was dead code. The
effect was that a required source — by definition one the caller must not run
without — was dropped exactly like an optional one, and a budget below its
estimated size returned an empty selection. A required source of 10 000 tokens
under a budget of 100 silently disappeared.

D-009 wired `maxContextTokens` to this function, and wiring a cap is what made
the path reachable. D-016b then removed `maxContextTokens` and ruled that the
behaviour could stand, downgrading the defect from outstanding CoreLimits work
to a known one. The pin `D009.2c` was left in place so that a future decision
on the required-source policy would be a deliberate act with a test to turn
green, rather than a silent edit.

One correction to how that pin is described. `D009.2c` was not a failing or
skipped test. It was a **passing** test that asserted
`selectContext([optional, required], 100)` deep-equal `[]` — it encoded the
defect as the contract, so the suite reported 359/359 green while the defect
stood. Its comment said it was "deliberately left RED relative to the intuitive
behaviour", which describes the gap to the intended behaviour, not a red suite.
The function also has no production caller, so nothing outside the test file
depended on the pinned behaviour.

### Ruling

Option A. `maxTokens` is a **soft cap for required sources and a hard cap for
optional ones**. A required source the budget cannot cover is still admitted. An
optional source that does not fit is still dropped, exactly as before.

The fix is the deletion of the second guard, keeping the first. Nothing else in
the function changed: no source is reordered, no field is added to the return
value, and the optional path is untouched.

### Rationale

The dead exemption is written evidence of the original intent. An author who
writes `&& !source.required` and then has it nullified one line later intended
required sources to be exempt; the second guard defeated the first by accident,
not by decision. D-020 repairs the code to its embedded intent rather than
inventing semantics the function never expressed.

D-016b is superseded on this single point. "The existing behaviour may stand
unchanged" was permission, not prohibition, and the operator has now chosen to
spend the change.

A required source was rejected because it would let a caller unknowingly run
against a context missing something it was told it could rely on, and because
truncation is silent content loss with no signal to the caller. It was rejected
as a contract change heavier than the defect it fixes. Leaving the behaviour
unchanged was rejected because a self-contradictory guard pair — one branch that
exempts, immediately followed by one that does not — must not survive a release
audit as shipped code.

### Consequence

A required source charges its full `estimatedTokens` against `used` exactly as
an optional one does, so a later optional source is measured against the true
remaining budget. Softness is the exemption from the drop decision, not an
unaccounted cost; without the charge, over-admitting a required source would
hand every following optional source a free allowance. `D009.2d` pins this
specifically, because it is the failure mode a naive reading of "soft cap"
would introduce.

The over-admission is **not** signalled in the return value, which remains a
plain `ContextSource[]`. A caller needing to know the budget was exceeded must
compare its own `estimatedTokens` figures against its own budget — the same
arithmetic this function performs. Fencing the shape would have changed the
return type for every caller to carry information the caller already holds.

### Value, immediate

`D009.2c` turned green deliberately, with its assertion inverted from the defect
to the ruling. Four cases now cover the boundary: admission over budget
(`D009.2c`), the charge against the optional budget (`D009.2d`), multiple
over-budget required sources and preserved priority order (`D009.2e`), and the
hard cap when nothing is required (`D009.2f`). The optional-only boundary was
already pinned by `D009.2` and `D009.2b`, both of which pass unchanged.

### Cross-references

- D-009 item 2 — the fenced defect this record resolves.
- D-016b — superseded on the required-source point only.
- D-018 — the budget raise this work is adjacent to.
- D-019 — the static type gate that covers this file.

## D-021: Phase M1–M4 (concurrency/recovery hardening) is de-scoped, not authorized

- **Date:** 2026-09-28
- **Status:** accepted
- **Amends:** none; records the absence of a specification
- **Affects:** no code. Nothing in `platform/`, `verification/` or `policies/` changes.

### Context

A standing execution order called for "PHASE M1–M4 (concurrency/recovery
hardening)", to be run as four PRs with a full lifecycle each. No written
specification for those phases exists in this repository or in the operator's
records. The label originated in session planning notes and was carried forward
into a later order as though it were a defined body of work.

An exhaustive search was run before this record was written. A search for
`M1`–`M4` outside the vendored `OmniRoute/` tree returns four hits, all of them
**vault** work-stream markers, not concurrency work: `platform/pi/vault-tools.ts`
and `platform/pi/kernel-adapter.ts` (the "M2 shape" where a descriptor is a
declaration with no handler), and `platform/pi/vault-boundary.test.ts` and
`platform/core/vault-redaction.test.ts` ("the M3 regression"). **`M4` appears
nowhere in the repository at all.**

`docs/CORE_HARDENING_PLAN.md` is the only plan-shaped document in the repo. It
carries `## Quality Gate For This Phase` and `## Next Implementation Slice`, and
no M-numbering. `docs/handoff.md` §4 "Phase 2 Roadmap" has three priorities —
write-budget thresholds, session-state recovery, policy-interception
diagnostics — labelled Priority 1/2/3, with no concurrency-hardening content and
no M-numbering.

### Ruling

**VOID as a named phase.** M1–M4 is deferred to the backlog. Any future
concurrency or recovery hardening requires a written specification, approved by
the operator, before implementation begins.

This is a de-scope, not a cancellation of the underlying idea. The work may
still be worth doing; what is withdrawn is the sign-off to begin it from a
label that never had a definition behind it.

### Rationale

Concurrency and recovery semantics are product decisions. What "parallel" means
here — whether a required source still holds a lock, what happens to in-flight
work when a budget is exhausted, whether recovery replays or resumes — has no
answer derivable from the code, and each choice changes observable behaviour for
every caller. Writing four phases from a label would have been product
invention dressed as engineering, and it would have entered the record the same
way F-006 and the `D009.2c` defect entered it: as work that proceeded on the
strength of a plausible-sounding reference nobody could check.

The cheaper outcome was to stop and ask. That cost one STOP; the alternative
costs four PRs of unreviewable design.

### Relationship to existing roadmap material

`docs/handoff.md` §4 **Priority 2 — Resilient Session State Recovery** (auto-
snapshot and resume of partial workflows) is the closest in-repo analog and is
**unaffected by this ruling**. It remains roadmap material. Roadmap material is
not a sign-off: the same section's Priority 1 and Priority 3 have sat in that
list through several release cycles without becoming work, and nothing in the
listing carries an approval.

### Consequence

No code changes. The label is retired rather than deleted, so a later order that
reintroduces it can be answered by this record instead of re-derived. The
de-scoped item is carried on the release backlog with its analog noted, so the
deferral is visible to whoever picks it up.

### Cross-references

- D-020 — the preceding record by merge order.
- `docs/handoff.md` §4 — the analog roadmap item, explicitly not a sign-off.
- F-006 — the same failure class this record prevents: work proceeding on an
  uncheckable reference.

## D-022: The write deny-scan is fail-closed, with the vault exempt by tool name

- **Date:** 2026-09-28
- **Status:** accepted
- **Amends:** none; closes a control gap found in live operation
- **Affects:** `platform/core/configured-policy.ts`, `platform/pi/write-scan-fail-closed.test.ts`

### Context

The gap was found by a live refusal, not by reading the code. Drafting a pull
request body was denied:

```
policy neurofebric-policy.json: secret write pattern matched: 'authorization'
```

The word was ordinary prose, not a credential. Investigating the false positive
turned up a real bypass in the same mechanism. The scanner selected payload
values with a closed allowlist:

```ts
const CONTENT_PARAM_NAMES: ReadonlySet<string> = new Set([
  "content", "contents", "text", "body", "data", "new_string", "old_string",
]);
```

and read only TOP-LEVEL keys whose name was in it. The harness Edit tool carries
its payload in camelCase `newText` / `oldText`. Neither name is in the set.
A write-tier call carrying a guarded literal in `content` was refused; the
identical literal in `newText` was authorized.

An allowlist is not a boundary. Any field name it had not already seen was
unscanned, so a new harness field would have become a silent bypass rather than
a test failure.

### Red-first evidence

`platform/pi/write-scan-fail-closed.test.ts` was written and run against
unmodified code first. Four of five tests failed, with the bypass visible as an
actual decision rather than an inference:

```
not ok 1  newText / oldText must be scanned     actual: REQUIRE_APPROVAL
not ok 2  nested at any depth must be scanned    actual: REQUIRE_APPROVAL
not ok 3  unknown field must be scanned          actual: REQUIRE_APPROVAL
ok     4  path/locator exemption preserved
not ok 5  every declared string field scanned    actual: 'oldText' unscanned
```

The marker is assembled from fragments at runtime so the test file is not itself
a refused write payload, and the suite uses `precheckToolCall` only — it decides,
it never writes to disk.

### Ruling

For a WRITE-tier tool, every string value in the payload is scanned at any depth.
The only exemptions are, by name:

- `PATH_PARAM_NAMES` — locator fields, so a file named for the concept is not a
  secret and `docs/password-policy.md` can still be created by a clean write.
- `SCAN_EXEMPT_TOOLS` — `vault_store`, and nothing else.

There is deliberately no allowlist of "content-ish" field names to fall out of.
A field name the scanner has never heard of is scanned, so escaping requires an
explicit, reviewable edit to this file.

### The vault conflict, and how it was resolved

The first run of the fix turned the suite red on `R-1 / P-1`:

```
not ok 352 - a configured write pattern does not deny a store
             actual: 'DENY'   expected: 'REQUIRE_APPROVAL'
```

`vault_store` is `riskLevel: "WRITE"` and takes a `value` field. The vault is the
one sanctioned unredacted store — it exists to hold credentials — and `R-1 / P-1`
pins, deliberately, that the deny-scan must not reach its payload: *"the approval
IS the sanction: a vault-local deny-scan could only have fired here, overriding
it."*

A scan over every write-tier string makes the vault unable to store a credential,
which is the one thing it is for. The two requirements were therefore mutually
unsatisfiable, and choosing between them is a product decision rather than a
mechanical one. The operator ruled on the jurisdiction: the deny-scan exists to
stop a credential reaching an **un-sanctioned** persistence, while `vault_store`
IS the sanctioned store and its control is the **approval gate**. A deny-scan
there would let an automated control override a human sanction. Exempting the
vault is the correct boundary, not a hole.

`R-1 / P-1` is unchanged and green.

### Why the exemption is code, not config

`SCAN_EXEMPT_TOOLS` lives in `platform/core/configured-policy.ts`, not in the
policy file. A security exemption should be a reviewed code change that appears
in a diff and a test, not a config flag that can be flipped without one.

### Alternatives rejected

- **Fail closed everywhere and update `R-1 / P-1` to expect DENY.** Rejected: a
  vault that cannot store a credential is a dead design. The test encodes a
  deliberate decision, not a stale expectation.
- **Declare credential-bearing fields on the tool descriptor.** Rejected for now:
  the descriptor contract is fenced (M2 — a descriptor is a declaration with no
  handler, and the binding belongs to the extension). Carried on the backlog as
  the principled successor.
- **Exclude the vault test from the suite.** Rejected: it hides the conflict
  rather than resolving it, which is the same failure class as the gap itself.

### Consequence

The companion doc change is the policy file's scanned-fields note, which still
enumerates the old seven names. **That update is operator-side and happens after
this record merges.** Until it lands, the note in
`.pi/neurofebric-policy.json` describes a scope narrower than the one now
implemented — the fourth instance of declared-state-diverging-from-actual-state
this cycle.

### Cross-references

- D-021 — the preceding record by merge order.
- D-016, D-017 — the vault this exemption protects; D-017 records it as
  INTENTIONALLY UNWIRED, so the exemption is currently latent rather than live.
- D-019 — the static type gate covering both changed files.
- `platform/pi/vault-boundary.test.ts` `R-1 / P-1` — the pinned vault behaviour.

## D-023: Write-size accounting is fail-closed over the whole payload

- **Date:** 2026-09-28
- **Status:** accepted
- **Amends:** none; the second half of the gap D-022 opened
- **Affects:** `platform/core/configured-policy.ts`, `platform/pi/write-byte-fail-closed.test.ts`

### Context — the escape hatch, cleared

D-022 split the deny-scan away from the size limit rather than widening the
shared collector, because widening it would have changed what
`maxBytesPerWrite` measures. That left the size limit reading the same closed
allowlist the deny-scan had used, and the same bypass:

```ts
const CONTENT_PARAM_NAMES = new Set([...7 names...]);
```

`payloadBytes` counted only those names, at the top level. A large payload
carried in the harness's camelCase `newText` / `oldText` measured as **zero
bytes** and so bypassed the cap entirely — the same bypass class, in a different
control.

Before changing it, the standing escape hatch was checked: is the limit
deliberately content-fields-only per its written specification?
`docs/POLICY_PORT.md` line 24 specifies it as **"measured as UTF-8 bytes of the
write payload"**, and records the legacy engine as having measured
`len(content.encode("utf-8"))`. A `newText` value is part of the write payload.
The specification does not nominate one field, so this is a divergence between
the written spec and the implementation — an implementation gap, not a narrow
design. The escape hatch does not apply.

### Ruling

`payloadBytes` counts every string value in a write payload at any depth.
Two things follow, and both are deliberate:

- **Locator fields are included.** A path is part of the call the cap governs.
- **There is no tool exemption.** A budget binds the vault exactly as it binds
  any other write. Approval sanctions a write; it does not waive the budget.
  This is the sharp contrast with the deny-scan, which the operator exempted
  `vault_store` from in D-022 precisely because the two controls have different
  jurisdictions. The size limit has no such second authority to defer to.

### Implementation

`collectBilledStrings` walks the payload and is the same walker family as the
deny-scan's `collectScannedStrings`, with two differences: no locator exemption
and no tool check. The dead `CONTENT_PARAM_NAMES` allowlist and the dead
`contentPayloadStrings` method were **removed** rather than left in place. An
allowlist that no longer governs anything is the exact shape of defect this
cycle exists to eliminate, and leaving it would invite the next reader to
believe the size limit is still field-scoped.

### Step 0 outcome — vault tier is consistent in production

The vault billing case turned on a real tension in the evidence: `vault-tools.ts`
declares `vault_store` as `WRITE`, while `toolDescriptorFromPi` classifies it as
`CONTROLLED` because it is absent from that file's `riskByTool` table — and the
size check is WRITE-gated, so under the default fallback the vault would escape
the budget entirely.

**Production consumes the real descriptors.** The call path is
`KernelAdapter.registerTools` (`platform/pi/kernel-adapter.ts:565`) to
`vaultDescriptors()` (`:579`) to `vaultToolDescriptors()`
(`platform/pi/vault-tools.ts:86`), which returns the descriptor carrying
`riskLevel: "WRITE"` (`vault-tools.ts:92`). `toolDescriptorFromPi` is a
separate path serving Pi built-in tools; the vault never routes through its
risk table. This is also why `R-1 / P-1` fired `DENY` under the fail-closed
scan rather than passing through to the approval gate.

**No conformance change was needed and none was made.** The alternative
outcome — production classifying `vault_store` as `CONTROLLED` through the
default fallback — would have been pre-authorized as mechanical, but it did not
obtain. No default-fallback semantics were touched.

### The operator fixture commit

The change to byte accounting turned one existing fixture red.
`platform/pi/policy-port.test.ts` test `4b` wrote `"ok.md"` with
`"x".repeat(60)` against a 64-byte cap: under the old accounting that was 60 ≤
64, and under path-inclusive billing it is 5 + 60 = 65 > 64.

That file is **operator-reserved**, so the agent stopped rather than edit it.
The operator verified the one-line diff and made the change in commit
`8d3315d` ("test: shrink byte-limit fixture for path-inclusive billing").

The fixture is green across the change, which is the compatibility property
worth stating: the same input is 50 + 5 = 55 under new billing and 50 ≤ 64
under old billing, so the assertion holds either side of the change. The
`repeat(200)` over-budget case in the same test was unaffected.

The bundling of that reserved-file edit into a feature-branch commit, and its
recovery, are recorded as DEV-003.

### Two vacuous greens caught before merge

Both were caught in this work and are recorded because a green that means
nothing is worse than a red:

1. **A test that passed for the wrong reason.** The vault budget case initially
   passed only because `toolDescriptorFromPi` classified `vault_store` as
   `CONTROLLED`, and a CONTROLLED tool never reaches the size check. The budget
   was not being evaluated at all. It now registers the real
   `vaultToolDescriptors()` descriptor, so the assertion tests the budget.
2. **A cap set below the size of a real path.** With locator fields billed, a
   64-byte cap is smaller than the sandbox temp path itself (~75 bytes), so
   *every* write in the suite exceeded it and the "small payload is admitted"
   case failed. That is why the fixture cap is 512. It is the same mechanism
   that turned test `4b` red, seen from the other side.

### Consequence

`maxBytesPerWrite` is now a budget on the call rather than on one nominated
field. The practical effect is that the effective headroom for path-heavy
writes is smaller than the number alone suggests, because path bytes are
billed. The operator-side policy note (`_secretWritePatternsNote`, merged in
`76c91f6`) already states the fail-closed scan scope with both exemptions; the
billing rule is recorded here and pinned by
`platform/pi/write-byte-fail-closed.test.ts`.

### Cross-references

- D-022 — the deny-scan half of the same gap, and the source of the split.
- D-016, D-017 — the vault, whose deny-scan exemption and budget coverage now
  differ deliberately.
- D-019 — the static type gate covering both changed files.
- DEV-003 — the reserved-file bundling and its recovery.

## D-024: Backlog closure — every item reaches a terminal state

- **Date:** 2026-09-28
- **Status:** accepted
- **Affects:** no runtime behaviour. One mechanical conformance change
  (`package.json`), one documentation sweep, one drafted spec.
- **Purpose:** close the cycle's backlog to zero open items. Every item below is
  fixed and merged, closed by recorded decision with rationale, or converted to a
  written spec awaiting approval. None is silently deferred.

### The two already-enforced surfaces, stated so they are not re-litigated

The concurrency races in this codebase are **stale-event races**, and they are
already fenced and pinned by `platform/pi/kernel-adapter-reentrancy.test.ts` —
19 cases across groups A–H. Recovery is already specified and verified by
`verification/live-f006-proof.mjs` (21 checks). Both are documented in
`docs/CONCURRENCY_RECOVERY_SPEC.md` §1–§2 so that any future "harden
concurrency" proposal must name a specific uncovered case rather than a label.

### Item-by-item terminal state

| Item | Terminal state | Where |
|---|---|---|
| `MODULE_TYPELESS_PACKAGE_JSON` warning | **Fixed and merged** — `"type": "module"` added to `package.json` | this commit |
| GitHub issue #23 (D-016 vault intake) | **Closed with rationale** — stale against D-017 | this commit |
| Test-comment truth audit | **Clean — none found** | this commit |
| Stale test counts in docs | **Fixed** — 320→372, 342→394 | this commit |
| F-006 | **Split and closed** — see below | this commit |
| D-017 | **Confirmed closed by design** — see below | this commit |
| Concurrency/recovery hardening | **Converted to a written spec**; **approved as context, all three items deferred to M2** by D-026 | `docs/CONCURRENCY_RECOVERY_SPEC.md` |
| Descriptor-based credential-field declarations | **Closed decision: deferred by design fence, revisit at M2** | this commit |
| Transport guard vs refspec policy mismatch | **Closed decision: operator-side publication sanctioned; guard narrowing needs a written spec** | this commit |

### F-006 — split, and closed

F-006 was carried as "Phase 1 merged, Phase 2 open" with three residual items.
They do not share a terminal state, so they are closed individually:

- **Real retryability propagation** → **moved to the drafted spec, §3.3.** It
  looked mechanical, and it is conformance-shaped, but it depends on the external
  tool-error contract, which is not defined in this repository. Guessing that
  interface would be inventing one. It is the highest-value item on the spec
  page and is flagged for operator decision.
- **Strategy-change recovery** → **moved to the spec, §3.2,** as a product
  question. Bounded recovery is intentional and tested; the absence of a replan
  admission for repeated same-class failure is a defensible design position, not
  obviously a defect, and is not the agent's to settle.
- **Trace evidence for the original observation** → **closed as unclosable.**
  The event-level hypothesis was never confirmed out of band and cannot be
  supplied retrospectively. The Phase 1 diagnostics make the mechanism
  observable in future; the original observation stays unconfirmed, and saying so
  is more honest than leaving an item open forever.

### D-017 — confirmed closed by design

D-017 records the credentials vault as **ARCHITECTURAL DECISION, INTENTIONALLY
UNWIRED**. The vault ships dark: its tools attach only when configured, and
`vaultStoreEnabled` is not enabled in this configuration. The work the issue
tracked — spec, implementation, tests, and a decision record — exists. The
registry wiring the issue asked for was the one element D-017 deliberately
declined, so the issue is stale against a standing ruling rather than pending.
Closed on that basis; no code changes.

### GitHub issue #23 — closed with rationale

Issue #23 ("D-016 Credentials Vault — intake") lists its acceptance as "spec +
implementation + tests green, PR to main, operator merges, D-record at close".
All of that exists. Its remaining element, tool-registry wiring, is precisely
what D-017 declined. Leaving it open implied outstanding work that is in fact a
settled decision, which is the declared-state-vs-actual-state class this cycle
exists to eliminate. Closed with a comment citing D-016, D-017 and this record.

### `"type": "module"` — proven safe before merging

The `MODULE_TYPELESS_PACKAGE_JSON` warning was triaged rather than suppressed.
Before changing anything:

- The repository contains **no `.js` and no `.cjs` files at all** — 9 `.mjs` plus
  TypeScript — so entry-point resolution cannot be affected by the module type.
- The codebase is already ESM: every file uses `import`, and the test scripts
  depend on it.
- With the field added, the warning count goes **1 → 0** and all four gates stay
  green: 22 mjs, 372 ts, 21/0 proof, `tsc` 0.

The change removes real noise on every CI run and changes no resolution
behaviour. It was merged rather than closed, because it is correct rather than
merely tolerated.

### Descriptor-based credential-field declarations — closed by fence

D-022 identified the principled successor to the tool-named deny-scan exemption:
let a tool **declare** which of its fields carry credential material, so the scan
needs no tool list. It was rejected for now because the descriptor contract is
fenced — M2 records that a descriptor is a declaration with no handler and the
binding belongs to the extension.

**Terminal state: deferred by design fence, revisit at M2.** This is a closed
decision, not an open item. The deny-scan works today via a one-name exemption
in reviewed platform code, and the alternative is parked behind the same fence
that blocks it.

### Transport guard vs refspec policy mismatch — closed, operator-side

The transport guard blocks `/push\s+--force/`, which also matches
`--force-with-lease`. The consequence is that **no force form is publishable from
the harness**, so an agent that rebases a published branch cannot republish it.
The guard and the standing rebase instruction therefore cannot both be satisfied
by an agent.

**Terminal state: operator-side publication of rewritten history is sanctioned.**
The operator publishes; the agent rebases locally, reports that publication
requires a force form, and stops. Narrowing the guard so that a with-lease force
becomes harness-publishable is **not** done here — it would change a security
control's surface and needs its own written operator spec. Recorded as a
decision, not code-fixed.

This is the same lesson as DEV-004, recorded structurally rather than as an
incident: a blocked control is a STOP condition, not a routing problem.

#### Correction (2026-09-29) — the blocking control is the harness, not this repository

The paragraph above is left in place unedited. This note corrects **which
control** it was describing, because the record as written attributes the
over-blocking to a pattern that does not exist in this repository.

**What D-024 quoted.** `/push\s+--force/`, stated as a pattern that also matches
`--force-with-lease`. That literal pattern appears nowhere in this repository.

**The repository's actual force-push control is correct.**
`platform/core/policy.ts:86` reads:

```
/\bgit\s+push\b.*--force(?!-with-lease)/i
```

The `(?!-with-lease)` negative lookahead excludes the lease form by
construction. The bare form is DENIED; `--force-with-lease` on a plain refspec is
ALLOWED. This was already established as **D-011 open item 3**, which reached the
same conclusion by evaluating the exported `DESTRUCTIVE_PATTERNS` array against
both forms and found the with-lease allowance "a verification, not an
amendment" — in effect, correct, and nothing changed.

**The repository's control is also pinned.** `platform/core/refspec-guard.test.ts`
row 6 asserts the plain-refspec with-lease push is ALLOWED; row 7 asserts a
with-lease push does **not** license a `+` refspec, which stays DENIED.
`docs/REFSPEC_GUARD_SPEC.md` rows 6 and 7 record the same. Removing the lookahead
would turn a passing conformance test red.

**So the over-blocking outlier is the harness-side transport guard**, an
external control not present in this codebase, which is the control that
actually fired during DEV-004. D-024's terminal state is **unchanged and still
correct**: publication of rewritten history is operator-side, the agent rebases
locally and reports, and a blocked control is a STOP condition rather than a
routing problem.

**What changes is attribution, and it changes the open item.** The consequence
paragraph below calls the narrowing of "the transport guard" an operator-side
item awaiting approval. Narrowed correctly, that item is *not* an amendment to
this repository's security surface at all: `platform/core/policy.ts` needs no
change, and no operator spec for a security-control amendment is required here.
The item is a **harness-configuration question outside this repository**,
against a control this repository does not own and cannot amend. That is a
narrower and more accurate ask than the one D-024 left open.

**Ruling reaffirmed, not reopened.** No D-record is rewritten. This is an
amendment note in the D-024 body: the decision stands, the reasoning is
corrected, and the full divergence is recorded in `docs/handoff.md`.

### Consequence

The backlog is at zero open items. Two items now await **operator approval**
rather than agent work — the concurrency/recovery spec §3.1–§3.3, and the
narrowing of the transport guard. Both are written specifications, not
deferrals. *(Update, 2026-09-29: the first of these was ruled on by **D-026** —
approved as context, all three items deferred to M2. The transport-guard item
remains operator-side.)*

### Cross-references

- D-021 — the de-scope this spec answers.
- D-022, D-023 — the deny-scan and billing fixes whose exemptions this record
  bounds.
- DEV-003, DEV-004 — the two process deviations of this cycle.
- `docs/CONCURRENCY_RECOVERY_SPEC.md` — the drafted spec.
- `verification/live-f006-proof.mjs` — the recovery proof, 21 checks.

## D-026: The concurrency/recovery spec is approved as context — all three items deferred to M2

- **Date:** 2026-09-29
- **Status:** accepted
- **Ruling on:** `docs/CONCURRENCY_RECOVERY_SPEC.md` sections 3.1, 3.2, 3.3
- **Affects:** no code, no tests, no runtime behaviour. No new semantics are
  introduced by this record.

### Context

D-024 closed the cycle's backlog by converting "concurrency/recovery hardening"
into a written specification, `docs/CONCURRENCY_RECOVERY_SPEC.md`, so the
question could be decided on evidence rather than on the M1–M4 label that D-021
withdrew. That spec separated surface already enforced (section 1: stale-event
races, 19 cases in `platform/pi/kernel-adapter-reentrancy.test.ts`; section 2:
recovery, 21 checks in `verification/live-f006-proof.mjs`) from surface that would
introduce **new semantics** and therefore required an operator ruling (3.1
parallel tool execution, 3.2 strategy-change recovery, 3.3 retryability
propagation).

The spec was left at DRAFT status pending that ruling. This record is the ruling.

### Ruling

**APPROVED AS CONTEXT. All three section 3 items are deferred to M2. No
implementation now, no new semantics.**

| Item | Ruling |
|---|---|
| 3.1 true parallel tool execution | **DEFERRED to M2**, out of scope this cycle |
| 3.2 strategy-change recovery | **NOT A DEFECT** — bounded hard-stop recovery is intentional and tested; strategy-switching noted as an M2 candidate only |
| 3.3 retryability propagation | **KNOWN LIMITATION acknowledged**, deferred to M2 |

### Rationale

**3.1.** Parallel tool execution does not exist as a feature: `maxParallelTools`
and `maxParallelTasks` were removed from `CoreLimits` in D-009 because nothing
schedules tasks concurrently. The open question was whether a *limit* could be
given real meaning when two tool calls are in flight at once, and that question
presupposes an executor that does not exist. Answering it would require building
the concurrency model this record defers. The removed limits therefore stay
**deliberately removed** — not silently pending, not re-added as a paper
constraint.

**3.2.** The spec itself flagged that the retry-budget hard stop "is defensible —
bounded recovery is intentional and tested — and is not obviously a defect." The
operator adopts that reading. A deterministic exact-match-edit failure that
consumes its budget and stops is the bounded-recovery contract working as
specified, not a failure of it. The residual observation from F-006 Phase 2 is
real, but it is a **product question** about whether recovery should ever replan,
not a correctness gap. It is carried to M2 as a candidate and nothing more.

**3.3.** The hard-coded `retryable: false` in `recordToolResult` is acknowledged
as a **known limitation**, not a defect and not hidden. The blocker is unchanged
and was correctly identified in the spec: the real value from the tool error
depends on an external tool-error contract that **is not defined in this
repository**, and guessing that contract would be inventing an interface.
`classifyFailure` already honours `CoreError.retryable`; what is missing is a
producer that sets it truthfully. That stays conformance work until the contract
exists.

### Consequence

- **No code, test, or policy change.** The harness kernel, the Pi extension, and
  the policy set are untouched.
- The spec moves from DRAFT to **approved as context**. It is now the reference
  for why these three items are deferred and on what basis, so a later cycle does
  not re-derive the analysis.
- All three items are **carried to M2 as written, decided, deferred items** — the
  same terminal-state discipline D-024 applied. None is an open agent-work item.
- **Reactivation requires a new operator order.** Any implementation attempt on
  sections 3.1 to 3.3 before then is unauthorised by this record, in the same way
  D-021 withdrew the sign-off to begin M1–M4 from a label.
- 3.3 additionally requires the tool-error contract to be confirmed before it
  becomes implementable at all.
- The spec's own exclusions hold unchanged: no new limits, no new persisted
  state, no change to `selectContext` (D-020), the vault's jurisdiction
  (D-022/D-023), or the descriptor contract (M2 fence).

### Cross-references

- D-021 — the de-scope this spec was written to answer.
- D-024 — closed the backlog and produced this spec; its "awaiting approval" row
  is closed by this record.
- D-009 — the removal of the paper concurrency limits that 3.1 leaves removed.
- F-006 — the origin of the 3.2 and 3.3 observations; the recovery proof (21
  checks) continues to run unchanged in CI.
- `docs/CONCURRENCY_RECOVERY_SPEC.md` — the approved-as-context spec.

## D-025: Wall-clock assertions are removed in favour of structural pins

- **Date:** 2026-09-29
- **Status:** accepted and executed
- **Affects:** `platform/core/tool-paths-recursion.test.ts` (test 14). No
  production code, no runtime behaviour, no new semantics.

### Context

Test 14, *"deep nesting is bounded and terminates"*, asserted wall-clock
duration inside a unit test:

```ts
const started = Date.now();
assert.ok(Date.now() - started < 2000, "extraction must terminate promptly on deep input");
```

A timing assertion reports on machine load and scheduler contention rather than
on the behaviour under test, so it is a flake source that can fail a green
codebase for reasons unrelated to the code. This is the same defect class as the
D-024 test-comment truth audit: a test asserting something other than what it
claims to assert.

### Ruling

The wall-clock assertion is **removed**. Termination is pinned **structurally**
instead: the walk must *return* rather than recurse without bound, which the
array-shape check (`assert.ok(Array.isArray(candidates))`) establishes, and the
permitted-depth escape check confirms the bound is a bound rather than a
silent full walk.

A stronger pin — `assert.deepEqual(candidates, [])` on the deep payload — was
considered and **deliberately not adopted**. The extractor's depth behaviour on
that payload was never verified, so strengthening the assertion would risk a red
test resting on an unverified assumption. It is recorded as an open question
rather than smuggled in with the removal.

### Evidence

- Executed in **PR #49**, squash `ca9f5de`, merged to `main`.
- **14 pass / 0 fail, five consecutive identical runs** after the removal.
- `Date` references remaining in the file: **0**.
- The five pre-existing tests in the file were left intact.

### Provenance of this record

This entry was written **after** the change shipped. While D-025 was being
executed no decision record for it existed anywhere in `docs/` or `.pi/` — the
search returned nothing, and the gap D-024 left between D-024 and D-026 was
real rather than a numbering artefact. Nothing was reconstructed: the interim
referent was the **queue snapshot in `docs/handoff.md` §9**, merged in PR #48
(`d09e7ea`), which is what PR #49 cited at the time. This entry closes that gap
with the executed evidence attached, not with a guess at what the original
record would have said.

### Cross-references

- D-024 — the backlog closure whose terminal-state discipline this follows.
- `docs/handoff.md` §9 and §10 — the interim referent, and the operational notes
  from the same cycle.
- `platform/pi/write-byte-fail-closed.test.ts` — the same class of conformance
  pinning applied to the byte cap (PR #50, `0f30913`; PR #51, `5f00279`).

## D-027: The write deny-scan enforces a hard depth bound of 12

- **Date:** 2026-09-29
- **Status:** accepted
- **Ruling authority:** operator
- **Affects:** `platform/core/configured-policy.ts`,
  `platform/pi/write-scan-fail-closed.test.ts`. New control behaviour on
  write-tier payloads nested deeper than the bound.

### Context — a crash where a decision belongs

Cycle-1 item 6 probed the write deny-scan with a marker at increasing nesting
depth and found the guard is fail-closed only to roughly 2000–3000 levels.
Past that, `collectScannedStrings` throws
`RangeError: Maximum call stack size exceeded`, and because `precheckToolCall`
has no `catch`, the exception escapes the guard instead of producing a `DENY`.
The boundary therefore had an input on which it crashed rather than decided.
Cycle 1 recorded the defect and declined to choose a bound, because choosing one
is new semantics and was not authorised.

### Ruling

**A write-tier payload nested deeper than 12 is DENIED.** The bound is hard: the
guard does not descend past it and does not attempt to scan the remainder.

The value **12** is taken from `platform/core/redaction.ts`, where
`const MAX_DEPTH = 12` already bounds the redaction plane and returns
`REDACTED` at the limit. Using the same number is the point: the repository now
has **one** depth convention across its two recursive boundary walkers, and a
future reader does not have to learn two different limits for the same concern.

The failure mode is also made uniform. `redactValue` does not crash at depth; it
stops and returns a safe value. The scan now does not crash at depth; it stops
and returns a safe **decision**. A guard that cannot answer must fail closed, and
"fail closed" for a policy engine means `DENY`, not an exception.

### Scope of the control

The bound is checked on the **write-tier path before the tool exemption**, not
only on the scanned subset. This is a deliberate choice: `vault_store` is exempt
from the deny-scan, but its payload still reaches `collectBilledStrings` for the
byte cap, and that walker was equally unbounded. Checking the bound ahead of the
exemption means a too-deep payload is refused on the way in, so no unbounded
recursive walker is ever entered on a write. Scoping it to the scanned subset
only would have left the vault reachable.

### Consequence

- A write payload nested deeper than 12 is refused with a depth-specific
  reason, whatever it contains. The refusal does not depend on finding a
  marker, because "too deep to scan safely" is itself the reason.
- The denial happens before the byte cap, so the billing walker is never handed
  an unbounded payload.
- Real write payloads are shallow (a path plus a body). The bound is generous
  for every shape the harness actually produces.
- The file header in `write-scan-fail-closed.test.ts` said the payload "is
  scanned at any depth". That statement becomes false the moment the bound
  exists, so rewording it is part of making the documented semantics true rather
  than a separate editorial change.

### Cross-references

- D-022 — made the deny-scan fail-closed over depth; this bounds that depth.
- D-023 — the byte cap, whose walker this bound also protects.
- `platform/core/redaction.ts` — `MAX_DEPTH = 12`, the source of the number.
- `docs/handoff.md` §9 — the queue entry this closes.

---

## D-028: The GitHub Actions gate is retired in place and superseded by `.gitlab-ci.yml`

GitLab is the sole delivery remote:
`https://gitlab.com/neurofebric-group/neurofebric.git`. `.github/workflows/ci.yml`
is **retired in place, not deleted**.

### Why keep the file

The workflow can no longer execute. The repository has no GitHub remote, and a
repo-local insteadOf rule rewrites every `github.com` URL to
`killswitch.invalid`. There is no path by which `on: pull_request` is ever
fired by GitHub's Actions service.

It is kept because deleting it would destroy the record of *why* the gate is
shaped the way it is. Three decisions survive only in that file's comments and
would otherwise be re-litigated:

- the three test jobs run on bare node with **no install step**, because the
  harness has zero runtime dependencies;
- the type gate is a **separate job**, not a step on the test job, so a type
  error cannot fail the runtime suite and a runtime failure cannot hide a type
  error;
- the `test-windows` job exists to prevent a Windows-only boundary regression
  from merging green against an ubuntu-only gate.

An inert file is a smaller risk than a rewritten memory. It is inert **and**
legible; deletion would be legible only to whoever already knew the history.

### What `.gitlab-ci.yml` reproduces, and the one change

The same four commands, the same single parallel stage, the same `node:22`
image. Job names differ only by prefix because GitLab job names must be
`[A-Za-z0-9_-]`-clean; GitHub rendered them as "platform test suites" and
"static type gate".

One functional change, and it is a **fix, not a port**: every job runs
`npm ci`, including the type gate. The GitHub `typecheck` job had an explicit
`Install dev dependencies` step. Without it, `npm run typecheck` fails in a
fresh container with `tsc: not found`, because `tsc` resolves only from
`node_modules/.bin` and there is no global tsc. Verified on this machine: no
global `tsc` is on PATH.

### Scope reduction, stated plainly

`test-windows` is **not** reproduced. GitLab runners are linux by default, and
a Windows runner requires a project-level runner registration — a GitLab
project settings action reserved for the operator, and out of scope for a
`read_repository + write_repository` token by design.

The consequence is real: the ubuntu-only gate no longer detects a
Windows-only regression in the workspace boundary (`CASE_INSENSITIVE` in
`platform/core/workspace.ts`, separator handling, realpath/junction
resolution). This is a **known, accepted coverage reduction**, not an
oversight, and it is recorded here so the next reader does not assume the
matrix coverage survived the migration.

### Triggering

Pipelines run on `merge_request_event` and on pushes to `main` only. A push to a
feature branch produces no pipeline; the first pipeline appears when the MR is
opened. That is intentional — the gate exists to gate merges.

Branch protection on `main` is **not** configured by this commit. It is a
GitLab project settings action requiring permissions beyond repository
read/write, and it remains an operator task.

### Cross-references

- D-019 — added the static type gate; that job is carried over here.
- `.gitlab-ci.yml` — the new canonical gate.
- `.github/workflows/ci.yml` — retired in place, retained as historical record.
- `package.json` — the authoritative source of the four script names.

## D-029: The pipeline is the merge gate, and the agent does not certify its own green

- **Date:** 2026-09-29
- **Status:** accepted
- **Affects:** delivery mechanism only. No code, no tests, no runtime behaviour,
  no CI configuration.

### The decision

Every delivery is an MR whose merge is armed with **merge-when-pipeline-succeeds**.
The agent never observes a green pipeline and then merges; it arms the merge and
lets the gate decide. Red is therefore not an approval failure — it is the gate
doing its job, and the MR simply does not merge.

This replaces an oversight model with a mechanical one. Nothing about the change
under review is trusted, least of all by the party that wrote it.

### What this record deliberately does not contain

An earlier draft of this record restated D-028: the job list, the retired
workflow, the image, the `npm ci` fix. Reviewer **R2** cut all of it to a
cross-reference, and that edit stands as written.

The restatement was not harmless. D-028 is the record of *what the gate runs*. A
second copy of that list is a second thing to keep true, and it would drift the
moment a job is added. D-029 owns one question — **who is allowed to call a
change delivered** — and D-028 already answers the adjacent one.

The general rule this instantiates: a record states the decision and points at
the record that owns the detail. It does not paraphrase the neighbour.

### Consequences of arming rather than watching

- A red pipeline is **silent by default** — nothing alerts, and no merge happens.
  Detection falls to the next session's `git fetch`, not to a notification.
  This is a real cost and is the accepted trade: the alternative is a human
  watching four jobs to approve something the platform can approve itself.
- The agent cannot merge a red MR at all. There is no "merge anyway" path it
  holds, which is the point.
- Status check **names** are enforced by the protected-branch ruleset, not by
  this record. A required check that is renamed stops blocking, and a green
  pipeline then means less than it appears to. See D-011 on `main` protection.

### Provenance note

R2's original draft text is not recoverable from the repository — no review
artifact records it. The record above is written directly in the post-review
shape rather than being edited into it, and it says so here rather than implying
a draft-and-reduce cycle that cannot be evidenced.

### Cross-references

- D-028 — owns the gate itself: what runs, where, and what was retired.
- D-011 — the ruleset that makes the gate binding on `main`.
- D-024 — the terminal-state discipline this operationalises.

## D-031: A truncated security scan fails closed — the depth bound is a safety limit, not an allow condition

- **Date:** 2026-09-29
- **Status:** accepted and executed
- **Affects:** `platform/core/workspace.ts`, `platform/core/tool-paths.ts`,
  `platform/core/policy.ts`, `platform/core/configured-policy.ts`, and the new
  suite `platform/core/bounded-scan-truncation.test.ts`. No policy file, no
  `.pi/` configuration, and no runtime semantics outside these four modules.

### Context

A security audit of the workspace and path boundary found a fail-open on the
production decision path. Depth bounds in the security scanners were written as
a bare `return`:

- `tool-paths.ts` `collectFromObject` and `collectFromArray` — `depth > 4`, return
- `workspace.ts` `extractPathCandidates` — `depth > 6`, return
- `policy.ts` `collectStrings` — `depth > 6`, return empty list

A bare `return` is a silent skip. The scan stops, returns an empty list, and
every downstream check iterates zero times. The workspace boundary is never
consulted, and an empty result is read as "nothing to find" rather than "not
inspected".

Measured against the real `TrustedProjectPolicy.evaluate` (not the helper), with
an absolute out-of-root path wrapped in N anonymous levels:

| nesting | candidates | decision |
| --- | --- | --- |
| 0 to 4 | 1 | DENY (boundary) |
| 5 and above | 0 | **ALLOW** |

A clean cliff between depth 4 and 5, on a byte-identical payload.

D-027 had already established the correct principle for the write deny-scan —
"too deep to scan safely is itself the reason" — but that check was gated on
`riskLevel === "WRITE"`, so reads, controlled calls, and every other tier had no
depth protection at all. The three literals (4, 6, 12) had drifted apart.

A fourth, independent instance was found while closing the first three:
`extractCommandText` scopes a structured tool's command text to top-level keys
only. A command argument nested one level down produced a command scope of an
empty object, which the pattern scan matched against and reported as clean.
Verified separately rather than assumed to share an implementation with the path
walk: a `printenv` command at nesting 10 returned ALLOW from both engines.

### Ruling

**Truncation of a security scan fails closed. A depth bound is a safety limit,
not an allow condition. "Not scanned" is never read as "safe".**

### Implementation

One bound, one typed contract, propagated explicitly — never inferred from an
empty result, never a global, never parsed out of error text.

- `MAX_SECURITY_SCAN_DEPTH = 12` is defined **once**, in `workspace.ts`, the
  lowest module all four scanners depend on. It reuses D-027's bound rather
  than inventing a fourth literal, and replaces 4 and 6.
- `CandidateScan { candidates, truncated }` and
  `StringScan { strings, truncated }` are the scan results. `ScanState` threads
  truncation through the recursive walks. Truncation is recorded at the point
  the walk gives up, and the policy checks the flag *before* the empty-list
  shortcut.
- `scanToolPathCandidates`, `scanPathCandidates`, `scanStrings`, and
  `scanCommandText` return the truncation-carrying form. The old unscoped
  functions are retained for callers that only want the values, and each is
  documented as unfit for a security decision.
- `classifyTrustedOperation` and `ConfiguredPolicy.evaluateRules` and
  `evaluatePaths` deny on truncation via `truncatedScanReason`, which quotes only
  the tool name and the bound — never any part of the payload, which may itself
  be the secret being hunted for.
- The generic scanner check sits **after** the D-027 write-depth check, so a
  deep WRITE keeps D-027's own reason rather than being relabelled.

### Why 12 is safe

The walkers recurse once per payload level, so frame count is capped at 13
regardless of input size. The `RangeError` that motivated D-027 appeared around
2000 to 3000 levels — three orders of magnitude beyond this. Breadth is
unchanged: the walk was already linear in the payload, as any traversal of one
must be. A 5000-level payload terminates inside the bounded walk and is denied
deterministically.

### Evidence

`platform/core/bounded-scan-truncation.test.ts`, 8 cases, written **before** the
production change. Red against the unmodified tree: tests 1, 2, 4 and 7 failed
with "must be DENY, got ALLOW"; tests 5 and 6 **passed** pre-fix, which is the
guard against over-correcting into a false-positive denial. Test 8 was added
after the first fix attempt and caught the `extractCommandText` gap, which is
why the fourth instance is in this record.

Mutation testing, both reverted and verified by SHA-256 against pre-mutation
hashes:

| mutation | result |
| --- | --- |
| fail-closed deny removed from `classifyTrustedOperation` | tests 4 and 8 fail |
| truncation recording removed from `collectFromObject` | test 3 fails |

### Consequence

The read, controlled, and structured-command tiers are now covered by the same
fail-closed rule D-027 established for writes. Three drifted depth literals
become one. No policy file or `.pi/` configuration changed; the bound is a
property of the scanners, not of the operator's policy.

### Observation, deliberately not changed

`artifact.ts declaredArtifactReferences` still calls the unscoped
`extractToolPathCandidates`. Truncation there costs artifact provenance
completeness, not containment: every reference that is declared is still
boundary-checked by `verifyArtifact`, so an empty result grants nothing. It is
outside the four affected scanners and is recorded here rather than fixed inside
a security MR.

Also noted, not fixed: `sensitiveBasenameMatch` retains an
`extractPathCandidates` default for external callers. Its only in-repo caller
passes the scanned candidate list, and the enclosing decision already denies on
truncation, so no live fail-open remains.

### Cross-references

- D-027 — the write deny-scan bound this extends to every tier; its reason text
  is preserved and pinned by test 6.
- D-009 — "a limit declared here is a limit that is enforced", the same
  fail-closed instinct applied to scan bounds.
- D-030 — referenced by `tool-paths-recursion.test.ts` but absent from this file;
  that gap is pre-existing and was not fabricated here.

## D-032 — Schema memory has two stores, and the checkout's own wins

**Date:** 2026-10-02
**Stage:** 3 (product wedge)
**Status:** Accepted

### Context

Stage 2 established a verified column mapping for the Pega alert export: the
category role is `alert_code`, the duration role is `elapsed_time`, and
`alertType` — which is named exactly like a category column and holds a single
distinct value across the whole export — is rejected as unable to discriminate.

The same export shape will arrive again, from a customer who has never run this
tool. If the only place that knowledge lives is a per-checkout scratch
directory, then every new install re-derives the mapping by column name, and
re-runs the R9 trap on real customer data instead of on a fixture.

### Decision

Two stores, one merge, and the order between them is the decision:

> **SUPERSEDED IN PART — see the note at the end of this entry.** The learned
> store was renamed from `.session-archive/schemas.json` to
> `.session-archive/schema-memory.json`, and the legacy name is no longer read.
> The ordering ruling below still stands; only the filename changed, and the
> reason for the change is recorded in the addendum.

1. `.session-archive/schemas.json` — what THIS checkout has learned. Per
   checkout, gitignored, never shipped. Accepted as either a bare array or a
   `{ "schemas": [...] }` object, because it is a file a person edits by hand.
2. `configs/default-schemas.json` — core VERIFIED schemas, tracked in git,
   shipped with the product.

They are merged role by role, archive first: a checkout that corrected one role
keeps that correction and still inherits the verified mapping for the rest.
Choosing a whole store rather than merging would mean either discarding what the
user learned or discarding what we verified.

A stored mapping is applied only to a file that actually has its columns, and
only when it can fill the required roles. It is never a way to force a column
past the cardinality rejection: that rejection is a property of the data, and a
configuration file does not overrule arithmetic.

### Consequence

- `platform/conductor/schema-memory.ts` is the only reader of either store. A
  missing, empty or corrupt archive degrades to the shipped defaults and never
  throws: a memory subsystem that can take the product down is worse than one
  that forgets.
- A column supplied by a store is reported as `established` with its
  provenance; everything inferred from a column NAME stays `hypothesis`. The
  report's own sentence about its basis is now derived from that count rather
  than hardcoded, because a page that calls a verified mapping a guess — or a
  guess an established fact — is worse than one that admits what it does not know.
- Pinned by `platform/conductor/schema-memory.test.ts` (5) and
  `platform/conductor/report-markdown.test.ts` (5).

### Cross-references

- R9 (Stage 2) — the `alertType` cardinality rejection this store now carries.
- D-016 — the per-checkout vault precedent for runtime-learned state staying
  untracked.

## D-033 — The dashboard is a generated string, and the one CDN exception is isolated

**Date:** 2026-10-03
**Stage:** 4 (interactive dashboards)
**Status:** Accepted, with a recorded limit
**Affects:** `platform/web/react-report.ts`, `platform/web/page.ts`, D-018

### Context

The report this product produces is static: a Markdown file and an HTML page
with inline SVG. That answers "what is in this file". A commercial product has
to answer "what do I do next", and the difference between those two questions is
interactivity — filtering findings by severity, switching the ranking between
top 5 and top 10 — without re-reading or re-parsing anything.

The obvious way to build that is a React application in the repository, with a
toolchain, a lockfile, a build step and a dev server. That directly contradicts
the product's central claim, which is that a fresh clone runs: see D-018, where
the platform was given **zero runtime dependencies** so that "it works on my
machine" has nowhere to happen. A build step is the same failure wearing
different clothes.

### Decision

> The interactive dashboard is a **generated string**. No build step, no
> installed dependency, no `node_modules`. The document IS the deliverable.

`toReactDashboard(analysis)` returns a complete standalone HTML string, in the
same way the SVG chart generator returns markup. The application code is a
literal in the module, small enough to read, and the data travels beside it as
one escaped JSON block.

React itself is loaded from a CDN. This is the **only** place in the product
where third-party code executes, and it is the decision this entry exists to
justify rather than to bury.

The justification is **isolation, not hope**:

1. **It is a separate artifact from the kernel's own page.** The wedge at
   `platform/web/page.ts` keeps `default-src 'none'` and loads nothing remote.
   The generated dashboard carries its own, wider policy. These are not kept
   consistent with each other on purpose, and a test in `react-report.test.ts`
   asserts the difference so nobody widens the kernel's page to match.
2. **Versions are pinned**, and asserted by test. An unpinned reference means a
   report about a production incident can change because somebody else published
   a package.
3. **The app makes no network calls.** It reads the JSON block beside it and
   nothing else, so there is nothing for injected code to exfiltrate even if it
   ran.
4. **The application source is generated by us** and is small enough to audit by
   reading it.

The payload is the other half of the risk, and it is fully handled rather than
argued about. The embedded JSON holds column names and cell values taken from a
file the user dropped, so a file containing a script-closing sequence is not a
hypothetical for a product whose job is ingesting arbitrary files. `embedJson`
escapes `<`, `>` and `&`, plus U+2028 and U+2029, at the JSON level, so the data
still round-trips to the exact original string. Tested by planting a hostile
column name and asserting both that nothing breaks out and that the value comes
back intact.

### The limit, stated rather than solved

Pinning the version prevents silent drift. **It does not give integrity of the
publisher.** A compromised `unpkg` account, or a malicious patch release of the
pinned version, executes inside a page that has just been trusted to read the
user's files.

The real fixes are to vendor the two files into the image, or to pin by
`integrity` attribute (subresource integrity). Both need a build step that
verifies a hash, and this repository deliberately has no build step. So this is
recorded as **open risk**, with the two closing options named, rather than
described as handled.

### Consequence

- `platform/web/react-report.ts` is self-contained. Nothing under `platform/`
  imports a package, so D-018 still holds.
- Interactivity is asserted at **source level**, not against a rendered DOM:
  there is no browser and no React in this environment, so the tests check that
  the controls are wired to state and that the state reaches the render. This is
  a weaker claim than a rendered-DOM test and is labelled as such in the test.
- The severity vocabulary is a **closed set** (`critical`/`warning`/`info`)
  derived from the profiler's own fences, so the filter dropdown is built from a
  known list rather than from whatever values happened to appear.

### Cross-references

- D-018 — zero runtime dependencies, the claim this decision protects.
- D-034 — containerisation, where the same page is served from an image.

## D-034 — The container binds wider than the tool does, and the boundary moves to the volume

**Date:** 2026-10-03
**Stage:** 4 (commercial deployment)
**Status:** Accepted
**Affects:** `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `platform/web/server.ts`, `start-ui.mjs`

### Context

`startWedgeServer` binds `127.0.0.1`, and that is a security decision rather than
a default: the process reads the user's files and writes reports, so a listener
on every interface turns a local tool into a remote one. It has been that way
since the wedge was written and it is pinned by test.

Containerising it runs straight into that decision. **A loopback bind inside a
container is unreachable from the host.** Docker publishes a port to the
container's own interface, not to its loopback, so a containerised wedge starts
successfully and then refuses every connection. The symptom is a dead product
with a healthy-looking log, and the fix everyone reaches for is to bind
`0.0.0.0` — which silently deletes the security decision above, in the one
place where nobody was reading for it.

### Decision

> The **default is unchanged and stays loopback.** `0.0.0.0` is an explicit
> opt-in, used only inside the container, and the safety comes from what
> surrounds it.

1. `WedgeOptions.host` defaults to `127.0.0.1`, and a test asserts the default
   has not moved. `--host` / `$WEDGE_HOST` is how a deployment opts in.
2. Inside the container the process binds `0.0.0.0`; the compose file publishes
   `"127.0.0.1:3000:3000"`, so the **host**-visible surface is the same loopback
   address as running `start-ui.mjs` directly. The container's network namespace
   is the isolation in between.
3. A widened bind **prints a warning at startup**, so it is never silent.

Three supporting decisions travel with it:

- **No `npm install` in the serving image.** D-018 means there are no runtime
  dependencies, so the image ships with no `node_modules` at all. This is a
  security property and not only a size one: no installed packages means no
  third-party code to compromise and no lockfile to drift. (The earlier
  `docker-ui-scaffold` test container *does* install devDependencies, correctly,
  because `npm test` runs `tsc`.)
- **The data boundary is a named volume, not a host bind mount.** A bind hands
  the container whatever the host path resolves to, and "the data directory" is
  very often the repository root. A named volume starts empty, so the only thing
  in it is what was deliberately put there. The boundary is also declared in the
  `Dockerfile` itself, so `docker run` without compose gets the same containment.
- **`.session-archive/` is excluded from the build context.** It is gitignored,
  so it is not in the repository, which means the build context picks it up from
  a **working checkout**. It holds the developer's learned schema memory — months
  of corrections about what their columns mean — and baking it into an image
  publishes one operator's operational knowledge to everyone who pulls. The
  runtime creates its own archive inside the mounted volume, which is the correct
  place for it: per deployment, and gone with the volume.

### Consequence

- The image runs as `node` (uid 1000), and the workspace is chowned **before** the
  `USER` switch, because a chown after it fails and a container that will not
  start is one nobody debugs.
- `read_only: true` with a `tmpfs` at `/tmp`, `no-new-privileges`, a memory
  ceiling and a PID cap. Input size is the operator's to choose, so the ceiling
  belongs to the deployment.
- The healthcheck requests the real route rather than opening a socket, because a
  listener that is up while its module graph failed to import answers on the
  socket and 500s on every request.
- **The image has never been built.** Docker is absent from the authoring
  environment. Both files say so in capitals, a test asserts they keep saying
  so, and the operator runs `docker compose up --build`. The precedent is the
  `docker-ui-scaffold` branch, which recorded the same limitation honestly and
  was right to. An unverified image described as verified is the exact defect
  this repository refuses to commit elsewhere.
- `platform/web/deployment.test.ts` pins the constraints as a **regression
  guard**, not as verification: it reads the three files as text. It is good for
  the way these rots — removing `USER node` to silence a permission error,
  changing `127.0.0.1:3000:3000` to `3000:3000` so a colleague can see a demo,
  bind-mounting the working tree to make a path resolve. Each is a one-line
  change that looks like a fix and is a boundary removal.

### Cross-references

- D-033 — the CDN exception, which travels into the image unchanged.
- D-032 — why the session archive is sensitive in the first place.

---

## D-035 — The second CDN exception, and the one rule that bounds both

**Date:** 2026-10-04
**Stage:** 4 (conversational wedge and visual engine)
**Status:** Accepted, with debt
**Affects:** `platform/web/react-report.ts`, `platform/web/server.ts`

### Context

D-033 admitted one remote dependency — React — into the generated dashboard, and
isolated it: a separate artifact, pinned versions, no network calls of its own.

Phase 4 needs two more things, and each one reaches for a remote script.

**A chart library.** Phase 3's SVG charts are static images of the answer. The
Owner asked to hover a spike and see the value and the hour, which an `<img>`
cannot do. Chart.js is UMD with an imperative `new Chart(canvas, config)` entry
point and no build step. Recharts — the more natural React choice — must be
*compiled against* React, and adopting it would mean shipping Babel output or
hand-rolling a component tree around a library that is already imperative, in an
artifact whose entire premise is that there is no toolchain.

**A same-origin POST.** The chat has to reach `/api/feedback`, which needs a
policy that permits it. A dashboard opened over `file://` has no origin to post
to, so the conversational page is served by `GET /api/dashboard` — and that
route widens `connect-src` from `'none'` to `'self'`.

### Decision

> **The exception is admitted a second time, and the rule that bounds it is
> stated once rather than re-derived per dependency.**

1. **Chart.js joins React on the CDN**, pinned to `4.4.1` — a major-plus-patch,
   never `@latest`. A test asserts the pin, so "bump the dependency" is never a
   silent commit.
2. **`connect-src` is `'self'` for the live page and stays `'none'` for the
   standalone file.** The two artifacts are different documents with different
   reach, and the offline one keeps every guarantee D-033 gave it. The chat is
   not merely hidden in the standalone artifact — it is **not emitted into it**,
   so the file contains no `/api/feedback` string and cannot present a control
   wired to an endpoint that will never answer.
3. **What may cross the wire is a mapping, never the file.** The request body is
   `path`, `column`, `role` — three fields, pinned by test, with a negative
   assertion that nothing row-shaped may be added later.
4. **The charts are an enhancement, never the only way to read a number.** Every
   charted series is also rendered as a table beneath it, and `typeof Chart` is
   feature-detected before every use. A blocked or offline CDN costs two
   pictures, not the report.
5. **The kernel's own page is untouched.** `platform/web/page.ts` keeps
   `default-src 'none'` and loads nothing remote. The widening lives only in the
   separately generated artifact.

### Why the debt is acceptable, and what would end it

Pinning a version stops silent drift. **It does not stop a compromised
publisher**, and the same sentence was written for React in D-033 and is still
true for Chart.js now that there are two.

The honest closure is vendoring both files at build time, or pinning by
`integrity` hash — and both need a build step this repository deliberately does
not have. So this is recorded as accepted debt with a named trigger rather than
described as solved.

**Trigger to revisit:** the first time a user reports a chart or a dashboard
that fails to render on a network that reaches neither unpkg nor a CDN mirror.
That is the moment the "enhancement only" rule is under real pressure, because
the workaround will be reaching for `unsafe-inline`/`unsafe-eval`, and that is
the boundary removal this repository refuses to make quietly.

### Cross-references

- D-033 — the first CDN exception, and the isolation argument both rest on.
- D-032 — why the session archive is sensitive; the chat writes to it.
- D-034 — the container that serves `/api/dashboard` unchanged.

---

## D-036 — Tailwind, a compiler shipped to the browser, and why the CDN is the lesser evil here

**Date:** 2026-10-04
**Stage:** 4 (UX overhaul)
**Status:** Accepted, with debt
**Affects:** `platform/web/react-report.ts`, `platform/web/page.ts`

### Context

The Owner opened a database performance CSV and was shown a hundred rows of
table. Task 1 of the UX overhaul asked for Tailwind via CDN to make the page
look like a product rather than a dump.

Two findings from that work matter more than the styling, and both are recorded
here because they change how this artifact should be read.

**THE DASHBOARD WAS NEVER SHOWN TO ANYONE.** The dropzone called `/api/report`,
which returns Markdown, and injected it with `innerHTML`. The React dashboard —
every chart, the tooltips, the whole conversational UI — was served by
`/api/dashboard`, which existed, was tested, and had **zero callers**. So the
product had two front ends: the one a user reached, and the one built for them.
Every existing test passed throughout, because each held the dashboard in a
variable and read it as a string. Not one asked whether the product ever
navigated a user to it. Tests of a generator prove the generator works; only a
test of the product proves the generator is REACHED.

**THE CHAT PANEL WAS DEAD MARKUP IN A BROWSER.** The correction-refresh function
searches the re-read document for the end of its data block, so its own source
contains the literal text that closes an HTML script element. That source is
emitted inside a script element, and the HTML tokenizer — unlike a JS parser —
has no idea it is inside a string. It ended the block there, roughly a third of
the way through, and the entire chat panel was parsed as markup rather than
script. The fix is to escape the forward slash: in a JavaScript string literal
`\/` is just `/`, so the search still works while the tokenizer no longer
recognises an end tag.

It was found only because `react-app-parses.test.ts` extracts the block with a
naive `indexOf` on the closing tag, which reproduces the browser's reading of the
document. A cleverer extractor that understood JS string context would have
hidden the bug and reported a green suite for a page with no chat at all.

### Decision

> **Tailwind joins React and Chart.js on the CDN, and the rule that bounds all
> three is stated once, in D-035.**

1. **Pinned to `3.4.16`**, never a floating tag, asserted by test. A report about
   a production incident must not restyle itself because somebody published a
   build.
2. **The bespoke stylesheet is cut to what utilities cannot express** — the
   chart box, the severity pills, the chart-library-off notice. Two sources of
   truth for one property is how a design system rots.
3. **A Tailwind failure is survivable by construction.** If the CDN does not
   answer, the class names simply stop applying. The document is ordered so the
   *unstyled* reading order is still the right one — findings before raw data,
   charts before both — and the charts already fall back to tables via
   `ChartNote`. A test asserts that ordering rather than trusting it.
4. **The kernel's own page is untouched.** `platform/web/page.ts` keeps
   `default-src 'none'`, loads nothing remote, and since the dropzone navigates
   instead of injecting, it has **no HTML-injection sink at all**.

### The trade, stated plainly

Tailwind's Play CDN **compiles utilities in the browser**. It ships a compiler
to the client, and its own documentation says not to use it in production. That
is the correct default, and it is being overridden here for one reason: the
alternative is vendoring Tailwind, which means shipping a build step, and "no
build step" is the premise of this artifact (D-033). A heavier compiler over
the wire on a page that already loads React and Chart.js is the smaller cost
against a toolchain.

**What pinning does not buy, restated from D-035 because it is now three
dependencies deep:** pinning stops silent drift. It does not stop a compromised
publisher. The honest closure is vendoring or subresource-integrity hashing, and
both need the build this repository does not have.

**Trigger to revisit:** the first time a user reports a dashboard that renders
unstyled, or fails to render, on a network that reaches none of the three CDNs.
At that point the workaround will be reaching for `unsafe-inline`/`unsafe-eval`,
and that is the boundary removal this repository refuses to make quietly.

### Cross-references

- D-035 — the exception set and the rule that bounds all three dependencies.
- D-033 — "no build step", the premise this decision trades against.
- `page-navigation.test.ts` — the test that asked whether the product is reached.
- `react-app-parses.test.ts` — the naive extractor that caught the dead chat.


## D-037 — V1 Commercial Wedge: complete, with the two caveats that travel with it

**Date:** 2026-10-05
**Stage:** 5 (Chat-first agent)
**Status:** Accepted
**Affects:** `platform/web/react-report.ts`, `platform/web/server.ts`, `docs/DECISIONS.md`

### Context

The wedge is four capabilities behind one loop: drop a file, ask it questions
in English, correct it by speaking, and send the result to somebody who has no
access to the machine it came from.

1. **Omnivorous ingestion.** CSV, database (SQLite and Postgres) and PDF are
   read through a router that decides what a file IS before it decides anything
   else, so nobody has to name a format. `router.test.ts`, `db-connector.test.ts`,
   `pdf-connector.test.ts`.
2. **Conversational querying.** The chat is the primary surface, and the
   conductor answers in words rather than routing to a chart.
3. **Predictive forecasting.** Wired to a chart that cannot be mistaken for data
   (1f46077).
4. **Standalone export.** One self-contained file, carrying the conversation and
   the numbers, built through the standalone path on purpose.

### The defect worth recording, because the suite caught it and a belief did not

The export work refactored the composer from a runtime `D.live ?` ternary to a
GENERATION-TIME SPLICE, and moved the endpoints from literal strings to
substitution tokens resolved at build time. Both changes were improvements. One
of them shipped broken.

`refreshFromServer` — and therefore the `__DASH_URL__` token — lives in
`CHAT_SOURCE`, which is concatenated by the FINAL `.replace(...)` in the chain.
The three endpoint substitutions ran BEFORE that concatenation, so on a live page
the token was never replaced. The dashboard shipped:

    fetch("__DASH_URL__?path=" + encodeURIComponent(D.source))

which the browser resolves relative to the current origin. It 404s, lands in the
catch branch, and the user sees the correction save while the charts silently keep
drawing the pre-correction analysis. The dangerous version of that feature is the
one that appears to work.

`react-chat-refresh.test.ts` had asserted `/api/dashboard?path=` on the live
page for several stages. It was not a stale test needing an update. It was
correct, and the code had regressed under it.

Two things generalise, and both are the reason this entry exists:

- **An injection that runs after a substitution defeats that substitution.**
  Order is load-bearing whenever a document is assembled from parts. The
  generator now throws if any `__TOKEN__` survives to the emitted source, so
  this class of defect fails at build time rather than in a browser that renders
  a 404 as a stale chart.
- **A reported test count is a claim, not a measurement.** The handoff for this
  session said "exactly 1 test is failing". There were five, and four of them
  were regressions against committed, previously-green tests. The count was
  never run. Had it been, a broken live-refresh loop would have been caught one
  session earlier.

Three further test assertions were updated, and the distinction matters: each had
asserted an IMPLEMENTATION DETAIL the splice legitimately removed, and each now
asserts a STRONGER property — that the offline artifact contains no composer and
no endpoint at all, rather than a composer gated at runtime. Two of the three are
strictly tighter. The third (`react-report.test.ts`, which asserted the submit
handler) was MOVED to the live page rather than strengthened, because a composer
cannot be asserted on a document that no longer contains one. That one is a real
trade, and it is recorded as one.

### Audit result, 2026-10-05

`npm test`: **1073 passed, 0 failed, 2 skipped** (1075 TypeScript tests) plus
22/22 in the MJS suite. 110 of those are dedicated security tests
(`sql-guard`, `redaction`, `vault-redaction`, `connector-security`,
`path-boundary-corpus`, `redaction-boundary`, `vault-boundary`,
`security-gap-r6-r7`, `server-boundary`), all passing.

Verified at the ARTIFACT level, not only through the suite:

- **Path boundaries** — the export route returns 403 for `../../../etc/passwd`,
  using the same kernel resolver as every other route. An export endpoint that
  reads an arbitrary path is an exfiltration endpoint with a download header on
  it; it is not one.
- **Secret redaction** — a closed field-name set (25 credential names) plus
  provider key prefixes plus entropy-based detection, with explicit
  false-positive carve-outs for hex, decimal and UUID tokens so that ordinary
  identifiers are not silently destroyed.
- **SQL injection** — `classifySql` admits a single read-only SELECT and denies
  everything else, and the DB connector checks the PATH BEFORE the query, so an
  escaping path is refused even when the query is innocent. Rows are capped.
  Note the threat model honestly: the SQL here is authored by the analyst against
  their own database, not interpolated from file contents, so a read-only
  classifier is the correct control and parameterisation would be the wrong one.
- **CSP** — one function feeds both the meta tag and the HTTP header, and
  `chart-assets.test.ts` asserts they are byte-identical. Live is
  `connect-src 'self'`, export is `connect-src 'none'`, no wildcard, no
  `unsafe-eval`, no duplicated directive.

### Caveat one: the export still contains two `fetch()` calls

They are dead in the strict sense — the code is present — and cannot reach a
network. Both target `about:blank#offline`, a non-network scheme, inside
`ask()`, which returns on `if (!D.live) return;`; the payload says
`live: false`; the composer that would call `ask()` is spliced out; and
`connect-src 'none'` would block the request at the browser regardless. Four
independent layers, any one of which is sufficient.

This is stated rather than glossed because the obvious next edit is to delete
those two calls, and someone should know that the deletion is safe but the
REASON matters: they are the residue of making offline mean "the network calls
are absent from the source" and not finishing the job for `ask()`, which lives
in `APP_SOURCE` and is therefore shared with the live page. Leaving them inert
is defensible; leaving them unremarked would not be.

### Caveat two: two security tests did not run here

`a stored vault is not readable by group or other` and `a vault file left
world-readable by an earlier version is tightened on its next write` skip on
Windows, because POSIX permission bits are not meaningful on it. The invariant
"secrets at rest are not world-readable" is therefore UNVERIFIED on the platform
this session ran on. It is not regressed — it is unproven. It must be run on
Linux before any claim is made about credential storage on disk.

### What V1 is, stated without inflation

It is a local-first analysis wedge: files read on the user's machine, nothing
phoned home, every network call either absent or inert in a document that is
meant to be sent away. The three CDNs are a known, recorded, bounded debt
(D-035, D-036) — the dashboards fetch React, Chart.js and Tailwind from unpkg and
cdn.tailwindcss.com, so a dashboard rendered on an air-gapped machine will not
style, and the honest fix is vendoring or SRI, which needs the build step
D-033 trades against.

The remaining refusals are features. A refused path, a redacted credential and a
denied `DROP` are the product working.

### Cross-references

- D-036 — the CDN debt this carries.
- D-033 — "no build step", the premise vendoring would cost.
- `react-chat-refresh.test.ts` — the test that was right and the code that was wrong.
- `export.test.ts` — the export's own gate, asserting the standalone path.

## D-038 — V2: MAD instead of Z-scores, and a symptom that was not the size it looked like

**Date:** 2026-10-09
**Stage:** 6 (Enterprise scale & advanced intelligence)
**Status:** Accepted
**Affects:** `platform/conductor/multivariate.ts`, `platform/conductor/conversation.ts`, `platform/conductor/query.ts`, `platform/web/server.ts`

### Context

V2 closed three gaps. The conversational surface could not name a column that was
not there; the engine looked along one column at a time; and the categories
question was reported as failing on files of 200 rows or more, which for an
enterprise tool is the difference between a demo and a product.

### THE MATH, AND WHY IT IS NOT A Z-SCORE

Every existing check standardises on a mean and a standard deviation. For
outlier detection that is the obvious choice and the wrong one, and the reason
is specific to this problem: **the outliers being hunted are exactly the values
that inflate a standard deviation.** Each one makes itself look less anomalous.
Four extreme rows can widen sigma far enough to conceal all four, and the
defect that costs an enterprise money is the one that gets hidden.

The usual repair is to remove the outliers before estimating, which makes the
test depend on a first pass that has already decided what an outlier is.

So V2 standardises on the **median** and the **MAD** — median absolute
deviation — rescaled by **1.4826**, the constant that makes the MAD estimate
sigma for normally distributed data. Both are medians, so both are unmoved by a
minority of extreme values *by construction*. That is precisely why they are
correct here: the thing being searched for is the thing that would corrupt the
obvious estimator. `multivariate.test.ts` runs the naive sigma alongside so the
obvious way is not chosen again by someone who has not seen it fail.

### WHY TWO COLUMNS AT ALL

A 1D check finds big numbers. The defect worth a phone call is a number that
**contradicts its neighbour**: high `latency_ms` with low `total_bytes` is not a
slow request, it is a row that does not belong to the same population as its
neighbours — a bad join, or a field measured in the wrong unit. A per-column
check reports "latency is high", which is true and useless.

A row is reported only when **discordant**: both axes past the line *and opposite
signs*. A row that is large on both axes is self-consistent and belongs to the
existing per-column checks, so claiming it would duplicate a finding and inflate
the count. A row extreme on one axis is left alone on purpose. Both are pinned,
because a detector that flags everything is worse than none — a user who learns
to ignore it will ignore the real one.

Two columns is a **hard bound**, stated in the code. With k columns the space of
contradictions is combinatorial and the finding stops being legible in one
sentence.

### THE 200-ROW BOUNDARY WAS NOT A BOUNDARY

The categories question was reported as declining at 200 rows and working below
it, and the obvious reading was a classification-sample cap. **There is no such
cap.** Sweeping the real path — `resolveSchemaMemory` into `analyseBottlenecks` —
resolves the category cleanly at 50, 200, 250 and 400 rows.

The actual cause was upstream of all of it. `readCsvFor` already returns rows as
`{header: value}` records, and the chat handler converted them **a second time**
as if they were cell arrays, so every row became a copy of the first row's
values. The file collapsed to one distinct value per column, the category-role
check demoted it as degenerate, and the question declined.

The reason it *looked* size-dependent is the part worth keeping. A corruption
with no boundary does not fail on a clean schedule — whether the question
declined depended on whether a given row count happened to trip some other
threshold on the way past. So it presented as a boundary at 200, and the hunt for
a sample cap was a hunt for something that was never there. **A symptom that
tracks an input you did not change is a symptom you have not understood.**

Nothing caught it at the time. The analyser, the schema resolver and the archive
were all correct *in isolation*, because the isolation harness did not reproduce
the server's data preparation. Every unit test passed. Only a test through the
HTTP boundary can see a bug that lives in the seam between layers.

### THE DECLINE THAT WAS NOT A DECLINE

`resolveQuery` has always known the numeric columns and always composed a
message naming them. It returned that message as `matched: false`, which the
caller reads as "not a question I recognise" — so it fell through to the generic
"I cannot answer that from what I have measured".

The effect was worse than an unhelpful answer. Someone asks a reasonable
question about a column that does not exist and is told the agent cannot answer,
which reads as the agent being **incapable** rather than the column being absent,
and invites the user to conclude the product does less than it does. The router
now has a third state: a sentence it does not recognise still falls through; a
sentence whose *shape* it recognises and which is missing one input is surfaced
as a question, with the nearest real name suggested by bounded Damerau-Levenshtein
distance.

### Honest status

Complete: the clarification path, the row-fidelity fix, MAD-based cross-column
detection in the summary **and** in the chat.

**Not attempted, by decision:** the streaming ingestion rewrite and the cloud
connector. The first would have put the analyser, the schema resolver,
synthesis, the report renderer and the web server all in one change; the second
is the first route in this product that would reach the network on a user's
behalf, and it belongs in its own review rather than at the end of a long one.

**Still unverified:** secret file permissions on Windows (D-037 caveat two), and
the Linux assertion that would close it, because the project still has **zero
active CI runners** and no pipeline in this repository has ever executed. V2 is
declared on a locally green suite — 1108 passed, 0 failed, 2 skipped — and on
110 dedicated security tests. It is **not** declared on a green pipeline,
because there has not been one.

### Cross-references

- D-037 — the V1 wedge declaration, and the caveat this inherits.
- D-036 — the recorded CDN debt, unchanged by V2.
- `multivariate.test.ts` — the maths, and the naive-sigma comparison.
- `v2-top-categories.test.ts` — the size sweep that proved there was no boundary.

## D-039 — Egress, the credential vault, and a second agent contract beside the Conductor's

**Date:** 2026-10-14
**Stage:** 7 (Multi-agent platform)
**Status:** Accepted
**Affects:** `platform/egress/webhook-dispatcher.ts`, `platform/omniroute/edge-security.ts`, `platform/swarm/`, `platform/api/ui-routes.ts`, `Dockerfile`, `docker-compose.yml`, `package.json`

### Context

Three decisions in one epic, each of which forecloses an alternative that looks
obvious until it is written down.

### D-039.1 — Egress is a separate module, and it shares no rules with ingress

Ingress fails by accepting something it should refuse; egress fails by omitting
something it should send. A shared abstraction would have to pretend those are the
same problem. Egress therefore has no caller to prove, so it presents no
credential — and its failure mode is a silent blind spot, which is why **every
attempt is returned** rather than logged and dropped, and why `delivered` counts
endpoints rather than attempts.

Retries are split into transient and permanent because lumping them is how a
partner's outage becomes our load: a 4xx that is not transient is attempted once
and reported, since retrying an identical refusal is a request to be ignored. A
429 that states `Retry-After` outranks our own ladder.

**Refused:** a durable outbox. Retry within a process is not a delivery
guarantee, and the honest upgrade is an inspectable queue — a design decision, not
a bug.

### D-039.2 — Provisioning is a `VaultProvider`, loaded once at startup

The gateway credential list was a hardcoded array, so the values deciding who may
push events lived in the repository, and therefore in every clone, every branch
and every image built from it. Provisioning is now an interface, so an environment
variable in development and an external credential store in production are one
call site.

Four rules, each a named failure mode: **read once and memoise**, so a mid-flight
change cannot silently alter who is admitted; **report a rejected entry by index
and reason rather than dropping it**, because dropping it is safe *and* how a
partner gets locked out against a manifest that looks correct; **refuse unknown
fields**, so a typo cannot mint a well-formed credential that admits nobody; and
**treat empty as closed**, because an environment that refuses to boot is a
platform that is down.

Values never appear in a rejection, a diagnostic or an error.

### D-039.3 — `DiagnosticAgent` sits BESIDE `Subagent`, and does not replace it

`Subagent` is a good contract for what it does: synchronous, question-shaped,
returning one `Reply` the renderer already draws. It cannot carry an AML sweep or a
supply-chain walk, because those are async, are selected by scope rather than by
prompt, and produce findings with evidence rather than a widget.

So there are two contracts. `fromSubagent` adapts the three existing Conductor
agents, which means **no conductor code changed** — the refactor is the adapter.

`evidence` is a required field, so an unverifiable claim is a type error rather
than a review comment.

### D-039.4 — A stub must not produce findings

A stub answering "3 high-severity vulnerabilities" is a fabrication. It will be
screenshotted, quoted in a status report and acted on. Each of the three
specialists is therefore selectable by vocabulary and refuses with
`status: "unavailable"`; the registry will not route to a stub unless a caller
opts in, and even then the refusal is what comes back. An empty roster that says
so is useful; a populated one that lies is worse than useless.

### D-039.5 — The command center has no HTTP server in it

`handle` is a function from (method, path, headers) to a response value, so the
decisions are testable without a socket and the transport stays someone else's
problem. All three routes prove the caller with the **same** `guard` and the same
vault as the ingress: a route that validated credentials its own way would be a
second control plane that drifts from the one under attack.

An unknown path is 404ed *before* proof and does not name the routes, because
naming them hands a stranger the reconnaissance this edge exists to prevent.

`OmniRouteGateway.providerNames()` was added rather than recovering a name from a
partition label such as `push:payments` — that is a prefix dependency on an
internal detail, and it silently returns the wrong name the day a second prefix
appears.

### D-039.6 — The container's GC limits are a documented default, not a measurement

`--max-old-space-size=256` against the existing 512 MiB container limit, so the
bounded-memory claim in the streaming reader is enforced by the image rather than
assumed. Deliberately half the container limit: the heap is only part of a
process, and a cap at or above the kernel's buys an OOM kill with no runtime
explanation.

The Dockerfile was **appended to, not replaced** — its non-root user, read-only
root contract and honest "never built" status are load-bearing. `docker-compose.yml`
repeats the command so one deployment can raise the ceiling without a rebuild;
both copies are verified identical.

**Not verified:** no build and no load test, because Docker is unavailable in the
authoring environment. The flag names and the resulting heap limit were verified
against the local Node; the values are not benchmarked.

### Cross-references

- D-018 — zero runtime dependencies, so the egress dispatcher uses global `fetch`
  and no new packages.
- D-037 — the wedge declaration, whose non-root and loopback contract this
  container inherits unchanged.
- `webhook-dispatcher.test.ts` — the retry ladder, asserted without waiting.
- `edge-security.test.ts` — the four vault rules.
- `agent-registry.test.ts` — a stub that cannot be mistaken for a capability.
- `ui-routes.test.ts` — proof before data, and 404 before proof.

## D-040 — The platform as a factory: schema-driven agents and generated portals

**Date:** 2026-10-21
**Stage:** 8 (Dynamic platform)
**Status:** Accepted
**Affects:** `platform/swarm/dynamic-registry.ts`, `platform/api/portal-routes.ts`, `platform/swarm/agents/stream-harness.ts`, `package.json`

### Context

The platform stops shipping agents and starts shipping a factory. Two consequences
follow, and both foreclose an alternative that looks obvious.

### D-040.1 — A schema is DATA interpreted by code that already exists

`AgentSchema` is a JSON document: patterns, thresholds, rate windows, and the
streams a customer says are theirs. Nothing in a schema can read a file, open a
socket, or reach another agent, and the reason is structural rather than a matter
of trust — there is no interpreter for a customer's intentions to escape through.
The three hand-written specialists from D-039 are unaffected; they were never the
product.

A generated agent implements `DiagnosticAgent` with **no special case anywhere**,
so it routes, registers, publishes through the command center and appears on a
portal through exactly the interfaces a hand-written one uses. That property is
the whole claim of the pivot, and it is pinned by test.

### D-040.2 — The regex is MITIGATED, NOT SOLVED, and says so

Every other part of a schema is bounded by construction. A regular expression is
not: `(a+)+` runs in time exponential in the subject length, and the subjects here
arrived off a network.

Four defences, all mitigation:

1. a ceiling on pattern length;
2. rejection of the classic nested-quantifier shape **at validation**, so a
   customer authoring a portal gets a field-level error rather than a wedged
   process;
3. compilation **once** at registration;
4. bounded subjects, via the line ceiling in the stream harness.

What this does *not* do is bound worst-case time in general. The heuristic does not
catch nesting two groups deep. The real fix is a linear-time engine (RE2, or WASM)
and the platform has **zero runtime dependencies by decision (D-018)**, so adding
one is an Owner decision, not a detail to assume. `SCHEMA_LIMITS` is where that
ceiling lives in code instead of in a caveat.

The `g` flag is refused outright: with it, `RegExp.test` remembers `lastIndex`, so
a pattern would find every second event differently depending on what preceded it.

### D-040.3 — A portal is a VALUE, and the tenant is the proven credential

Portals are returned as JSON, not rendered as HTML. A layout change is a data
change, a customer's portal is exportable, and the server never assembles markup
for somebody else to paste. It also avoids putting a template language on a
platform whose claim is that it has one.

The tenancy boundary is the token's own `id`. **No tenant name in a path, header
or body is ever consulted**, because a tenant parameter a caller can choose is a
tenant parameter an attacker chooses. Adding a `tenant` field to `GatewayToken` was
rejected: the token list is vault-provisioned, and a second tenant field is a
second thing to get wrong at issuance. The id is already unique and already proven.

Tenant isolation is tested with **two live credentials**, not one.

Stored portal configs are validated on write *and re-validated on read*: the store
is replaceable, and a read path that trusts it is one refactor from serving a
malformed layout to every tenant at once.

### D-040.4 — Unknown fields are refused, everywhere

A misspelled `treshold` produces a rule that never fires and an agent that reports
a clean pipeline for ever. A misspelled `dashbords` produces a portal that renders
nothing, and nothing is the hardest failure to notice. Both are refusals with a
path, not defaults.

### D-040.5 — Three defects the tests caught, recorded so they are not reintroduced

- **`RateWindow` tracked a modulo.** With `bucketCount === 1` — a legitimate
  configuration — every instant maps to slot 0, so `count()` saw its own slot and
  could never forget. It now tracks the **unmodded** bucket index, and the
  elapsed-bucket arithmetic is correct for any ring size.
- **`ZapXmlScanner` watched tag names.** ZAP uses `<alert>` as both the container
  and one of its fields, so a name watcher emitted on the *inner* close and every
  finding it produced was a fragment. It is now a nesting stack that emits only
  when the close leaves no `alert` open.
- **The E2E flood carried no anomalies.** Keying them off the loop index meant
  `i % 30 === 0` was only ever true for even `i`, so every anomaly landed on the
  payments branch. A flood that silently has nothing to find proves the opposite
  of what it claims.

### D-040.6 — The O(1) claim is measured, not asserted

100,000 events at 4 KiB each — 391 MiB of payload volume — through two generated
agents: **4.9 MiB retained**, 64.6 MiB peak RSS, ~257k events/sec. Buffering would
have held 391 MiB of live strings.

The stronger half of the proof needs no GC and no threshold: the finding list is
capped at 50 both at 5,000 events and at 50,000, and every counter is exact at both
sizes. A retention that scaled with input fails that outright.

Both halves matter because `heapUsed` is read without forcing a collection (the
suites run under plain `node --test`, no `--expose-gc`), so the empirical figure
includes transient garbage. The deterministic assertions are the ones that cannot
fluke.

### Cross-references

- D-018 — zero runtime dependencies, which is why the regex risk is mitigated in
  code rather than fixed with a library.
- D-039.3 — the `Subagent` versus `DiagnosticAgent` split this extends.
- D-039.2 — the `VaultProvider` that issues the portal credential.
- `dynamic-registry.test.ts` — the nested-quantifier refusal, and the O(1) primitives.
- `portal-routes.test.ts` — two-credential tenant isolation.
- `e2e-dynamic-platform.test.ts` — the memory proof.


## D-041 — A linear-time regex engine, and why the timeout was the wrong fix

**Date:** 2026-10-28
**Stage:** 9 (ReDoS remediation and demo)
**Status:** Accepted
**Affects:** `platform/swarm/safe-regex.ts`, `platform/swarm/dynamic-registry.ts`, `tsconfig.json`, `scripts/demo.ts`

### Context

D-040.2 recorded that schema regexes ran on V8 and could be hung by a
nested-quantifier pattern, and mitigated it with a heuristic that refused the
common shapes. This closes that limitation properly.

### D-041.1 — THE REQUESTED 50ms ABORT IS NOT IMPLEMENTABLE, AND BUILDING IT WOULD BE DANGEROUS

The directive asked for a strict evaluation timeout that aborts a pattern after
50ms. A JavaScript regex call is **synchronous**: there is no interrupt, no
`AbortSignal` that reaches it, and no way to move it to another thread without a
structured-clone round trip per event. A timer around such a call can only be
measured *after* it returns, which is after the event loop has already been
blocked for as long as the pattern wanted.

So a timeout wrapper would be the single most dangerous thing this platform could
ship on this surface: it would make a wedged event loop *look* handled in a
review, while remaining exactly as wedged in production.

The fix is therefore structural rather than temporal. Schema patterns are compiled
to a **Thompson NFA** and evaluated in one pass, O(subject x program), with no
backtracking to be exponential with. The 50ms budget survives as a **tripwire**
that disables a pattern and counts it — the alarm, not the door.

### D-041.2 — The nested-quantifier heuristic is DELETED, not left in place

`(a+)+` is now simply safe. Keeping the refusal would forbid customers patterns
they are entitled to write, for a reason that no longer exists.

A control whose justification has evaporated is worse than no control: it is a
control nobody thinks to update, and the next engineer to read it concludes the
platform is more fragile than it is. The reason for the deletion is recorded in
the source where the refusal used to be, so the next reader finds the history
instead of the absence.

The pattern **length ceiling survives**, and its test name now says why: it is a
cost bound, not a safety one. Quoting the two as the same thing is how a control
ends up justified by a reason that has gone.

### D-041.3 — The supported language is a SUBSET, and the refusals are specific

Supported: literals, the dot, classes with ranges and negation, the digit, word
and space shorthands and their negations, groups, alternation, counted
repetitions, the three anchors, word boundaries, and the case-insensitive and
multiline flags.

Refused, each with its own reason: lookahead, lookbehind, backreferences, named
groups, lazy and possessive quantifiers, non-ASCII literals, empty alternatives,
repetition over 1000, program over 20,000 instructions.

A bounded subset that cannot hang is worth more here than a complete one that can,
because the author sees the refusal at authoring time and can write a different
pattern. The global flag is refused too, and for a NEW reason: matching is
stateless, so it is inert rather than meaningful.

### D-041.4 — CORRECTNESS IS THE PRIMARY EVIDENCE, NOT A TIMING NUMBER

A linear engine that is subtly **wrong** is worse than one that is merely slow: it
produces confident wrong verdicts and there is no hang to notice. So the main
evidence is differential — a written corpus of 60 patterns across 40
boundary-chosen subjects, plus a **seeded generative sweep** of 1,200
grammar-built patterns against V8.

Seeded deliberately. A generative differential test that fails intermittently is
worse than none, because it gets rerun until it passes.

### D-041.5 — Five real bugs, all in exit wiring, all found by that sweep

Every one of these produced confident wrong answers with no error and no hang:

1. A character fragment exited at its trailing `match`, which `patch` cannot
   repoint, so a three-count repetition compiled to a single character.
2. A repetition's loop entry had its escape branch emitted as -1 and filled by a
   patcher that only writes the FIRST branch, so a one-or-more repetition matched
   one character.
3. An open-ended counted repetition returned without consuming its closing brace,
   so the brace was parsed as a literal and the pattern silently acquired a
   required character.
4. An alternation's outermost split was both entry and exit, so the caller's patch
   found its first branch already set and no alternation could reach `match`.
5. Alternation chained option **successes** into the next option instead of the
   shared exit. In an NFA all branches run at once, so `a` or `ab` failed to match
   the single character "a".

The lesson worth keeping: in a Thompson construction, "every path out of a region
reaches the same node, and that node is written by the CALLER" is the invariant,
and violating it fails silently rather than loudly.

### D-041.6 — The type gate never covered the scripts directory

Adding the demo to `tsconfig` surfaced a real pre-existing type error in
`generate-synthetic-data.ts`. The gate was widened to the demo file only, and the
debt recorded in the `tsconfig` comment as the next increment that owns it —
rather than fixed inside an epic whose scope is explicitly no new features.

### Cross-references

- D-040.2 — the limitation this closes, and the heuristic it retired.
- D-018 — zero runtime dependencies, which is why the engine is hand-written
  rather than imported and the demo runs on strip-only type erasure.
- `safe-regex.test.ts` — the differential corpus and the seeded sweep.
- `dynamic-registry.test.ts` — the two inverted heuristic tests.
- `scripts/demo.ts` — the end-to-end proof, which throws rather than reporting its
  own failure in passing prose.
