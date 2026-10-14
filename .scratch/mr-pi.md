## What changes

One file: `frontend/src/product-identity.test.tsx` — 13 tests, previously orphaned in the working tree since the operator completed Slice 1 directly.

No production code changes.

## How to verify

```
cd frontend
npx vitest run src/product-identity.test.tsx
```

```
 Test Files  1 passed (1)
      Tests  13 passed (13)
```

```
npx tsc --noEmit
npx vitest run
```

Full frontend gate, unchanged by this diff: `tsc` clean, 283 pass / 6 skipped / 0 fail.

## What it pins, and why it is worth its own file

**1. "Neurofebric" is the wordmark, in a centring region, with identity
typography.** It asserts *both* the class and the grid rule — a class with no
layout rule centres nothing, and that is exactly the shape of a test that passes
while the product does not do the thing.

**2. Severity is encoded by shape, weight and fill — with a guard that fails if
any severity is ever distinguished by colour alone again.** This is the one worth
keeping. Every severity originally differed in `color` and `border-color` and
nothing else: three pills in three hues, same shape, same size, indistinguishable
on a projector. "It looked wrong once" does not stop anyone making the same edit
again. This does.

**3. The header speaks to a person.** No store word reaches the screen, and the
machine state stays in `data-status` for styling and for tests — translated for
the reader, not erased.

**4. `prefers-reduced-motion` is present.** A criterion from the CEO mandate that
the stylesheet had never mentioned, found by *asserting the criterion* rather
than by looking for it.

## What could break

- **A deliberate wordmark change fails this test.** That is correct — the wordmark
  is the product's face and changing it should be an argued change, not an
  incidental one.
- **The colour-alone guard reads `styles.css` as text.** It is a **regression
  guard, not a verification** — a stylesheet can say anything and only a renderer
  knows what it does. Same distinction `deployment.test.ts` draws for compose
  files.
- **The guard matches on `background|border-width|font-weight|text-transform|
  padding|height`.** A severity differentiated by, say, `letter-spacing` or
  `opacity` alone would pass it and be caught by a person instead. It is a floor,
  not a proof.
- **No behaviour changes.** Nothing imports this file; it observes.
