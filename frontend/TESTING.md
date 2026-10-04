# Testing this workspace

Everything here runs in **node**, not jsdom. That is a deliberate choice with
consequences, and this page exists because those consequences have bitten twice.

---

## The rule that costs the most: machine claims vs human claims

**`text()` strips tags.** It strips them and it collapses whitespace and it
replaces entities. So:

```ts
// WRONG for a machine claim. This asserts on a DIFFERENT THING than the one a
// machine reads, and it will happily pass on wording that was never wired.
expect(text(html)).toContain("degraded");

// RIGHT. The attribute is the contract; it survives every rewording.
expect(html).toContain('data-status="degraded"');
```

### Two failures this prevents, and both have happened here

**1. A test that passes on wording that was never wired.** If the component
renders `<span data-state="live">connecting</span>` — the attribute is correct,
the text is stale — a `text()` assertion on `"live"` fails and sends you hunting a
rendering bug that does not exist. You fix the wrong thing, and the real
inconsistency stays.

**2. A reword breaks a test nobody meant as a wording check.** When
`slice-1-status-header` changed `degraded` → `Partial data`, four tests failed.
Two of them were *intended* — the header was printing a machine word to a person.
The other two were doing layout assertions that happened to contain the word. The
indistinguishable ones are the expensive ones.

### How to tell which kind a test is

| You are asserting… | Assert on |
|---|---|
| a state, a count, an id, an age, a severity | **raw markup** via `data-*` |
| that a person is told something | **`text()`** |

If a test cannot say which it is, it should not be written. `liveness-strip.test.tsx`
is the worked example: the machine half and the human half are separate `describe`
blocks in one file, with the rule stated at the top.

---

## Why `node` and not `jsdom`

The components under test are pure logic: a state derivation, a class list, an
attribute. None of them lays out. Installing a DOM implementation would add a
dependency to buy a renderer that would assert nothing extra — **the day a test
genuinely needs `getBoundingClientRect` or an event dispatch, add jsdom and
switch `environment` in one place.**

The poller is the reason this works. A timer callback only runs inside an effect,
and an effect only runs inside a DOM, so a hook that polls could not be tested at
all. `TelemetryPoller` takes its timers as **constructor options** and the tests
drive them by hand — which is how "the backoff floors at 5s" became an assertion
rather than a comment.

---

## What these tests cannot prove

Stated here so a green run is not read as more than it measured.

| Claim | Why not | Who verifies |
|---|---|---|
| 60fps under live updates | needs a browser and a profiler | operator |
| flat heap over 30 min | needs a browser and a profiler | operator |
| "it looks right" | no renderer here | a person |
| CSS actually applies | the stylesheet is read **as text** | a browser |

That last one matters: `product-identity.test.tsx` greps `styles.css` for rules.
That is a **regression guard**, not a verification — the same distinction
`deployment.test.ts` draws for compose files. A stylesheet can say anything, and
only a renderer knows what it does.

---

## Running things

```bash
npm test                  # vitest run
npm run typecheck         # tsc --noEmit
npm run test:watch        # the same, interactive

# the suite that needs a running wedge. Skips unless you give it one, because a
# test that needs a server and cannot skip breaks the suite the first time anyone
# runs it alone.
COMMAND_CENTER_LIVE=1 COMMAND_CENTER_TOKEN=<credential> \
  npx vitest run src/api/live-path.live.test.ts
```

PowerShell: `$env:COMMAND_CENTER_LIVE="1"; $env:COMMAND_CENTER_TOKEN="..."`.

---

## Conventions worth keeping

- **Assert from `renderToStaticMarkup`, never from a live DOM**, for the same
  reason as `node` over jsdom: effects do not run, so a static render tests what
  it says it tests.
- **Drive a store with its real API.** `await store.load(source)`. An earlier
  version of a test called `store.ingestAgents(...)`, which does not exist — it
  guessed the interface instead of reading it, and failed at parse time.
- **Derive ids from the value under test.** `Record<StoreStatus, string>` fails the
  type gate when a state is added. `{ ready: "Ready", loading: "Loading" }` does
  not, and ships an untranslated word.
- **No `.map(fn)` where `fn` takes one argument** in a way that matters:
  `.map(words)` passes the array index as the second argument. It produced five
  identical strings from five different states and looked like a component bug.