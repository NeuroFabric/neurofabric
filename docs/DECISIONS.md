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



