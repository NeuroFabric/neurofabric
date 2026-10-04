# ADR-002 — uPlot for the high-frequency series, and why it is not installed yet

- **Status:** accepted (decision), deferred (implementation)
- **Date:** 2026-10-04
- **Relates to:** ADR-001 (minimalism as the audit trail), P1 Slice 3

---

## Context

P1 asks for live telemetry end-to-end and, for high-frequency series, uPlot
rather than a hand-rolled canvas sparkline.

That is a change of position and it needs saying plainly: **Slice 1's design log
deferred a hand-rolled sparkline on purpose**, arguing that redrawing canvas on
a 500ms poll is precisely what would break "≤1 React render per frame" and the
flat-heap criterion. The current mandate says uPlot. The mandate supersedes the
log; the *reasoning* in it was not wrong, and this ADR records why it was
superseded rather than pretending it was wrong.

There is also a conflict with ADR-001, which is zero-dependency, and with the
≤~50KB acceptance budget. Both are real. Both are addressed below.

## Options

**A — hand-rolled canvas sparkline.** Zero dependencies, ~0 bytes. You own the
redraw schedule, the axis maths, the hit-testing, and every edge case around
device pixel ratio. The deferral argument stands: it is the thing most likely to
break the render budget.

**B — uPlot.** ~545KB unpacked on disk; 145KB raw ESM, roughly 45KB gzipped.
Purpose-built for dense time series, does its own canvas work outside React's
render cycle, and is a single dependency with no transitive tree.

**C — a full charting library** (Chart.js, Recharts, ECharts). Rejected outright:
Recharts renders SVG through React and would violate the render budget by
construction. ECharts is ~1MB. Neither is a better version of the same trade.

### The alternatives the Slice 1 design log recorded, and where they went

The log predates this ADR and its triage is worth preserving, because **the
findings that have not shipped yet are the reason Slice 3 is scoped the way it
is.** Recorded here so the log can go rather than rot as an orphan.

| Finding | Status |
|---|---|
| F1 product names itself | **shipped** — Slice 1 |
| F2 severity is a hue, not a signal | **shipped** — Slice 1, with a guard test |
| F3 the status pill leaks store words | **shipped** — Slice 1, keyed on the `StoreStatus` union |
| F4 nothing states *when* | **shipped** — Slice 2, the liveness strip |
| F5 no values are interactive | **open** — Slice 3 |
| F6a the demo's count-vs-rate ambiguity | **open** — Slice 5 |
| F6b two failure surfaces, one Reload button | **open** — Slice 6 |
| F6c the agent `<select>` is a form field | **open** — Slice 4 |

**The hand-rolled sparkline (option A) was deferred on this reasoning, and the
mandate overrode it:** redrawing canvas on a 500ms poll is exactly what would
break "≤1 React render per frame" and the flat-heap criterion — the two places a
naive implementation actually fails. That reasoning was not wrong; uPlot simply
removes the problem instead of asking us to solve it. The deferred risk is
recorded because **the failure it predicted is still ours to avoid** in Slice 3:
whatever renders the series must not re-render React to move a point.

**The acceptance criteria that travel with Slice 3, unchanged:** 60fps sustained,
≤1 React render per frame, flat heap over 30 minutes, `tabular-nums` on every
changing figure, ≤300ms breach transition, ≤~50KB gzipped, and
`prefers-reduced-motion` honoured. **Two of them cannot be verified in this
environment** — there is no browser and no profiler — and they are logged
operator-verified, never claimed.

## Decision

**B — uPlot — for high-frequency series only.**

Scoped deliberately. uPlot is approved for the dense throughput/records series
where it does the job better than hand-rolled code and keeps the render budget
intact, because it draws on its own canvas and does not re-render React to move a
point.

**It is NOT approved for** the severity pills, the status strip, the verdict
cards, or anything else on this product. Those are not high-frequency series, and
"we already took the dependency" is not a reason to reach for it again.

**Consequences, stated honestly:**

1. **This breaks the "zero runtime dependencies" claim for `frontend/`**, not for
   the kernel. ADR-001's verification is "the root `package.json`
   `dependencies` field is absent", and it remains absent — the kernel claim is
   untouched. But the UI Command Center now has a dependency, and the frontend
   README must say so rather than let the kernel's purity stand in for the UI's.
   **This is the cost, and it is a real one.**
2. **It exceeds the ≤~50KB budget** on raw size and roughly meets it gzipped.
   Rather than redefine the budget to fit the decision, both numbers are recorded
   and the budget is treated as **gzipped**, which is what a browser downloads.
3. **ADR-001's failure mode applies here.** The ADR warns against a small
   auditable diff around an opaque dependency. That risk is accepted for one
   chart, deliberately, and it is why the scope above is bounded to a single use.

## Why it is NOT installed in the Slice 2 commit

**Because nothing uses it yet.** Slice 2 delivers the liveness strip, and a
dependency shipped ahead of its consumer is a cost with no return — precisely the
thing ADR-001 exists to prevent. The install was performed and verified available
(`uplot@1.6.32`, 545KB unpacked, zero vulnerabilities) and then **removed**, and
`frontend/package.json` is byte-identical to `main`.

The dependency lands **with the commit that first renders a series**, in its own
MR, so the size cost and its benefit arrive together and are reviewed together.

## Verification

This ADR is falsified by `frontend/package.json` containing `uplot` while no
component imports it. If that ever happens, this decision was not followed.