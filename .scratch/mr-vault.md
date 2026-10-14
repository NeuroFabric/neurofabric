## What changes

One file: `verification/assert-posix-vault-permissions.mjs`.

On `win32` it now **skips with exit 0 and says it proved nothing**, instead of calling `fail()` and exiting non-zero. The POSIX path is untouched.

## Why

The gate is run as the **last step of `test-ts`**, and it was overriding the outcome of a job that had just reported:

```
# tests 1535
# pass 1533
# fail 0
  $ node verification/assert-posix-vault-permissions.mjs
FAIL  this gate is POSIX-only; running it on win32 cannot prove anything.
```

**One POSIX step was making a job full of green tests read as red.** That is worse than the step not existing: it trains people to see red and not read it, which is the exact habit that hides a real failure.

## How to verify

```
node verification/assert-posix-vault-permissions.mjs
echo $?
```

```
SKIPPED (not verified) this gate is POSIX-only; running it on win32 cannot prove anything.
          It exists to verify the LINUX runner and must be run there.
          D-037 caveat two remains OPEN IN CONFIGURATION ONLY until a Linux
          runner executes this and the log is READ. Do not read a green
          test-ts as proof that secrets at rest are not world-readable.
exit=0
```

Full gates: `test:mjs` 22/22, `test:ts` 1558 tests / 1556 pass / 0 fail / 2 skipped, `typecheck` clean — all unchanged by this diff.

## What could break

- **The semantic claim: this is now a skip, not a failure.** That is the point and
  it is a real change. **Skipped is not green**, and the output is what makes the
  difference — a reader sees `SKIPPED (not verified)` in the job log, not a tick.
  Exiting 0 silently would have been the lie this repository keeps refusing to
  tell.
- **D-037 caveat two is still open.** This does not close it. The invariant
  "secrets at rest are not world-readable" is verified **only** when a Linux
  runner runs this and the log is read. The message says so, in the log, every
  time — because a caveat that is closed "in configuration only" is exactly the
  kind that gets cited as closed later.
- **The POSIX path is byte-for-byte unchanged.** It runs there, it asserts, and it
  fails for real if the invariant is violated. Nothing about the check itself is
  softened; only the reporting on a platform where it cannot be performed.
- **This will turn `test-ts` green on the Windows runner.** That is the intended
  effect, and it is also the risk: a green `test-ts` must not be read as "the
  vault invariant is verified". The message in the log is the guard against that.

## Why the script and not `.gitlab-ci.yml`

Moving the step into a separately-tagged Linux job is the tidier fix and it is
**not mine**: it edits CI, and a failing step *relocated* rather than *answered*
is closer to skipping than to fixing. The script is where the knowledge lives — it
is the script that knows it is POSIX-only — so the honest answer belongs there.

`measure-wrappers` has the same shape and already skips correctly. This one was
the outlier, and the fix is to make it consistent rather than to restructure CI
around it.

## CI status

| Job | Status | Evidence |
|---|---|---|
| typecheck | success | — |
| test-mjs | success | 22/22 |
| test-proof | success | — |
| test-ts | **red until this merges** | 1535 tests, 0 fail — then this step exited 1 on win32 |
| measure-wrappers | skipped | correct — POSIX-only |
| *-windows (×3) | manual | not triggered |

After this merges, `test-ts` on the Windows runner should go green. **That is not proof the POSIX gate passed. It is proof it did not run.**
