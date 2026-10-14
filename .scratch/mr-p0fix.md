## What changes

**The collapsed telemetry panel. I caused it.** `.live` was not mine —
`LiveStreamView`'s telemetry panel has been `<section className="live">` since
before the liveness strip existed (`LiveStreamView.tsx:79` and `:89`). Slice 2
reused the same class, so the rule written for the strip:

```css
.live { display: flex; align-items: center; gap: 0.75rem; }
```

was applied to **the whole telemetry panel** — a panel containing a key/value list
and a data table became one flex row with no wrap, and each child compressed to its
minimum width. **"One character per line" is what a flex item looks like when its
min-content width is measured against a track it cannot use.** That is the report,
exactly.

**Fixed by renaming**, in component, stylesheet and tests: every liveness selector
becomes `.liveness`. `LiveStreamView` keeps `.live`, which is what it always had.
I did **not** rename the panel instead — it owns the class and is the older claim;
renaming the newer thing is the correct direction.

**And fixed as a class**, by four declarations:

```css
.app__side { min-width: 0; }                              /* it was an <aside> with no rule at all */
.app__main > * { min-width: 0; }
.live, .card, .panel { overflow-wrap: anywhere; }          /* a long sentence must not set a min-width wider than the viewport */
.liveness { flex-wrap: wrap; }                             /* wrap to a second line, or crush */
```

## How to verify

```
cd frontend
npx tsc --noEmit
npx vitest run
```

```
 Test Files  14 passed (14)
      Tests  283 passed | 6 skipped (289)
```

**Then the part only your browser can settle:** open 5173 and confirm the
right-hand panel's text runs horizontally, at 1024, 1440 and 1920px. **I cannot
verify this — there is no browser here, and no test asserts on layout.** It is
marked unverified in this description and operator-verified in yours.

## What could break

- **Nothing visual is removed.** This is a rename plus four layout declarations. No
  content, no copy, no behaviour.
- **`flex-wrap: wrap` on `.liveness` means the status strip can take two lines** at
  a narrow viewport. That is the intent — a second line, versus one character per
  line — but it is a visible change on a small window.
- **`overflow-wrap: anywhere` can break a long word mid-character** where it
  previously overflowed. Nothing in this UI relies on a long unbroken token not
  being broken.
- **The rename touches the liveness tests' selectors.** They were updated to
  `.liveness--*` and pass; if any other code referenced `.live` for the strip, it
  is caught by the suite.
- **This does not guarantee no future collision.** It guarantees the *symptom* is
  structurally prevented. A collision inside a single component's own classes
  would still need a browser to catch — **which is why the operator's eyes remain
  part of the definition of done.**

## Also in this branch

`docs/PRODUCT-VISION.md` — the one-page product definition this delivery is
judged against: what it is, who runs it, what data it touches, what "alive" looks
like, and what is explicitly out of scope.

## A finding, with its receipt

You reported **"provider greg"** leaking into customer copy. There is no `greg`
in the source:

```
$ grep -rn "greg" --include="*.ts" --include="*.tsx" frontend/src platform/
frontend/src/api/gateway-client.ts:38:  * aggregator, a support ticket ...
frontend/src/components/LiveStreamView.tsx:38:  * something a browser can render ...
frontend/src/conductor/bottlenecks.ts:9:  KeyedAggregator,
```

Every hit is `aggregat**or**` / `aggregat**ed**`. **My reading is that "provider
greg" is a fragment of "aggregated" split across lines by the collapse itself** —
the same defect, surfacing as nonsense text rather than as narrow columns. This is
a hypothesis, not a finding, and it is settled by opening the panel after this
merges. If the words are still there, it is a real leak and I will find it.
