# User Guide — Neurofebric Analysis

**Applies to:** `main` at `f4265e8` (Phase 4 UX overhaul)
**Verified:** every sentence template below was executed against the shipped
parser (`platform/web/chat-parse.ts`) on this branch. Nothing here is inferred.

---

## What this build does

Drop a CSV into the workspace and the engine reads it, profiles every column,
and produces a dashboard: a timeline, ranked columns, and the anomalies it found.
You can then **correct the engine's reading of your file in plain English**, and
the charts redraw from the corrected analysis.

Your file is read on your own machine. Nothing is uploaded.

---

## 1. Telling the engine what your columns mean

The engine gives every column a *role*. A role is what the column represents —
a time, a category, a duration, a status. Roles are what make the difference
between a useful report and a table of numbers.

The engine guesses. You correct it, once, in a sentence.

### The eight roles

| Role | What it means | Example columns |
|---|---|---|
| `category` | A grouping label | `alert_code`, `region` |
| `time` | When something happened | `created_at`, `timestamp` |
| `source` | Who or what originated it | `host`, `client_ip` |
| `duration` | How long something took | `elapsed_ms`, `latency` |
| `threshold` | A limit to compare against | `sla_limit`, `budget` |
| `alias` | A second name for another column | `aka_of` |
| `status` | An outcome or state | `state`, `outcome` |
| `message` | Free text | `error_text`, `description` |

### Four sentence forms, all verified

**1. Column first (the usual one)**

```
<column> is the <role>
```

```
alert_code is the category
col_15 is the duration
created_at is the time
client_ip is the source
return_reason is the message
```

You may insert `actually`, `really` or `just` — they are ignored:

```
total_elapsed_time_ms is actually the duration
```

**2. Reversed — the same correction, said the other way round**

```
the <role> is the <column>
```

```
the category is alert_code
the time is created_at
```

**3. "use / set / treat / mark … as …"**

```
use alert_code as the category
set created_at as time
treat host as the source
mark outcome as status
```

**4. "should be"**

```
<column> should be the <role>
```

```
alert_code should be the category
latency_ms should be the duration
```

A trailing `.`, `?` or `!` is fine.

### Column names can be awkward — quote nothing, just type them

Real headers contain dots, spaces, brackets and parentheses. All of these parse,
and are stored against the header exactly as typed:

```
total.usd is the threshold
Alert Code is the category
total (USD) is the duration
```

### Plain words work too

You do not have to know the engine's vocabulary. These are accepted as synonyms:

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
hostname is the source
elapsed is the duration
sla is the threshold
outcome is the state          ← note: resolved as a synonym, so the engine treats
                                it as less precise than naming the role directly
```

### What is refused, and why that is the point

These are **rejected**, and nothing is changed:

```
col_3 is actually the amount     → "amount" is not a role this engine has
col_3 is the cost                → "cost" is not a role this engine has
col_3 is the revenue             → "revenue" is not a role this engine has
```

The reason is deliberate, and it is the single most important thing to know
about this product. Guessing that `amount` means `duration` would produce a
report that publishes a *latency* finding about *money* — confidently wrong,
and every figure downstream inherits the error while looking completely normal.

A refusal costs you one more sentence. A wrong mapping costs you a report you
have to notice is wrong, and most people will not notice.

The refusal always tells you the roles the engine does have, so you can finish
the sentence rather than start over.

### Two limits worth knowing

- A correction must be **under 200 characters**. A pasted paragraph is refused
  rather than half-matched.
- An empty input is refused with the same guidance.

---

## 2. Asking questions — **not available in this build**

This is the important limitation, stated plainly rather than discovered later.

**Asking a question in English is not supported on `main`.** There is no query
endpoint. The only thing the text box accepts today is a *correction*.

The sentence the natural phrasing suggests:

```
What are the top categories?
```

is **refused by the parser** on this branch, because it is a data question, not
a schema correction. That is not a bug in the sentence — it is that the
capability is not in this build.

A conversational query surface, along with the standalone export, ships in
Phase 5. See the status section below.

---

## 3. Export — **not available in this build**

There is no "Export Analysis" feature on `main`. The dashboard can be saved
from your browser, but that is the browser's Save Page, not a product feature,
and it carries none of the guarantees described below.

The standalone export arrives in Phase 5. When it does, its security properties
are the reason it exists rather than a happy path:

- The exported file is a **single self-contained document** — the conversation
  and the data travel inside it.
- It is generated through the **standalone** code path deliberately, so it
  carries `connect-src 'none'` and **no composer**. The control is not hidden
  with CSS; it is absent from the document.
- It contains **no live network calls**. A reader can open it with the machine
  offline.

Those claims are recorded, with the caveats that travel with them, in
`docs/DECISIONS.md` (D-037) on the Phase 5 branch.

---

## 4. Security, as verified on this build

| Property | Status |
|---|---|
| Files read locally, never uploaded | Verified |
| Path boundary — a path escaping the workspace is refused | Verified, **403** |
| Credential fields redacted in output | Verified |
| Dashboard Content-Security-Policy | `default-src 'none'`, no wildcard, no `unsafe-eval` |
| Secret file permissions on disk | **Unverified on Windows** — see below |

**The one open caveat.** Two tests that check that stored secrets are not
readable by other users on the machine **skip on Windows**, because Windows has
no equivalent of POSIX permission bits. They are not regressed — they are
unproven, and no amount of Windows testing will prove them.

They run on a Linux runner. A pipeline assertion now exists
(`verification/assert-posix-vault-permissions.mjs`) that fails if those tests
are skipped *or missing*, so the claim cannot silently lapse.

**However, no CI runner is registered for this project**, so that assertion has
not yet executed. Until a Linux runner runs it and the log is read, treat
credential-at-rest permissions as **unverified**.

---

## Try it in two minutes

1. Put a CSV in the workspace the launcher serves from.
2. Open the dashboard.
3. Look at a column the engine described badly, and correct it:
   `alert_code is the category`
4. The charts redraw from the corrected analysis.

Ready-made demo files live in `test-fixtures/synthetic/` — see
`scripts/generate-synthetic-data.ts`. They contain no personal data: customers
are opaque IDs (`CUST-00042`) and the service-mesh client IPs come only from
the RFC 5737 documentation ranges, which cannot collide with a real network.

---

## Status of this document

Written against `main` at `f4265e8`. Two capabilities named in the commercial
roadmap are **absent from that branch** and are documented above as absent
rather than described as working:

- Conversational querying (no `/api/chat`)
- Standalone export (no `/api/export`)

Predictive forecasting is likewise absent from this branch.

If you are reading this expecting those, you are on `main` and not on the
Phase 5 branch that has them. That gap is a release-state discrepancy, not a
documentation error, and it is tracked in the handover.
