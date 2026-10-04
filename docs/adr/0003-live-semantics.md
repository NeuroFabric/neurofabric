# ADR-003 — "Live" means "arriving now", and the demo is a burst

- **Status:** accepted — **interim**
- **Date:** 2026-10-04
- **Ratified by:** operator, 2026-10-04
- **Relates to:** ADR-002, `docs/PRODUCT-VISION.md`, the F3 finding

---

## Context

The operator's browser showed the status strip reading **"Live — just now"** while
the throughput panel read **"0 events/sec over 510ms"**.

Both readings were true. The demo pushes 240 events in one burst; a rate measured
over a 510ms window after the burst ends is zero, because nothing arrived during
it. Meanwhile the strip was answering from the *snapshot's age*, which was under a
second old — so it was correctly reporting that an answer had recently arrived.

**The strip was not wrong. The two surfaces were answering different questions
and neither said which.**

That is the same failure as F1, one level up: two surfaces, both true, and a
reader forced to reconcile them. And it is the specific thing this project exists
not to do — `docs/PRODUCT-VISION.md` says a rate of zero while the count holds is
correct and the screen must never make the two look like a contradiction.

## Options

**A — continuous demo drip.** Keep events arriving so "Live" stays literally true.
Cheap to build. But the first five seconds of the demo become slow while the drip
fills a window, the numbers on screen are smaller, and **we would be generating
traffic continuously to keep a word honest.** That is optimising the label rather
than the truth.

**B — a "push more" affordance.** A button to send another burst. Honest, and it
makes the burst *visible as a burst*. But it asks a stranger to click again to see
the product work, which is exactly the friction the front door was built to remove.

**C — honest reframing with a human-scaled window.** The strip stops claiming
"live" about a burst it did not just observe. The rate is labelled as a *rate*, its
window is stated in human terms, and the screen distinguishes "arriving now" from
"last arrived 3 seconds ago" from "this stopped".

## Decision

**C.**

The word "Live" is a **promise about the feed**, not a description of the last
packet. A feed that delivered one burst and went quiet is not live; calling it live
is the screen making a claim the data does not support, and it is the same class of
dishonesty as rendering an unreachable panel as if it were healthy — which is
precisely what MR !93 was opened to remove.

**Specifically:**

1. **The strip's states are about the feed, not the packet.** `live` now means
   *answers arriving now*, which requires the rate to be non-zero — not merely that
   a snapshot is recent. A snapshot one second old after a burst is **`stalled` or
   `empty`**, which is what it actually is.
2. **The rate carries its window in human terms** — "over the last second" — rather
   than "over 510ms", because 510ms is an implementation detail and a reader
   comparing it to "0 events/sec" cannot tell whether that is a lot of time.
3. **The count and the rate are labelled as different things**, on the same surface,
   so no one has to reconcile them.
4. **The demo stays a burst.** It is honest about being one, and the screen says so
   after the burst ends rather than manufacturing traffic.

## Consequences

- **The demo's numbers freeze after the burst.** Accepted: the operator's own
  screenshot showed a static 20,000 and a zero rate, and the screen will now *say*
  that instead of implying activity that stopped.
- **"Live" becomes rarer and more meaningful.** On a real feed it is the common
  case; on a demo it is transient and the screen will say so.
- **This is an INTERIM decision.** **Phase 1 MEMORY revisits "live" semantics
  against real history** — with durable records and a restarts story, "last arrived
  3 minutes ago" becomes a fact worth showing, and the state set may change.
  **Do not over-build the burst UI.** What ships here is the labelling and the
  state logic, not a bespoke burst timeline.

## Verification

Falsified by the strip reporting `live` while the rate is zero. There is a test for
exactly that case, because it is the case this ADR exists for.

**What this does NOT settle:** 60fps and flat-heap remain operator-verified, and
neither this decision nor its tests can observe how any of it looks.