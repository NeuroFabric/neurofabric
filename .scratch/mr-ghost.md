## What changes

`start-ui.mjs` referenced `WEDGE_PORT` at line 48 **with no import and no definition**. The comment directly above it claimed the number was imported and that this file held no copy of it. The import was never added.

```
$ env -u PORT -u WEDGE_PORT node --experimental-strip-types start-ui.mjs --help
WEDGE_PORT is not defined
```

`--port` cannot bypass it: argv parsing (line 54) runs *after* the options object is evaluated.

**This MR is the fix plus the mechanism**, because the fix alone leaves the class of bug untouched:

1. `start-ui.mjs` — the import, from `scripts/dev-endpoints.ts`, the module that owns the number.
2. **`tsconfig.entries.json`** *(new)* — `checkJs` over `start-ui.mjs`, wired into `npm run typecheck`.
3. **`platform/core/entry-contract.test.ts`** *(new)* — the stripped-environment contract.
4. A second real defect found and fixed on the gate's first run (below).

## How to verify

**Acceptance — bare shell, empty environment:**

```
env -u PORT -u WEDGE_PORT node --experimental-strip-types start-ui.mjs --help
```

```
Usage: node --experimental-strip-types start-ui.mjs [workspace] [--workspace DIR] [--port N] [--host H]
  workspace   directory the tool may read CSVs from and write reports into
              (default: ./ui-workspace)
  --port N    port to bind (default: 8080, or $PORT). 8080 is the declared
```

**The gate, proven — not promised.** Delete the import, re-run the gate:

```
$ npx tsc -p tsconfig.entries.json
start-ui.mjs(53,64): error TS2304: Cannot find name 'WEDGE_PORT'.
```

**Full gates — pasted:**

```
npm run typecheck
  tsc --noEmit && tsc -p tsconfig.entries.json
  (no output — clean)

npm test
# tests 22   pass 22   fail 0   skipped 0     <- test:mjs
# tests 1558 pass 1556 fail 0   skipped 2     <- test:ts

node --experimental-strip-types --test platform/core/entry-contract.test.ts
# tests 4  pass 4  fail 0
```

## Why nothing caught it, and what stops it recurring

The root `tsconfig.json` includes `platform/**/*.ts`, `.pi/extensions/*.ts` and `scripts/**/*.ts`. **`start-ui.mjs` is a root plain-`.mjs` file and was never in anyone's view.** The bug was statically visible for its entire life.

`tsconfig.entries.json` is `checkJs` over the entry scripts using the **typescript already installed** — the kernel's type gate binary, different flags. **No new dependency**, so the ADR condition ("if it adds a dependency") does not trigger. `noImplicitAny` is deliberately off: these files are plain JavaScript with no annotations, and demanding them would produce noise that buries the one error that matters.

`entry-contract.test.ts` adopts the standing rule — **the environment that verifies must not be the environment that flatters.** It spawns the entry script with `PORT`, `WEDGE_PORT`, `WEDGE_URL`, `WEDGE_HOST` and `WEDGE_GATEWAY_TOKEN` stripped, and accepts **any legitimate outcome**: binds, the friendly in-use message, or the usage banner. Only a `ReferenceError`, a `SyntaxError`, or an undeclared-identifier death fails. One test asserts the gate is actually wired into `npm run typecheck`, because a config nobody runs proves nothing.

## The second defect, found on the gate's first run

```
start-ui.mjs(100,20): error TS18046: 'error' is of type 'unknown'.
```

`error.message` on an un-narrowed catch binding. It happened to be an `Error` every time, which is why it shipped — on a string it prints `undefined` rather than throwing, so it fails **quietly and only on the rare path**. Fixed, the same day, for the same reason: nothing was looking at a plain-JavaScript file.

## What could break

- **`npm run typecheck` now runs `tsc` twice.** It is a separate project with `include: ["start-ui.mjs"]`, so it is fast, but it is a second process. If it ever becomes slow, the fix is to narrow what it pulls in transitively — not to drop the gate, which would restore the blindness.
- **`start-ui.mjs` is now type-checked and had two errors.** Any future edit to it can fail the gate. **That is the entire point**, and it is a real behavioural change to the development loop: an entry script that used to be free to be wrong now costs a fix.
- **The stripped-environment test spawns a child process** on every run. It uses `--help`, which exits before binding, so it leaves no socket and no timer — and the assertion requires the usage text, so a script that dies early cannot pass silently.
- **This makes the kernel's dependency claim stronger, not weaker.** No manifest `dependencies` field was added; `typescript` was already there as the kernel's static gate.

## CI status

Not verified by CI, and not blocked by it in a way I can fix — see `main`'s `test-ts` below. Local receipts are the gate for this MR.

| Job | Status | Evidence |
|---|---|---|
| typecheck | success | — |
| test-mjs | success | 22/22 |
| test-proof | success | — |
| test-ts | failed | 1535 tests, **0 fail** — then the POSIX vault gate refused on win32 |
| measure-wrappers | skipped | correct — POSIX-only |
| *-windows (×3) | manual | not triggered |

**Note for the reviewer:** once this merges, `npm run typecheck` on the runner will run the entries project too. That is the intended first appearance of the gate in CI.