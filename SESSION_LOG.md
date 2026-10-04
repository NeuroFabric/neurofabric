# Session log — autonomous run 2, 2026-10-04

**Read this first.** State on arrival, what is ready to merge, what is blocked and
whose hands it needs, and what I did wrong.

---

## THE HEADLINE: CI IS ALIVE

Your PATH fix worked. **Tests have now executed in this project's pipeline for the
first time in its history.**

| Job | Status | Evidence |
|---|---|---|
| typecheck | **success** | first-ever green |
| test-mjs | **success** | 22/22 |
| test-proof | **success** | — |
| test-ts | **failed** | **1535 tests, 1533 pass, 0 fail, 2 skipped** — then a *later step* failed |

**The tests all passed.** `test-ts` died on its final step:

```
$ node verification/assert-posix-vault-permissions.mjs
FAIL  this gate is POSIX-only; running it on win32 cannot prove anything.
```

**Same class as `measure-wrappers`.** The gate is *right* to refuse — it exists to
verify the Linux runner — and `.gitlab-ci.yml` runs it unconditionally. The file
is wrong; the gate is correct.

**This is exactly what your mandate predicted**: a never-run pipeline's first
failure is expected. This one is not a code fault, and it is not mine to fix —
fixing it means editing `.gitlab-ci.yml`, which is outside my authority.
**Runbook written: T10 in `docs/operator-runbooks.md`.**

---

## MRs ready to merge

| # | MR | One-line verification |
|---|---|---|
| 1 | **!88** Liveness strip (Slice 2) + ADR-002 | `cd frontend && npx vitest run` → 283 pass |
| 2 | **!89** Port startup check (T9) | `node --experimental-strip-types start-ui.mjs --port <busy>` |
| 3 | **!87** Bootstrap door (TASK 1) | `node --experimental-strip-types scripts/dev-boot.mjs` |
| 4 | **!90** Testing guide + scratch hygiene | `type frontend\TESTING.md` |
| 5 | **!91** Operator runbooks (T10, T11) | read it; it is instructions for you |

Independent of each other. **!88 and !89 are the substance**; the rest is
documentation of decisions.

---

## What Slice 2 actually delivers

The liveness strip, above everything, because **silence must never be ambiguous**.
A dashboard that is silent and a dashboard that is broken look identical from
outside; both show numbers that are not moving, and only one is true.

Five states that were previously one grey number: `connecting`, `live`, `stalled`,
`halted`, `empty`.

Two decisions in it, and both are arguments, not implementation:

- **`halted` is checked first.** A poller that stopped asking is not
  "connecting", and calling it that is a lie that looks like patience.
- **A read too old is `stalled` whatever the counter says.** A count holding
  steady while the feed dies is the exact failure this exists to catch.

**Partial data with a visible fault beats no data** — hiding a degraded store
loses the good data the operator already has *and* hides the only thing they
could act on.

### uPlot is decided and deliberately NOT shipped

ADR-002. I installed and verified `uplot@1.6.32` (545KB unpacked, 0
vulnerabilities) and then **removed it**, because nothing renders a series yet and
a dependency ahead of its consumer is a cost with no return — precisely what
ADR-001 exists to prevent. `frontend/package.json` is byte-identical to `main`.

ADR-002 also records two costs rather than hiding them: this breaks
zero-dependency for **`frontend/`** (the *kernel* claim is untouched — the root
manifest has no `dependencies` field), and 145KB raw / ~45KB gzipped **exceeds
the ≤~50KB budget** on raw size. I treated the budget as gzipped, which is what a
browser downloads, and stated both numbers rather than redefining the criterion to
fit the decision.

---

## T9 — the fifth coat

`platform/core/port-probe.ts`, wired **at the bind site**, because `start-ui.mjs`
is what calls `bind`. Measured output:

```
port 8097 on 127.0.0.1 is already in use by PID 1488 (node.exe).
Nothing has been stopped. ...
  node --experimental-strip-types start-ui.mjs --port 8098
```

**There is no code path in it that terminates a process**, and the test file states
that absence explicitly — "it does not kill things" is exactly the claim that
quietly stops being true when nobody checks.

---

## Self-corrections, recorded not buried

1. **The credential fault in the liveness strip was unreachable.** It was gated on
   `severity === "hard"`, which a credential refusal with an empty fault never
   reaches — so the most important message was missing in the state that most
   needed it. Caught by a test written to the !86 contract.
2. **`.map(words)` passed the array index as the props object.** Five identical
   strings from five states, and "expected 1 to be 5" looked like a component bug.
3. **The test suite's own `StoreStatus` union guess was wrong** — I invented two
   states; the real union is four. `statusWord` is now keyed on the type.
4. **uPlot almost shipped unused.** Caught by asking whether anything imports it.

---

## Blockers — operator only

**B1 — `test-ts` red on a POSIX gate.** Steps in `docs/operator-runbooks.md` §T10.
Needs: enable shared Linux runners, and a decision on tagging. **I did not edit
`.gitlab-ci.yml`** — moving a failing step into a separately-tagged job could be
read as skipping it, and that call is yours.

**B2 — runner token rotation.** It has been in a transcript four times; **one was
me**, printing it while looking for the shell setting. T11 in the same runbook is
the moment to rotate, and it is yours.

**B3 — 60fps and flat-heap-over-30-minutes.** Unverifiable here — no browser, no
profiler. **Logged operator-verified, never claimed.** I will not put a number in
a description I did not measure.

---

## Not done, and why

- **Slice 3 (uPlot series) and Slices 4–6.** ADR-002 has the decision; the
  dependency lands *with* the commit that first draws a series.
- **T10/T11 execution.** Runbooks written; both steps are yours.
- **`docs/ux-overhaul-design-log.md` and `frontend/src/product-identity.test.tsx`**
  are uncommitted in the working tree from the previous session. The design log
  content is now largely superseded by ADR-002 and the Slice 2 MR description.
  **They need a decision: commit or discard.** I did not delete them — the
  deletion guard is right that they should be a deliberate choice, not a reflex.

---

## What I would do next

1. **B1** — the Linux runner. Everything about CI is downstream of it.
2. **Merge !88, then !89** — the two that change the product.
3. **The two untracked files**: commit the design log into Slice 3, or discard.
4. **Slice 3** — uPlot series, with the dependency and its benefit arriving in the
   same commit.
5. **B2** — rotate, once !91's steps are followed.