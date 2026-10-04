/**
 * THE DOOR. One command that starts everything the Command Center needs.
 *
 *   node --experimental-strip-types scripts/dev-boot.mjs
 *
 * or, equivalently, `npm run dev:boot` from the repository root.
 *
 * === WHY THIS FILE EXISTS ===
 *
 * A live demo failed four times in one session. Every one of those failures was
 * in getting UP, and none was in the engine: the ingestion path, the anomaly
 * evaluation and the verdict machinery produced zero failures while a person
 * typed a command. The four were --
 *
 *   1. `npm run` swallowed a flag before the script saw it.
 *   2. The parser accepted only `--token=value`; the space form silently bound an
 *      empty value and the policy guard fired on a correctly-typed credential.
 *   3. The operator had to open `boot.mjs` to learn what the credential was.
 *   4. The flood generator still dialled 3000 while the wedge served on 8080, so
 *      a healthy server answered "fetch failed" against a dead port.
 *
 * (1) and (3) are what this script removes. (2) is fixed in `scripts/flood-args.ts`
 * and (4) in `scripts/dev-endpoints.ts`; neither is this file's job, and both are
 * tested where they live.
 *
 * === THE CREDENTIAL, AND WHERE IT COMES FROM. THIS IS THE PART TO READ ===
 *
 * There are three sources, in precedence order, and **none of them is a literal
 * in this repository**:
 *
 *   1. `$WEDGE_GATEWAY_TOKEN` already set in the operator's environment. This is
 *      the operator's explicit act and it always wins.
 *   2. A per-run value GENERATED HERE, printed once, and never written to disk.
 *      Ephemeral by construction: it exists for this process, it is handed to two
 *      child processes and to nothing else, and it dies with the session.
 *   3. Nothing -- in which case this script says so and exits with the fix, rather
 *      than starting a wedge that would refuse everything.
 *
 * **On the value being "just a local placeholder".** It is a development
 * credential for a loopback process that admits one tenant, and the operator
 * creates it. But "not a secret" is a statement about THIS machine, not a licence
 * to put one in a file that ships. So: stated here, generated at runtime, never
 * written, never committed. The repository's policy guard refuses writes to
 * credential files, and that refusal is a control, not an obstacle -- see
 * `docs/handoff.md`, Governance.
 *
 * === WHAT IT DOES NOT DO, AND WHY ===
 *
 * **It never stops a process.** A stale listener on 8080 is REPORTED -- PID,
 * owning process, and how long it has held the port -- and this script then stops.
 * Deciding whether to end someone else's process is the operator's call, not a
 * side effect of booting. This file runs `netstat` and nothing that changes state.
 *
 * **No hazard commands.** Not `rm`, not `kill`, not `taskkill`, not a force
 * anything. A previous session of this work was terminated by a deletion guard,
 * and the correct response to that was to leave the file and write this header --
 * not to find a way around it.
 *
 * === WHY IT PRINTS THE FLOOD COMMAND RATHER THAN RUNNING IT ===
 *
 * A flood is a demo beat, not a boot step. Running one automatically would put
 * 20,000 synthetic events into a server the operator may be pointing at real
 * data. So the command is printed, complete, with the credential already filled
 * in, for them to press enter on.
 */
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WEDGE_PORT, WEDGE_URL, UI_PORT, UI_URL, DEFAULT_PROVIDER } from "./dev-endpoints.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

const heading = (text) => {
  console.log("");
  console.log(`-- ${text} ${"-".repeat(Math.max(0, 66 - text.length))}`);
};

/* ================================================================== */
/* STALE LISTENER -- REPORT ONLY                                      */
/* ================================================================== */

/**
 * Is anything already listening on the wedge port?
 *
 * **Reports, never acts.** Returns a description or undefined so the caller can
 * print it and stop. There is no code path in this file that terminates a
 * process, and adding one later would need to be argued for on its own merits.
 */
export function describeListener(port) {
  let output;
  try {
    output = execFileSync("netstat", ["-ano"], { encoding: "utf8", timeout: 5000 });
  } catch {
    return undefined; // netstat unavailable: say nothing rather than guess
  }
  const needle = `:${port}`;
  const lines = output
    .split("\n")
    .filter((line) => line.includes("LISTENING"))
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => {
      const local = parts[1] ?? "";
      return local.endsWith(needle);
    });
  if (lines.length === 0) return undefined;

  const first = lines[0];
  const pid = first[first.length - 1] ?? "?";
  return { pid, port, lines: lines.length };
}

/**
 * Best-effort process name for a PID.
 *
 * Purely cosmetic -- the PID is the thing an operator needs. A failure here is
 * swallowed rather than propagated, because "could not read a process name" must
 * not stop a boot.
 */
function processName(pid) {
  try {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", timeout: 5000 });
    // tasklist leads with CRLF even under /NH, so the FIRST line is empty. Taking
    // `[0]` blindly is how this reported an empty name for a process that exists.
    const first = out.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
    const name = first.trim().split(/\s{2,}/)[0] ?? "";
    return name === "" ? "unknown" : name;
  } catch {
    return "unknown";
  }
}

/* ================================================================== */
/* CREDENTIAL                                                         */
/* ================================================================== */

/**
 * The one value both sides receive.
 *
 * Generated from `randomBytes`, so two people booting at the same time on the
 * same machine get different credentials and neither can read the other's
 * sessions out of a shared port. Printed once, below, and never stored.
 */
function resolveCredential(env) {
  const supplied = env.WEDGE_GATEWAY_TOKEN;
  if (typeof supplied === "string" && supplied.trim() !== "") {
    return { value: supplied.trim(), generated: false };
  }
  return { value: `dev-${randomBytes(12).toString("hex")}`, generated: true };
}

/* ================================================================== */
/* BOOT                                                               */
/* ================================================================== */

const env = process.env;
const credential = resolveCredential(env);
const wedgePort = Number(env.WEDGE_PORT ?? WEDGE_PORT);
const wedgeUrl = `http://127.0.0.1:${wedgePort}`;

console.log("");
console.log("  THE DOOR");
console.log("  One command brings up the wedge and the command center, with a");
console.log("  credential both of them already agree on.");

/* ---- the stale-listener check, before anything is spawned ---- */

const listener = describeListener(wedgePort);

heading(`port ${wedgePort}`);
if (listener === undefined) {
  console.log(`  free. The wedge will bind it.`);
} else {
  console.log(`  ALREADY IN USE by PID ${listener.pid} (${processName(listener.pid)}).`);
  console.log(`  REPORTING ONLY. This script will not stop it.`);
  console.log("");
  console.log(`  If that is a wedge you started earlier, the usual outcome is that`);
  console.log(`  this boot cannot bind and you keep using the one already running --`);
  console.log(`  which is fine, but its credential may not be the one below, so the`);
  console.log(`  UI would refuse every request.`);
  console.log("");
  console.log(`  Decide what to do with PID ${listener.pid}, then re-run.`);
  process.exit(1);
}

/* ---- the credential, stated plainly ---- */

heading("credential");
console.log(`  ${credential.generated ? "generated for this run" : "taken from $WEDGE_GATEWAY_TOKEN"}`);
console.log(`  It goes to the wedge and to the UI from this one value, so the two`);
console.log(`  cannot disagree. It is not written to any file and dies with this`);
console.log(`  session.`);
console.log("");
console.log(`  To choose your own instead, set WEDGE_GATEWAY_TOKEN before running.`);

/**
 * The wedge's credential list, assembled from the single value above.
 *
 * This is the documented env path the header promises, and it is the only place
 * in this repository that builds it: one shape, one place, so the wedge cannot
 * be provisioned one way and the UI another.
 */
const wedgeEnv = {
  ...env,
  NEUROFEBRIC_GATEWAY_TOKENS: JSON.stringify([{ id: "dev", credential: credential.value, providers: ["portal"] }]),
};

/**
 * `boot.mjs` when the operator has one, and the wedge directly when they do not.
 *
 * The operator's `boot.mjs` is untracked and holds their own credential list. If
 * it is present it is honoured -- it is their configuration, not ours to
 * override. If it is absent, the wedge is started from this script with the
 * credential resolved above, so a fresh clone still boots with one command.
 */
/**
 * Whether to hand the boot to the operator's `boot.mjs`.
 *
 * === OFF BY DEFAULT, AND THE REASON IS THE WHOLE POINT OF THIS FILE ===
 *
 * `boot.mjs` assigns `NEUROFEBRIC_GATEWAY_TOKENS` itself, unconditionally. So if
 * this script generated a credential and then started `boot.mjs`, the wedge would
 * be provisioned with the operator's value while the command center was handed
 * the generated one -- two credentials, one session, and a UI that refuses every
 * request with "the credential presented is not recognised".
 *
 * That is not hypothetical. It is exactly what happened the first time this ran,
 * and it is the same class of failure as the stale 3000: two sides that each
 * believed they had the credential.
 *
 * So by default this script starts the wedge ITSELF, provisions it from the one
 * value it resolved, and hands that same value to the UI. One credential, two
 * processes, no possibility of disagreement.
 *
 * Setting `WEDGE_USE_BOOT_MJS=1` opts into the operator's file instead. It is
 * allowed, and it is not the default, because opting in means also setting
 * `WEDGE_GATEWAY_TOKEN` to whatever that file provisions -- and this script says
 * so rather than leaving the operator to discover it at the first 401.
 */
function wedgeCommand() {
  const useBootMjs = env.WEDGE_USE_BOOT_MJS === "1";
  if (useBootMjs) {
    if (!existsSync(path.join(ROOT, "boot.mjs"))) {
      throw new Error("WEDGE_USE_BOOT_MJS=1 but there is no boot.mjs at the repository root");
    }
    if (env.WEDGE_GATEWAY_TOKEN === undefined || env.WEDGE_GATEWAY_TOKEN.trim() === "") {
      throw new Error(
        "WEDGE_USE_BOOT_MJS=1 provisions the wedge from your own boot.mjs, which " +
          "overwrites the credential this script would set. Set WEDGE_GATEWAY_TOKEN " +
          "to match it, or unset WEDGE_USE_BOOT_MJS and let this script own the value.",
      );
    }
    return { file: "boot.mjs", args: ["--experimental-strip-types", "boot.mjs", "--port", String(wedgePort)] };
  }
  return { file: "start-ui.mjs", args: ["--experimental-strip-types", "start-ui.mjs", "--port", String(wedgePort)] };
}

const wedge = wedgeCommand();
const children = [];

/** Start a child with the shared environment, and record it for shutdown. */
function start(label, command, args, childEnv, cwd) {
  const child = spawn(command, args, {
    cwd: cwd ?? ROOT,
    env: childEnv,
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    console.log("");
    console.log(`  ${label} exited (${signal ?? `code ${code}`}). Shutting the other down.`);
    for (const other of children) {
      if (other !== child) other.kill();
    }
    process.exit(code ?? 0);
  });
  children.push(child);
  return child;
}

start("the wedge", process.execPath, wedge.args, wedgeEnv);

// Give the wedge a moment to bind before the UI's proxy points at it, so the
// first request a person makes is not refused by a server that had not started.
await new Promise((resolve) => setTimeout(resolve, 1200));

const uiEnv = {
  ...env,
  VITE_GATEWAY_TOKEN: credential.value,
};
const viteBin = path.join(ROOT, "frontend", "node_modules", "vite", "bin", "vite.js");

if (env.COMMAND_CENTER_SKIP_UI !== "1") {
  if (existsSync(viteBin)) {
    start("the command center", process.execPath, [viteBin, "--port", String(UI_PORT)], uiEnv, path.join(ROOT, "frontend"));
  } else {
    console.log("");
    console.log("  frontend/node_modules is not installed, so the command center was NOT started.");
    console.log("  The wedge is up. To get the UI: cd frontend, then npm install, then npm run dev.");
  }
}

/* ---- the flood command, complete, for them to press enter on ---- */

heading("flood it");
console.log("  When the UI has finished loading, run this. It is complete -- the");
console.log("  credential is already filled in:");
console.log("");
// Built by concatenation rather than a template literal: the printed command
// CONTAINS backticks, and a backtick inside a template literal ends it. A tool
// that prints commands has to survive its own output being pasted back in.
// The URL IS PRINTED EVEN THOUGH IT NOW HAS A DEFAULT.
  //
  // It has a default, and this still prints it, because the default is 8080 and
  // this boot may be on any other port. A printed command that silently omits
  // the address is a printed command that hits whatever is on 8080 -- which is
  // exactly the stale-listener confusion this script spent its first half
  // warning about. Complete means complete.
const floodCommand = [
  "node --experimental-strip-types scripts/generate-synthetic-data.ts --flood",
  `--url=${wedgeUrl}`,
  `--token=${credential.value}`,
  `--provider=${DEFAULT_PROVIDER}`,
].join(" ");

console.log(`  ${floodCommand}`);
console.log("");
console.log("  Both --token=value and --token value now work. The target defaults to");
console.log(`  ${wedgeUrl}, which is the port the wedge was just started on.`);

heading("where things are");
console.log(`  wedge            ${wedgeUrl}`);
console.log(`  command center   ${UI_URL}`);
console.log(`  live view        ${wedgeUrl}/api/portal/live`);
console.log("");
console.log("  Ctrl-C stops both.");
console.log("");

/** Both children end together, or neither does. */
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log("");
    console.log("  Stopping.");
    for (const child of children) child.kill();
    // Give them a moment to close their listeners before the parent exits, or
    // the port stays bound by a process nobody is watching.
    setTimeout(() => process.exit(0), 300);
  });
}