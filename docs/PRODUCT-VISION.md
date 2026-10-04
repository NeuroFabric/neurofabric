# Neurofebric Command Center — what this is

**The definition this delivery is judged against.** One page. If a feature cannot
be justified against it, it does not ship.

---

## What it is

Neurofebric watches a stream of business events as they arrive and tells an
operator, in plain language, when something in that stream is behaving unlike
itself — and which specific measurement gives it away. It is a **live operations
screen**, not a log viewer, not a report builder, and not an AI product: the
verdicts are arithmetic over the observed window, which is why they are
reproducible and why we can say exactly which measurement breached.

## Who runs it, and where

One engineer or operations lead, sitting in front of their own machine or an
internal server, watching a pipeline they already own. **It is not a
multi-tenant SaaS product and it is not sold as one.** There is no account
system, no billing, no marketplace, no customer-facing login.

## What data it touches

Event streams the operator already has — currently `pega_time`, `elapsed_time`,
`threshold`, `alert_code` — flowing through a loopback HTTP endpoint into an
in-memory window. **Nothing is written to disk and nothing leaves the machine.**
The window is bounded and the snapshot is derived, so there is no retained
history to protect and nothing to breach later.

## What "alive" looks like

Three things, all visible without clicking anything:

1. **A strip that says which of five states the feed is in** — connecting,
   arriving, stalled, stopped, or connected-and-quiet — and **how long ago the
   last answer was**. Silence is never ambiguous.
2. **A live count and a live rate**, clearly distinguished. The count is how many
   records the window holds. The rate is how fast new ones arrived. **A rate of
   zero while the count holds is correct**, and the screen must never make the two
   look like a contradiction.
3. **Alerts that name the measurement**, with severity a person can read at a
   glance rather than infer from a hue.

## The one click

From a cold, empty screen, **one button** registers a demo agent and starts
telemetry flowing. Not a terminal command, not a curl, not a fixture someone
imported. The screen a stranger opens should be one button away from showing
them what the product does.

---

## Explicitly out of scope

Naming these matters as much as naming the product, because most of what has made
this project feel like a diagnostic tool was somebody reasonable filling a gap.

| Out of scope | Why |
|---|---|
| **Any model call.** | D-001. The verdicts are arithmetic. A model would make them unreproducible and would make "how do you know?" unanswerable. |
| **Any internal jargon on the default view.** | Version strings, stub counts, layout hashes, schema endpoints, provider identifiers. Engineers get these behind a flag; customers never do. |
| **Multi-tenancy in the UI.** | The *engine* is tenant-scoped for safety. The screen is not a tenancy product and must not look like one. |
| **Historical retention, search, and replay.** | The window is live and derived. Persisting it turns a live screen into a database with obligations. |
| **A charting framework for anything but the dense series.** | One deliberate exception (ADR-002, uPlot) for high-frequency series only, because a chart that re-renders React to move a point would break the render budget. |
| **Refactoring the kernel, the refusal handling, or the credential guard.** | They are the best things in this repository. The front door gets built *around* them, never by rewriting them. |

---

## How a change is judged

Three questions, in order, and a "no" at any of them ends the discussion:

1. **Does a non-engineer understand what this screen is telling them?** If it
   needs the source to interpret, it does not ship.
2. **Can it go wrong legibly?** Every state has words and a next action. Silence
   is a bug.
3. **Does it survive one diff of audit?** A human reviewer, one file at a time.

And one rule about claims: **every claim is marked test-verified, operator-verified,
or unverified.** This project has been trusted precisely because it says "I cannot
check this without a browser" instead of implying otherwise.

---

## The five checks

The delivery is done when a stranger, opening the browser cold, can confirm:

1. No panel is collapsed or broken at any normal window size.
2. One click takes the empty screen to events visibly flowing.
3. There is zero internal jargon on the default view.
4. Installing an agent works end to end — form, submit, listed, selectable, rules
   loaded — with no hand-built API calls.
5. It looks like a product.

**Items 1, 2 and 5 can only finally be confirmed by the operator's eyes in a
browser.** No test suite can settle whether a screen *looks* like a product, and
we do not pretend otherwise.