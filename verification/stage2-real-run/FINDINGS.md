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