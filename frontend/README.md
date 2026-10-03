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
npm run dev        # vite, 127.0.0.1:5173, proxies /api to 127.0.0.1:3000
```

## Layout

```
src/
  api/gateway-client.ts     native fetch, typed, no state, no React
  store/SchemaStore.ts      subscription model over dynamic schemas
```

Neither module imports React. That is deliberate: it means every rule about
malformed payloads, timeouts and refusals is testable in a `node` environment
with no DOM, which is why the test runner is configured as `environment: "node"`
and no `jsdom` dependency is installed yet.

## Not yet a gate

`.gitlab-ci.yml` documents, in detail, that this project has **never had a
pipeline run**: `glab api projects/.../runners` reports zero active runners. So
every job in that file is a promise and not a gate.

`frontend/` has no CI job at all yet, and adding one now would produce another
promise in a pipeline that does not execute. It should be added when a Linux
runner is registered, alongside the existing four jobs — not before, and it must
not be read as coverage until a green run is actually observed.

## Open integration gap

`platform/api/portal-routes.ts` defines the four routes this client speaks to
(`GET /api/portal/config`, `GET /api/portal/agents`, `GET /api/portal/schema/:id`,
`POST /api/portal/schema`). As of this commit that module is imported **only by
its tests** — `platform/api/portal-routes.test.ts` and
`platform/swarm/e2e-dynamic-platform.test.ts`. `platform/web/server.ts` does not
mount it.

So the client is written against a contract that is unit-tested but not yet
served by any running process. There is no live end-to-end path from a browser to
these routes yet. Wiring the router into the wedge server is backend work and was
not in scope for this micro-step; it is recorded here rather than left to be
discovered as a broken dev proxy.