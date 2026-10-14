## What changes

Rewrites the root `README.md` as a one-page onboarding document: what Neurofebric
is, how to run it, how to run the tests, what each CI gate means **and does not
mean**, and how credentials are handled and rotated.

Replaced rather than appended to. An onboarding page that is mostly history is an
onboarding page nobody finishes.

## How to verify

**The test is: can a new engineer boot this system from this page alone?** So run
the commands in it. Specifically, on a clean shell:

```powershell
npm run dev
# then, in a second shell, from the repository root:
node --experimental-strip-types scripts/generate-synthetic-data.ts --flood --url=http://127.0.0.1:8080 --token=<value>
```

I ran every command in this page before writing it, and **caught one of my own
claims being false in the process**: the quickstart originally said both
`--flag=value` and `--flag value` work. Running it proved the space form binds an
*empty* credential on `main`, because the parser splits each argument on `=`. The
page now states the equals form is the working one and explains that the other
presents as a policy-guard firing on a value you just typed — which is precisely
how it confused a live session.

The unreleased fix lives in `chore/bootstrap-door` and is not claimed here.

## What could break

- **No code is touched.** This cannot break the build.
- **The quickstart is accurate to `main` today.** When `chore/bootstrap-door`
  merges, the equals-form caveat becomes wrong. It should be removed **in that
  MR**, not left to rot — flagged here so it is not forgotten.
- **Ports.** 8080 for the wedge, 5173 for the UI. If either moves, this page and
  `scripts/dev-endpoints.ts` must move together — that is the drift class that
  cost four demo failures.
- **The credential guidance is a policy, not a recipe for a production
  deployment.** It describes the local development path. Anything that provisions
  a real tenant should read `docs/SECURITY.md`.

## CI status

Docs-only. **The `main` pipeline is red for a reason outside this repository's
code**: `npm` is not on the Windows runner service's `PATH`, so every job fails at
`prepare environment` and **no test has executed**. Operator-blocked, fix logged.
This MR is verified by reading and by running the commands, not by CI.

| Job | Status | Evidence |
|---|---|---|
| typecheck | failed | `CommandNotFoundException` — never ran |
| test-mjs | failed | same |
| test-ts | failed | same |
| test-proof | failed | same |
| measure-wrappers | skipped | correct — POSIX-only, no Linux runner |
| typecheck-windows / test-mjs-windows / test-ts-windows | manual | not triggered |