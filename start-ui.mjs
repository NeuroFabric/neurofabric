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
import { mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { startWedgeServer } from "./platform/web/server.ts";
import { MemoryStore, MINIMUM_NODE } from "./platform/memory/store.ts";
import { environmentVault, loadTokens } from "./platform/omniroute/edge-security.ts";
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
    /**
     * THE DURABLE RECORD IS ON BY DEFAULT.
     *
     * A flag rather than an environment variable, because this is a decision
     * about whether history exists, and an operator should make it by typing
     * something they can read in `--help`.
     */
    record: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace" || arg === "-w") options.workspace = argv[++i];
    else if (arg === "--port" || arg === "-p") options.port = Number(argv[++i]);
    else if (arg === "--host" || arg === "-H") options.host = argv[++i];
    else if (arg === "--no-record") options.record = false;
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
    "  --no-record  boot WITHOUT the durable record.",
    "",
    "              The default is that the record is opened. A missing file is a",
    "              FIRST RUN and not an error (ADR-005 §2), so the honest default",
    "              is to create it and say so plainly. This flag is for the case",
    "              where you already know: a throwaway workspace, or an inspection",
    "              you do not want written to.",
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
 * THE DURABLE RECORD, OPENED BEFORE THE SERVER BINDS.
 *
 * The order is the argument. A server that binds first and then fails to open its
 * record is a process that answered a request it cannot honour, and the operator
 * finds out from a broken page rather than from the terminal they are watching.
 * So the store is opened, migrated and read BEFORE `listen`, and if it cannot be
 * opened this process says why and stops having bound nothing.
 *
 * IT LIVES INSIDE THE SAME CONTAINMENT AS EVERY OTHER WRITE. `<cwd>/workspace/memory`
 * sits beside the session store rather than in a home directory or a temp folder,
 * so "the only place a file may be written" keeps meaning exactly one place --
 * and pointing `--workspace` elsewhere moves the record with everything else
 * instead of stranding the history behind.
 */
const recordDirectory = path.join(cwd, "workspace", "memory");
const recordFile = path.join(recordDirectory, "neurofebric.sqlite");

/** Decided BEFORE opening, so the boot lines can tell a first run from a restart. */
const firstRun = !existsSync(recordFile);

/**
 * OPEN THE RECORD, OR EXPLAIN WHY IT DID NOT OPEN.
 *
 * `MemoryStore.open` already refuses with a clear message on a Node too old for
 * `node:sqlite` (ADR-005 §4). This wrapper adds the one thing the store cannot
 * decide: what the operator should do instead. Silently continuing without a
 * record would be the worst available outcome -- the wedge still renders a
 * perfectly normal screen that quietly forgets everything, which is the exact
 * failure the record was built to refuse, reintroduced at the last possible step.
 */
function openRecord() {
  if (!options.record) {
    console.log("");
    console.log("  Durable record: OFF (--no-record). Nothing is kept, and nothing is compared.");
    console.log("");
    return null;
  }
  try {
    return MemoryStore.open({ directory: recordDirectory });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("");
    console.error("  The durable record could not be opened, and this process has not started.");
    console.error(`    ${message}`);
    console.error("");
    console.error("  Nothing has been bound and nothing has been written. Two ways forward:");
    console.error("    node --experimental-strip-types start-ui.mjs --no-record");
    console.error("      boots without history. Nothing is compared and nothing is kept --");
    console.error("      which is a different product, so it is a thing you choose.");
    console.error("    node --version");
    console.error(`      ${MINIMUM_NODE} or newer is required for node:sqlite.`);
    console.error("");
    process.exit(2);
  }
}

const record = openRecord();

/**
 * THE TENANT A BREACH BELONGS TO, OR NOTHING.
 *
 * The record's namespace is `tokenId` (ADR-005 §10.1) -- the credential's ID,
 * not its value, so rotating a credential changes nothing. That makes the vault
 * the ONLY thing in this process that knows a tenant, which is why the decision
 * to assign one is made here and printed here rather than inside the server
 * factory.
 *
 * **EXACTLY ONE PROVISIONED TENANT, OR NONE.** This is the case where a choice
 * would be a fabrication: with two tenants provisioned, picking one attributes a
 * breach to whichever happened to be listed first, and writes another customer's
 * audit trail under their name. The two rejected alternatives are recorded so the
 * refusal is legible:
 *
 *  - a sentinel tenant such as `"local"` -- rows no credential can ever
 *    authenticate as, so invisible to every read, forever;
 *  - the first of several -- the same misattribution with extra steps.
 *
 * So: one tenant, resolved. Several, or a vault that cannot be read, resolved to
 * nothing -- and the wedge still serves reports, with the decision path silent
 * and SAYING SO.
 */
const provisioned = await (async () => {
  try {
    return await loadTokens(environmentVault());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("");
    console.error("  The credential vault could not be read:");
    console.error(`    ${message}`);
    console.error("  The wedge will still serve reports, and nothing will be recorded.");
    console.error("");
    return [];
  }
})();

const liveTenant = provisioned.length === 1 ? provisioned[0]?.id : undefined;

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
const server = await startWedgeServer({
  cwd,
  port: options.port,
  host: options.host,
  installRoot: ROOT,
  // OMITTED ENTIRELY when there is no record, rather than passed as a null the
  // server would have to check. With no store mounted the diff routes do not
  // exist and answer 404, so a caller cannot mistake "nothing is kept" for
  // "everything agrees".
  ...(record === null ? {} : { memory: { store: record, ...(liveTenant === undefined ? {} : { tenant: liveTenant }) } }),
});

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

/**
 * THE RECORD, DESCRIBED IN WORDS, EVERY BOOT.
 *
 * The counts are tenant-independent facts about the file, which is why they can
 * be printed here at all: the tenant is proven by a credential this process does
 * not have, so the DIFF is answered per-credential at `/api/memory/diff` and
 * cannot honestly be summarised on this terminal. What can be said without a
 * credential is whether a record exists, what shape it is at, and how much is in
 * it -- so that is exactly what is said.
 *
 * **THE EXPERIMENTAL WARNING ABOVE THIS LINE IS NOT SUPPRESSED**, and it is named
 * here because a warning nobody can account for is a warning people learn to
 * ignore. `node:sqlite` is a Node built-in, so the record costs no npm
 * dependency and no lockfile line (ADR-005 §4) -- and it is flagged experimental
 * by Node itself. Hiding that would hide a real status from the operator, which is
 * the thing this platform is supposed to refuse.
 */
if (record !== null) {
  const schemas = record.version();
  console.log(`  Durable record: ${firstRun ? "FIRST RUN, created just now." : "opened."}`);
  console.log(`    ${recordFile}`);
  console.log(`    schema version ${schemas}. First run is not an error; a restart is a colleague coming back.`);
  console.log(`    The SQLite warning above is deliberate. node:sqlite is experimental, and we do not hide that.`);
  console.log(`    Where the record and this process disagree: GET /api/memory/diff, with your credential.`);
  if (liveTenant === undefined) {
    console.log("");
    console.log("    DECISIONS ARE NOT BEING RECORDED. " +
      (provisioned.length === 0
        ? "No credential is provisioned, so no tenant owns a breach and nothing is attributed to nobody."
        : `${provisioned.length} tenants are provisioned, so a breach cannot honestly be attributed to one of them.`));
    console.log("    Provision exactly one credential and restart, and this line will say what it resolved.");
  } else {
    console.log(`    Decisions are recorded under tenant "${liveTenant}", from the credential that proved it.`);
  }
  console.log("");
}

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
    /**
     * THE RECORD IS CLOSED BEFORE THE PROCESS EXITS.
     *
     * SQLite in WAL mode is safe against an abrupt exit -- that is what the
     * journal is for -- but "safe against a crash" is not "closed". Closing
     * checkpoints the WAL and releases the file handle, so the next boot opens a
     * record that is already compact rather than one that has to recover first.
     *
     * It is closed in a `finally` so a listener still attached cannot leave the
     * database open while the listener is torn down, which would be the same
     * class of bug as the timer this file's own header warns about: a handle that
     * outlived the thing that owned it.
     */
    const stop = () => {
      record?.close();
    };
    server.close().then(
      () => {
        stop();
        process.exit(0);
      },
      () => {
        stop();
        process.exit(1);
      },
    );
  });
}