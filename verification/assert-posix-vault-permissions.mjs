/**
 * PROVE THE POSIX VAULT PERMISSIONS ACTUALLY RAN.
 *
 * D-037 caveat two: the two vault permission tests skip on Windows, so the
 * invariant "secrets at rest are not world-readable" was UNVERIFIED on the
 * platform that produced that declaration. `test-ts` on the Linux runner does
 * execute them -- so on paper the caveat is closed by the existing pipeline.
 *
 * "On paper" is the problem. A skip is not a failure. If a later edit widens
 * SKIP_WINDOWS, or the suite is refactored and the two tests quietly lose their
 * coverage, the pipeline stays green and the caveat reopens with no signal. A
 * security claim that is verified only by the absence of a red build is not
 * verified; it is assumed.
 *
 * So this asserts the POSITIVE: that both named tests appear in the TAP output
 * and neither is skipped. Absence of a skip line is not evidence, because a
 * test that stopped existing produces no skip line either. This is the
 * difference between "nothing went wrong" and "the thing I needed ran".
 *
 * It fails on Windows, on purpose. This script is the Linux gate; running it
 * anywhere else is a configuration error, and a gate that quietly no-ops off
 * its target platform is the exact failure mode it exists to prevent.
 *
 * Usage: node verification/assert-posix-vault-permissions.mjs
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

/** The two tests that carry the invariant D-037 could not verify. */
const REQUIRED = [
  "a stored vault is not readable by group or other",
  "a vault file left world-readable by an earlier version is tightened on its next write",
];

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exitCode = 1;
}

/**
 * NOT VERIFIED ON THIS PLATFORM. Reported loudly, and NOT treated as a pass.
 *
 * The distinction matters and it is the whole reason this is a change: `fail`
 * exits non-zero, which makes this job RED on the Windows runner and fails every
 * test in `test-ts` alongside it -- even though `1..1535 / pass 1533 / fail 0`.
 * One POSIX step was overriding the outcome of a job full of green tests, which
 * trains people to read a red job without reading it.
 *
 * So on win32 this SKIPS with exit 0, and says, in the job log and in this
 * process's output, that it proved nothing. **Skipped is not green** and this
 * output is the difference: a reader sees "NOT VERIFIED" rather than a tick.
 *
 * The script is unchanged on POSIX. It runs there, it asserts, and it fails for
 * real if the invariant is violated. Nothing about the check itself is softened
 * -- only the reporting on a platform where it cannot be performed.
 */
if (process.platform === "win32") {
  console.log(
    "SKIPPED (not verified) this gate is POSIX-only; running it on win32 cannot prove anything.\n" +
    "          It exists to verify the LINUX runner and must be run there.\n" +
    "          D-037 caveat two remains OPEN IN CONFIGURATION ONLY until a Linux\n" +
    "          runner executes this and the log is READ. Do not read a green\n" +
    "          test-ts as proof that secrets at rest are not world-readable.",
  );
} else {
  const suite = path.join("platform", "core", "vault.test.ts");
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--test", suite],
    { encoding: "utf8", cwd: process.cwd() },
  );

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

  if (result.status !== 0) {
    console.error(output);
    fail(`the vault suite exited ${result.status}; the POSIX assertions are not merely unproven, they are failing`);
  }

  for (const name of REQUIRED) {
    // TAP reports a passing test as `ok N - <name>` and a skipped one as the
    // same line with `# SKIP <reason>` appended. The escape handles the
    // parentheses and hyphens in these names.
    const line = output
      .split("\n")
      .find((l) => l.startsWith("ok ") && l.includes(name));
    if (line === undefined) {
      fail(`"${name}" did not run at all. A renamed or deleted test produces no ` +
        `failure, so its absence must be treated as a failure here.`);
    } else if (line.includes("# SKIP")) {
      fail(`"${name}" was SKIPPED: ${line.trim()}. The permission invariant is unverified.`);
    } else {
      console.log(`ok    ${name}`);
    }
  }

  if (process.exitCode !== 1) {
    console.log("\nPOSIX VAULT PERMISSION ASSERTIONS VERIFIED ON THIS RUNNER");
  }
}
