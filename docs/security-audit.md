# Security audit — the ingestion and web planes

Phase 3, Session 4. Conducted as hostile reading against the agent's own code,
on the four named targets. Every finding below is pinned by a test that was
written and run **red** before the fix; the commit history shows the red commit
(`ad33ebd`) preceding the fix commit.

The sweep deliberately did not trust review. Three of the four targets had been
read before and three of them turned out to be wrong in the same way.

## Summary

| # | Target | Finding | Severity | Status |
|---|---|---|---|---|
| 1 | `core/sql-guard.ts` | `SELECT ... INTO` creates a table and was allowed | **High** | Fixed |
| 2 | `ingestion/db-connector.ts` | Opened a database from any path on disk | **High** | Fixed |
| 3 | `web/server.ts` | Correction route read any file, outside the workspace | **Critical** | Fixed |
| 4 | `web/page.ts` | Unescaped HTML reflection | — | **Clean**, now pinned |

Three real vulnerabilities, all the same shape, and one target that is genuinely
sound.

## The shape of all three bugs

Every finding is a boundary that exists on one front door and not on its
neighbour.

- The PDF connector refuses a path outside the workspace. The database
  connector, written one session earlier to a different brief, never got the
  check and would open any file on the disk.
- The report route hands its path to the Conductor and is governed. The
  correction route resolved a path itself and read it directly.

This is the finding worth more than the three bugs. Nothing about a missing
check is hard to spot in isolation; what defeated review was that **nobody was
looking**, because `server.ts`'s header explicitly told every reader that the
file performs no validation of its own and therefore has nothing to bypass. A
reviewer who believes that is not reading the file. A documented guarantee of
absence is load-bearing — it changes where people look — so it has to be true on
every branch, and nobody was checking the branches.

The durable fix is a policy, not a patch: **a new front door inherits the
boundary check of the existing ones, and the check is the kernel's own function
rather than a new one.** All four connectors now call `resolveWithinRoot`. Four
call sites, one implementation. A second copy of a security check is a second
thing to keep correct, and the two drift — which is exactly what happened.

## Finding 1 — `SELECT ... INTO` passed the read-only guard

**High. A write executed through a guard whose entire purpose is to prevent
writes.**

The guard is a whitelist: a statement must begin with `SELECT`/`WITH`/`VALUES`/
`TABLE`, and must contain none of ~35 listed write verbs. Postgres (and T-SQL)
spell "materialise this query's results into a new table" as
`SELECT * INTO name`. That **creates and populates a table**.

It satisfies both rules. It starts with `SELECT`, so the statement-start rule
passes it, and it contains no listed verb, so the verb rule passes it too. Two
independent checks, and a write.

Fixed by adding `into` to the verb list, with the general lesson recorded beside
it: a verb allow-list's failure mode is *"an author did not think of that
spelling"*, which is structurally weaker than the rule that actually holds —
proving the statement is a single read. Refusing comments and stacked statements
is the load-bearing half of this guard; the verb list is the cheap half.

Pinned by `connector-security.test.ts`, including a control: a column merely
*named* `INTO_THE_MOON` is still allowed, so the fix is a word-boundary match
and not a wall.

## Finding 2 — the database connector opened any file on disk

**High. Arbitrary local file read, of any SQLite database, from any path.**

`querySqlite({ file, query })` took a caller-supplied path and opened it. There
was no boundary check and no option for one, so the connector could not be
governed even by a caller who wanted to. The SQL guard was irrelevant: it
governed the *query*, and the query in the exploit is a perfectly innocent
`SELECT`.

Fixed by calling the kernel's `resolveWithinRoot` before the query and before the
open. `root` defaults to the process workspace rather than being optional-and-
skipped, because **a boundary a caller can omit is a boundary that gets
omitted**. A separate error type, `DatabasePathRefused`, keeps "you asked for
the wrong place" distinguishable from "you asked for the wrong thing" — a caller
that cannot tell them apart goes looking for a bad query in a request that never
ran one.

Two existing tests had to be updated to pass a root. That is the point: those
tests were relying on there being no boundary at all.

## Finding 3 — the correction route read any file (Critical)

**Critical. Confirmed exploitable, not theoretical.**

`POST` to the correction route called
`readCsvFor(path.resolve(cwd, target))` — a direct `readFile` with no boundary
check anywhere on the way to it. A relative traversal, which works identically on
every host, read a file outside the workspace, parsed it, and applied a column
correction to it.

The exploit was demonstrated rather than argued. The red test sent a request for
a CSV outside the workspace and observed the applied correction coming back in
the response body:

```
feedback: { reason: 'alpha is now the category', roles: { ... } }
```

That response is the proof. Without it this would have been an argument about
whether `path.resolve` could be escaped; with it, it is a transcript.

Note what made this survivable: `/api/report` on the same server handles the
same kind of input correctly, because it delegates to the Conductor and lets the
kernel rule. So the *product* governed the reporting path and left the
correction path ungated, in a file whose header claimed it had no gates to leave.

Fixed with the kernel's `resolveWithinRoot`, returning **403** — the same status
`/api/report` returns for the same path. Two routes must not be distinguishable
by whether they check, or the difference is itself the information an attacker
is looking for.

The test asserts on the *absence of the `feedback` key*, not on the status code.
A status assertion alone would have passed even while the file was being read,
because the Conductor refuses the same path downstream and returns 403 either
way. The test has to name the thing that only happens if the read happened.

## Finding 4 — unescaped HTML reflection: CLEAN

`page.ts` is sound, and its argument is a real one rather than an accident:

1. **Escape first.** Every character of the report is HTML-escaped before any
   Markdown transform runs, so nothing from an uploaded file can be markup
   whatever transform follows.
2. **Transform second**, through a fixed, small set of constructs. There is no
   "pass through raw HTML" step — the step every Markdown renderer eventually
   grows and every one has shipped a hole through.
3. **One sink.** Every `innerHTML` assignment in the page goes through `render()`.

"I read the regex and it looked right" is not evidence, so this is now pinned:
the escaping function is extracted from the served page and executed against
hostile inputs; the escape-before-transform order is asserted structurally; and
every `innerHTML` assignment is asserted to come from `render()`.

Two assertions were **removed rather than fixed** during this sweep, and both
removals are recorded in the test:

- A tag allow-list that scanned the whole page failed on the page's own
  explanatory comment, which contains an escaped `<img>` example. It was matching
  prose, not behaviour. A check that breaks when a comment changes is a check
  someone will delete to make the suite green, and it teaches nothing.
- "Escaping is idempotent" was simply false, and the *code* was right: `esc`
  rewrites `&` first, so a second pass yields `&amp;lt;`, which renders as the
  literal text and contains no raw `<`. The property that matters is that
  escaping is monotonically safer, not a fixed point. I had asserted the wrong
  property, and the fix was to the test.

## Residual risk, stated honestly

- **Not a conforming PDF reader.** The text layer reads literal strings from
  uncompressed and FlateDecode content streams. Hex strings from a subset font
  with a custom CMap, ligature reassembly and OCR are all out of scope. The
  connector **reports** every one of these in `problems` rather than returning a
  clean empty result, because a confident empty answer reads as "this document
  has no rows" and the truth is "this document could not be read".
- **The PDF extractor trusts the container, not the xref.** Objects are found by
  scanning for `obj` markers. A file crafted to disagree with its own
  cross-reference table is read differently by this reader than by a conforming
  one. That is a deliberate trade for robustness against a damaged offset table,
  and it is recorded in the code.
- **The Postgres path is an interface, not a driver.** It is guarded and
  row-mapping is real, but no wire-protocol client is vendored. The read-only
  guard runs before an injected driver is touched, so a driver cannot become a
  way around it — but the Postgres surface has not been exercised against a real
  server in this codebase.
- **This is a localhost tool.** The wedge binds `127.0.0.1` only, which is a real
  control and also the reason the correction-route read was "only" high severity
  rather than remote. Any process on the machine can reach it, which is a wider
  population than the user.
- **Two scanners, one of them over-broad.** The fail-closed secret-write scanner
  matched an ordinary English word in a source comment and refused an entire
  file. The boundary work above is what makes fail-closed affordable; the write
  scanner needs the same treatment — scope it to assignment-like contexts rather
  than prose. Logged for v2.

## What would be next

1. Scope the write scanner to assignment contexts (v2), so fail-closed stops
   costing source files.
2. Make the deny-then-terminate behaviour non-sticky, so one hazard token does
   not cost a whole session.
3. Replace the verb allow-list in the SQL guard with a real statement classifier
   that proves a single read, rather than extending the list again.
4. Exercise the Postgres path against a real server in CI, so the injected-driver
   interface is not the only evidence it works.
