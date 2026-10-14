## What changes

**The guard I deferred twice.** Here it is, and it paid for itself on the first
run.

### (a) The CSS collision guard

`LiveStreamView` rendered `className="live"` long before the liveness strip
existed. The strip reused it, and the rule written for the strip —
`display:flex`, no wrap — was applied to the whole telemetry panel. That is !97,
one character per line, in production. It shipped because two files picked the same
plausible noun and **nothing in this repository looks at `styles.css`.**

The guard reads both sides as text and compares the one thing that collided: the
**BEM root**. A `no-duplicate-class` lint needs to parse CSS, resolve cascade and
map selectors to `className` literals — a dependency, which is not worth spending
the kernel's zero-dep ethos on. This catches the same bug in a hundred lines and
costs nothing.

**It found a second collision on its first run**: `topkeys`, claimed by
`AlertCenter` and `LiveStreamView`. The class is still live in the tree.

Handled **deliberately rather than reflexively**: they render the same data in the
same presentation, and unlike `.live` this is a leaf style with no layout rules, so
it cannot capture anything. Splitting the CSS would duplicate a rule for no
behavioural difference. Allowlisted **with its reason**.

**The allowlist is honest by construction** — every entry must be used *and* claimed
by two or more files. That check **pruned ten speculative entries** I had written
(`app`, `stack`, `grid`, `dot`, `demo`, `threshold`, `selector`, `alerts`,
`dashboard`, and two nothing used). An allowlist that accumulates entries is how the
rule dies quietly.

### (b) The assembled-page census

`jargon.test.tsx` renders panels in isolation and says so. `app-default-view.test.tsx`
**mounts App** — real component, real store, real wiring — and asserts on the whole
page. My stated gap, now closed.

**Both directions, and the second matters as much.** A guard that only proves
something is *hidden* is satisfied forever by **deleting** the internals. Asserting
they **come back** is what makes the flag a flag rather than a deletion.

## It found a real dead end

The front door lived only in the `records === 0` branch, so a **fresh install** —
no verdict yet — rendered *"Connecting to the live gateway…"* and **no button**.

That is the exact dead end the front door was built to remove, and it is the state
a stranger actually arrives in. Your verification passed because your wedge already
had traffic. **The button now renders in both empty states.**

## One assertion I deliberately weakened

The composite id is checked against the **spoken text**, not the raw markup:

```tsx
expect(html).toContain('value="dev/sla-monitor"');   // must be there
expect(spoken(html)).not.toContain("dev/sla-monitor"); // must not be seen
```

An `<option value>` **must** carry the real id or selecting the agent breaks — that
is a bug, not jargon. A guard demanding its absence would be demanding a bug.

## How to verify

```
cd frontend
npx tsc --noEmit
npx vitest run
```

```
 Test Files  18 passed (18)
      Tests  316 passed | 6 skipped (322)
```

## What could break

- **The guard will fail on a legitimate shared class** until someone allowlists it
  with a reason. That is the intended friction: the list makes the sharing
  decision explicit rather than implicit.
- **`diagnosticsEnabled` gained an optional sources parameter** and
  `diagnosticsEnabledHere()` is what components call. Omitting the parameter reads
  the real browser sources, so behaviour is unchanged — but **a caller that
  imported `diagnosticsEnabled` expecting no-arg behaviour still works**, and one
  that relied on it reading the browser while passing sources would differ.
- **`App` and `DynamicDashboard` gained an optional `diagnostics` prop.** Omitted,
  behaviour is identical. It exists so both directions are renderable.
- **The front door now renders in the `verdict === null` branch too.** A viewer who
  has clicked Connect and is waiting for a first answer will now also see the
  button. That is intended — but if you find it visually noisy during connection,
  it is one conditional.
- **The guard reads `.tsx` as text.** It catches the *name* collision, which is
  what !97 was. It cannot catch a collision with a class defined only in CSS, or
  one created dynamically at runtime.

## Verification labels

| Claim | Label |
|---|---|
| No class root is claimed by two components | **test-verified** |
| A second live collision (`topkeys`) found and resolved | **test-verified** |
| Assembled page free of jargon, both directions | **test-verified** |
| The front door is reachable on a fresh install | **operator-verified** — needs your browser |
| The flag behaves in a real browser | **unverified — operator**, tested both directions in CI-style assertions only |
