## What changes

Adds `docs/demo-runbook.md`. Docs-only; no code, no gates affected.

Written for **the person running the demo**, not the audience — and deliberately
organised failure-first. A demo is judged on the thirty seconds after something
breaks, because that is the part nobody rehearses. Each failure in the playbook
carries something **true** to say, because the worst outcome in a demo is not a
failure; it is a failure the person on stage cannot talk about.

## How to verify

Read it against the product that exists **today**:

```
type docs\demo-runbook.md
```

Then check every claim it makes is true of `main`:

| Claim in the runbook | How to check |
|---|---|
| The wedge prints `The wedge is up.` | `npm run dev` |
| vite prints `ready in ... ms` | `cd frontend; npm run dev` |
| The empty state reads as empty, not zero | open 5173 with no traffic |
| The flood prints `MEASURED (not claimed)` and `provider check` | run the flood command |
| A refusal shows the prompt naming which of the two problems it is | type a wrong credential |
| `fetch failed against <url>` names the address | point the flood at a dead port |

**The runbook deliberately does not describe severity styling, the pulse
indicator, or a live credential banner.** Those are on the P1 backlog and do not
exist. Inventing them in a runbook would leave someone on stage describing a
product they cannot show, which is the specific failure this document exists to
prevent. Those beats are marked as future work in the backlog, not promised here.

## What could break

- **The equals-form caveat.** The runbook says `--flag=value` is the working form,
  because `main`'s parser splits on `=`. When `chore/bootstrap-door` merges this
  becomes wrong and **should be corrected in that MR**. Flagged rather than left.
- **Ports.** 8080 and 5173. If either moves, this and `scripts/dev-endpoints.ts`
  move together.
- **The failure playbook goes stale silently.** A runbook that prescribes words
  ages badly. The "things to never say" table is the part most likely to need
  review, and it needs it on every product change, not on a schedule.

## CI status

Docs-only. **The `main` pipeline is red for a reason outside this repository's
code**: `npm` is not on the Windows runner service's `PATH`, so every job fails
before any test executes. Operator-blocked; the fix is logged. This MR is verified
by reading and by the table above, not by CI.

| Job | Status | Evidence |
|---|---|---|
| typecheck | failed | `CommandNotFoundException` — never ran |
| test-mjs | failed | same |
| test-ts | failed | same |
| test-proof | failed | same |
| measure-wrappers | skipped | correct — POSIX-only, no Linux runner |
| typecheck-windows / test-mjs-windows / test-ts-windows | manual | not triggered |