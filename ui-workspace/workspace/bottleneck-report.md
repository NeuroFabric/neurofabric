# Analysis: production\_access\_logs

> The dataset is broadly sound across 400 row(s), with nothing that needs fixing. For completeness: 4 values across one column sit past the 1.5x fence, which is ordinary variation in a normal distribution and is not a defect.

400 row(s) · ranked by **status\_code**
· no status column, so no error rate is claimed

> **#1 by frequency:** 200 — 221 record(s), rows 2, 3, 5, 7, 9, 15, 16, 17, 20, 22, 24, 25 (+188 more).

> **This report cannot answer anything requiring:** source, message, duration. No credible column for those exists in this export, so nothing below is substituted.

## Data health insights

_Checked 2 numeric column(s) across 400 row(s). 0 dirty cell(s), 0 outlier(s), 0 empty cell(s)._

## Record categories by frequency

| # | category | record(s) | total elapsed (ms) | mean (ms) | median (ms) | p95 (ms) | source rows |
|---|---|---|---|---|---|---|---|
| 1 | 200 | 221 | not measurable | not measurable | not measurable | not measurable | 2, 3, 5, 7, 9, 15, 16, 17, 20, 22, 24, 25 (+188 more) |
| 2 | 304 | 70 | not measurable | not measurable | not measurable | not measurable | 10, 11, 12, 13, 32, 35, 36, 41, 44, 56, 80, 86 (+58 more) |
| 3 | 404 | 41 | not measurable | not measurable | not measurable | not measurable | 6, 8, 18, 21, 40, 53, 66, 68, 77, 81, 88, 94 (+29 more) |
| 4 | 403 | 30 | not measurable | not measurable | not measurable | not measurable | 4, 23, 39, 54, 65, 69, 76, 78, 89, 106, 117, 127 (+18 more) |
| 5 | 401 | 14 | not measurable | not measurable | not measurable | not measurable | 14, 160, 164, 186, 207, 223, 236, 274, 298, 303, 322, 342 (+2 more) |

_Ranked by frequency._

_Showing the top 5 of 9. The remaining 4 are in the analysis, not in this table._

## Record categories by total elapsed time

| # | category | record(s) | total elapsed (ms) | mean (ms) | median (ms) | p95 (ms) | source rows |
|---|---|---|---|---|---|---|---|
| 1 | 200 | 221 | not measurable | not measurable | not measurable | not measurable | 2, 3, 5, 7, 9, 15, 16, 17, 20, 22, 24, 25 (+188 more) |
| 2 | 304 | 70 | not measurable | not measurable | not measurable | not measurable | 10, 11, 12, 13, 32, 35, 36, 41, 44, 56, 80, 86 (+58 more) |
| 3 | 404 | 41 | not measurable | not measurable | not measurable | not measurable | 6, 8, 18, 21, 40, 53, 66, 68, 77, 81, 88, 94 (+29 more) |
| 4 | 403 | 30 | not measurable | not measurable | not measurable | not measurable | 4, 23, 39, 54, 65, 69, 76, 78, 89, 106, 117, 127 (+18 more) |
| 5 | 401 | 14 | not measurable | not measurable | not measurable | not measurable | 14, 160, 164, 186, 207, 223, 236, 274, 298, 303, 322, 342 (+2 more) |

_Ranked by total elapsed time._

_Showing the top 5 of 9. The remaining 4 are in the analysis, not in this table._

> Only 3 hour bucket(s) carry rows, which is too few for the 2x test to mean anything. No hour is called abnormal.

## Rows by hour (host-local; these timestamps carry no zone)

| hour | rows | share | vs avg | signal |
|---|---|---|---|---|
| 2026-10-02T23 | 102 | 25.5% | 0.8x |  |
| 2026-10-03T00 | 198 | 49.5% | 1.5x |  |
| 2026-10-03T01 | 100 | 25.0% | 0.8x |  |

## Data provenance

_No stored schema matched this file, so every column reading below was **inferred** from the column names and from a statistical profile of the values. None of it has been checked by a person: treat it as a first reading, not a verified mapping._

| role | column | basis | note |
|---|---|---|---|
| time | timestamp | hypothesis | inferred from name and a profile of 392 sampled value(s) |
| category | status\_code | hypothesis | inferred from name and a profile of 9 sampled value(s) |
