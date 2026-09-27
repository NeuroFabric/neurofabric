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
- **Status:** accepted, gates pending
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
| **0** | Remove the duplicate `pi-free` install (the git checkout). Reversible, removes double registration, and does not affect the working provider. | **PENDING — run by operator, then recorded here as done** |
| **1** | One real headless Pi turn pinned to the `omni` provider, completing a small real task. | Pending |
| **2** | Full removal of the remaining fallbacks and the openai-compat package. | Pending, blocked on Gate 1 |

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
- **Relates to:** D-004 (operator-only policy changes), D-006 (temporary global bump), F-001 (write-budget saturation), F-005 (policy file inside allowed roots)

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
- Selection is operator-only (D-004). At gauntlet start the operator sets
  `activeLimitProfile`; the committed file keeps the conservative base budget
  at all other times.

Known residual: the policy file itself sits inside the agent-writable boundary
(F-005), so D-004 remains a convention rather than an enforced boundary.


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
3. **Agents never push `main` directly.** `main` advances only via a PR merge or
   an operator push. The guard is the transport boundary by design, not an
   obstacle to be defeated.

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


