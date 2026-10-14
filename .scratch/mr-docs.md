## What changes

Adds two documentation artefacts. **No code, no configuration, no gates affected.**

1. **`.gitlab/merge_request_templates/default.md`** — the MR template, plus a
   README explaining why each section is mandatory.
2. **`docs/adr/0001-minimalism-as-the-audit-trail.md`** — the thesis, recorded as
   an ADR: context, three options with their honest costs, the decision, the
   consequences including the expensive ones, and the failure mode it could
   itself become.

## How to verify

Docs-only. Read them and check they say what this description says:

```
type .gitlab\merge_request_templates\default.md
type docs\adr\0001-minimalism-as-the-audit-trail.md
```

**The functional test is the next merge request you open.** If GitLab renders the
four sections, the template is live. That is the only claim here that needs
evidence rather than reading.

## What could break

- **An existing open MR keeps its description.** Templates apply to new MRs only.
  Nothing in flight is rewritten.
- **The template does not change GitLab's permissions.** Assignee is documented
  in the README as the convention; it is not enforced by the template, because a
  template cannot enforce an assignee. If you want it enforced, that is a
  project-setting change on your side.
- **ADR numbering.** This is `0001` in a new `docs/adr/` directory while the
  existing decision log lives in `docs/DECISIONS.md` as `D-0nn`. That is two
  sequences, deliberately: DECISIONS.md is a running log with hundreds of
  entries and this is a numbered record of durable architectural positions. If
  you would rather have one sequence, that is a call for you and I will not
  renumber a log on my own initiative.

## CI status

Docs-only; no gate is affected. **The pipeline on `main` is currently red for a
reason outside this repository's code** — `npm` is not on the Windows runner
service's `PATH`, so every job fails before any test executes. That is an
operator-environment block, logged with the exact fix. Do not read this MR as
verified by CI: it is verified by reading.

| Job | Status | Evidence |
|---|---|---|
| typecheck | failed | `CommandNotFoundException: npm` — job never ran tests |
| test-mjs | failed | same |
| test-ts | failed | same |
| test-proof | failed | same |
| measure-wrappers | skipped | correct — POSIX-only, no Linux runner yet |
| typecheck-windows | manual | not triggered |
| test-mjs-windows | manual | not triggered |
| test-ts-windows | manual | not triggered |