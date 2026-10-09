# NeuroFabric

An edge inference platform. It authenticates a caller, accepts events, evaluates
them against registered agent schemas, and emits a verdict and an alert.

It ships **no runtime dependencies** and **no agent framework**. Git, tests and
human oversight are the entire control plane — see
[ADR-001](docs/adr/0001-minimalism-as-the-audit-trail.md) for why, and what it
costs.

---

## Quickstart

Two terminals, from the repository root.

```bash
# terminal 1 — the wedge (the HTTP surface, on 127.0.0.1:8080)
npm run dev

# terminal 2 — the Command Center UI (on 127.0.0.1:5173)
cd frontend
npm install     # once
npm run dev
```

Open **http://127.0.0.1:5173**.

The UI asks for a gateway credential. Anything the wedge is provisioned with
will be accepted; see **Credentials** below for where that value comes from.

### Driving data into it

```bash
# from the repository root. WEDGE_GATEWAY_TOKEN may be set in your shell instead.
node --experimental-strip-types scripts/generate-synthetic-data.ts --flood \
  --url=http://127.0.0.1:8080 --token=<your credential>
```

**Use the `--flag=value` form.** The parser on `main` splits each argument on
`=`, so `--token value` binds an *empty* credential and then reports that none was
supplied — on a command where one plainly was, and, worse, in a form that can
present as a policy-guard firing on a value you just typed correctly. A fix
accepting both forms is in review; until it lands, the equals form is the only one
that works, and this page will not claim otherwise.

The last line printed confirms the provider matches what the dashboard reports. A
mismatch is called out explicitly, because events pushed to the wrong provider are
**accepted, counted, and invisible** — the worst kind of quiet.

Without a flood, drop a CSV into `ui-workspace/` and reload.

---

## Running the tests

```bash
npm test            # typecheck + every suite. This is the gate.
```

Which is the same as:

```bash
npm run typecheck   # tsc --noEmit
npm run test:mjs    # node --test platform/*.test.mjs
npm run test:ts     # every platform/** and scripts/** suite
```

The frontend is a **separate npm project** and has its own gate:

```bash
cd frontend
npm test            # vitest
npm run typecheck   # tsc --noEmit
```

The root gate cannot see `frontend/`, and the frontend gate cannot break the
kernel. That separation is deliberate and is why CI has a job for each.

There is also a suite that talks to a **running wedge**. It skips unless you give
it one, because a test that needs a server and cannot skip breaks the suite the
first time anyone runs it alone:

```bash
cd frontend
COMMAND_CENTER_LIVE=1 COMMAND_CENTER_TOKEN=<credential> \
  npx vitest run src/api/live-path.live.test.ts
```

(PowerShell: `$env:COMMAND_CENTER_LIVE="1"` and `$env:COMMAND_CENTER_TOKEN="..."`.)

---

## What each CI gate means

| Job | Proves | Does NOT prove |
|---|---|---|
| `typecheck` | Every non-test source file under `platform/`, `.pi/extensions/`, `scripts/` type-checks. | That the **tests** type-check — they are excluded from this gate by a recorded scope boundary. |
| `test:mjs` | The platform-level suites pass. | Anything about the frontend. |
| `test:ts` | Every TypeScript suite passes, including the portal mount and the flood-argument parser. | That the command-wrapper assumptions still hold on POSIX — see `measure-wrappers`. |
| `test-proof` | The F-006 lifecycle proof still holds. | — |
| `measure-wrappers` | The wrapper table (`printf`, `nice`, `stdbuf`, `nohup`) still matches measured behaviour. | **Skipped on Windows.** It is POSIX-only and needs a Linux runner. Skipped is not green. |
| `*-windows` | The same suites re-derived on Windows. | Manual until a Windows runner is attached. |

**Read the job table, not the summary.** "CI failed" tells you nothing about
whether the code was judged; on this project the first two pipeline runs failed
before a single test executed.

---

## Credentials

**Where they live.** A development gateway credential is chosen by the operator
and supplied to the wedge through the environment. Nothing is committed, and the
repository's policy guard **refuses writes to credential files** — that refusal is
a control, not an obstacle.

```bash
# provisions the wedge
$env:NEUROFABRIC_GATEWAY_TOKENS='[{"id":"dev","credential":"<value>","providers":["portal"]}]'
npm run dev
```

```bash
# supplies it to the flood
$env:WEDGE_GATEWAY_TOKEN="<value>"
```

**The UI.** Either type it into the credential prompt — kept in that tab's session
storage only — or set `VITE_GATEWAY_TOKEN` before `npm run dev`. A value you type
**outranks** the environment variable, so you can correct a refused credential
without editing anything. If a stored value is shadowed by configuration, the UI
ignores what you type, which looks identical to the server rejecting it.

**Rotation rhythm.** Treat a credential as short-lived. Rotate when a wedge is
reprovisioned, when a credential has appeared in a transcript, a log, or a
screenshot, and whenever a runner is registered — the runner token in
`config.toml` is exactly this accident waiting to happen.

**The failing case to recognise.** `401` with
`"the credential presented is not recognised"` means the client sent a value the
server does not know. It does **not** mean no credential was sent. The two are
different problems and the UI now says which one it hit.

---

## Troubleshooting

**The UI refuses every request.** The client and the wedge disagree about the
credential. Compare what the UI is presenting with what the wedge was provisioned
with — that is the whole cause.

**`fetch failed against http://127.0.0.1:8080`.** Nothing is listening there. The
message names the address on purpose: "fetch failed" alone has four possible
causes and none of them can be chosen from that word.

**Port already in use.** Something else holds 8080. Find it before starting
anything:

```powershell
Get-NetTCPConnection -LocalPort 8080 -State Listen |
  ForEach-Object { Get-Process -Id $_.OwningProcess } |
  Select-Object Id, ProcessName, Path
```

---

## Layout

```
platform/          the kernel — zero runtime dependencies
  core/            policy, limits, state machine, vault, workspace boundary
  web/             the wedge HTTP server
  api/             portal routes: config, agents, schema, live, ingest
  omniroute/       the authenticated edge
  conductor/       anomaly detection and verdicts
frontend/          the Command Center UI — a SEPARATE npm project
scripts/           flood generator, dev boot, demo
docs/              decisions, handoff, ADRs
ui-workspace/      where a dropped CSV is read from. The boundary, not a folder.
```

## Where to read next

| If you want | Read |
|---|---|
| Why the project is built this way | [ADR-001](docs/adr/0001-minimalism-as-the-audit-trail.md) |
| What is being worked on right now | [docs/handoff.md](docs/handoff.md) §9 |
| Why a decision was made | [docs/DECISIONS.md](docs/DECISIONS.md) |
| How the security boundary works | [docs/SECURITY.md](docs/SECURITY.md) |