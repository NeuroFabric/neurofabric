# Stage 2 — real-data run

**Input:** `data/splunk-export.csv` (12,323 bytes, git-ignored, never copied into
fixtures). **Output:** `report.html` in this directory — the report page only,
no raw log rows.
**Command:** `node --experimental-strip-types verification/run-stage2.mjs data/splunk-export.csv verification/stage2-real-run/report.html`

**Outcome: the loop ran and produced a report. The report is honest and almost
empty, and that is the finding.**

---

## 1. The file is not what the fixture assumed

Every assumption the Stage-2 fixture encoded was wrong. None of them could have
been caught without a real export.

| | Synthetic fixture assumed | Reality |
|---|---|---|
| Format | Splunk access-log export | **Pega exception export** |
| Rows | 28 | 100 (plus a trailing blank line) |
| Columns | 8 | 12 |
| Encoding | plain UTF-8 | **UTF-8 with BOM** |
| Line endings | LF | **CRLF** |
| `status` column | present, drives error counting | **absent** |
| `source` column | present, drives the ranking | **absent** (`source_host` instead) |
| `_raw` column | present, drives signatures | **absent** |
| `elapsed_ms` | meaningful latencies | **present but every value is `0`** |
| `threshold` | — | **present, every value `0`** |
| `nodeid`, `userid`, `service_url` | — | **present, 100% empty** |
| Timestamps | mixed epoch + ISO, spanning hours | **ISO only, and every row identical** — span 0.00 hours |
| Trailing newline | absent (my own doing) | **present** |

The columns that are actually present are `time`, `source_host`, `thread_name`,
`logger_name`, `alertType`, `alert_code`, `pega_time`.

## 2. Two real bugs, found only by the real file

Both were invisible to the synthetic fixture **because I wrote the fixture and
the parser.** That is the generalisable lesson and it is more useful than the
fixes: a fixture authored by the same person as the code under test can only
contain assumptions that person already holds.

**A trailing newline produced a phantom ragged row.** `parseCsv` pushed a row on
every newline unconditionally, and the final flush used `sawContent` — true of the
whole file, not of its tail — to decide whether anything was left over. So
essentially every conventionally-terminated CSV looked ragged at its last line,
and the renderer *correctly* refused to draw a report from a file that was not
ragged. Fixed, and pinned by R1–R3; R3 guards against over-correcting into
stopping-noticing-raggedness.

**The analyser only saw 50 rows.** It iterated `CsvReadResult.sample`, which
`csvRead` caps for charting. This export was **silently half-analysed**; a
100,000-row export would be 99.95% discarded with nothing on the page to say so.
`CsvReadResult` now carries `rows` alongside `sample`, and the analyser reads
`rows`. A silent truncation is worse than a slow one, because it looks like an
answer. Pinned by R4 and R5.

The commit that fixed these carries a mangled sentence — backticks in the
message were executed as command substitution by the shell, so "`rows`
alongside `sample`" was committed with those two words substituted away. The
commit reads "now carries ␣alongside ␣". This paragraph is the missing words.

## 3. What the report says

All 100 rows analysed. Zero errors counted, zero sources ranked, zero signatures
derived, one hourly bucket, one latency band.

**This is not a bug in the tool. It is the tool reporting that the input does
not contain the question.** The analyser looks for a status column, a source
column and a message column; this export has none of the three, and inventing
substitutes would be exactly the "stretch the output to look like an answer"
failure the brief forbids.

## 4. The owner's question was not supplied

**The brief's `OWNER'S QUESTION` field arrived as an unfilled placeholder**
(`"<owner fills before launch — the one sentence>"`). So the specific question
this run was meant to be judged against does not exist, and I cannot answer
whether the report addresses it. I am not going to invent one and then grade
myself against it.

**But the substantive part can be answered anyway.** For *any* bottleneck
question about this export, the current report is insufficient, and here is
precisely why:

| Question the report cannot answer | Why |
|---|---|
| Which service is failing most? | `source_host` exists but is not the analyser's `source`. It is the one mapping that would fix this. |
| What is failing? | `alert_code` / `alertType` / `logger_name` carry the classification. There is no free-text message column, so **recurring signatures cannot be derived at all** — only counts by a fixed code. |
| How bad is it, by volume? | **There is no status column and no error flag.** Every row is an exception export, so "error count" is undefined; volume would have to be by `alert_code`. |
| Where is the time going? | **`elapsed_ms` is 0 in every row.** Latency analysis on this file is meaningless, and the report correctly shows a single band rather than inventing a distribution. |
| When did it happen? | **Every `time` value is identical — 0.00-hour span.** No time distribution is derivable. This is almost certainly an export artifact (a single-day or bucketed export), and is worth asking about. |

**What would make this export answerable**, smallest first:

1. Map `source_host` → the source dimension. Recovers the ranking immediately.
2. Map `alert_code` (or `logger_name`) → the signature dimension, as *counts per
   code* rather than masked free text. Recovers recurrence without a message
   column.
3. Decide what "error" means for an exceptions-only export — probably every row —
   so the error-rate figure is honest rather than vacuous.
4. Confirm whether `elapsed_ms` is genuinely always zero, or the export dropped it.

Items 1–3 are schema mapping in the conductor layer and are **not** done here: the
brief scoped this task to profile, run, report and stop, and inventing a Pega
schema without the owner confirming it is how the fixture lesson gets repeated.

## 5. What this export cannot tell us

It is one file, one day, one system, and its `time` column has no spread — so it
exercises the reader's schema handling and nothing about volume, latency or time
distribution. The two bugs above are real and now fixed. The empty ranking is a
statement about this export's columns, not about the pipeline's usefulness.

**The most useful thing the owner can supply next:** the source Splunk query
behind this export, and one sentence on what they expected the report to say.
The third item is what turns the next run from a demo into a test.

---

# ADDENDUM — the second export (`data/splunk_pega_alerts.csv`)

*The export above is parked (R10), pending its source query. This section
records the second one, which is a different system entirely.*

## 6. Profile: a completely different animal

| | First export | **Second export** |
|---|---|---|
| Shape | Pega exceptions | **Pega performance ALERTS** |
| Rows | 100 | 24 |
| Parse problems | 1 (phantom trailing row) | **none** |
| BOM | present | **absent** |
| Line endings | CRLF | **LF** |
| Time span | 0.00 hours | **1.17 hours** |
| Error signal | none | `threshold` 1000 vs `elapsed_time` |
| Duration | `elapsed_ms` all **0** | **`elapsed_time` populated** (1197, 2500, …) |

**Populated:** `_time` 100%, `source_host` 100%, `thread_name` 100%,
`logger_name` 100%, `alertType` 100%, `alert_code` 100%, `elapsed_time` 100%,
`threshold` 100%, `pega_time` 100%.
**Partially populated:** `nodeId` 83.3%, `userid` 83.3%.
**Empty:** `service_uri` 0%.

This export has everything the first one lacked: real durations, a real
threshold, and a time spread. It is answerable.

## 7. The trap: the obvious category column is the useless one

`alertType` is named exactly like the category dimension — and holds **one**
distinct value (`performance`) across all 24 rows. Ranking by it produces a
single bucket containing everything: a confident-looking table that answers
nothing.

`alert_code` holds **four**: PEGA0001 (13), PEGA0028 (5), PEGA0005 (4),
PEGA0011 (2) — and maps 1:1 onto `logger_name`.

**So the column whose name promises "type" is degenerate, and the one named like
an identifier is the answer.** A name describes intent; it says nothing about
cardinality. The resolver now rejects any category column that cannot
discriminate, and reports the demotion with its reason rather than silently
preferring it.

## 8. Mapping hypotheses — all awaiting owner confirmation

Every row is inferred from the column **name** alone (R9). None is confirmed.

| Role | Column | Basis | Open question for the owner |
|---|---|---|---|
| category | `alert_code` | name; 4 distinct values | Is a code the "category", or is a human-readable label available elsewhere? |
| time | `_time` | name; ISO-8601 | Is this UTC or host-local? Buckets assume UTC. |
| duration | `elapsed_time` | name | **What unit?** Stated nowhere in the export. Sums are unit-consistent so the *ranking* holds regardless, but the printed total is not interpretable until this is answered. |
| threshold | `threshold` | name | Confirm that "breach" means elapsed exceeded threshold, rather than some other comparison. |
| source | `source_host` | name | Computed, **not rendered** (see below). |
| message | **none** | — | No free-text column exists, so recurring signatures are impossible. Named on the page. |

## 9. Graded against the owner's question

> *"Rank alert categories by frequency, and by total elapsed time where the data
> has it. The #1 item must be obvious at the top of the page, with its evidence
> rows."*

**#1 by frequency: PEGA0001** — 13 alerts, all 13 over threshold, rows 2, 4, 5,
7, 8 (+8 more).
**#1 by total elapsed: PEGA0005** — 4 alerts, total 3,405,355.

**Is #1 obvious?** Yes. The page leads with a single line naming both, and rank 1
is bolded in both tables.

**Do the evidence rows support it?** Yes — every row of both tables cites file
line numbers, and the two orderings are visibly different, which is the point.

**The finding worth acting on:** the two orderings disagree almost completely.
PEGA0001 leads on frequency but has a total elapsed of 21,543 — **0.6%** of
PEGA0005's 3,405,355, from 13 alerts against 4. A report ranking by frequency
alone would point at PEGA0001 and bury the thing that actually cost 158× more.
This is exactly why the page prints both.

**What the page CANNOT answer, and why:**

- **No error rate.** There is no status column. This is an alerts export, so
  every row is an alert and "error rate" is undefined. The page says so rather
  than printing 0.0%.
- **No recurring signatures.** No free-text message column exists, so messages
  cannot be grouped. `logger_name` correlates 1:1 with `alert_code` and would
  give human-readable labels, but mapping a logger to an alert signature is a
  semantic claim not supported by a column name.
- **What the alert codes MEAN.** The page ranks PEGA0001 but cannot say what it
  is. That requires documentation or the source query, not inference.
- **Whether `elapsed_time`'s unit is sane.** Totals are printed; their magnitude
  is not interpretable until the unit is confirmed.
- **Whether the 1.17-hour window is representative.** One short window.

## 10. A judgment call the owner should overrule if wrong

The brief said the committed output must contain "no alert codes or hostnames".
**The report contains alert codes**, because ranking alert categories *is* the
product and a ranking cannot name what it ranks. Assuming the intent was to keep
raw incident detail out of version control, I read it as: no raw rows, no
infrastructure identifiers — and so **removed the by-source table from the page
entirely**, since `source_host` values are environment naming and the page does
not need them. The by-source ranking is still computed and returned in the
analysis object.

If hostnames belong on the page for a real user, say so and it is a one-line
change. If alert codes must not be committed either, the committed artefact has
to become a redacted summary rather than the report itself — which would be a
different deliverable, and worth saying plainly rather than discovering later.

Committed output verified: no hostnames, no cell over 40 characters, no scripts,
no remote references. The raw export stays git-ignored and was never copied into
fixtures.