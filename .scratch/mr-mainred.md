## `main` is red, and the tests were pointing at a real product defect

`npm test` on integrated `main` fails two tests. Both are stale assertions against
a multi-tenancy change — and chasing them turned up a bug in the Command Center's
own round trip.

**This is the focused MR. It is first in the queue because everything else is
built on a red base.**

---

## Attribution, measured rather than reasoned

Four worktrees, both failing files run at each commit:

| Commit | What landed | `portal-mount` | `e2e-dynamic-platform` |
|---|---|---|---|
| `37663ac` | portal + schema routes mounted | 9/9 green | 10/10 green |
| `9be7b6c` | live endpoint mounted | 16/16 green | **9/10 red** |
| `51b4038` | !78 epic tip | **15/16 red** | 9/10 red |
| `0573ea0` | integrated `main` | red | red |

`d221f3d feat(api): implement crud endpoints for dynamic schema authoring` made
`DynamicAgentRegistry` namespace by tenant — composite id `tenant/schemaId`, and
`get(tenant, id)` in place of `get(id)`. Two tests were written against the old
signature; neither was updated. **Neither is a behavioural regression. Both are
literals that stopped describing the contract.**

### The two failures were also hiding each other

My !78 fix corrected the stale route count in the e2e test, and the assertion *behind* it failed immediately — `registry.get` returning `undefined`. **Fixing a stale assertion reveals the next stale assertion underneath it**, which is why the count fix alone could never have turned it green.

---

## The real defect, which is not a test

The roster publishes `demo/log-anomaly`. The Command Center puts that value in a select and sends it straight back to `GET /api/portal/schema/:id`. The route resolved `schemaOf(tenant, id)` against the id as given, producing `demo/demo/log-anomaly`.

Measured against a running wedge on the current tree:

```
GET /api/portal/agents                    ->  "id": "demo/log-anomaly"
GET /api/portal/schema/demo%2Flog-anomaly  ->  404
GET /api/portal/schema/log-anomaly         ->  200
```

**The UI could list an agent and never open one.** No test covered the round trip, because the two tests that failed were both about id formatting in isolation.

The route now accepts both forms. A bare id resolves against the proven tenant; a composite id resolves only when its tenant matches. **A composite id naming another tenant is a 404, not a 403** — indistinguishable from an id nobody registered, because a 403 would make this endpoint an oracle for enumerating another customer's agent names. Both are now pinned.

### Why the roster was not changed to publish bare ids

That was a decision, not a default. The tenant comes from the **proven credential, never the request**. With bare ids, one id means different things to different callers and the only thing separating them is the credential behind each request; the moment any surface resolves a tenant *from* an id — a deep link, a cached roster from another session — the namespace opens. Qualified ids make the tenant visible at every hop, so a mismatch is a visible 404 rather than an invisible cross-tenant read.

Reverting the composite id in the registry was refused for a second reason: it was a deliberate multi-tenancy change alongside `49f7713`, and undoing it to make two stale tests pass would trade a correctness property for a convenience.

**Decision record: `docs/DECISIONS.md` D-042.1–D-042.4**, shipped with this fix rather than after it. A record written later is a description, and a description cannot be reviewed against what it describes.

---

## On the !78 gate, which was honest

I implied the !78 gate was misreported. **That was wrong, and I am withdrawing it with the measurement that settles it:**

```
259931c (Merge main into epic/ui-command-center-core) IS an ancestor of 0573ea0
259931c is NOT an ancestor of 964032f   <- the !78 tip that was gated
d221f3d (composite ids)    is NOT an ancestor of 964032f
d221f3d                   IS an ancestor of 0573ea0
```

The gate ran on a tree without the composite-id change, was green, and was correct for what it ran. `main` went red when `259931c` brought `d221f3d` in, and no test moved with it.

**A green gate on a pre-merge tree is not a gate on what ships.** That was the CI argument in general terms; it is now evidence. It is also the sharpest possible argument for the runners you are about to enable: the pipeline must run on the **merged result**. A developer gate runs before the merge that breaks it, and with no runner, nothing ever runs after.

### Correction to my own record

I wrote that route commits "landed after !78's branch was cut" and cited `main` growing by "24 commits". The 24 was measured from the old local `main` (`0265121`); the relationship that mattered was the merge `259931c`. Both numbers were real and neither was about the same thing. **State the merge-base whenever a commit count is cited** — now a standing reporting rule.

---

## Gates

| Gate | Result |
|---|---|
| `test:mjs` | 22 / 22 pass / 0 fail |
| `test:ts` | **1549 tests / 1547 pass / 0 fail / 2 skipped** |
| `npm test` total | **1571 tests / 1569 pass / 0 fail / 2 skipped** |
| `platform/web/portal-mount.test.ts` | **18/18**, including two new contract tests |
| `typecheck` | clean |

## Not in this MR

The TASK 1 bootstrap work is on `chore/bootstrap-door` and will be rebased onto this branch once it lands — **not stacked before it.** A branch cut from a red base is how the !77/!78 coupling happened.