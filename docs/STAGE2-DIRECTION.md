# Stage 2 — Direction

**Status: ACTIVE. First user: Rishabh (owner). First increment built and pinned.**

## Who, and what they actually do

**Rishabh** — reporting, analysis, and finding bottlenecks.

Data arrives as **Splunk log exports in CSV**. That is the input, and it is not
a wish: it is the format that already exists, which is the first criterion in the
framework below and the reason this direction is live rather than hypothetical.

**Explicitly later scope: documents and attachments.** Not deferred because they
are unimportant — deferred because the first increment has to be one command and
one file, and document parsing is a second problem wearing the first one's coat.

**The specifics on this page are hypotheses to validate, not facts.** They were
drafted from the owner's description before anyone had opened a real export. The
founder of every claim here is the first session with Rishabh, not this document.

## The first increment

**One command: a Splunk CSV in, a one-page bottleneck report out.**

The report answers four things, and every number in it cites the rows it came
from:

1. **Top error sources by volume** — ranked worst-first, each with its error
   count, its rate, and the row numbers behind it.
2. **Time distribution** — error volume bucketed by hour, with unreadable
   timestamps excluded from the buckets and listed, rather than silently coerced.
3. **Recurring patterns** — error signatures with volatile numbers masked, so
   `waiters=57` and `waiters=73` group as one bottleneck instead of appearing as
   two unrelated events.
4. **Row-level evidence** — every figure carries its citations, because the
   ranking is the thing a reader argues with.

**The dashboard is the artifact. The bottleneck ranking is the product.** A chart
of a CSV is Stage 1, and it is already built. What is new is being told *which
thing is costing you*, with the evidence attached.

## Why this candidate was first

Against the four criteria this direction was scored on:

| Criterion | How Rishabh meets it |
| --- | --- |
| Data already in CSVs | Splunk log exports. No extraction project, no integration, no access request. |
| Pain recurs | Reporting on a live pipeline is continuous, not occasional. |
| Person reachable | The owner. One named human who will run it and can be asked what they were looking at. |
| Dashboard-shaped output | Volume over time, ranked sources, recurring signatures — the shape the report renders. |

All four, without an argument. That is why the page moved from BLOCKED rather
than being nudged.

## What the fixture can and cannot tell us

The Stage-2 acceptance fixture is **synthetic** — hand-authored, modelled on a
Splunk export, modelling the awkward parts on purpose: mixed epoch and ISO-8601
timestamps in one file, quoted fields containing commas, doubled-quote escapes,
recurring signatures across hosts.

It proves the **reader** handles those shapes. It proves **nothing about a real
export**, and the first real export supersedes it. What it cannot know: an
encoding nobody thought of, a column Splunk emits only for certain sourcetypes,
a locale-formatted timestamp, an export silently capped at 10,000 rows with no
truncation marker, a `_raw` field containing an unescaped newline.

Treat every figure the fixture produces as a claim about the reader, never about
the pipeline.

## What one real session must answer

The loop is already proven against synthetic data. What it cannot tell us is
whether it is *right* for this person's actual work. Four questions, each
answerable only by sitting with Rishabh and watching:

1. **What did you open it to decide?** The report ranks by error volume. The
   session that matters is the one where they open it already knowing which
   service is broken. If the ranking's top entry is not the thing they came for,
   the ranking is wrong, however correct the arithmetic.

2. **Which export did you reach for first?** Not the one they name when asked —
   the one they go looking for. If it is not a Splunk CSV, criterion 1 was
   satisfied on paper and not in practice, and the first increment has aimed at
   the wrong file.

3. **Did you come back?** Recurrence is the difference between a tool and a
   one-off. A report opened twice in a week is a product; opened once, it was a
   favour.

4. **What did you do when it was wrong?** Every figure here cites its rows, so
   "that's wrong" should be checkable rather than merely assertible. What we
   cannot predict is whether citing rows makes disagreement *cheaper* or just
   *longer* — a cited report that gets argued past in ten minutes has failed even
   when the numbers were right.

## What Rishabh must supply next session

**One real Splunk CSV export.** Nothing else is needed to start, and nothing
else in this repository can substitute for it:

- A genuine export, not a hand-written approximation of one.
- **Its source query** — the search that produced it, so we know what population
  the rows represent and whether the export was capped or filtered.
- **One sentence on the question they expect it to answer**, so we can tell
  whether the ranking agrees with their intuition before it is judged on its
  merits. A mismatch is the most informative possible starting point.

That third item is the cheapest and the most valuable: it converts the first run
from a demo into a test.

## Building blocks now in place

- `platform/conductor/bottlenecks.ts` — pure analysis. Ranks, groups, buckets,
  masks, and carries row citations.
- `platform/conductor/bottleneck-report.ts` — the self-contained report page, and
  the refusal to render from a structurally broken file.
- `verification/acceptance-stage2.mjs` — 25 assertions, three-way no-silent-death
  on the malformed path, mutation-evidenced.