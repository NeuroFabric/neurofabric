## What changes

**MR !105. The durable record, wired into the boot path, and the diff on screen.**

The record exists (!104). It is opened at boot, it receives content, and the five
legal disagreements are presented to the operator — who acknowledges them, and
resolves nothing.

| File | What it does |
|---|---|
| `platform/memory/store.ts` | Migration **2** (`acknowledgements`) + `acknowledgeDifference()` |
| `platform/memory/reconcile.ts` | `differenceKey()` — one identity for a difference |
| `platform/memory/memory-routes.ts` | **NEW.** `GET /api/memory/diff`, `POST /api/memory/ack` |
| `platform/memory/memory-routes.test.ts` | **NEW.** 13 tests |
| `platform/web/server.ts` | `memory` option, live freshness at ingress, route mount |
| `platform/api/portal-routes.ts` | `onSchemaRegistered` hook |
| `start-ui.mjs` | Opens the record before the bind; `--no-record`; closes on Ctrl-C |
| `frontend/src/api/memory-contracts.ts` | **NEW.** Envelope validation |
| `frontend/src/api/gateway-client.ts` | `fetchReconciliation()`, `acknowledgeDifference()` |
| `frontend/src/hooks/useReconciliation.ts` | **NEW.** `DIFF_POLL_MS = 5_000` |
| `frontend/src/components/ReconciliationPanel.tsx` | **NEW.** The panel |
| `frontend/src/App.tsx` | Props + the panel as a sibling section; **dead 80-line block deleted** |
| `frontend/src/Root.tsx` | The hook, called unconditionally |

**Zero dependencies added.** `node:sqlite` is a Node built-in. D-018 and ADR-001
untouched.

---

## Constraint 1 — the system presents, it does not choose

There is **no `resolve` verb anywhere in this tree**, and that absence is
asserted rather than asserted-about:

- The only mutating route is `POST /api/memory/ack`. Its response carries
  `stillOpen: true`.
- **The difference stays on the list after acknowledgement.** A test reads the
  diff again and asserts it is still there, still explained, still actionable.
- `DELETE` / `PUT` / `PATCH` on the diff route are 405. `/api/memory/resolve`,
  `/api/memory/migrate` and `/api/memory/reconcile` are 404.
- A client test asserts `resolveDifference`, `dismissDifference` and `migrate`
  do not exist as methods.
- **Acknowledging something not on the list is refused (404).** The key is
  resolved against a freshly computed reconciliation. The permissive version
  would have let an audit trail record the caller's own account of what the
  system said.

## Constraint 2 — the two-truths visual contract

ADR-005 §9, all three rules, asserted **on markup, not on props** (law 3):

1. **Never in the same block.** The record panel is a sibling `<section>` that
   *closes before* the live `<aside>` opens — asserted by index, so no future
   edit can quietly merge them. Inside a row, "Recorded" and "Live" are their own
   labelled cells, repeated on every row rather than stated once.
2. **Every figure carries its age.** The comparison carries its own age
   ("Checked 14:32 · 10 minutes ago"); every recorded verdict carries one; a
   test asserts no bare ISO timestamp reaches the screen.
3. **A recorded breach and a live breach look different, on purpose.**
   `chip--recorded-breach` is flat and dated; the live strip keeps its pulse. The
   stylesheet says in a comment that **nothing in the record panel may animate**,
   because an animation on a recorded value is a claim that it is happening now.

---

## The three defects this MR found

**1. An unreachable duplicate in `App.tsx`.** The file ended with a second,
verbatim copy of everything from the refusal screen to the closing `return`,
sitting after the first `return`. Nothing caught it: `allowUnreachableCode` is
`undefined` (a suggestion, not an error), the tests render the live copy, and
both copies pass every assertion. Anyone editing it had a fair chance of editing
the copy that does not run — and this MR would have been the third thing wired
into one of the two, silently. Deleted, with a marker explaining why.

**2. A recorded acknowledgement, hidden.** The panel wrapped the whole
acknowledgement line in `onAcknowledge !== undefined`, so an acknowledgement that
had **already been stored** was invisible whenever no callback was supplied. A
durable fact about what a person did, not rendered because this particular render
had nobody to offer a button to. Found by a test, not by reading the code. The
button is now conditional; the **record** is not.

**3. `.stack` claimed by two components.** The CSS collision guard from !97 fired
on my own first draft — the third instance of that class here. Resolved the way
the guard's allowlist is designed for: `stack` is a bare layout utility with no
colour, no border and no component meaning, so it cannot capture anything the way
`.live` captured a whole panel. Allowlisted **with the reason**, rather than given
a `.record__stack` alias — an alias would be a second name for one rule, which is
"relocated rather than answered".

---

## Two corrections to my own verification, which matter more than the fixes

**The boot proof's auth case proved nothing.** `.scratch/boot-proof.mts` shared one
`headers` object across every request, so its "no credential" case silently sent
the credential and printed `200` for a request that had established nothing. The
honest receipts are `401` with no header and `401` with an unrecognised one. An
auth receipt that cannot fail is not a receipt.

**The restart proof deleted the record before restarting.** The same script called
`rmSync(workspace)` on the shutdown line, so the "restart" opened an empty
directory, printed "FIRST RUN", and appeared to show that nothing survived — on a
record it had just deleted. This is the standing rule from `SESSION_LOG.md`: *the
environment that verifies must not be the environment that flatters.* Both fixed,
both re-run, and the durability receipt is now real.

---

## Live receipt — the real boot path, a real credential, a real restart

```
no credential                        -> 401 UNAUTHENTICATED
a credential that was never issued  -> 401 UNAUTHENTICATED
GET  /api/memory/diff (first run)    -> 200, 2 differences
POST /api/portal/schema              -> 200, agent "acme/log-anomaly" registered
GET  /api/memory/diff                -> 200, 3 differences
                                         no-live-window-yet :: agent log-anomaly
POST /api/memory/ack  (invented key) -> 404 "that difference is not on the list right now"
POST /api/memory/ack  (real key)     -> 200, stillOpen: true
GET  /api/memory/diff                -> difference STILL LISTED, acknowledged: true
--- restart, same workspace ---
Durable record: opened.  (not "FIRST RUN")
summary: 3 difference(s) to look at. Nothing has been changed for you.
    no-live-window-yet :: acknowledged=true
```

---

## Two places this deviates from ADR-005, stated rather than discovered

**The diff is recomputed per read, not captured at boot.** §2 step 5 puts
reconciliation at boot. It cannot be: the tenant is proven by a credential the
boot process does not have, so a boot-time reconciliation would mean guessing
which tenant to reconcile. The consequence is that a difference can **retire
itself** — difference 2 clears the moment data starts arriving. That is a fact
ceasing to exist, not the system choosing anything, and §12.1 of the ADR now
says so.

**An unknown difference kind is refused, not ignored.** Every other validator in
this frontend ignores fields it does not recognise, because the server owns the
shape and may grow it. This one does not: an unrecognised kind is a disagreement
the platform cannot explain, and rendering it as an unlabelled row is exactly the
skimming §7.3 warns about. Refusing makes the gap loud.

---

## What this does NOT prove

- **The click.** `renderToStaticMarkup` runs no effects. That the acknowledgement
  reaches the server and the panel re-reads is the operator's browser test. The
  round trip *is* proven above, by curl against a real process.
- **The interval.** `DIFF_POLL_MS = 5_000` is asserted as a named constant
  (10× the live poll). That the timer fires, that a tick re-reads, and that the
  in-flight guard skips an overlap are timing behaviours this environment has no
  clock for. They are not claimed.
- **Live attribution is coarse.** The wedge's live path carries no tenant, so
  `defaultLatest()` attributes the newest reading to every registered agent. That
  is fit for differences 2 and 5, which ask whether the window is empty and
  whether history is ahead. It is **not** fit for attributing a number to an
  agent, and `memory.latest` is the seam for a caller with real attribution.
- **§7.1's write boundary still has no caller.** `recordDecision()` is reachable
  and tested but nothing in the running server calls it yet. That is exactly why
  SSE is !106 and not part of this MR.

## Gates

`test:mjs` **22/22** · `test:ts` **1589 tests / 1587 pass / 0 fail / 2 skipped** ·
`tsc --noEmit` clean · `tsc -p tsconfig.entries.json` clean · frontend
`tsc --noEmit` clean · frontend vitest **387 passed / 6 skipped / 0 fail, 24
files** · memory suites **31/31** · `.scratch/boot-proof.mts` green.
