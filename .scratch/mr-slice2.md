## What changes

The **liveness strip** — a status line above everything, answering "is anything
happening?" — plus **ADR-002** recording the uPlot decision.

**The problem it solves.** A dashboard that is silent and a dashboard that is
broken look identical from the outside. Both show numbers that are not moving.
The only difference is which one is *true*, and the operator standing in front of
it cannot tell. That is not a styling complaint; it is the failure the strip
exists to remove.

Five states that were previously one grey number:

| State | Means |
|---|---|
| `connecting` | we asked, nothing has answered yet |
| `live` | answers arriving, and this is when the last one landed |
| `stalled` | the last answer is older than it should be — **suspect, and said** |
| `halted` | polling stopped: the credential was refused |
| `empty` | connected, answering, and there is genuinely nothing |

**It sits above the header**, not in the side panel. "Visible without scrolling"
is the requirement, and a fault you have to scroll to find is a fault an operator
misses.

**Partial data with a visible fault beats no data.** The instinct to hide a
degraded store until everything is well is wrong twice: the operator loses good
data they already have, *and* the fault — the only thing they could act on — is
the one thing hidden. `severityFor()` makes the fault **replace** the reading
rather than sit under it.

**Ordering in `livenessOf()` is the argument, not an implementation detail:**
1. `halted` first — a poller that stopped asking is not "connecting", and calling it that is a lie that looks like patience.
2. No read yet is `connecting`, but only while there is no error.
3. A read too old is `stalled` **whatever the counter says** — a count holding steady while the feed dies is the exact failure this catches.

## How to verify

**Receipts — pasted, not summarised.**

```
npx tsc --noEmit
  (no output — clean)

npx vitest run
 Test Files  14 passed (14)
      Tests  283 passed | 6 skipped (289)
```

This MR adds **25 of those tests**, all green, in
`frontend/src/components/liveness-strip.test.tsx`.

**Read the tests as the design.** They follow the `!86` contract exactly:
**machine claims assert on raw markup** via `data-*` attributes; **human claims go
through `text()`**. Both are in one file and the split is stated at the top,
because a test that cannot tell which kind it is should not be written.

Spot-check by hand:

```
cd frontend && npm run dev
```
Then: open 5173 with no traffic → `Connecting`, no pulse. Load a credential with
the wedge down → `Feed stalled` with the age counting up. Stop the poller with a
wrong credential → `Polling stopped` and the fault names itself.

## What could break

- **`live--live` and `live--empty` must never look alike.** A green pulse beside a
  counter that has not moved is the exact combination that makes a dashboard lie,
  so `empty` and `stalled` get **no pulse at all**. This is the single most
  important CSS constraint in the diff and it is easy to break by "tidying" the
  selectors.
- **A new timer, in `useNow`.** It ticks every second to keep the age honest, and
  it is cleared on unmount. A frozen age is *worse* than none — it looks live and
  is not — but an uncleared timer keeps the event loop alive, and this repository
  has been hung by exactly that shape once.
- **`now` is a prop, not a clock read inside the component.** That is what makes
  "43s ago" assertable exactly. Changing it to `Date.now()` internally makes every
  age assertion untestable and they will fail intermittently rather than loudly.
- **`data-age-ms=""` rather than `0` when there has never been an answer.** Zero
  would mean "0ms ago", which is precisely wrong. Null is not zero, and the
  attribute has to be able to say so.
- **The global `prefers-reduced-motion` block neutralises the pulse, and a local
  rule adds an outline** so removing the animation does not remove the
  information. Someone who strips the local rule would make the strip say nothing
  for readers who asked for less motion.
- **`App` gains one state update per second.** Negligible, and it is the only
  thing that re-renders without new data.

## What I could NOT verify — logged, not claimed

**60fps sustained and a flat heap over 30 minutes are unverified.** Both need a
browser and a profiler; this workspace has neither. They are **operator-verified
or they are not verified.** I will not put a number in this description I did not
measure.

## CI status — not the gate, and honest about why

Local receipts above are the gate. **CI cannot currently pass on `main`**, for a
reason outside this repository's code:

| Job | Status | Evidence |
|---|---|---|
| typecheck | success | first-ever green |
| test-mjs | success | 22/22 |
| test-proof | success | — |
| **test-ts** | **failed** | **1535 tests, 1533 pass, 0 fail, 2 skipped — then `assert-posix-vault-permissions.mjs` refused to run on win32.** Tests passed; a later step in the same job did not |
| measure-wrappers | skipped | correct — POSIX-only |
| *-windows (×3) | manual | not triggered |

**Not mine to fix.** That script is *correct* to refuse on Windows — it exists to
verify the Linux runner. `.gitlab-ci.yml` runs it unconditionally. Fixing it means
editing CI, which is outside my authority. **Operator blocker, same class as
`measure-wrappers`.**

## Also in this MR: ADR-002, and a dependency deliberately NOT shipped

The mandate asks for uPlot. **ADR-002 records the decision and why the dependency
is not installed in this commit.** I installed and verified `uplot@1.6.32`
(545KB unpacked, 0 vulnerabilities) and then **removed it**, because nothing
renders a series yet and a dependency shipped ahead of its consumer is a cost
with no return — precisely what ADR-001 exists to prevent.

`frontend/package.json` is **byte-identical to `main`** and still has no
dependency beyond react. It lands with the commit that first draws a series.

Two costs ADR-002 records rather than hides: this **breaks zero-dependency for
`frontend/`** (the *kernel* claim is untouched — the root manifest has no
`dependencies` field), and 145KB raw / ~45KB gzipped **exceeds the ≤~50KB budget**
on raw size. The budget is treated as gzipped, which is what a browser downloads,
and both numbers are stated instead of redefining the criterion to fit.