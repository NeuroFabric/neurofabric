# UX Command Center Overhaul — Phase 1 design log

**Before any component changes.** Required by the mandate, and the reason is not
ceremony: the mandate's items came from a screenshot, and I did not have the
screenshot. So Phase 1 is the code, read as evidence, and every finding below
cites what is actually there.

**The screenshot is still owed** (see Blockers). Nothing here depends on it, but
two items in the mandate cannot be *confirmed* without it, only re-derived.

---

## Findings, each with its evidence

### F1 — The product has no name on screen

```tsx
// frontend/src/App.tsx, the first element the audience sees
<h1>Command Center</h1>
```

"Neurofebric" appears nowhere in the rendered UI. It is in the repository, the
package name, the ADR, and the compose service — and not on the product. **F1
confirmed from code**, no screenshot needed.

It is also not centred. `.app__bar` is a left-aligned row with `.app__actions`
pushed right, which is the shape of a debug toolbar.

### F2 — Severity is a hue, not a signal

This is the mandate's sharpest complaint — *"the critical alert looked like an
error, not a signal"* — and the code explains why.

```css
/* frontend/src/styles.css */
.pill { /* one shape, for all of them */ }
.pill--ready,  .pill--info,  .pill--idle     { color: var(--good);     border-color: ...; }
.pill--stub,   .pill--warning, .pill--loading, .pill--degraded { color: var(--warn); border-color: ...; }
.pill--critical, .pill--server, .pill--refused { color: var(--critical); border-color: ...; }
```

**Every severity is the same shape and the same size. They differ in exactly two
properties, both of them a thin stroke.** Three pills in three hues are
distinguishable on a laptop at arm's length and indistinguishable on a projector
at eight metres, or in a screenshot in a slide deck.

The mandate asks for `critical ≠ warning ≠ info **at a glance**`. At a glance is
the operative word, and hue is not a glance channel when hue is the *only*
channel. Redundant encoding is what survives projection, colour-vision
difference, and a bad projector.

**The severity LOGIC is already correct and tested** — `AlertCenter` deliberately
refuses to re-derive it ("the severity a viewer reads is the BACKEND'S, and this
component never recomputes it"). So this is purely a presentation defect. **F2
confirmed from code.**

### F3 — The status pill leaks internal state names

```tsx
<span className={`pill pill--${state.status}`}>{state.status}</span>
```

The store's internal status string is rendered verbatim — `loading`, `ready`,
`stub`, `degraded`, `error`. A person who has not read `SchemaStore.ts` cannot
tell whether `stub` means "this agent is a placeholder" or "the schema failed to
load". This is the single clearest "reads as a debug console" symptom in the file.

### F4 — Nothing states *when*

There is no `last updated` anywhere in the tree, and no indicator of whether
polling is live, paused, or halted. `useLiveTelemetry` knows all three — it
carries `loading`, `state` and `credentialRequired` — and the UI renders none of
it. The mandate's *"the system must look alive"* and *"silence must never be
ambiguous"* are the same requirement, and the data for it already exists.

### F5 — No values are interactive

Every statistic renders as a `<dd>` of text. There is no hover detail, no
drill-down, and no tooltip anywhere in `src/`. The mandate's "all useful stats
must be interactive" is a genuine gap, not a tuning problem.

### F6 — Findings I added (triage mine, per the mandate)

**F6a — The demo's own ambiguity is unresolvable on screen.** The runbook's
strongest beat is throughput reading `0 events/sec` while records holds at
`20,000`. A viewer sees a contradiction and concludes one of them is broken. The
UI must *explain* the difference, not just display it.

**F6b — `Reload` re-reads the schema roster but the live panel keeps its old
error.** Two independent failure surfaces, one button, no indication of which it
refreshed.

**F6c — The agent selector is a `<select>`.** It is the primary navigation of
the product and it renders as a native dropdown — indistinguishable from a form
field, and it drops any room for a per-agent status dot, which is exactly what
would let the UI show "one agent breaching" without opening anything.

---

## Triage

| | Item | Severity | Depends on unmerged work? |
|---|---|---|---|
| **Slice 1** | F1 product identity, centred | high | no |
| **Slice 1** | F2 severity as shape + weight + fill, not hue | high | no |
| **Slice 1** | F3 status words a person can read | high | no |
| Slice 2 | F4 liveness: pulse, last-updated, polling state | high | no |
| Slice 3 | F5 stat interactivity, hover + drill-down | medium | no |
| Slice 4 | F6c agent list replaces the `<select>` | medium | no |
| Slice 5 | F6a the count-vs-rate explanation | medium | no |
| Slice 6 | F6b surface separation | low | no |

Slice 1 is chosen first because **all three items are defects in presentation
over logic that already exists and is already tested** — the highest
confidence-to-effort ratio in the list, and the three most visible in a
screenshot.

**Nothing depends on unmerged work.** The frontend gate is `frontend npm test` +
`tsc`, which covers this directory independently, so none of this waits on the
pipeline blocker or on `chore/bootstrap-door`.

---

## Acceptance criteria (the gate, not the goal)

Carried from the mandate and binding on every slice:

- 60fps sustained under live updates
- ≤1 React render per frame
- flat heap over 30 minutes of polling
- `font-variant-numeric: tabular-nums` on every changing figure
- ≤300ms breach transition
- ≤~50KB added
- `prefers-reduced-motion` honoured

**Two of these I cannot verify in this environment and will not claim:** 60fps and
a flat heap over 30 minutes need a browser and a profiler. There is no DOM here
and no browser. I will verify what a node environment can verify — the rendered
markup, the reduced-motion media query's presence, tabular-nums on the figures,
and the added byte count — and I will say plainly that the rest is unverified
rather than inferring it.

## What I am not doing yet, and why

**A sparkline.** The mandate asks for one, hand-rolled, no chart library. A
canvas sparkline redrawn on every 500ms poll is precisely the thing that would
break "≤1 React render per frame" and the flat-heap criterion — the two places a
naive implementation actually fails. It needs a design decision (redraw on
`requestAnimationFrame`, or on change) before it is code, and that decision
belongs after Slice 1 establishes whether the render budget is real.

**A live credential banner.** It should show which credential *generation* is
live without revealing it. That is a real security design question, not a
formatting one, and it wants its own MR.