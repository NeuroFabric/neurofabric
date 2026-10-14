## What changes

**F1 and F4 together, because fixing them separately would have found an eighth
jargon line next week.** Every one of the operator's seven enumerated lines was a
test *asserting it was present*.

### F1 — the rule panel was never wired

`DynamicDashboard` takes `readings` and defaulted it to `[]`; `App` never passed
one. So `measured` was **always** undefined and every rule rendered "limit 1000, no
reading yet" — directly beneath a panel showing CRITICAL BREACHED.

**Your question, answered: unwired display. Not a missing dispatched evaluation.**
Readings are now derived from the live verdict and joined **by column name** — the
verdict reports `elapsed_time`, the rule declares `field: "elapsed_time"`, and
nothing in the pipeline gives a rule an id the verdict knows about. Memoised, so a
poll that changes nothing does not re-render every rule row.

**Alert dispatch: it does not exist and is out of scope.** There is no dispatch
mechanism on this screen and the vision does not promise one. So the fix is to say
where the number came from — *"measured directly from the data in view"* — rather
than build machinery to justify a sentence about machinery.

### F4 — the jargon census

| Enumerated | Now |
|---|---|
| `dev diagnostics` block, `tenant dev`, `layout version 0.0.0.dev+derived` | behind `?diagnostics=1` |
| `0.0.0.dev+derived` on agent + schema cards | behind the flag |
| `(1 READY, 0 STUB)` | just the count |
| `dev/sla-monitor` (a composite id) | the agent's **name** |
| `recs 240` | `events` |
| `From the live verdict, not a dispatched alert` | `Measured directly from the data in view.` |
| *(found while fixing)* `aria-label="stub"` | `not yet configured` |

**The flag is not `import.meta.env.DEV`, and that is the design.** `DEV` is true on
a vite dev server — exactly where you ran this — so every line would have stayed on
screen and the problem would have been solved only in a build nobody looks at.
**Off unless someone asks**: `?diagnostics=1` in the URL, or
`VITE_SHOW_DIAGNOSTICS=1`.

## How to verify

```
cd frontend
npx tsc --noEmit
npx vitest run
```

```
 Test Files  16 passed (16)
      Tests  300 passed | 6 skipped (306)
```

`jargon.test.tsx` renders every panel with the **worst-case** data — dev tenant,
derived layout, stub agent, dev version — and asserts the default view contains
none of it, **in the rendered text and in the raw markup** (an `aria-label` is
spoken and is not produced by stripping tags).

**It caught two leaks I had missed**: the agent version string and the composite id
in the widget line. That is the argument for having written it before fixing.

## What could break

- **`?diagnostics=1` changes the rendered tree**, so a screenshot taken with it on
  will show internals. That is the point; do not leave it on when showing a
  customer.
- **The widget line loses the agent id entirely by default** and shows the bare
  name. Two agents with the same name in different tenants would look identical —
  acceptable on a single-tenant screen, and the id is one query parameter away.
- **The schema line now reads "watching …" instead of naming the schema.** A reader
  who needs to know *which* schema should use the flag.
- **Six existing tests were inverted**, not deleted. Each asserted jargon was
  present; each now asserts it is absent, with the reason inline. **A test that
  pins jargon defends jargon**, and that is why this class took seven findings.
- **`diagnosticsEnabled()` reads `window.location`**, so it is a no-op under
  `renderToStaticMarkup` — which is why the tests see the default view and the
  browser sees the same thing by default.
- **No kernel, refusal-handling or credential-guard code is touched.**

## Verification labels

| Claim | Label |
|---|---|
| 300 tests pass, `tsc` clean | **test-verified** |
| Default view contains none of the seven lines | **test-verified**, worst-case fixtures |
| Rule panel now shows a real measured value | **test-verified** (unit); **operator-verified** in the browser |
| Assembled page is clean | **unverified — operator.** The test renders panels in isolation and says so |
| `?diagnostics=1` reaches the internals | **unverified — operator** |
