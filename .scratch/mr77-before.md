## Live Gateway Wiring & Demo Finalization

MR !76 carried the Command Center UI. This MR closes the gap it deliberately left open: the UI refused to display a throughput rate because **nothing measured it**, and there was no endpoint that did.

**MR !76 is superseded by this one** — both target `main` from the same branch, so only this one should merge.

### Commits

| Commit | What |
|---|---|
| `96f7891` | style(ui): mask gateway credential input via css |
| `ea5982a` | fix(scripts): repair synthetic data generator, add `scripts/` to tsconfig |
| `9be7b6c` | feat(api): mount live gateway + `/api/portal/live` + `/api/portal/ingest` |
| `d8e5826` | feat(ui): live telemetry polling and dashboard wiring |

### Test counts

- **Backend: 1461 pass, 0 fail, 2 skipped** (1441 TS + 22 MJS) — 10 new meter tests, 7 new mount tests
- **Frontend: 207 pass, 0 fail** (was 187)
- `tsc --noEmit`: 0 errors in both workspaces · `vite build`: 258 kB / 79 kB gzipped

---

## The headline: a measured rate, not an asserted one

Two commits ago I wrote a test asserting that **no** per-second figure could ever appear, because a count is not a rate and no endpoint reported one. That test is now **inverted rather than deleted**, and the reason is recorded in its replacement.

`GET /api/portal/live` returns a rate computed by `ThroughputMeter` from two consecutive observations — because the server is the only place both instants exist. Verified against a running wedge:

```
records=213000  rate=—           window=—        breached=1  synthetic=false
records=283250  rate=46278 ev/s  window=1518ms  breached=1  synthetic=false
records=336250  rate=32063 ev/s  window=1653ms  breached=1  synthetic=false
```

The first row shows `rate=—`: one observation cannot produce a rate, and the UI says **"no reading yet"** rather than showing a zero. Zero would read as a dead stream. `breached=1` is the real IQR fence in `live-anomaly.ts` catching the injected SLA breach, not a hardcoded flag.

### What did *not* relax — it moved

- **Every rate publishes its window and its delta.** 56,690 ev/s over 1.4s and over 10s are different claims. The UI renders both.
- **`validateLiveSnapshot` refuses `windowMs <= 0`.** That is a divide by zero that reached the wire; `Infinity events/sec` on a live dashboard is worse than no number.
- **The SIMULATED banner is conditional, not deleted.** It appears on `synthetic: true`. A label shown only when inconvenient is not a label.

---

## Reviewer focus

**1. `portal-routes.ts` had never been mounted.** It was correct, fully tested, imported only by its tests. The gateway had the same problem — in-process, no HTTP surface. Both are now singletons built **outside the request handler**; a per-request broker discards the stream when the response is written, so every read would report "no data" forever.

**2. `scripts/generate-synthetic-data.ts` had two live `--strict` errors for the file's whole life.** `type Check = string | {...}` unioned the wrong thing, making the function branch unreachable. It survived because `scripts/` was outside the type gate. Both fixed, and **`scripts/**/*.ts` is now in the include** — a source file no gate can see is a file that rots silently, and this one demonstrably did.

**3. The in-flight guard is the point of the polling hook.** A 500ms interval against an 8s client timeout means a slow server produces unbounded pile-up — a memory leak reachable from the network. A tick arriving during a request is **skipped, not queued**. `clearInterval` and a `mounted` flag are in the cleanup: a timer outliving its component is the exact shape that hung this repo's suite once.

**4. Port 8080, not 3000.** Omniroute is a separate product already bound to 3000 on this machine. The Vite proxy targets 8080.

---

## Honest gaps

- **Polling is not exercised by the test suite.** `renderToStaticMarkup` does not run `useEffect`, so every integration test correctly sees "Connecting to the live gateway". Asserting live numbers there would assert something the renderer never ran. LiveStreamView's rendering is covered directly, props-driven. The guard's invariant is pinned as a concurrency test, not by driving the hook.
- **No DOM interaction tests.** Reload, selector `onChange`, prompt submit — all still unverified, and they need a real browser.
- **No CI pipeline.** As agreed, none written. Note that this pipeline has never executed anyway — zero active runners.
- **`verification/` and `tools/` remain outside the type gate.** Deliberate; widening further is its own measured decision.

## Demo

Three commands, verified working end to end this session. See the thread for the exact invocation.