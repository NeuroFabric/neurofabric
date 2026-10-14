## What this records

TASK 0 of the current brief. Three records in `docs/handoff.md`, none of which a future session should have to rediscover.

**1. !78, recorded.** Squash SHA `0573ea02f74cc0b97fc192dc8913f880033d997b` on `main`, fetched via `glab api .../merge_requests/78` and confirmed present on `origin/main`. With the six portal route statuses, the verdict body, and the gate counts. This is the D-024 bar met: recorded, not drafted.

**2. The operator session note**, verbatim. The first end-to-end live proof: 20,000 events accepted at 37,313 events/sec through the real dev proxy into a populated UI, 51x `GET /api/portal/live` all 200 with zero console errors.

**3. Governance.** CEO agent owns backlog, MR sequencing, decision records, honest reporting. Operator owns merges, credential files, approvals. Advisor owns strategy. No party sponsors, decides and self-certifies the same change.

---

## Two facts recorded so they are not re-learned the hard way

**`--token=<value>` is the only accepted form.** The space form silently fails to bind, and the guard then fires on the value instead — which presents as a policy violation rather than a syntax error.

**`generate-synthetic-data.ts` still defaults `--url` to `http://127.0.0.1:3000`.** The !77 3000→8080 migration swept the README, `vite.config.ts` and `start-ui.mjs` and missed the flood generator. The flood refused with "fetch failed" against a dead port **while the wedge ran healthy on 8080**. That is TASK 1 of the current brief.

## And one thing recorded so nobody "fixes" it

Throughput read 0 events/sec after the flood completed while records held at 20,000. **That is the count-versus-rate house rule rendering itself, not a defect.** `records` is a count; a rate is zero once no new records arrive in the window. Making the rate agree with the count would make a measurement agree with a number it was never derived from.

## The standing flag

!77 shipped a red suite and reported itself green — `routes.routes.length === 4` went stale in `9be7b6c`, and the description's "1461 pass" figure counted it as passing while it was failing. The count was never taken from a red run, because this project has no CI runner. Recorded as priority work when runners are enabled: **a never-run pipeline's first failure is expected, and each fix converts an enterprise claim into evidence.**

## The credential-file guard, recorded as a feature

This MR also records that the guard refusing agent writes to credential files is the control working, not a limitation to route around. During !78 the agent was denied by both the write tool and the shell. The correct response was to document the manual step and hand it to the operator — which `frontend/README.md` now does. Without that in the repository, the next session is invited to find a path around it.

## Gates

Documentation only. No code touched, so neither gate is affected by this commit; both were green at `0573ea0` and are re-run before the next MR.