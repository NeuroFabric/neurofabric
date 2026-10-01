/**
 * LIVE MEASUREMENT of the command-wrapper table, on whatever host runs it.
 *
 * WHY THIS EXISTS. `platform/core/command-position.ts` carries a wrapper table
 * whose every row was measured on MSYS2/MinGW64, bash 5.3.15, and the file says
 * so. The corpus test (`command-position-corpus.test.ts`) is a STATIC table of
 * pinned expectations: running it on Linux proves the parser still produces the
 * answers it produced on Windows, which is a real and necessary check, and is
 * NOT the same as re-deriving the measurements on Linux. Until this script
 * exists, that second claim is unevidenced.
 *
 * Each probe below asserts a claim the table makes in prose -- that `timeout`
 * eats a DURATION, that `stdbuf` REQUIRES a mode option, that `command -v`
 * queries rather than runs. Running them here either confirms the row on this
 * host or refutes it, and a refutation is a finding rather than a failure to be
 * papered over.
 *
 * Every probe is benign: printf, echo, true. Nothing here deletes anything.
 *
 * Exit codes are the point. The table encodes "this option consumes its value"
 * as "this invocation FAILS", which is a stronger and more durable claim than
 * any output matching, so every probe is judged on exit status.
 *
 * Run: node verification/measure-command-wrappers.mjs
 * Exits non-zero if any measured claim is refuted.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * `expect` is the exit code the table's prose predicts.
 *  - `null` means "this tool is absent on this host", which is information
 *    rather than a refutation: `setsid` and `watch` are absent from the
 *    measurement host and were deliberately not guessed at.
 *
 * 125 is coreutils' own "the argument you gave me is invalid" code, used by
 * both `timeout` for a bad duration and `stdbuf` for a bad mode. The table's
 * prose claims only that these invocations FAIL, which is what proves the
 * option was consumed; the exact code was guessed as 1 on the first run of this
 * script and refuted, which is the script working rather than the table being
 * wrong. It is now pinned to the code the host actually uses.
 */
const PROBES = [
  { wrapper: "timeout", claim: "eats a DURATION as a bare operand", cmd: "timeout printf x", expect: 125 },
  { wrapper: "timeout", claim: "runs the command when given one", cmd: "timeout 5 printf ok", expect: 0 },
  { wrapper: "timeout", claim: "-s consumes the next token", cmd: "timeout -s KILL printf x", expect: 125 },

  { wrapper: "env", claim: "-i CLEARS the environment (so a bare name is lost)", cmd: "env -i FOO=bar no_such_command_xyz", expect: 127 },
  { wrapper: "env", claim: "consumes NAME=VALUE assignments", cmd: "env FOO=bar printf ok", expect: 0 },

  { wrapper: "command", claim: "-v QUERIES a name rather than running it", cmd: "command -v printf", expect: 0 },
  { wrapper: "command", claim: "without -v it runs the operand", cmd: "command printf ok", expect: 0 },

  { wrapper: "stdbuf", claim: "REQUIRES a mode option", cmd: "stdbuf printf ok", expect: 125 },
  { wrapper: "stdbuf", claim: "-o0 attaches and runs the command", cmd: "stdbuf -o0 printf ok", expect: 0 },

  { wrapper: "nice", claim: "-10 attaches and runs the command", cmd: "nice -10 printf ok", expect: 0 },
  { wrapper: "nice", claim: "-n takes a separate value", cmd: "nice -n 10 printf ok", expect: 0 },

  { wrapper: "nohup", claim: "runs the command after its own flags", cmd: "nohup printf ok", expect: 0 },

  { wrapper: "exec", claim: "replaces the shell with the command", cmd: "exec printf ok", expect: 0 },

  // Deliberately NOT in the wrapper table, and probed every run so that its
  // absence from the table stays a checked fact rather than a stale comment.
  //
  // `sudo` answers `--version` here and reports `sudo 1.0.1`. That is Git for
  // Windows' stub, NOT GNU sudo (which is 1.9.x). Measuring this one's option
  // grammar would tell us nothing about the target's sudo, so it stays
  // unmeasured, and R6 is what covers a token delegated to it. The probe runs
  // so that if a real GNU sudo ever appears here, the change is visible.
  { wrapper: "sudo", claim: "runnable but Git-for-Windows stub, NOT GNU sudo", cmd: "sudo --version", expect: null },
  { wrapper: "setsid", claim: "ABSENT here and therefore not measured", cmd: "setsid --version", expect: null },
  { wrapper: "watch", claim: "ABSENT here and therefore not measured", cmd: "watch --version", expect: null },
];

/** 127/126 are "command not found" and "found but not executable". */
const NOT_PRESENT = new Set([126, 127]);

async function main() {
  const host = process.platform;
  console.log(`\nCommand-wrapper measurement on ${host}, node ${process.version}\n`);

  const refuted = [];
  const absent = [];

  for (const probe of PROBES) {
    let code = null;
    try {
      await run("bash", ["-c", probe.cmd], { timeout: 5000 });
      code = 0;
    } catch (error) {
      code = typeof error.code === "number" ? error.code : null;
    }

    if (probe.expect === null) {
      const isAbsent = code === null || NOT_PRESENT.has(code);
      if (isAbsent) { absent.push(probe.wrapper); console.log(`  absent   ${probe.wrapper.padEnd(8)} ${probe.claim}`); }
      else { console.log(`  PRESENT  ${probe.wrapper.padEnd(8)} ${probe.claim} (exit ${code}) -- now measurable`); }
      continue;
    }

    const ok = code === probe.expect;
    if (!ok) refuted.push({ ...probe, actual: code });
    console.log(`  ${ok ? "holds  " : "REFUTED"} ${probe.wrapper.padEnd(8)} ${probe.claim} (exit ${code}, expected ${probe.expect})`);
  }

  console.log("");
  if (absent.length > 0) {
    console.log(`Absent and therefore unmeasured: ${absent.join(", ")}`);
    console.log("An unmeasured wrapper cannot be classified, so a destructive token");
    console.log("delegated to one is handled by R6 rather than by the table.\n");
  }

  if (refuted.length === 0) {
    console.log(`ALL ${PROBES.length - absent.length} MEASURED CLAIMS HOLD on this host.\n`);
    return 0;
  }
  console.log(`${refuted.length} MEASURED CLAIM(S) REFUTED on this host:\n`);
  for (const r of refuted) {
    console.log(`  ${r.wrapper}: ${r.claim}`);
    console.log(`    command: ${r.cmd}`);
    console.log(`    expected exit ${r.expect}, measured ${r.actual}`);
  }
  console.log("\nEach refutation means the wrapper table's row for that wrapper is");
  console.log("wrong ON THIS HOST. Reclassify with this evidence and pin the row.");
  console.log("Do not silently widen the table -- a wrapper guessed at is a hole.\n");
  return 1;
}

process.exit(await main());