/**
 * BOOT THE WEDGE. A local, read-only-by-default report tool with a dropzone.
 *
 * Run: node --experimental-strip-types start-ui.mjs
 * Or:   node --experimental-strip-types start-ui.mjs --workspace ./data --port 3000
 *
 * WHY A SCRIPT AND NOT A TEST. This file is never imported by the suite and
 * never runs in CI. It binds a port and then waits for a person, which is the
 * opposite of what a test does, and the earlier hang in this suite was caused
 * by a handle that outlived its test. A boot script that is only ever run by
 * hand cannot become the thing CI depends on, so it cannot be the next hang.
 *
 * THE WORKSPACE IS THE BOUNDARY, NOT A FOLDER OF CONVENIENCE. The Conductor's
 * boundary is rooted at the directory given here, so this is genuinely the only
 * place a file can be read from and the only place a report can be written.
 * Pointing it somewhere else changes what the tool is allowed to see, so the
 * default is a dedicated directory rather than the repository root.
 *
 * Drop a CSV into that directory and open the printed URL.
 */
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { startWedgeServer } from "./platform/web/server.ts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * Arguments, parsed by hand and defensively.
 *
 * `--workspace X` and `--port N`, plus positional forms, and the PORT
 * environment variable. An unparseable value is refused with the usage rather
 * than silently defaulting, because a UI that quietly opened the wrong
 * directory would be a UI reading the wrong files.
 */
function parseArgs(argv) {
  const options = { workspace: process.env.WEDGE_WORKSPACE ?? path.join(ROOT, "ui-workspace"), port: Number(process.env.PORT ?? 3000) };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace" || arg === "-w") options.workspace = argv[++i];
    else if (arg === "--port" || arg === "-p") options.port = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") return { help: true };
    else if (!arg.startsWith("-")) options.workspace = arg;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`that is not a port number: ${options.port}`);
  }
  if (options.workspace === undefined) throw new Error("no workspace given");
  return options;
}

function usage() {
  return [
    "Usage: node --experimental-strip-types start-ui.mjs [workspace] [--workspace DIR] [--port N]",
    "",
    "  workspace   directory the tool may read CSVs from and write reports into",
    "              (default: ./ui-workspace)",
    "  --port N    port to bind on 127.0.0.1 (default: 3000, or $PORT)",
  ].join("\n");
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`${error.message}\n\n${usage()}`);
  process.exit(2);
}
if (options.help) {
  console.log(usage());
  process.exit(0);
}

const cwd = path.resolve(options.workspace);
mkdirSync(cwd, { recursive: true });

// Port 0 asks the OS for a free one, which is what the tests do. Here the port
// is chosen explicitly because a person has to type the URL, so the trade is
// the other way: a known address beats an arbitrary one.
const server = await startWedgeServer({ cwd, port: options.port, installRoot: ROOT });

console.log("");
console.log("  The wedge is up.");
console.log("");
console.log(`    ${server.url.replace("127.0.0.1", "localhost")}`);
console.log("");
console.log(`    workspace  ${cwd}`);
console.log(`    the only place a file may be read from, and reports are written here.`);
console.log("");
console.log("    Drop a CSV into that directory, then open the URL above.");
console.log("    Ctrl-C to stop.");
console.log("");

/**
 * Shut down cleanly on Ctrl-C.
 *
 * A close that is not called leaves the listener bound, and the process then
 * sits there holding a socket open for a person who believes they stopped it.
 * This is the same failure the test suite had, in a different costume.
 */
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log("\n  Stopping.");
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}