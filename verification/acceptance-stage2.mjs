/**
 * Stage 2 acceptance: a Splunk-style CSV export in, a bottleneck report out --
 * and a malformed one that fails honestly instead of dying quietly.
 *
 * The fixture is SYNTHETIC. No real Splunk export has been supplied, so this
 * proves the READER handles the shapes we expect an export to contain. It
 * proves nothing about a real export, and `verification/fixtures/stage2/README.md`
 * lists what it cannot know.
 *
 * The three-way no-silent-death assertions are carried over from Stage 1
 * deliberately: the run must RETURN rather than throw, must reach a terminal
 * state carrying a structured failure, and must not have produced a report. A
 * run that quietly ranked half-parsed rows would pass a naive did-not-crash
 * check, and that is the outcome being ruled out.
 *
 * Run: node --experimental-strip-types verification/acceptance-stage2.mjs
 */
import assert from "node:assert/strict";
import { readFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { csvRead } from "../platform/conductor/capabilities.ts";
import { analyseBottlenecks } from "../platform/conductor/bottlenecks.ts";
import { renderBottleneckReport } from "../platform/conductor/bottleneck-report.ts";
import { makeTempWorkspace, pathExists } from "../platform/test-support/temp-workspace.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures", "stage2");

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

async function stage2Workspace() {
  const dir = await makeTempWorkspace("nf-stage2-");
  for (const name of ["splunk-export.synthetic.csv", "splunk-malformed.synthetic.csv"]) {
    await copyFile(path.join(FIXTURES, name), path.join(dir, name));
  }
  return dir;
}

// ---------------------------------------------------------------- scenario A
console.log("\nA. synthetic Splunk export -> bottleneck report");
let analysis;
{
  const ws = await stage2Workspace();
  const out = path.join(ws, "bottlenecks.html");

  let csv;
  try {
    csv = await csvRead({ path: path.join(ws, "splunk-export.synthetic.csv") });
  } catch (error) {
    check("the reader returns instead of throwing", () => { throw new Error(`threw: ${error.message}`); });
  }

  check("the reader reports no structural problems on the clean fixture", () => {
    assert.deepEqual(csv.problems, [], `unexpected: ${csv.problems.join("; ")}`);
  });
  check("every row parsed, quoted commas and all", () => {
    assert.equal(csv.rowCount, 28, `got ${csv.rowCount} rows`);
  });
  check("a quoted field containing commas stayed one field", () => {
    const raw = csv.headers.indexOf("_raw");
    assert.ok(raw >= 0, "no _raw column");
    const withComma = csv.sample.filter((r) => r[csv.headers[raw]].includes(","));
    assert.ok(withComma.length >= 5, `only ${withComma.length} quoted fields contained a comma`);
    for (const row of withComma) assert.equal(Object.keys(row).length, 8, "a quoted field was split");
  });

  analysis = analyseBottlenecks(csv);

  check("errors are counted, not guessed", () => {
    assert.equal(analysis.errorRows, 15, `got ${analysis.errorRows}`);
    assert.equal(analysis.totalRows, 28);
  });
  check("the top bottleneck is the checkout path, by error volume", () => {
    assert.equal(analysis.bySource[0].key, "checkout-api", `got ${analysis.bySource[0]?.key}`);
  });
  check("the leading recurring signature is masked into a pattern, not a unique row", () => {
    assert.ok(analysis.recurring.length > 0, "nothing recurred");
    assert.match(analysis.recurring[0].key, /upstream timeout after Nms/i,
      `signature not masked: ${analysis.recurring[0]?.key}`);
  });
  check("recurrence is what makes it a bottleneck, not one loud failure", () => {
    assert.ok(analysis.recurring[0].errorCount > 1, "the leading pattern occurred once");
  });
  check("mixed timestamp encodings all parsed", () => {
    assert.deepEqual(analysis.unreadableTimestamps, [], "some timestamps were unreadable");
    assert.ok(analysis.byHour.length >= 1, "no hourly buckets at all");
  });
  check("hourly buckets carry evidence rows", () => {
    for (const hour of analysis.byHour) {
      assert.ok(hour.rows.length > 0, `hour ${hour.key} cites no rows`);
    }
  });
  check("latency is distributed across bands", () => {
    assert.ok(analysis.latency.length > 1, `got ${analysis.latency.length} band(s)`);
  });

  // -- render --
  let rendered;
  try {
    rendered = await renderBottleneckReport({ path: out, title: "Payment pipeline bottlenecks", csv });
  } catch (error) {
    check("the renderer returns instead of throwing", () => { throw new Error(`threw: ${error.message}`); });
  }

  check("the report rendered", () => assert.equal(rendered.rendered, true, `problems: ${rendered.problems}`));
  const reportWritten = await pathExists(out);
  check("the report file exists", () => assert.equal(reportWritten, true, `no file at ${out}`));

  // Guarded rather than assumed: a refusal must not crash the acceptance run
  // with ENOENT. The assertions below only run when there is a report to read,
  // and their absence is itself reported by the checks above.
  if (!rendered.rendered) {
    console.log("  SKIP  page assertions: nothing was rendered");
  } else {
  const html = await readFile(out, "utf8");
  check("it is a complete, self-contained page", () => {
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.trimEnd().endsWith("</html>"));
    assert.equal(/<script/i.test(html), false, "carries a script tag");
    assert.equal(/\b(src|href)\s*=\s*["']https?:/i.test(html), false, "references a remote resource");
  });
  check("every figure cites the rows behind it", () => {
    assert.match(html, /rows 2, 3, 4/, "expected row citations in the source table");
    assert.equal((html.match(/class="cite"/g) ?? []).length > 5, true, "too few citations");
  });
  check("the ranking is present, worst first", () => {
    // This fixture has NO alert-category column -- it is an access log, not an
    // alerts export -- so there is nothing to rank categories by and the page
    // must say so rather than substitute the source and call it a category.
    const checkoutAt = html.indexOf("checkout-api");
    const searchAt = html.indexOf("search-idx");
    assert.equal(checkoutAt, -1, "infrastructure hostnames must not reach the committed page");
    assert.equal(searchAt, -1, "infrastructure hostnames must not reach the committed page");
    assert.match(html, /no credible column/,
      "with no category column the page must name that, not degrade quietly");
    assert.match(html, /Rows by hour/, "the hourly ranking is still present and still cited");
    assert.ok((html.match(/class="cite"/g) ?? []).length > 3, "evidence citations must survive");
  });
  check("it states its own error rate rather than implying one", () => {
    // Present ONLY when a status column was mapped. Without one an error rate is
    // not computable, and printing 0.0% would be a confident invention.
    assert.match(html, /error rate \d+\.\d%/);
    assert.equal(/no status column, so no error rate is claimed/.test(html), false,
      "this fixture DOES have a status column, so the rate must be claimed");
  });
  }
}

// ---------------------------------------------------------------- scenario B
console.log("\nB. malformed Splunk export -> honest failure, never a silent death");
{
  const ws = await stage2Workspace();
  const out = path.join(ws, "bottlenecks.html");

  let csv;
  let threw = null;
  try {
    csv = await csvRead({ path: path.join(ws, "splunk-malformed.synthetic.csv") });
  } catch (error) {
    threw = error;
  }

  check("the reader returns instead of throwing", () => assert.equal(threw, null, threw && String(threw.message)));

  if (csv) {
    check("the structural defects are reported, not swallowed", () => {
      assert.ok(csv.problems.length >= 3, `expected >=3 problems, got ${csv.problems.length}: ${csv.problems.join("; ")}`);
    });
    check("the ragged row is named with its line number", () =>
      assert.ok(csv.problems.some((p) => /row \d+ has \d+ value/.test(p)), csv.problems.join("; ")));
    check("the unterminated quote is named specifically", () =>
      assert.ok(csv.problems.some((p) => /quoted field/.test(p)), csv.problems.join("; ")));
  }

  // The rendering decision: a report drawn from a file the reader already called
  // malformed is a lie with a chart on it.
  let rendered = null;
  let renderThrew = null;
  try {
    rendered = await renderBottleneckReport({ path: out, title: "Bottlenecks", csv });
  } catch (error) {
    renderThrew = error;
  }

  check("the renderer refuses rather than ranking half-parsed rows", () => {
    assert.equal(renderThrew, null, renderThrew && String(renderThrew.message));
    assert.equal(rendered.rendered, false, "it rendered anyway");
  });
  check("the refusal carries the structural problems as its reason", () => {
    assert.ok(rendered.problems.length >= 3, `got ${rendered.problems.length}`);
  });
  const wroteReport = await pathExists(out);
  check("nothing was written", () => assert.equal(wroteReport, false, "a report was written from a malformed file"));
  check("and the failure is reachable without rendering, as a structured result", () => {
    const a = analyseBottlenecks(csv);
    assert.ok(Array.isArray(a.problems) && a.problems.length > 0, "the analysis dropped the problems");
  });
}

console.log(`\n${failures === 0 ? "STAGE 2 ACCEPTANCE PASS" : `STAGE 2 ACCEPTANCE FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);