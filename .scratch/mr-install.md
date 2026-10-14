## What changes

**Check 4 — the install-agent loop.** The previous state deserves stating precisely,
because *"incomplete"* would understate it:

The **"Forms" section rendered a read-only table** of the portal's declared form —
field, label, type, required — and called it a form. **There was no input, no
submit, and no code path from the UI to `POST /api/portal/schema` at all.**
Installing an agent was something a person did with curl while the screen described
the paperwork.

**The loop now exists end to end:** type → submit → appear in the list →
**selected** → rules loaded. The select step is the one that is easy to miss, and it
is the difference between a loop and half a loop — an agent that appears but does
not open is the same class of failure as a panel that renders but is broken.

## The schema is built, not collected

The portal declares two fields — an id and a title. A valid `AgentSchema` needs a
domain, a version, capabilities, streams, and **at least one rule**, because the
registry refuses a schema with none. Asking an operator for all of that is a form
nobody fills in.

So the two things a person can meaningfully name are asked for, and the rest is
supplied **visibly**:

> We add a starter rule so the agent can be registered, and you can change it
> afterwards.

An agent that silently arrived with a rule nobody chose is worse than one that
visibly does.

`buildSchemaDocument` is exported and tested against the **same allowed rule-key
set as the demo agent** — because the first demo schema invented `column` and
`factor` and the POST answered 400. Same failure, same guard, so it cannot return.

## Other decisions on the record

- **Required fields are checked in the component, not by the browser.** A native
  bubble is not an error in this product's language, and it vanishes the moment
  they click again. The message names the missing field in a sentence.
- **Failures are told.** Unauthorised, unreachable, refused-by-the-platform and
  everything else are four different sentences, with the detail in `title`.
- **The form is offered only when a transport exists** — the same runtime check the
  front door uses. A cast would offer a form that 404s. Two existing tests
  asserted the old table rendered; they now assert the **absence** of the form
  shape, because with no transport the honest rendering is nothing at all rather
  than a description.

## How to verify

```
cd frontend
npx tsc --noEmit
npx vitest run
```

```
 Test Files  19 passed (19)
      Tests  327 passed | 6 skipped (333)
```

**Then break it in the browser**, which is the test this MR exists for:

1. Fill in an id and a title → the agent appears in the list, **selected**, with
   its rules shown.
2. Submit an id that already exists → it should be replaced, not duplicated.
3. Submit a blank required field → a sentence naming what's missing, no request.
4. Submit a name the platform will refuse → the refusal is told in user language.
5. **Reload the page and do it again** → the loop must work from cold, which is the
   state your wedge was in when it had traffic and mine was not.

## What could break

- **The starter rule is a placeholder, not a design.** It is a `missing-field` rule
  on `elapsed_time`, chosen because the registry accepts it with no value or
  operator. An operator will want to replace it, and the panel says so.
- **`onInstalled` reloads, then selects, then loads rules** — three steps. If the
  reload is slow the select runs against a stale roster, so it falls back to
  matching by suffix (`<id>` or `tenant/<id>`). A tenant with an agent literally
  named `x` and another named `tenant/x` could select the wrong one; that is not
  possible today because ids are `tenant/name` by construction.
- **Two tests were inverted, not deleted** — they asserted the old table rendered.
  Per law 2, the replacement asserts the shape is **absent**.
- **`portal forms are server-declared**, so a portal that declares different
  fields renders those fields. The starter-rule note is fixed text; if a portal
  ever declares a three-field form the note still reads correctly.
- **No kernel, refusal-handling or credential-guard code is touched.**

## Verification labels

| Claim | Label |
|---|---|
| 327 tests pass, `tsc` clean | **test-verified** |
| The built document uses only accepted rule keys | **test-verified** |
| A real input per declared field, labelled | **test-verified** |
| **Submit → appear → selected → rules load** | **unverified — your browser.** `renderToStaticMarkup` runs no effects, so the click is not driven by any test here |
| The loop works from cold, with no prior traffic | **unverified — your browser** |
