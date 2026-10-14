## What changes

**The front door.** One click takes a stranger from an empty screen to events
visibly arriving. This is the most important item in the product.

Before: the UI could read every route and push nothing at all — the client had
no ingest method — so the empty state's only exit was a terminal. *"Start the
flood and this fills in"* described a command to someone who does not know there
is a terminal.

**One click does the whole loop:** register the demo agent → push a burst → let
the existing poller notice on its next read. **The agent goes first**, so the
roster shows it *before* the numbers move and the two halves are separately
visible.

Also, per the P1 language ruling: the empty state no longer names the provider,
and the test that asserted `pega` was asserting the jargon — it is now **inverted**.

## How to verify

```
cd frontend
npx tsc --noEmit
npx vitest run
```

```
 Test Files  15 passed (15)
      Tests  295 passed | 6 skipped (301)
```

**Live receipt — a real wedge, the shipped document, not a hand-written curl body:**

```
POST /api/portal/schema   200   demo/sla-monitor
GET  /api/portal/agents   1 agent(s)
POST /api/portal/ingest   200   accepted 240, refused 0
GET  /api/portal/live     records 240, breachedColumns 1
  elapsed_time  max=8541  outerFence=961   breached=true
  threshold     max=699   outerFence=1093  breached=false
WALL CLOCK 366ms (register + push + read; excludes render)
```

**Acceptance is "within 5 seconds".** Excluding render this is **366ms**. The
render half needs a browser and is **operator-verified, not claimed**.

## What could break

- **`GatewayClient` gains `ingest`.** It caps at the server's own 1000 per call and
  validates the result rather than trusting it — this path feeds the "events are
  arriving" claim on the front door, so a malformed answer must not reach it.
- **`demo-agent.ts` is a fixed document, not a generator.** A claim you can read
  and check beats a program you trust on sight. Its rule is written against the
  registry's **actual** grammar: a first attempt invented `column` and `factor`,
  both refused by the validator, so the POST would have **400'd and the front
  door would have been broken in exactly the situation it exists for**. A test
  asserts every rule key is in the allowed set.
- **The button appears only when a live transport exists AND the source has an
  `ingest` method** — a runtime check, not a cast. With `liveSource === undefined`
  it renders nothing, because a front door that cannot be opened is worse than no
  front door.
- **`StartDemo` closes over `reload`, and was written above it.** The type gate
  caught that; it was a real defect, not a type nit — `reload` would have been
  read before assignment. Fixed by ordering.
- **The demo registers an agent named `sla-monitor` for the tenant on the proven
  credential.** If one already exists it is replaced, not duplicated. Re-clicking
  is therefore idempotent, and says so.
- **A test asserting the empty state does NOT contain `pega`** now defends the
  absence of jargon. That is intentional: a test that pins jargon defends jargon.
- **`demoEvents` uses `Date.now()`.** I claimed flat determinism and it is false;
  the **measurements** are deterministic and the **timestamps** should move. The
  test asserts that split, so freezing them to make a suite pass becomes a
  visible decision.
- **Nothing in the kernel, the refusal handling, or the credential guard is
  touched.** This is a button, a client method, and a fixture.

## Verification labels

| Claim | Label |
|---|---|
| Schema validates, ingest accepted, verdict breaches | **test-verified + live-receipt** |
| 295 tests pass, `tsc` clean | **test-verified** |
| 366ms for register + push + read | **test-verified (live receipt)** |
| Under 5 seconds *including render* | **unverified — operator, needs a browser** |
| "Looks like a button a stranger would press" | **unverified — operator** |
