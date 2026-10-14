## What changes

**The fifth coat of the port-conflict fix, and the first one in the kernel.**

Every session in this project's history has lost time to `EADDRINUSE`. What it
produces is a code for a situation rather than a description of it — it does not
say **which** process holds the port, so the reader goes and finds out.

- **`platform/core/port-probe.ts`** *(new)* — `inspectPort`, `isPortFree`,
  `describePort`. **Reports. Never stops anything.**
- **`start-ui.mjs`** — checks the port *before* binding, and refuses to start with
  a report rather than an `EADDRINUSE`.
- **`platform/core/port-probe.test.ts`** *(new)* — 5 tests.

**It lives in the kernel, at the bind site, on purpose.** `start-ui.mjs` is what
actually calls `bind`. A check in a dev script is advice; a check here is the last
moment the answer is still cheap, and every route into the wedge passes through
it. The dev-boot script reports a stale listener too — but with `netstat` and
`tasklist` shelling out, which is a process spawn in a boot path and a
Windows-only implementation.

## How to verify

**Receipts — pasted.**

```
npm run typecheck
  (no output — clean)

npm test
# tests 22   pass 22   fail 0   skipped 0      <- test:mjs
# tests 1540 pass 1538 fail 0   skipped 2      <- test:ts

node --experimental-strip-types --test platform/core/port-probe.test.ts
# tests 5  pass 5  fail 0
```

**The behaviour, captured end to end on a port this session held:**

```
$ node --experimental-strip-types start-ui.mjs --port 8097

  port 8097 on 127.0.0.1 is already in use by PID 1488 (node.exe).

  Nothing has been stopped. If that process is yours and you no longer want it,
  end it deliberately -- and note that it may be holding a workspace in use.

  To see it yourself:
    Get-NetTCPConnection -LocalPort 8097 -State Listen |

  This process has not started, and nothing has been stopped.
  When you have decided what to do about the process above, either
  start it here and re-run, or use another port:
    node --experimental-strip-types start-ui.mjs --port 8098
```

**A PID, the name, the command to look with, and an alternative port.** That is
the whole difference between a code and a description.

## What could break

- **`start-ui.mjs` now refuses to start on a busy port where it previously
  started and then failed later.** That is the intended semantic change, and it is
  the useful one — but a workflow that relied on the wedge starting and
  reporting asynchronously will now exit(2) immediately instead.
- **Nothing is ever terminated.** There is no code path in `port-probe.ts` that
  signals a process, and `port-probe.test.ts` states that absence explicitly
  rather than leaving it as an assumption — "it does not kill things" is exactly
  the kind of claim that quietly stops being true when nobody checks.
- **`isPortFree` binds port 0 and releases it**, so there is a brief moment where
  the OS has handed out a port this process does not hold. That is the standard
  probe and it is safe; it is worth knowing if anyone ever runs this in a tight
  loop under a port-exhausting workload.
- **A TOCTOU window remains.** The port is free when checked and could be taken
  before `bind`. The check makes the common failure legible; it does not make the
  race impossible, and it is not claimed to. The bind error is still there as the
  backstop.
- **`netstat` / `tasklist` / `lsof` are shelled out.** On a host without them, a
  busy port is reported `unidentified` — which is **not** the same as reporting
  no process. "We do not know" and "there is nothing" are different answers, and
  the second would be a lie.
- **`platform/core/` is now reachable from `start-ui.mjs`.** The kernel stays at
  zero runtime dependencies; this adds `node:net`, `node:child_process`, both
  built-ins. No manifest change.

## CI status

**Not verified by CI.** `main`'s `test-ts` currently fails on
`assert-posix-vault-permissions.mjs`, which correctly refuses to run on win32 —
a POSIX-only gate run unconditionally by `.gitlab-ci.yml`. That is outside my
authority and is logged as an operator blocker. Local receipts above are the gate
for this MR.

| Job | Status | Evidence |
|---|---|---|
| typecheck | success | — |
| test-mjs | success | 22/22 |
| test-proof | success | — |
| **test-ts** | **failed** | 1535 tests, 1533 pass, **0 fail** — then the POSIX vault gate refused on win32 |
| measure-wrappers | skipped | correct — POSIX-only |
| *-windows (×3) | manual | not triggered |