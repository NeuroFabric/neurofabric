/**
 * Stage 1 acceptance: clean-sales.csv -> one-page dashboard, and
 * malformed.csv -> an honest structured failure.
 *
 * "Never a silent death" is the part that is easy to fake, so it is asserted
 * three ways rather than one: the run must RETURN (not throw), it must return a
 * terminal status carrying a structured failure, and it must not have produced a
 * dashboard. A run that quietly renders a chart of half-parsed rows would pass a
 * naive "did it not crash" check, and that is exactly the outcome being ruled out.
 *
 * Run: node --experimental-strip-types verification/acceptance-stage1.mjs
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, access, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Conductor } from "../platform/conductor/conductor.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "stage1");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${error.message.split("\n")[0]}`);
  }
}

async function exists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

/**
 * Each scenario gets its own workspace, with the fixtures copied in.
 *
 * This is not tidiness. The Conductor's boundary is rooted at its cwd, so an
 * output path outside it is refused by policy - which is correct, and is why
 * the first run of this script failed with POLICY_SOFT_REFUSE. The scenario has
 * to run somewhere the Conductor is actually allowed to write.
 */
async function makeWorkspace() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-accept-"));
  for (const name of ["clean-sales.csv", "malformed.csv"]) {
    await copyFile(path.join(FIXTURES, name), path.join(dir, name));
  }
  return dir;
}

// ---------------------------------------------------------------- scenario A
console.log("\nA. clean-sales.csv -> one-page dashboard");
{
  const ws = await makeWorkspace();
  const out = path.join(ws, "dashboard.html");
  const conductor = new Conductor({ cwd: ws });

  let result;
  try {
    result = await conductor.run("make me a dashboard from clean-sales.csv", { output: out });
  } catch (error) {
    check("the run returns instead of throwing", () => { throw new Error(`threw: ${error.message}`); });
    result = undefined;
  }

  if (result) {
    check("status is DELIVERED", () => assert.equal(result.status, "DELIVERED", `got ${result.status}`));
    check("no failure is reported", () => assert.equal(result.failure, undefined, JSON.stringify(result.failure)));
    check("one artifact is reported", () => assert.equal(result.artifacts.length, 1, `got ${result.artifacts.length}`));
    check("the artifact path is the one requested", () => assert.ok(result.artifacts[0]?.includes("dashboard.html"), result.artifacts[0]));
  }
  const wrote = await exists(out);
  check("the dashboard file was written", () => assert.equal(wrote, true, `no file at ${out}`));
  if (wrote) {
    const html = await readFile(out, "utf8");
    check("it is a complete HTML document", () => {
      assert.ok(html.startsWith("<!doctype html>"), "missing doctype");
      assert.ok(html.trimEnd().endsWith("</html>"), "not closed");
    });
    check("it is a single self-contained page (no network, no script)", () => {
      assert.equal(/<script/i.test(html), false, "carries a script tag");
      assert.equal(/\b(src|href)\s*=\s*["']https?:/i.test(html), false, "references a remote resource");
    });
    check("it charts the parsed rows rather than an empty shell", () => {
      assert.equal((html.match(/class="bar"/g) ?? []).length, 5, "expected one bar per region");
    });
    check("it states the row count it was given", () => assert.match(html, /5 row\(s\)/));
  }
}

// ---------------------------------------------------------------- scenario B
console.log("\nB. malformed.csv -> honest structured failure, never a silent death");
{
  const ws = await makeWorkspace();
  const out = path.join(ws, "dashboard.html");
  const conductor = new Conductor({ cwd: ws });

  let result;
  let threw = null;
  try {
    // No `resolve`: the run is given no repair instruction, which is the case
    // where a silent death would hide.
    result = await conductor.run("make me a dashboard from malformed.csv", { output: out });
  } catch (error) {
    threw = error;
  }

  check("the run returns instead of throwing", () => assert.equal(threw, null, threw && `threw: ${threw.message}`));

  if (result) {
    check("it does not report success", () => assert.notEqual(result.status, "DELIVERED"));
    check("it carries a structured failure", () => assert.ok(result.failure, "no failure object"));
    check("the failure is classified MALFORMED_CSV", () => assert.equal(result.failure?.code, "MALFORMED_CSV"));
    check("the failure explains itself in words", () =>
      assert.ok((result.failure?.reason ?? "").length > 20, "reason is too short to be useful"));
    check("the specific defects are enumerated, not summarised away", () =>
      assert.match(result.failure?.reason ?? "", /malformed|row \d|quoted/));
    check("it asked a question rather than guessing", () =>
      assert.ok(result.questions.some((q) => q.code === "AMBIGUOUS_CSV"), "no AMBIGUOUS_CSV question"));
    check("it reports progress rather than dying silently", () =>
      assert.ok(result.progress.length > 0, "no progress events recorded"));
    check("it reached a terminal state", () => assert.ok(
      ["CLARIFY_EXHAUSTED", "FAILED"].includes(result.status), result.status));
  }

  const wrote = await exists(out);
  check("no dashboard was written from a malformed file", () => assert.equal(wrote, false));
}

// ------------------------------------------------------------------ summary
console.log(`\n${failures === 0 ? "ACCEPTANCE PASS" : `ACCEPTANCE FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);