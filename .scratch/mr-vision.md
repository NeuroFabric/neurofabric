## What changes

`docs/PRODUCT-VISION.md` — the one-page product definition. Docs only.

**Deliberately shipped on its own, ahead of the code**, because building without
it is how this project got to a screen full of jargon and an empty right-hand
panel: both were defensible at the time to someone optimising for the engine.

## How to verify

```
type docs\PRODUCT-VISION.md
```

One page. Read it and answer: *could a stranger tell what this product is, who it
is for, and what it does not do?*

## What could break

- **Nothing. It is a document.** No code, no gates, no behaviour.
- **It is a commitment, and it is one I am making.** The out-of-scope table names
  things this project has already drifted toward — jargon on the default view,
  multi-tenancy in the UI, retention. If I ship one of them anyway, this document
  becomes untrue and that is a worse failure than never writing it.
- **It says the delivery is judged by five operator checks, and names two of them
  as browser-only.** That is a claim I am making in advance of the evidence, on
  purpose: a definition written after the fact is a description.

## Why it is first

The operator's verdict on the product was *"if it isn't good, I'm not working on
this project."* That is the continuation criterion, and it is not something a
retrospective can fix. So the standard is written down **first**, and every
subsequent MR is justified against it.

## CI status

Not applicable — docs only, no gates affected.

Note: this branch also carries the P0 layout fix, because it was cut before the
collision was diagnosed. **The layout fix is in !97; this is the document.** If you
prefer them separate, say so and I will split the branch.
