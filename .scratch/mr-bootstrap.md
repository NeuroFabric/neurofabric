## What changes

One command starts the wedge **and** the Command Center with a credential the two
already agree on, and the flood parser accepts `--flag=value` *and* `--flag value`.

Root cause of every item here: **a live demo failed four times in one session,
and all four failures were in getting up.** The engine — ingestion, anomaly
evaluation, verdict — produced zero failures while a person typed commands.

1. **`scripts/flood-args.ts`** — the parser accepts both flag forms. Only
   `--flag=value` worked, and `--token value` bound the **empty string**, then
   reported a missing credential — on a command where one had plainly just been
   typed. The observable failure was the policy guard firing on a correctly-typed
   value. **A syntax mistake must never present as a policy violation**, because
   the operator's next move is to argue with the guard instead of fixing the
   command, and that argument is unwinnable.
2. **`scripts/dev-endpoints.ts`** — each port declared once. The generator still
   dialled 3000 while the wedge served on 8080, so a **healthy** server answered
   `fetch failed` against a dead port, and the symptom looked like an engine fault.
3. **`scripts/dev-boot.mjs`** — starts both sides with **one** credential.
4. **`docker-compose.yml`** — was publishing the wedge on 3000, so a container and
   a host-run wedge served the same app on different ports. That was a second
   copy the sweep found.
5. **`platform/web/deployment.test.ts`** — reads the published mapping out of the
   compose file and asserts **loopback**, instead of pinning `127.0.0.1:3000:3000`
   as a literal and failing on a *number* rather than a security property.
6. **Refusal and provider checks** in the flood — see below.

## How to verify

```
npm test
```

```
test:mjs  22 tests / 22 pass / 0 fail
test:ts   1549 tests / 1547 pass / 0 fail / 2 skipped
```

```
cd frontend
npm test && npm run typecheck
```
*(not affected — this MR touches no frontend file)*

**The acceptance test is behavioural, and it passed:**

```
one command up:      node --experimental-strip-types scripts/dev-boot.mjs
one command floods:  ... --flood --url=... --token <value> --provider pega --events 5000

  elapsed        0.23s
  accepted       5,000
  refused        0
  failed         0
  throughput     22124 events/sec
  provider check  pega, 5,000 records visible
```

Note the flags: that run used the **space form for every single flag**. Before
this change, the same command bound an empty credential.

**The other two behaviours, run and shown:**

```
# a dead port now names itself
first refusal: fetch failed against http://127.0.0.1:8097 - is the wedge
               running there? (TypeError: fetch failed)

# a provider mismatch is now visible instead of silently empty
PROVIDER MISMATCH
  pushed to     webhook
  server reports pega
  The events were ACCEPTED and are invisible on the dashboard.
```

**And a stale listener is reported, not stopped:**

```
-- port 8080 ---------------------------------------------------
  ALREADY IN USE by PID 3928 (node.exe).
  REPORTING ONLY. This script will not stop it.
```

## What could break

- **`scripts/dev-boot.mjs` generates a credential when none is supplied.** It is
  per-run, printed once, never written to disk, and handed to two child processes
  and nothing else. If `WEDGE_GATEWAY_TOKEN` is already set, that is used instead
  and nothing is generated. **No credential literal exists in this repository**,
  and the policy guard refusing credential-file writes remains the control.
- **`dev-boot.mjs` no longer uses `boot.mjs` by default.** `boot.mjs` assigns
  `NEUROFEBRIC_GATEWAY_TOKENS` unconditionally, so honouring it would provision
  the wedge with one value while the UI received another — two credentials, one
  session, and a UI that refuses everything. **This was not hypothetical: it
  happened on the first run of this tool.** `WEDGE_USE_BOOT_MJS=1` opts back in
  and *requires* a matching `WEDGE_GATEWAY_TOKEN` or it refuses to start.
  **Semantic change:** if your workflow depends on `dev-boot.mjs` picking up
  `boot.mjs`, you must now set that flag. This is the one behavioural change here
  worth reading twice.
- **`docker-compose.yml` now publishes 8080:8080.** Anyone running the container
  reaches it on **8080**, not 3000. This is the intended alignment — one port
  everywhere — but it is a deployment surface and it changes where an existing
  container answers.
- **`deployment.test.ts` is now port-agnostic.** It asserts loopback, not a
  number. A compose file can move ports and stay safe; what it cannot survive is
  losing `127.0.0.1:`. That is strictly a stronger test than the one it replaces.
- **`scripts/*.test.ts` is now in the root `test:ts` glob.** One more file for the
  root suite to load. It is 14 tests, no I/O, and it exits in well under a second.

## CI status

**Not verified by CI — it could not be.** The `main` pipeline now *executes*
(the operator's PATH fix landed) and three jobs pass, but `test-ts` fails on a
**separate, pre-existing** POSIX-only step discussed below. Local receipts above
are the gate for this MR.

| Job | Status | Evidence |
|---|---|---|
| typecheck | success | first-ever green run |
| test-mjs | success | 22/22 |
| test-proof | success | — |
| **test-ts** | **failed** | **1535 tests, 1533 pass, 0 fail, 2 skipped — then the POSIX vault-permission gate refused to run on win32.** The tests passed; a later step in the same job did not |
| measure-wrappers | skipped | correct — POSIX-only |
| *-windows (×3) | manual | not triggered |

**Not mine to fix.** `verification/assert-posix-vault-permissions.mjs` correctly
refuses to run on Windows — it exists to verify the Linux runner. The CI file runs
it unconditionally. Fixing that means editing `.gitlab-ci.yml`, which is outside
my authority, and it is the same class as `measure-wrappers`: **the gate is right
and the file is wrong.** Logged as a blocker for the operator.