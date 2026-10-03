# UI Command Center — frontend

The React workspace for the Command Center. It is a **separate npm project**, and
that separation is the point rather than an accident of layout.

## Why this is not in the root `package.json`

The kernel's defining property is that it has **zero runtime dependencies** and
runs on bare node. `.gitlab-ci.yml` says so in its own header, and `npm ci` at the
root installs exactly two dev packages: `typescript` and `@types/node`, used only
by the static type gate and never imported by anything under `platform/`.

Adding `react`, `vite` and `vitest` to the root manifest would end that property,
so this directory carries its own `package.json`, its own lockfile and its own
`tsconfig.json`. Three things follow, and all three are structural rather than
conventional:

- **The kernel's gates cannot see this workspace.** The root `tsconfig.json` is
  `include: ["platform/**/*.ts", ".pi/extensions/*.ts"]` and the root test globs
  are `platform/**` only. So a type error here cannot fail `npm run typecheck`
  at the root, and a failure here cannot be mistaken for a kernel regression.
- **A frontend dependency bump cannot break the kernel.** The blast radius of the
  dependency tree is one directory.
- **The root install stays fast.** CI's `npm ci` does not pay for this tree.

The cost is that `frontend/` is **not in CI yet**. See "Not yet a gate" below.

## Commands

```bash
cd frontend
npm install        # once
npm test           # vitest run
npm run typecheck  # tsc --noEmit
npm run dev        # vite, 127.0.0.1:5173, proxies /api to 127.0.0.1:8080
```

The wedge must be running for any of this to return data. From the repository
root, with no arguments:

```bash
npm run dev        # binds 127.0.0.1:8080
```

`--port` still overrides it. 8080 is the wedge contract: `vite.config.ts` proxies
to it and `start-ui.mjs` defaults to it, so they are the same number rather than
two that can drift.

## Layout

32 files under `src/`. The four that matter for anyone changing behaviour:

```
src/main.tsx                     the mount point; reads the credential, renders
src/Root.tsx                     prompt-or-app, and owns the credential in state
src/api/gateway-client.ts        native fetch, typed, no state, no React
src/api/credential-state.ts      refusal classification, and the retry schedule
src/api/telemetry-poller.ts      the polling loop; React-free, timers injected
src/store/SchemaStore.ts         subscription model over dynamic schemas
```

The `api/` modules and the store import no React. That is deliberate: every rule
about malformed payloads, timeouts, refusals and backoff is testable in a `node`
environment with no DOM, which is why the test runner is `environment: "node"`
and no `jsdom` dependency is installed.

The polling loop is a class rather than a hook for a second reason. A timer
callback only runs inside an effect, and an effect only runs inside a DOM, so as
a hook its behaviour could not be tested here at all. `TelemetryPoller` takes its
timers as constructor options, so a test drives them by hand and asserts the
exact delay requested.

## The credential

Vite reads `VITE_*` variables **once, at startup**. A wedge restarted with a
different credential while vite keeps running leaves the client holding a value
the server no longer recognises, and the failure is quiet: every request answers
401 "the credential presented is not recognised", the UI renders, and the cause
is two terminals apart.

Two ways to supply one:

1. **`frontend/.env.local`** — the durable choice for development. Create it
   yourself:

   ```powershell
   cd frontend
   Copy-Item .gitignore .env.local     # then add the one line below
   Add-Content .env.local "VITE_GATEWAY_TOKEN=<the value the wedge was started with>"
   ```

   It is covered twice — `.env.*` in the root `.gitignore` and `*.local` in
   `frontend/.gitignore` — so it will not be committed.

   **Agents cannot create this file, and that is a feature, not a limitation.**
   The repository's policy guard refuses any write or command naming a credential
   file, which is why the step above is written out for you rather than scripted.
   No tooling in this repository — including an AI assistant with write access —
   can put a credential into a file it also has to keep out of version control.
   The guard is the control; a convention would not be.

2. **The prompt in the browser.** Type it into the credential form and it is kept
   in this tab's session storage only. It outranks the environment variable,
   because a person correcting a refused credential must actually change what the
   client sends — with the environment first, a typed correction was read, stored
   and then ignored, which is indistinguishable from the server rejecting it.

Either way, a refusal is now a screen rather than a loop: the poller stops after
one refused request instead of retrying every 500ms, and the reason the server
gave is carried through to the message, so "no credential arrived" and "the
credential arrived and was refused" read differently.

## Not yet a gate

`.gitlab-ci.yml` documents, in detail, that this project has **never had a
pipeline run**: `glab api projects/.../runners` reports zero active runners. So
every job in that file is a promise and not a gate.

`frontend/` has no CI job at all yet, and adding one now would produce another
promise in a pipeline that does not execute. It should be added when a Linux
runner is registered, alongside the existing four jobs — not before, and it must
not be read as coverage until a green run is actually observed.

## The portal routes are mounted

The previous version of this file carried an "Open integration gap" section
stating that `platform/api/portal-routes.ts` was imported only by its tests, that
`platform/web/server.ts` did not mount it, and that there was no live path from a
browser to these routes. **That was wrong by the time it was written.** The
router is mounted, and the six routes this client speaks to are served:

| Route | Verb |
|---|---|
| `/api/portal/config` | GET |
| `/api/portal/agents` | GET |
| `/api/portal/live` | GET |
| `/api/portal/schema/:id` | GET |
| `/api/portal/schema` | POST |
| `/api/portal/ingest` | POST |

Two facts about the mount are worth knowing before changing it:

- **It runs before any wedge route.** `platform/web/server.ts` delegates anything
  under `/api/portal/` at line 450, ahead of the wedge's own handlers and ahead of
  its catch-all 404. So a 404 from the portal router is a portal 404, never the
  wedge's, and a portal route can never fall through to a handler written for a
  different verb.
- **Two of them are singletons, and they have to be.** The dynamic agent registry
  and the live gateway are both built once per server process, outside the request
  handler. Built per request, every `POST /api/portal/schema` would install into a
  registry discarded when the response was written — a 200 that installs nothing —
  and every telemetry push would land in a broker discarded the same way, so
  `/api/portal/live` would report "no data" forever.

The registry starts empty, and that is not an oversight. `GET /api/portal/config`
therefore honestly reports a derived portal until an agent arrives through
`POST /api/portal/schema`, and `/api/portal/live` reports `verdict: null` before
the first event. Both are explicit nulls rather than omissions, because "no data
yet" and "the field is missing" must not parse the same way.

## Verifying against a running wedge

`src/api/live-path.live.test.ts` exercises the real client against a real server.
It skips unless both a wedge and a credential are supplied, because a test that
needs a server and cannot skip breaks the suite the first time anyone runs it
alone:

```powershell
cd frontend
$env:COMMAND_CENTER_LIVE="1"
$env:COMMAND_CENTER_TOKEN="<the dev token>"
npx vitest run src/api/live-path.live.test.ts
```

The token is read from the environment and never printed or asserted on.