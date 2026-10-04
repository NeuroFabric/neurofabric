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
import { WEDGE_PORT } from "./scripts/dev-endpoints.ts";
import { describePort, inspectPort } from "./platform/core/port-probe.ts";

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
  const options = {
    workspace: process.env.WEDGE_WORKSPACE ?? path.join(ROOT, "ui-workspace"),
    // THE DEFAULT COMES FROM `scripts/dev-endpoints.ts`, THE SAME CONSTANT THE
    // FLOOD GENERATOR AND THE DEV PROXY USE.
    //
    // It was a literal `3000` here and `8080` in `frontend/vite.config.ts` for
    // the life of both files, which is how a flood ended up dialling a dead port
    // while this server was serving healthily on another. One number, one place,
    // imported -- not a second copy that can be wrong independently.
    port: Number(process.env.PORT ?? process.env.WEDGE_PORT ?? WEDGE_PORT),
    // LOOPBACK BY DEFAULT, and the default is the security property. The
    // container is the one case that needs a wider bind, and it is an explicit
    // opt-in rather than a default that happens to suit one deployment.
    host: process.env.WEDGE_HOST ?? "127.0.0.1",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace" || arg === "-w") options.workspace = argv[++i];
    else if (arg === "--port" || arg === "-p") options.port = Number(argv[++i]);
    else if (arg === "--host" || arg === "-H") options.host = argv[++i];
    else if (arg === "--help" || arg === "-h") return { help: true };
    else if (!arg.startsWith("-")) options.workspace = arg;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`that is not a port number: ${options.port}`);
  }
  if (options.workspace === undefined) throw new Error("no workspace given");
  if (typeof options.host !== "string" || options.host.trim() === "") {
    throw new Error(`that is not a host: ${JSON.stringify(options.host)}`);
  }
  return options;
}

function usage() {
  return [
    "Usage: node --experimental-strip-types start-ui.mjs [workspace] [--workspace DIR] [--port N] [--host H]",
    "",
    "  workspace   directory the tool may read CSVs from and write reports into",
    "              (default: ./ui-workspace)",
    "  --port N    port to bind (default: 8080, or $PORT). 8080 is the declared",
    "              wedge contract and is what the Command Center's dev proxy",
    "              targets; a different value needs the proxy changed to match.",
    "  --host H    interface to bind. DEFAULT 127.0.0.1, and the default is the",
    "              security property: this process reads your files, so a listener",
    "              on every interface turns a local tool into a remote one.",
    "              Pass 0.0.0.0 ONLY inside a container, where a loopback bind is",
    "              unreachable from the host -- see the Dockerfile and",
    "              docker-compose.yml, which publish to the host's loopback anyway.",
  ].join("\n");
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  // The catch binding is UNKNOWN unless narrowed. It happened to be an Error
  // every time, which is why this shipped -- `error.message` on a string prints
  // `undefined` rather than throwing. Found by `tsconfig.entries.json` on the
  // same day as the WEDGE_PORT ghost, and for the same reason: nothing was
  // looking at a plain-JavaScript file.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`${message}\n\n${usage()}`);
  process.exit(2);
}
if (options.help) {
  console.log(usage());
  process.exit(0);
}

const cwd = path.resolve(options.workspace);
mkdirSync(cwd, { recursive: true });

/**
 * THE PORT, BEFORE THE BIND.
 *
 * Every session in this project's history has lost time to `EADDRINUSE`, and
 * what it produces is a code for a situation rather than a description of it: it
 * does not say WHICH process holds the port, so the reader goes and finds out.
 *
 * The check lives here, at the bind site, rather than in a dev script because
 * `start-ui.mjs` is what actually calls `bind`. A check anywhere else is advice;
 * a check here is the last moment the answer is still cheap.
 *
 * IT REPORTS AND STOPS THIS PROCESS. It does not terminate anything: deciding
 * whether to end a process somebody else started is a person's decision, and a
 * tool that makes it silently will eventually make it wrongly.
 *
 * `port: 0` is skipped because an OS-assigned port cannot collide, so "is it in
 * use" is not a question about it.
 */
if (options.port !== 0) {
  const report = await inspectPort(options.port, options.host === "0.0.0.0" ? "0.0.0.0" : options.host);
  if (!report.free) {
    console.error(`\n  ${describePort(report)}\n`);
    console.error("  This process has not started, and nothing has been stopped.");
    console.error("  When you have decided what to do about the process above, either");
    console.error("  start it here and re-run, or use another port:");
    console.error(`    node --experimental-strip-types start-ui.mjs --port ${options.port + 1}\n`);
    process.exit(2);
  }
}

// Port 0 asks the OS for a free one, which is what the tests do. Here the port
// is chosen explicitly because a person has to type the URL, so the trade is
// the other way: a known address beats an arbitrary one.
const server = await startWedgeServer({ cwd, port: options.port, host: options.host, installRoot: ROOT });

// A widened bind is announced, not silent. The default prints a URL; the
// container prints a WARNING first, because the person reading the log may not
// know their network namespace is the only thing keeping this local.
if (options.host !== "127.0.0.1" && options.host !== "localhost") {
  console.warn("");
  console.warn(`  WARNING: bound to ${options.host}, not loopback.`);
  console.warn("  This process can read the files in the workspace, so it must not be");
  console.warn("  reachable from anywhere the container's network is. In the shipped");
  console.warn("  compose file the published port is bound to 127.0.0.1 for that reason.");
  console.warn("");
}

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