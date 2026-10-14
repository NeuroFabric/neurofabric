## What changes

**F2 — `pega_time` was a phantom stream.** The operator asked whether it was a
phantom column. **It was, and the answer is worse than a naming problem.**

`streams` means *what the agent measures*, and the verdict computes fences over
numbers. `pega_time` is a timestamp and `alert_code` is a label, so **neither could
ever appear in the columns table**. The agent advertised two streams it could never
evaluate, and a reader comparing the stream list to the columns table had no way
to know why they disagreed.

`streams` is now exactly the measurements — `elapsed_time`, `threshold` — and both
appear. `pega_time` is renamed `observed_at`: it is **still sent on every event**,
because a timestamp is useful data even when it is not a measurement. It just no
longer pretends to be one.

**F3 — "Live, just now" beside "0 events/sec over 510ms."** ADR-003, ratified.

Both readings were **true** and the screen made them look like a contradiction.
The snapshot was under a second old *and* nothing was arriving, because the demo
burst had ended. Same failure as F1 one level up.

**"Live" is a promise about the FEED, not a description of the last packet.** It
now requires a non-zero rate. A fresh snapshot with a zero rate is `empty` — the
state a finished burst lands in, and the state a viewer is looking at when they
notice. The word changed too: **"Arrived, nothing since"**, because "connected,
nothing arriving" described a feed that had never spoken.

## The decision, in writing (ADR-003)

Direction pre-ratified: **honest reframing, not a drip.** The reasoning on the
record:

- **A continuous drip would mean generating traffic to keep a word honest.** That
  is optimising the label rather than the truth, and it makes the first five
  seconds slow.
- **A "push more" button asks a stranger to click twice** to see the product work —
  the exact friction the front door was built to remove.
- **The demo stays a burst**, and the screen says so when it ends.

**Recorded as INTERIM.** Phase 1 MEMORY revisits "live" semantics against real
history, so this ships the labelling and the state logic and **not** a bespoke
burst timeline.

## How to verify

```
cd frontend
npx tsc --noEmit
npx vitest run
```

```
 Test Files  16 passed (16)
      Tests  305 passed | 6 skipped (311)
```

Five tests for the exact case the operator caught, **including one asserting the
fix does NOT make "Live" so rare that a genuinely live feed is called empty.**

## What could break

- **`livenessOf` gained a required `rate`.** Every call site is updated and the
  type gate caught the ones I missed. A caller passing `null` gets `empty`, not
  `live` — claiming Live on an unmeasured rate is the same error as claiming it on
  a zero one.
- **The demo strip now says "Arrived, nothing since" instead of "Live" once the
  burst ends.** That is the intent and it is a **visible change**: for a few
  seconds after the demo, the state is honestly "nothing is arriving". Two existing
  tests asserted the old word; one was updated with the reasoning, and the F2 test
  caught its own rename — both are the census working.
- **Renaming `pega_time` → `observed_at` changes the wire field name.** It is
  demo-generated traffic only, so nothing downstream consumes it. If a real
  pipeline ever used that field name, this MR would need revisiting.
- **`streams` shrank from four entries to two.** The agent is honest about what it
  evaluates; a rule referencing a removed stream would now fail validation rather
  than silently never match.

## Verification labels

| Claim | Label |
|---|---|
| 305 tests pass, `tsc` clean | **test-verified** |
| A zero rate is never `live` | **test-verified**, including the not-overcorrected case |
| `streams` lists only measurable columns | **test-verified** (`toEqual`, exact list) |
| The columns table and the stream list now agree | **operator-verified** — needs your browser |
| The burst UI looks right | **unverified — operator** |
