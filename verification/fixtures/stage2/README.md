# Stage 2 fixtures — SYNTHETIC

**No real Splunk export has been supplied yet.** Everything in this directory is
synthetic and was authored by hand to exercise the reader against the shapes a
real export is expected to contain.

## `splunk-export.synthetic.csv`

Modelled on a Splunk CSV export. It deliberately contains the awkward parts,
because a fixture of only easy data would prove nothing:

- **Mixed timestamp encodings.** Rows 1–20 carry epoch seconds in `_time`; rows
  21–26 carry ISO-8601 strings. A real export split across two searches would do
  this. The analyser normalises both to a comparable instant.
- **Quoted commas.** Every `_raw` value is quoted and most contain commas, which
  is the case a naive `split(",")` gets wrong.
- **Multi-value-ish fields.** `_raw` carries `key=value` pairs after a leading
  status word (`ERROR upstream timeout after 3000ms, upstream=cart-svc`).
- **Quoted embedded quotes.** Rows containing `q=\"pending orders\"` force the
  doubled-quote escape to be exercised.
- **Recurring patterns.** Four distinct error signatures repeat across hosts, so
  the recurrence grouping has something real to group.
- **Numeric and status columns** (`status`, `duration_ms`) so error-rate and
  latency figures can be computed rather than eyeballed.

Row counts are small and deliberately lopsided: the checkout path dominates
failures, which is the shape the bottleneck report exists to surface.

## `splunk-malformed.csv`

Three defects in one small file: a row with a missing cell, a row with an extra
cell, and a field left open inside a quote. It exists to prove the reader
reports structure rather than dying quietly — see the three-way
no-silent-death assertions in `verification/acceptance-stage2.mjs`.

## What this fixture cannot tell us

**Everything about a real export.** These files were written by the person who
will read them, so they can only contain assumptions that person already holds.
They cannot reveal an encoding they did not think of, a column Splunk emits only
for certain sourcetypes, a locale-formatted timestamp, an export capped at
10,000 rows with no truncation marker, or a `_raw` field containing a newline
that no CSV writer escaped.

**The first real export supersedes this file**, and the acceptance run against
it is the only thing that settles those questions. Treat every figure this
fixture produces as a claim about the *reader*, never about the pipeline.