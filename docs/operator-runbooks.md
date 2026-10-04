# Operator runbooks — CI gates and runner config

Two things that can only be *executed* by the operator. I write the steps; you run
them. Nothing here touches CI settings, the runner, or a credential, because those
are yours.

---

# T10 — enable the Linux gate

## Why

Two gates are POSIX-only and both currently **fail or skip on Windows**, which
means neither has ever run:

| Gate | Where | Current state |
|---|---|---|
| `measure-wrappers` | re-derives the wrapper table (`printf`, `nice`, `stdbuf`, `nohup`) | **skipped** — honest, but not run |
| `assert-posix-vault-permissions` | proves "secrets at rest are not world-readable" | **FAILS on win32**, and it is right to |

That second one is the important one. `.gitlab-ci.yml` runs it unconditionally, so
`test-ts` is red on `main` **even though every test in it passed**:

```
# tests 1535
# pass 1533
# fail 0
# skipped 2
      $ node verification/assert-posix-vault-permissions.mjs
FAIL  this gate is POSIX-only; running it on win32 cannot prove anything.
      It exists to verify the Linux runner, and it must be run there.
```

**The gate is right and the file is wrong.** D-037 caveat two is closed *in
configuration only* until a Linux runner actually runs it, and per that caveat
itself: do not read a green merge as proof that invariant.

## What this needs, and what it must not become

Enabling GitLab.com **shared** Linux runners means your pipeline executes on
someone else's machine. Before you agree to that, know what it costs:

- **Your code is on a shared host.** The repository already refuses credential
  files in CI, so nothing sensitive is in the tree — but confirm that yourself
  rather than trusting the ignore rules.
- **Shared runners are free-tier and rate-limited.** A large `test-ts` may queue.
- **The vault-permission gate will start running for real**, and it may FAIL
  legitimately — for example if the runner's umask differs from yours. That is the
  gate doing its job, and it should be read, not worked around.

## Steps

**1. Enable shared runners for the project** (Settings → CI/CD → Runners →
**Enable shared runners**). Or via API:

```powershell
glab api -X PUT projects/neurofebric-group%2Fneurofebric \
  --field "shared_runners_enabled=true" -f "shared_runners_enabled=true"
```

**2. Confirm a Linux runner registered:**

```powershell
glab api projects/neurofebric-group%2Fneurofebric/runners
```

You want a second entry alongside `local-windows-operator`, described something
like `gitlab-hosted` or `shared-...`.

**3. Tag the POSIX jobs.** This is the part that is a judgement, not a step. My
recommendation, and the reasoning:

- Add `tags: [linux]` to **`measure-wrappers`**, replacing the `$CI_OS_NAME`
  guard. The guard is honest but it means the job *never runs*, and a job that
  never runs is indistinguishable from a job that passes.
- Split `assert-posix-vault-permissions` out of `test-ts` into its own job with
  `tags: [linux]`, so the tests and the POSIX assertion stop sharing an
  outcome. Right now one POSIX step fails a job full of green tests, which trains
  people to ignore the job's status.

**Why I am not making that change myself:** it edits `.gitlab-ci.yml`, and the
structural limits on me are explicit that I do not touch CI settings or skip
jobs. Moving a failing step into a separate Linux-tagged job could be read as
"skipping" it — it is not, but that call is yours and should be made by you.

**4. Re-run the pipeline and READ the log.** The point of the gate is the log.
A green `measure-wrappers` that nobody opened is the same as the skip it replaced.

---

# T11 — relocate the runner config out of the repository

## Why

Registering the runner dropped `config.toml` and `.runner_system_id` into the
**repository root**, and `config.toml` carries the runner authentication token in
plaintext.

They are now gitignored, which closes the *repository* exposure. This closes the
*structural* one: a credential file inside a working tree is one `git add -f`,
one `git clean -xdf`, or one IDE "add all" away from being committed, and the
ignore rule is a convention where a path outside the tree is a boundary.

## Steps

**1. Stop the service.**

```powershell
Stop-Service gitlab-runner
```

**2. Install against a config outside the repository.**

```powershell
# Anywhere that is NOT a git working tree. A per-user config directory is fine.
$cfg = "$env:LOCALAPPDATA\gitlab-runner\config.toml"
New-Item -ItemType Directory -Force -Path (Split-Path $cfg) | Out-Null

cd <repo root>
& "$env:ProgramFiles\GitLab Runner\gitlab-runner.exe" uninstall
& "$env:ProgramFiles\GitLab Runner\gitlab-runner.exe" register --config $cfg
```

**3. Edit the new config** — `notepad $cfg` — and set:

```toml
shell = "powershell"
```

**PowerShell 7 (`pwsh`) is not installed on this machine.** The first pipeline
failed on every job with:

```
exec: "pwsh": executable file not found in %PATH%
```

**4. Restart and verify.**

```powershell
Start-Service gitlab-runner
Get-Service gitlab-runner | Select-Object Name, Status
```

**5. Remove the repository-root remnants — YOU do this, not me.**

```powershell
# Confirm what is there first. Read the names; do not paste the contents anywhere.
Get-ChildItem .\config.toml, .\.runner_system_id -ErrorAction SilentlyContinue |
  Select-Object Name, Length

# Then remove them.
Remove-Item .\config.toml, .\.runner_system_id -ErrorAction SilentlyContinue
```

**6. Confirm the tree is clean:**

```powershell
git status --short
```

Both paths are gitignored, so they should not appear. If they do, the ignore rule
has not landed — **check that MR merged before trusting it.**

## Verify it worked

Start a pipeline. Every job should report `Running with gitlab-runner ... using
config <path outside the repo>` and none should fail with `pwsh ... not found`.

## Then rotate the runner token

T11 is what makes this the right moment. The token has been in this transcript
**four times** — and one of those was me, reading `config.toml` to find the shell
setting, which printed it. That was careless and I own it. Re-registering on a new
config path issues a fresh token, and the old one dies with the old config.

**Rotation is yours.** I will not touch it.