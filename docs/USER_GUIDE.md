# User Guide — Neurofebric Analysis

**Applies to:** V1 Commercial Wedge, branch `feat/v1-commercial-readiness`
(containing MR !62, merged to `main` as `83a8c47`).

**Verified:** every sentence template, every refusal, the forecast behaviour and
the export's security properties below were **executed against the running
product** on this branch, through the real HTTP endpoints — not read off the
source and assumed. Where a template does not work, this guide says so and
explains why, because a guide that lists a phrase the product refuses is worse
than no guide.

---

## 1. What this build does

Drop a CSV into the workspace. The engine reads it, profiles every column, and
produces a dashboard: a timeline, ranked columns, the anomalies it found, and a
forecast where the data supports one. You then **ask it questions in English**
and **correct its reading of your file in plain sentences**, and the charts
redraw from the corrected analysis.

Your file is read on your own machine. Nothing is uploaded.

The agent is **not a language model**. It is a deterministic router over an
analysis the engine has already computed. It answers what it measured and
declines the rest — it will not invent a figure to fill a gap. That refusal is a
feature, and most of this guide is about where the edges are.

---

## 2. Asking questions — the data query grammar

There are **six** question types. Each is matched by keywords. Nothing is
guessed, and anything unrecognised gets an honest decline rather than a
plausible-sounding wrong answer.

### 2.1 The busiest hour

Keywords: **worst**, **busiest**, **peak** — plus **hour** or **time**.

```
What was the worst hour?
show me the busiest hour
what is the peak time
```

> ✅ *"The busiest hour is 2026-09-01 09:00, with 79 rows — 1.0% of the readable
> rows."* — with a line chart of rows by hour.

If the engine flagged that hour, it says so: *"The engine flagged it: 2.5x the
hourly average."*

If the file has no readable timestamps, it declines: *"This file has no readable
timestamps, so there is no hour to rank."*

### 2.2 The worst data-quality column

Keywords: **missing**, **blank**, **null**, **empty**, **no value**, **not a
number** — plus **which**, **what**, **most**, **worst**, **highest**.

```
which column has the most missing values?
which column has the most blanks?
```

> ✅ *"No numeric column has a missing or unreadable value."*

The word **most** is what makes this a ranking question. Without it, the
sentence is not recognised.

### 2.3 The mean of a column — **you must name the column**

Keywords: **average** or **mean**.

```
what is the average latency_ms?
mean of request_bytes
```

> ✅ *"The mean of latency_ms is 106.61, over 8,155 measured values. It ranges
> from 12.4 to 3,186."*

Naming the column is **required**:

```
what is the average latency_ms?          → ANSWERED
what is the average?                     → DECLINED
average                                  → DECLINED
mean of banana                           → DECLINED
```

Naming the column is the one thing the agent will not infer, because guessing
which of your columns you meant is how you get a confident answer about the
wrong one.

### 2.4 Counting values either side of a number — **name the column too**

Above: **over**, **above**, **greater than**, **more than**, **exceed**, **at
least**, **bigger than**.
Below: **under**, **below**, **less than**, **fewer than**, **smaller than**,
**at most**.

```
how many latency_ms values exceed 1000?
how many order_value_usd are over 1000?
how many rows are below 50?
```

You need **two** things: a number, and a column name. Both are load-bearing.

```
how many rows are over 1000?              → DECLINED
how many banana are over 5?               → DECLINED
how many latency_ms values exceed 1000?   → ANSWERED
how many order_value_usd are over 5?      → ANSWERED (6,386 of 6,386)
```

⚠️ **A column name that is not in the file is declined the same way as no
column name at all** — you get the generic decline in §2.7, not a list of what
the file does have. Check the spelling against `how did you read the columns?`
before assuming the feature is broken. The engine's underlying router can list
the numeric columns for you, but that message does not currently reach the user
through the chat endpoint; it is noted in the handover as a fix.

> ✅ *"At least 48 of the 8,155 measured values in latency_ms are above 1,000,
> and at most 48. The threshold falls inside a bucket spanning 1,000 to 1,123,
> so I cannot narrow it further without the raw values."*

**Why "at least … and at most".** The engine keeps a histogram, not every raw
value, so a threshold that lands inside a wide bucket cannot be resolved to one
exact number. Rather than round to something that looks precise, it gives the
range it can actually support. This is the single most distinctive behaviour in
the product: **it will not pretend to a precision it does not have.**

If you omit the column, or misspell it, the sentence is declined as above.

### 2.5 The top categories — **and a real limitation**

```
What are the top categories?
```

> ⚠️ On all three bundled demo files this currently answers: *"I could not find
> a categorical column in this file, so there is nothing to rank."*

**This is not a phrasing problem, and no rephrasing fixes it.** The engine
resolves the category role **only** by column *name*, against a fixed list:

> `alert_code` · `alertcode` · `alert_type` · `alertType` · `category` ·
> `event_type` · `type`

…and the column must hold **more than one distinct value**. A name that matches
but holds a single value is deliberately demoted, because ranking by it yields
one bucket containing everything — a table that looks like an answer and is not
one.

So this question works only on a file with one of those names. Note the
asymmetry: the demo files carry `channel`, `endpoint`, `entry_type` and
`status_code`, none of which are in the list.

**Correcting the column does not currently unlock it.** Saying
`channel is the category` is accepted and remembered as a correction, but the
categories question still declines afterwards. That is a genuine gap, tracked in
the handover, and it is documented here rather than left to be discovered in a
customer demo.

### 2.6 Two more, offered to you as suggestions

```
what is wrong with this file?
how did you read the columns?
```

> ✅ *"1 severe finding. The worst is order_value_usd: 250,000 against a fence
> of 156."*

The second reports the role the engine assigned to every column — the fastest
way to see what it got wrong before you correct anything.

### 2.7 When the agent declines

Anything outside the six forms answers:

> *"I cannot answer that from what I have measured. I report what the engine
> found in this file — the shape of the day, the categories, the findings and
> how I read each column — and I will not invent a figure to fill the gap."*

That is the correct behaviour, not a defect.

---

## 3. Correcting the engine — the schema correction grammar

The engine gives every column a **role**. Roles are what separate a useful
report from a table of numbers. The engine guesses from the column name; you
correct it once, in a sentence.

### The eight roles

| Role | Meaning | Example columns |
|---|---|---|
| `category` | A grouping label | `alert_code`, `category` |
| `time` | When something happened | `_time`, `timestamp` |
| `source` | Who or what originated it | `host`, `source_host` |
| `duration` | How long it took | `elapsed_ms`, `duration` |
| `threshold` | A limit to compare against | `threshold`, `limit` |
| `alias` | A second name for another column | `logger_name` |
| `status` | An outcome or state | `status`, `code` |
| `message` | Free text | `_raw`, `message` |

### Four sentence forms — all verified working

**1. Column first (the usual one)** — `alert_code is the category`

```
col_15 is the duration
created_at is the time
client_ip is the source
return_reason is the message
```

`actually`, `really` and `just` are accepted and ignored:
`total_elapsed_time_ms is actually the duration`

**2. Reversed** — `the category is alert_code`, `the time is created_at`

**3. use / set / treat / mark … as …** — `use alert_code as the category`,
`set created_at as time`, `mark outcome as status`

**4. should be** — `alert_code should be the category`

A trailing `.`, `?` or `!` is fine.

### Awkward column names are fine

Dots, spaces, brackets and parentheses all parse and are stored against the
header **exactly as typed**:

```
total.usd is the threshold
Alert Code is the category
total (USD) is the duration
```

### Plain words work too

| You can say | Means |
|---|---|
| `type`, `kind`, `group`, `class`, `label` | `category` |
| `timestamp`, `datetime`, `date`, `when`, `day` | `time` |
| `host`, `hostname`, `system`, `origin`, `service`, `app`, `server` | `source` |
| `latency`, `elapsed`, `response_time`, `took`, `runtime` | `duration` |
| `limit`, `target`, `sla`, `budget` | `threshold` |
| `also`, `aka` | `alias` |
| `state`, `outcome`, `result`, `disposition`, `severity` | `status` |
| `text`, `detail`, `description`, `reason`, `summary` | `message` |

```
kind is the category
timestamp is the time
outcome is the state
```

A synonym is recorded as **less precise** than naming the role directly, and the
agent may confirm it rather than act on it.

### What is refused — and why that is the point

```
col_3 is actually the amount     → REFUSED
col_3 is the cost                → REFUSED
col_3 is the revenue             → REFUSED
```

> *"'amount' is not a role this engine has, so nothing was changed. It knows:
> category, time, source, duration, threshold, alias, status, message. If one of
> those is what you meant, say it by name."*

Guessing that `amount` means `duration` would publish a **latency finding about
money** — confidently wrong, and every figure downstream would inherit the error
while looking entirely normal. A refusal costs one more sentence. A wrong
mapping costs you a report you have to notice is wrong, and most people will not
notice.

Corrections are also refused if over 200 characters, or empty.

### After a correction

The engine re-reads the file and the charts redraw from the corrected analysis.
It also tells you when a correction will not change measurement:

> *"I will treat col_15 as the duration. Note that no numeric column in this
> file has that name, so it will change how I label things rather than how I
> measure them."*

That distinction — naming versus measuring — is worth reading before you assume
a correction took effect.

---

## 4. Predictive forecasting

**Method:** damped exponential smoothing with a local linear trend. The shaded
band is how much the model has been missing by so far, widened with distance.

### The forecast requires a continuous hourly series

**This is the rule that catches people.** The engine refuses to project across a
gap in the timeline, and says exactly which hour broke it:

> ❌ *"The hours in this file are not continuous — 2026-09-26T13 and
> 2026-09-26T15 are not adjacent. A missing hour is missing data, not a quiet
> hour, so I will not project across it."*

The reasoning is sound: an hour with no rows in a sparse file is missing data,
not a genuinely quiet hour, and projecting across it would silently corrupt
every point after the gap.

### Observed behaviour on the bundled demo files

| File | Forecast | Why |
|---|---|---|
| `service-mesh-access.csv` | ✅ **12 points**, from 193 observed hours | hourly coverage is complete |
| `e-commerce-transactions.csv` | ❌ declines | hourly gaps |
| `financial-ledger.csv` | ❌ declines | hourly gaps |

So two of the three demo datasets do **not** demonstrate forecasting. That is a
gap in the demo data rather than in the feature, and it is flagged in the
handover; the generator should be revised to emit complete hourly coverage.

When it succeeds, it reports its provenance: *"12 hours projected by damped
exponential smoothing with a local linear trend, from the 193 observed hours."*

---

## 5. Standalone export — one file, safe to send

### What it does

The export produces a **single self-contained HTML file** you can email. It
carries the **conversation you were looking at** and **the data behind the
charts**, so the recipient gets both the reasoning and the numbers.

It is a POST, not a page you can bookmark: the conversation lives in your
browser, and only your browser can send it.

**Verified behaviour:**

| Property | Observed |
|---|---|
| Status | `200` |
| Filename | `attachment; filename="e-commerce-transactions.csv-analysis.html"` |
| Size | ~121 KB for the e-commerce demo |
| Source named in the file | `"e-commerce-transactions.csv"` |
| Conversation included | ✅ 3 turns replayed |
| Data payload included | ✅ timeline, ranking, forecast |
| Marked live | `false` |

### The security guarantee — and precisely what it means

An export is opened by people with **no server behind it**, often over
`file://`, sometimes years later. So the artifact is generated through the
**standalone** path deliberately, which produces a document that is inert by
construction rather than by politeness:

| Guarantee | Verified |
|---|---|
| Content-Security-Policy is `connect-src 'none'` | ✅ |
| **No chat composer** — absent from the source, not CSS-hidden | ✅ |
| **No chat endpoint** in the file | ✅ |
| Any remaining `fetch()` targets `about:blank#offline` | ✅ not a network URL |
| `live` is `false`, so the code refuses before any call | ✅ |
| A path escaping the workspace is refused | ✅ **403** `PATH_OUTSIDE_WORKSPACE` |

Four independent layers stop a network call: the composer is not in the file,
the endpoint is not in the file, the payload says the page is not live, and the
policy forbids connecting even if you bypassed the first three. Opening an
export on a laptop with the network off behaves identically.

The export endpoint reads an arbitrary path, which would otherwise be an
**exfiltration endpoint wearing a download header**. It uses the same kernel
resolver as every other route, so a traversal attempt is refused exactly as it
is everywhere else.

---

## 6. Security summary

| Property | Status |
|---|---|
| Files read locally, never uploaded | Verified |
| Path boundary enforced on every route | Verified, 403 |
| Credential fields redacted | Verified |
| Dashboard CSP — no wildcard, no `unsafe-eval` | Verified |
| Export contains no reachable network call | Verified, 4 layers |
| **Secret file permissions on disk** | ⚠️ **Unverified** |

**The open caveat.** Two tests asserting that stored secrets are not readable by
other users on the machine **skip on Windows**, which has no equivalent of POSIX
permission bits. They are unproven, not regressed, and no amount of Windows
testing will prove them.

They run on a Linux runner, and a pipeline assertion now exists that fails if
they are skipped **or missing**. But **no CI runner is registered for this
project**, so that assertion has never executed. Treat credential-at-rest
permissions as unverified until a Linux runner runs it and the log is read.

---

## 7. Try it in two minutes

1. Put a CSV in the workspace.
2. Open the dashboard and ask: `what is wrong with this file?`
3. Ask `show me the busiest hour` — it answers with a chart.
4. Read what it assumed: `how did you read the columns?`
5. Correct anything wrong: `alert_code is the category`
6. Export the conversation and open the file with your network off.

Demo files are in `test-fixtures/synthetic/`, generated by
`scripts/generate-synthetic-data.ts`. They contain **no personal data**:
customers are opaque IDs (`CUST-00042`), accounts `ACC-000123`, and client IPs
come only from RFC 5737 documentation ranges, which cannot collide with a real
network.

Regenerating is byte-identical — the generator is seeded, so two people demoing
the same file see the same chart.

---

## Known limitations on this build

Stated plainly, because finding these in a customer demo is worse than reading
them here.

1. **"What are the top categories?" does not work on the bundled demo files.**
   The category role resolves only by a fixed set of column *names* (§2.5).
2. **A correction does not currently unlock the categories question**, though it
   is accepted and remembered (§2.5).
3. **Two of three demo files produce no forecast**, because their hourly series
   has gaps (§4).
4. **Threshold counts are reported as a range**, not a single number, whenever
   the threshold falls inside a histogram bucket (§2.4). This is intended.
5. **Secret file permissions are unproven on Windows** (§6).
6. **A wrong or missing column name yields a generic decline** rather than the
   list of valid columns (§2.4). The router can produce that list; the message
   does not currently reach the user.
