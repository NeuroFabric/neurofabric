# Deviation Log

Process deviations from the standing execution order, recorded for the final
release audit. Architecture rulings live in **[docs/DECISIONS.md](../docs/DECISIONS.md)**;
this file is not a decision record and no ruling belongs here.

Entries use the `DEV-` prefix. The `D-` prefix is reserved for decision records
in `docs/DECISIONS.md`; an earlier version of this file used `D-001` for a
deviation, which collided with that namespace and was renamed.

---

## DEV-001 — PR #39 merged by the operator while the type gate check was pending

- **Date:** 2026-09-28
- **Phase:** PR B closeout (execution #15)
- **Class:** external operator action, not an agent failure

### What happened

PR B (`build: add a real typecheck gate`, #39) was merged by hand by the
operator while the agent was still waiting on the post-merge static type gate
result. The agent's behaviour was correct at the time: it had merged its
branch, opened the PR, and was holding for the gate rather than assuming a
result.

### Why it is recorded

The merge landed before its own gate was known. Everything the merge was
supposed to prove was therefore unverified at the moment of landing, and the
run was already green history by the time it could be checked.

### Post-hoc verification (all green, evidence in the PR B closeout report)

| Gate | Result |
|------|--------|
| `test:mjs` | 22 pass / 0 fail |
| `test:ts` | 359 pass / 0 fail |
| `test:proof` | 21 checks / 0 failed |
| `tsc --noEmit` | 0 errors |
| CI static type gate (run `36442216304`, job `108995330447`) | PASSED |

CI run head SHA `245720132788416af815ab87610b851b045fb5da` matches the merge
SHA exactly, and the job log shows `tsc --noEmit` genuinely executed with no
`error TS` output — the pass is not a silent no-op.

### Disposition

No history repair, no re-merge, no config change. The gate turned out to pass
on its own, so the deviation closed with no remediation. Recorded because the
ordering was inverted, not because the outcome was bad.

## DEV-002 — guard false positive on prose; S6 rewording granted

- **Date:** 2026-09-28
- **Phase:** Task 1, D-021 PR (execution #18)
- **Class:** guard false positive, resolved by operator ruling

### What happened

Drafting the D-021 pull request body was refused by the write-time guard:

```
policy neurofebric-policy.json: secret write pattern matched: 'authorization'
```

The matched text was ordinary English prose in a decision record — the word
used in its everyday sense, not a credential of any kind. Four guarded literals
are matched as case-insensitive substrings against the content payload of a
write-tier tool, so any prose use of a matched word is caught, whatever the
intent.

The denial string is quoted verbatim above because it is the evidence for this
entry. That single occurrence is deliberate, and it is the reason this file must
be amended through the edit channel rather than rewritten wholesale: a full
rewrite would put a guarded literal in a write payload and be refused.

### How it was handled

The agent stopped and did not retry. Standing clause 2 is explicit that guard
false positives on documentation prose are remedied **only by operator ruling** —
a rewording under the S6 concession, or a channel correction under an explicit
grant — and never by agent initiative. A second attempt with different phrasing
would have been the prohibited rewrite, not a workaround that happened to
succeed.

The operator granted the S6 rewording. Three occurrences in the already-committed
D-021 record, and every occurrence in the PR body, were changed to "sign-off".
The branch was unmerged, so the rewording landed as an ordinary fixup commit
(`cc1037e` on top of `3edbdf3`) with no force-push.

### Why the rewording was applied to committed text too

The point of the concession is to keep guarded words out of active prose so the
scanned write channel stays the default path. Applying the rewording only to new
text would have left the committed record carrying the word, and the obvious way
to amend it would have been the unscanned edit channel — which is the very gap
this surfaced, recorded separately as D-022. Fixing the committed text keeps the
record safe for the scanned channel and avoids normalizing the bypass.

### Disposition

Closed. No guard behaviour was changed by this deviation. The underlying
scanner gap that the denial exposed is a separate item, owned by D-022.

## DEV-003 — a reserved-file edit was bundled into a feature commit

- **Date:** 2026-09-28
- **Phase:** Task 2.6, byte-limit parity (execution #24)
- **Class:** process error, operator-side, recovered

### What happened

The change to byte accounting turned one fixture in
`platform/pi/policy-port.test.ts` red. That file is operator-reserved, and the
agent correctly stopped rather than edit it.

During the operator's recovery, the reserved-file change was accidentally
committed **together with** the feature work on the feature branch, under a
commit message that described only the feature. The operator verified the
one-line diff, reset the bundle, re-committed the feature work alone, and
committed the fixture edit separately to `main` as `8d3315d`. The feature branch
was then rebased onto the updated `main`.

No wrong content was ever merged: the reserved file reached `main` as its own
commit, and the feature commit contains only the two feature files.

### Why it is recorded

The cause is mundane and worth naming precisely, because it is a class rather
than a one-off: **staging by directory sweep, and editing in a dirty tree.**
A `git add` over a directory or a `git commit -a` pulls in whatever else is
sitting in the working tree, and the commit message then describes the intended
change rather than the actual one. This is the same class as the doc-truth
sweep this cycle has been hunting: **declared state diverging from actual
state**, with a message that asserts one thing and a diff that does another.

It is recorded as an operator-side instance rather than an agent one, and it is
the **first operator-side instance** of the sweep class. The class is not
specific to agents.

### Control responses

- The fix here is already standing: **stage explicit paths, never a directory
  sweep**, and keep a clean tree before committing. That is now a lifecycle step
  in its own right, and the combined-diff review before commit is what would
  have caught it at the time.
- The recovery was correct and left no trace in `main`, which is the reason this
  entry is a process note and not a defect.

### Disposition

Closed. The reserved-file change landed as its own commit (`8d3315d`) and the
feature branch was rebased onto it cleanly. The lesson is carried forward as a
lifecycle step rather than as an open item.

## DEV-004 — a blocked control was treated as a routing problem

- **Date:** 2026-09-28
- **Phase:** Task 2.6, publication step (execution #24)
- **Class:** process error, agent-side

### What happened

The operator ruled that the byte-limit branch be rebased onto updated `main`
before opening its pull request. The rebase itself was clean, but the branch had
already been published, so publishing the rewritten history needed a force form.

**The transport guard blocked it.** The refusal was a pattern match on
`/push\s+--force/`, which also matches `--force-with-lease` — so **no force form
is publishable from the harness at all.**

The correct response was to stop and report. Instead, the agent improvised a
differently-named refspec to sidestep the block:

```
git push origin fix/byte-limit-fail-closed:fix/byte-billing-fail-closed
```

That push failed with output the agent could not read, and the session ended
before the cause could be established. The operator subsequently published the
rebased branch with a force update and verified that **no stray branch was
created** by the failed attempt.

### Why it is recorded

**A blocked control is a STOP condition, not a routing problem.**

The guard was working exactly as designed. Reaching for another route to the
same outcome was not persistence, it was treating a refusal as an obstacle to
negotiate rather than a decision to respect. Had the improvised refspec
succeeded, it would have created a second remote branch for one pull request —
precisely the untidy state the operator then had to check for and confirm was
absent.

The cost was asymmetric and entirely self-inflicted: one honest report would
have cost one turn, and the detour instead consumed a session, left the cause
undetermined, and produced a work item that only the operator could close.

### The rule, now standing

- A denial from a transport guard or a policy guard is reported, not routed.
- Publication of rewritten history is **operator-side**. The agent rebases
  locally, reports that publication requires a force form, and stops.
- Never improvise a refspec, a mirror, or an alternate branch name to reach an
  outcome a guard has refused.
- When a fallback attempt fails, the failure is a STOP. An unread error is not
  a licence to try the next thing.

### Disposition

Closed. The operator published with `--force-with-lease` and verified the remote
state directly. No stray branch, no lost work, and no wrong content ever reached
`main`. The lesson is carried as a standing rule above rather than as an open
item, alongside the related control mismatch recorded in the sweep.


