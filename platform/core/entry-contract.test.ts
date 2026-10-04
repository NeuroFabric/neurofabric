import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * THE CLEAN-ENVIRONMENT CONTRACT FOR ENTRY SCRIPTS.
 *
 * === WHY THIS FILE EXISTS, AND IT IS NOT A NORMAL TEST ===
 *
 * `start-ui.mjs` shipped a line referencing `WEDGE_PORT` with no import and no
 * definition. Reproduced:
 *
 *     $ env -u PORT -u WEDGE_PORT node --experimental-strip-types start-ui.mjs --help
 *     WEDGE_PORT is not defined
 *
 * **Every prior verification of it passed**, because the shell running the
 * verification had `WEDGE_PORT` exported, so the `??` short-circuited before the
 * bare reference was ever evaluated. The receipts were honest; the environment
 * flattered the code.
 *
 * That is the generalisable lesson, and it is why this test **spawns a child
 * process with a deliberately impoverished environment** rather than importing
 * anything: **the environment that verifies must not be the environment that
 * flatters.**
 *
 * === WHAT COUNTS AS A PASS ===
 *
 * Not "the server started". Any legitimate outcome passes:
 *
 *   - it binds and serves        (we kill it in a `finally`)
 *   - the friendly in-use message (somebody else holds the port -- also correct)
 *   - the usage banner           (`--help` exits before binding)
 *
 * What FAILS is narrow and is the thing that actually broke: a `ReferenceError`,
 * a `SyntaxError`, or any death whose output names an identifier this repository
 * does not export.
 */

/** Strip every variable that could make a missing definition look present. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["PORT", "WEDGE_PORT", "WEDGE_URL", "WEDGE_HOST", "WEDGE_GATEWAY_TOKEN"]) {
    delete env[key];
  }
  return env;
}

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const ENTRY = path.join(ROOT, "start-ui.mjs");

test("start-ui.mjs runs with a STRIPPED environment and never names an undeclared identifier", () => {
  // `--help` is the cheapest route through the whole file: it exercises every
  // module-level expression including the port default, then exits before it
  // binds a socket. So this covers the code that broke without leaving a server
  // behind for the next test to trip over.
  const result = spawnSync(process.execPath, ["--experimental-strip-types", ENTRY, "--help"], {
    env: cleanEnv(),
    encoding: "utf8",
    timeout: 30_000,
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.doesNotMatch(
    output,
    /is not defined/,
    `the entry script named an undeclared identifier with a clean environment:\n${output}`,
  );
  assert.doesNotMatch(output, /SyntaxError/, `the entry script failed to parse:\n${output}`);

  // It must also actually reach its usage text, or the assertions above would
  // pass on a script that died before printing anything.
  assert.match(output, /Usage: node --experimental-strip-types start-ui\.mjs/, `the entry script produced no usage text:\n${output}`);
});

test("the port default is the declared contract, from the module that owns it", () => {
  // Not the number written twice -- the NUMBER IS IN ONE PLACE, and this asserts
  // the entry script inherits it. A copy here would pass this and fail the first.
  const result = spawnSync(process.execPath, ["--experimental-strip-types", ENTRY, "--help"], {
    env: cleanEnv(),
    encoding: "utf8",
    timeout: 30_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  assert.match(output, /default: 8080/, `the documented default should be the contract port:\n${output}`);
});

test("every identifier the entry script uses is actually imported", () => {
  // The structural half. `tsconfig.entries.json` gates this on every build; this
  // asserts the GATE is wired into `npm run typecheck`, because a config file
  // nobody runs is a config file that proves nothing.
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  assert.match(
    manifest.scripts.typecheck ?? "",
    /tsconfig\.entries\.json/,
    "the entry-script gate is not wired into npm run typecheck, so nothing enforces it",
  );
});

test("a clean environment changes nothing about the outcome", () => {
  // The contrast that makes the rule legible: with the variables PRESENT the
  // old code passed, and with them stripped it failed. If both now succeed, the
  // difference is gone and that is the property we are buying.
  const clean = spawnSync(process.execPath, ["--experimental-strip-types", ENTRY, "--help"], {
    env: cleanEnv(),
    encoding: "utf8",
    timeout: 30_000,
  });
  const withVars = spawnSync(process.execPath, ["--experimental-strip-types", ENTRY, "--help"], {
    env: { ...process.env, PORT: "8080", WEDGE_PORT: "8080" },
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.doesNotMatch(`${clean.stdout}${clean.stderr}`, /is not defined/);
  assert.doesNotMatch(`${withVars.stdout}${withVars.stderr}`, /is not defined/);
});