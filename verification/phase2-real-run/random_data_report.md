# random\_data\_with\_issue

200 row(s) · ranked by **no credible column**
· no status column, so no error rate is claimed

## How this report was read

_No stored schema matched this file, so every column reading below is inferred from the column NAME alone and awaits owner confirmation._

_No column in this file was credibly readable as any role, so there are no readings to report. The columns exist and are described below._

> **This report cannot answer anything requiring:** category, time, source, message, duration. No credible column for those exists in this export, so nothing below is substituted.

## Data health insights

> ⚠️ **Data Quality Warning:** **col_7** contains 1 type-mismatched value (for example: oops_wrong_type). Something wrote text into a numeric column; find it before trusting its figures.
> ⚠️ **Extreme values:** **col_15** contains 1 outlier (worst: 9,999,999.99, beyond a fence of 3.066). These sit outside the range the rest of the column occupies, and may be real or may be corruption.
_**col_10** has 1 empty cell; **col_18** has 1 empty cell; **col_3** has 1 empty cell. A blank is an absent value, which is a different problem from a type mismatch._
_Checked 20 numeric column(s) across 200 row(s). 1 dirty cell(s), 1 outlier(s), 3 empty cell(s)._

> No categorical columns found; skipping categorical rankings.

## Numerical data summary

_20 numeric column(s) across 200 row(s). Showing the 10 with the widest spread. 10 further numeric column(s) are not shown._

| # | column | measured | empty | dirty | min | max | mean | spread | anomaly |
|---|---|---|---|---|---|---|---|---|---|
| 1 | col\_15 | 200 | 0 | 0 | -2.929 | 9,999,999.99 | 50,000.068 | 10,000,002.919 | **[ANOMALY: OUTLIER]** max 9,999,999.99 beyond a 3.066 fence, min -2.929
| 2 | col\_16 | 200 | 0 | 0 | -2.591 | 3.926 | 0.06 | 6.517 | **[ANOMALY: OUTLIER]** max 3.926 beyond a 2.704 fence, min -2.591
| 3 | col\_3 | 199 | 1 | 0 | -3.241 | 3.152 | -0.04 | 6.393 | **[ANOMALY: OUTLIER]** max 3.152 beyond a 2.645 fence, min -3.241
| 4 | col\_10 | 199 | 1 | 0 | -2.316 | 3.853 | 0.123 | 6.169 | **[ANOMALY: OUTLIER]** max 3.853 beyond a 2.975 fence
| 5 | col\_18 | 199 | 1 | 0 | -2.832 | 3.138 | -0.042 | 5.97 | **[ANOMALY: OUTLIER]** max 3.138 beyond a 2.191 fence, min -2.424
| 6 | col\_2 | 200 | 0 | 0 | -2.896 | 2.985 | 0.071 | 5.882 | **[ANOMALY: OUTLIER]** max 2.985 beyond a 2.735 fence, min -2.603
| 7 | col\_17 | 200 | 0 | 0 | -2.636 | 3.243 | 0.002 | 5.879 | **[ANOMALY: OUTLIER]** max 3.243 beyond a 2.625 fence
| 8 | col\_19 | 200 | 0 | 0 | -2.604 | 3.079 | 0.096 | 5.683 | **[ANOMALY: OUTLIER]** max 3.079 beyond a 2.653 fence, min -2.562
| 9 | col\_7 | 199 | 0 | 1 | -2.697 | 2.949 | -0.098 | 5.646 | **[ANOMALY: OUTLIER]** max 2.949 beyond a 2.627 fence
| 10 | col\_6 | 200 | 0 | 0 | -2.532 | 3.11 | -0.024 | 5.642 | **[ANOMALY: OUTLIER]** max 3.11 beyond a 2.879 fence

_Columns with the widest spread first. `empty` counts blank cells; `dirty` counts cells holding something that is not a number. Neither reaches the figures above, and neither is treated as zero._
