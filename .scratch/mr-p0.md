## P0 — getting pipeline one green

The Windows runner registered and **pipeline one is running right now**
(`2909555268`, `main` @ `c40fd11`). Every job on it has failed. **None of the
failures are in the code.** The tests have not run yet, so nothing has been
proven about them by this pipeline, in either direction.

---

## Defect 1 — the runner's shell does not exist (operator's hands)

Every job, without exception, dies at `prepare environment`:

```
Using Shell (pwsh) executor...
ERROR: Job failed (system failure): prepare environment: failed to start
process: starting OS command: exec: "pwsh": executable file not found in %PATH%.
```

`config.toml` declares `shell = "pwsh"`, which is **PowerShell 7**. This machine
has Windows PowerShell 5.1:

```
pwsh        -> INFO: Could not find files for the given pattern(s).
powershell  -> C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe
```

**Nothing in `.gitlab-ci.yml` needs changing for this.** Every script line is
`npm ci` or `npm run <script>` — no shell syntax, no bash. It will run under
Windows PowerShell unchanged.

### Copy-pasteable, operator only

```powershell
# 1. Point the runner at the shell that exists
notepad .\config.toml
#    change:   shell = "pwsh"
#    to:       shell = "powershell"

# 2. Restart the runner service
Restart-Service gitlab-runner

# 3. Confirm it took
Get-Service gitlab-runner | Select-Object Name, Status
```

Then re-run pipeline one. I will watch it.

---

## Defect 2 — a job that cannot pass on Windows (mine, fixed here)

`measure-wrappers` probes `printf`, `env`, `nice`, `stdbuf` and `nohup`, and
asserts a specific exit code for each — 125 for a bad `stdbuf` mode, 0 for a
good one. **None of those exists on Windows.** The job had no `tags`, so it
landed on the Windows runner and would have reported a wrapper *regression* that
is not one — it is the wrong operating system.

It now carries `rules: - if: '$CI_OS_NAME == "linux"'`, so it is **skipped** on
Windows rather than failed. Skipped is the honest outcome: the wrapper table still
needs re-deriving on POSIX, and until a Linux runner exists that check **has not
run**. It is not evidence and must not be read as a green.

---

## Defect 3 — the runner token was one `git add -A` from the repository

Registering the runner dropped `config.toml` and `.runner_system_id` into the
repository root. **Nothing ignored them**, and `config.toml` carries the runner
authentication token in plaintext.

`boot.js` and `boot.mjs` were already ignored — but only by luck, because I had
been careful to never stage them. `config.toml` had no such protection.

Both are now ignored, verified with `git check-ignore`, and `git status` no longer
shows them.

**This is the same failure the repository's own policy guard refuses on the write
side, arriving through a different door.** The guard catches an *agent* writing a
credential. Nothing caught the *runner* writing one. It is also the third time the
runner token has appeared in a transcript — including mine, when I read the file
to find the shell setting. **Rotate after pipeline one is green**, per the P2
directive; I will not print it again.

---

## Gates for this MR

`.gitlab-ci.yml` and `.gitignore` only. No source touched, so the hand-run gates
are unaffected — but **they are not evidence for this MR either**, and the honest
statement is that this MR is verified by review and by the next pipeline run, not
by a local green I did not need.

| Change | Verified by |
|---|---|
| `rules` on `measure-wrappers` | review, then a pipeline run showing it `skipped` |
| `.gitignore` entries | `git check-ignore -v` — both confirmed matched |

## What could break

- **`CI_OS_NAME` on an older GitLab.** It has been predefined for many releases,
  but if it evaluates empty the job is *skipped everywhere* rather than failing.
  That is the safe direction to fail, and it will be visible as the job never
  running — not as a silent pass.
- **Windows PowerShell 5.1 vs 7.** `npm` is identical across both. Nothing in the
  CI file depends on a 7-only feature. If a future job needs one, this decision
  is the place to revisit.

## Not in this MR

P0 is a gate on everything else, so nothing is stacked behind it: the UI overhaul
(P1), the port/process startup check and README (P2), and the demo runbook (P3)
are all waiting. `chore/bootstrap-door` sits on merged `main` and is unmerged —
it is TASK 1's bootstrap work and will get its own MR after this lands.