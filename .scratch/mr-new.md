## Closing the Command Center auth loop

MR !77 mounted the live routes and wired the UI to them. It did not answer the question the browser then asked: **every request answered 401, sixty-two times in thirty-one seconds**, and the UI rendered a degraded dashboard rather than saying why.

This MR names the failure, fixes it, and makes the failure self-diagnosing. No new scope.

---

## The root cause, and why it was not the first three candidates

The refusal body was the whole diagnosis:

```
{"status":"FAILED","failure":{"code":"UNAUTHENTICATED",
 "reason":"the credential presented is not recognised"}}
```

`presented is not recognised` — **not** `no credential presented`. The client sent a credential and it was the wrong value. Confirmed against the running wedge, both halves:

| Credential sent | Status | Reason |
|---|---|---|
| none | `401` | `no credential presented: send the x-gateway-token header` |
| wrong value | `401` | `the credential presented is not recognised` |
| the configured dev token | `200` | real portal envelope |

Hunting the token's origin: no `.env*` file existed under `frontend/`, and vite was started from a shell with nothing exported, so `import.meta.env.VITE_GATEWAY_TOKEN` was `undefined`. The value came from `CredentialPrompt` → `sessionStorage` → `Root` → `GatewayClient`.

### Three defects, one symptom

**1. The poll ignored what the last poll returned.** `useLiveTelemetry` used `setInterval`, whose only knob is how long to wait and whose only response to a failure is to wait the same again. A wrong credential is not a transient fault — it is true on the next request exactly as it was on the last — so 2Hz produced 62 identical errors, a load generator pointed at our own server, and no new information.

Now `TelemetryPoller`: a credential refusal **schedules nothing at all**, and faults a retry can clear back off exponentially from a **5 000 ms floor** to a 60 000 ms ceiling. The floor is a constant rather than a multiple of the healthy cadence, because the thing being prevented does not care what the cadence is.

**2. Two 401s arrived as one `kind`.** `GatewayError` now carries the edge's `code` and `reason` — redacted, and included in `toJSON()` — and `credentialStateOf` maps them to distinct states: `required` (nothing arrived, the client is unwired), `rejected` (something arrived, it was wrong), `revoked`, `forbidden`, `no-gateway`. Each gets its own screen and its own wording. A withdrawn credential is **not** told to enter the one the server was started with; that would walk the operator round the same loop.

The edge renders `{status, failure:{code, reason}}`, but an operator reading a browser's network panel sees the flattened form. **Both are read, nested first.** An operator's evidence is not adjusted to fit the parser.

**3. A typed correction was silently ignored.** `initialToken` preferred the environment over storage, so once a value was configured, anything entered at the prompt was read, stored, and then discarded — indistinguishable from the server rejecting it. A person at the keyboard now outranks a default, and the environment remains what an unattended boot gets.

### Why the loop is a class and not a hook

A timer callback only runs inside an effect, and an effect only runs inside a DOM. So as a hook, none of this was testable in a project that deliberately installs no `jsdom` — "the floor is 5s" would have been a comment. `TelemetryPoller` takes its timers as constructor options, so tests drive them by hand and assert the exact delay requested. `RefusalScreen` is split out for the same reason: `App` reaches it through the hook, so it was unreachable from any test.

---

## Evidence

**Six routes, through the dev proxy at 5173, all `200` with the credential and `401` without:**

| Route | Verdict | Body shape |
|---|---|---|
| `GET /api/portal/config` | `200` / `401` | derived-portal envelope, 1 widget, 1 form, 1 dashboard |
| `GET /api/portal/agents` | `200` | `{"at":…,"total":1,"agents":[…]}` |
| `GET /api/portal/live` | `200` | `LiveSnapshot`, verdict present |
| `GET /api/portal/schema/:id` | `200` | `{"schema":{…}}` |
| `POST /api/portal/schema` | `200` | install result |
| `POST /api/portal/ingest` | `200` | `{"accepted":200,"refused":0,"provider":"pega"}` |

**A live verdict that renders, after a flood ingest:**

```
POST /api/portal/ingest  ->  {"accepted":200,"refused":0,"provider":"pega"}
GET  /api/portal/live    ->  records 262, breachedColumns 2, open true
                            throughput {records:262, delta:200, windowMs:15149,
                                        eventsPerSecond:13}
                            elapsed_time  max 50000  outerFence 4500  breached true
                            queue_depth   max 900    outerFence 2     breached true
                            synthetic false
```

A first throughput sample of `null` is by design — a rate needs two instants.

**The opt-in live suite, 7/7, green across four consecutive runs.** It runs the real client against the real wedge and is skipped unless `COMMAND_CENTER_LIVE=1` and a credential are supplied, so CI is unaffected.

---

## Gates

| Gate | Result |
|---|---|
| root `npm run typecheck` | clean |
| root `test:mjs` | **22 tests / 22 pass / 0 fail / 0 skipped** |
| root `test:ts` | **1458 tests / 1456 pass / 0 fail / 2 skipped** |
| root `npm test` (total) | **1480 tests / 1478 pass / 0 fail / 2 skipped** |
| frontend `tsc --noEmit` | clean |
| frontend `vitest run` | **251 tests / 245 pass / 6 skipped / 0 fail** (12 files) |
| frontend live suite (opt-in) | **7 / 7**, 4 consecutive runs |
| `vite build` | not run — no size claim is made here |

---

## Drift corrected in this MR

- **`frontend/README.md`** — proxy target 3000 → 8080; the "Open integration gap" section, which claimed `portal-routes` was imported only by its tests and that `server.ts` did not mount it, is **deleted and replaced** with the mounted reality (six routes, the delegation at `server.ts:450` ahead of every wedge route, and why the registry and gateway must be per-process singletons); layout updated from 2 files to the real 32; the `.env.local` flow documented, including that **the policy guard refuses credential-file writes and that is a feature**.
- **`frontend/vite.config.ts`** — the comment claiming Omniroute binds 3000 is gone. **Nothing bound 3000**; the listener was this repository's own wedge. MR !77's description carries the same correction.
- **`start-ui.mjs`** — default port 3000 → **8080**, matching the proxy target and the declared contract, so the two are one number rather than two that drift. `--port` still overrides.
- **`platform/swarm/e2e-dynamic-platform.test.ts`** — repaired in passing, **not** caused by this change: `routes.routes.length === 4` went stale when the two live routes landed in `9be7b6c`, and it was failing on arrival. It now asserts the route list, so it fails on an addition *or* a removal rather than on a stale count.

## Not in this MR

- **`.env.local` is not committed.** The policy guard refuses any write naming a credential file, from this agent and any other. That is the control doing its job; the README carries the manual step. Until it exists, the UI still authenticates through the prompt.
- `boot.js` / `boot.mjs` remain untracked and were excluded from the commit.
- `.scratch/verify-live.mjs` is left on disk, untracked — a quarantined probe, not a deletion target.
- The dev-boot script and the seeded SLA agent are the **next** MR, after this lands.