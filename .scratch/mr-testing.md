## What changes

`frontend/TESTING.md` *(new)* and four scratch patterns added to `.gitignore`.
Docs and ignore rules only — no code, no gates affected.

## How to verify

```
type frontend\TESTING.md
git check-ignore -v vitest-out.txt builds .scratch
```

## What could break

- **`.gitignore` now covers `vitest-*.txt` and `builds/`.** If either is ever
  meant to be a deliverable, this pattern will hide it. That is the intended
  trade — a debugging artefact nobody reads twice is not a deliverable — but it
  is a pattern, not a one-off, so a real artefact named `vitest-<something>` would
  be silently ignored.
- **Nothing here is enforced by a gate.** `frontend/TESTING.md` documents a
  convention; it does not make one. The convention is currently followed by
  convention.

## CI status

Not verified by CI, and not blocked by it — docs only. The `main` pipeline's
`test-ts` job fails on a POSIX-only vault gate run unconditionally on win32, which
is an operator blocker outside my authority. Local receipts for the code MRs are
in their own descriptions.

| Job | Status | Evidence |
|---|---|---|
| typecheck | success | — |
| test-mjs | success | 22/22 |
| test-proof | success | — |
| test-ts | failed | 1535 tests, 0 fail — then the POSIX vault gate refused on win32 |
| measure-wrappers | skipped | correct — POSIX-only |
| *-windows (×3) | manual | not triggered |