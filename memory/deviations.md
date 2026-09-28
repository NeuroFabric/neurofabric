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

