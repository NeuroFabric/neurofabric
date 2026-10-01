import test from "node:test";
import assert from "node:assert/strict";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { toBottleneckMarkdown, renderBottleneckReport } from "./bottleneck-report.ts";
import { parseCsv, csvRead } from "./capabilities.ts";
import { makeTempWorkspace, writeFixture } from "../test-support/temp-workspace.ts";
import type { CsvReadResult } from "./capabilities.ts";
import type { ResolvedSchema } from "./schema-memory.ts";

/**
 * TASK 1 (cont.) — the memory must CHANGE THE ANALYSIS, and the Markdown must
 * survive a hostile file.
 *
 * A schema store that is read and then ignored would pass every test in
 * `schema-memory.test.ts` while the product behaved exactly as before, so the
 * wiring is pinned here: a verified mapping is used, and it is labelled
 * established rather than hypothesis.
 */

/**
 * A CsvReadResult from text, WITHOUT going through the filesystem.
 *
 * The rows are keyed BY HEADER, exactly as the real reader builds them. An
 * earlier version of this helper passed the parser's positional arrays straight
 * through, and every column then read as undefined -- which made every column
 * look degenerate and would have "passed" a cardinality test for the wrong
 * reason.
 */
function csvOf(text: string, file = "in.csv"): CsvReadResult {
  const parsed = parseCsv(text);
  const keyed = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return { path: file, headers: parsed.headers, rowCount: keyed.length, columns: [], sample: keyed.slice(0, 5), rows: keyed, problems: parsed.problems };
}

const PEGA = `_time,source_host,alertType,alert_code,elapsed_time,threshold
2026-09-30 12:00:00.000,host-web,performance,PEGA0001,1200,1000
2026-09-30 12:01:00.000,host-bg,performance,PEGA0028,800,1000
2026-09-30 12:02:00.000,host-web,performance,PEGA0001,1300,1000
2026-09-30 12:03:00.000,host-api,performance,PEGA0011,300,1000`;

const PEGA_HEADERS = PEGA.split("\n")[0].split(",");

test("a stored mapping is applied and reported as established, not inferred", () => {
  const schema: ResolvedSchema = {
    id: "pega-alert-export",
    roles: { time: "_time", source: "source_host", category: "alertType", duration: "elapsed_time", threshold: "threshold" },
    source: "DEFAULT",
    learnedRoles: [],
    absent: [],
    unresolved: [],
  };
  const analysis = analyseBottlenecks(csvOf(PEGA), schema);
  // alertType is degenerate (one distinct value). A stored mapping must not be
  // able to force it past the cardinality check -- the rejection is a property
  // of the DATA, and a config file cannot overrule arithmetic.
  assert.equal(analysis.categoryColumn, "alert_code", "a degenerate stored column is still rejected");
  assert.equal(analysis.degenerateColumns[0]?.column, "alertType");
  assert.ok(
    analysis.degenerateColumns[0]?.note.includes("cannot rank"),
    "the rejection is reported, so the report can explain itself",
  );
  // Because the store's category column was rejected, the category that was
  // actually used came from NAME INFERENCE and is still a hypothesis. Storing a
  // column does not make it right.
  const category = analysis.mappings.find((m) => m.role === "category");
  assert.equal(category?.column, "alert_code");
  assert.equal(category?.hypothesis, true, "a rejected stored column leaves an inferred one, still a hypothesis");
  // Every other role the store DID supply is established, which is the visible
  // difference the store makes.
  for (const role of ["time", "source", "duration", "threshold"]) {
    const m = analysis.mappings.find((x) => x.role === role);
    assert.equal(m?.hypothesis, false, `${role} came from the stored schema`);
    assert.match(String(m?.note), /verified schema/);
  }
  assert.equal(analysis.schemaSource, "DEFAULT");
  assert.ok((analysis.verifiedRoles ?? []).includes("duration"));
});

test("with no stored schema every mapping is still a hypothesis (unchanged behaviour)", () => {
  const analysis = analyseBottlenecks(csvOf(PEGA));
  assert.ok(analysis.mappings.every((m) => m.hypothesis), "no memory, no certainty");
  assert.equal(analysis.schemaSource, undefined);
  assert.deepEqual(analysis.verifiedRoles, [], "no memory means nothing is verified");
});

test("the markdown report states its basis and cannot be broken by file content", () => {
  // A category name carrying every character that would break a Markdown table
  // and then the HTML around it. This value came from an uploaded file.
  const hostile = `PEGA|0001 <script>alert(1)</script> \`code\` **bold** [x](y)
second line`;
  const text = `_time,source_host,alertType,alert_code,elapsed_time,threshold
2026-09-30 12:00:00.000,host-web,performance,"${hostile}",1200,1000
2026-09-30 12:01:00.000,host-bg,performance,PEGA0002,800,1000`;
  const analysis = analyseBottlenecks(csvOf(text));
  const md = toBottleneckMarkdown(analysis, "Bottleneck report");

  assert.match(md, /^# Bottleneck report/m, "it is a report");
  assert.match(md, /inferred from the column NAME alone/, "no memory means it says so");
  // The pipe inside a cell must not become a column break. Counted INSIDE one
  // table, because both category tables have a row numbered 1.
  const frequencyTable = md.split("## Alert categories by frequency")[1].split("## ")[0];
  assert.equal(
    frequencyTable.split("\n").filter((l) => l.startsWith("| 1 |")).length,
    1, "the hostile cell did not split the table into two rows",
  );
  assert.ok(frequencyTable.includes("\\|"), "the pipe is escaped, so the cell stays one cell");
  assert.ok(!md.includes("\nsecond line"), "a newline in a value must not invent a row");
  assert.ok(!md.includes("<script>"), "raw HTML must not survive into the report");
  assert.ok(!md.includes("`code`"), "backticks are neutralised so the value cannot open a code span");
});

test("markdown and html renderings come from ONE analysis and agree on the leader", async () => {
  const cwd = await makeTempWorkspace("nf-md-");
  const file = await writeFixture(cwd, "pega.csv", PEGA);
  const csv = await csvRead({ path: file }, { boundary: { check: (p: string) => ({ allowed: true, reason: "test", resolved: p }), assert: (p: string) => p } } as never);
  const analysis = analyseBottlenecks(csv);
  const md = toBottleneckMarkdown(analysis, "Bottleneck report");
  const html = await renderBottleneckReport({ path: `${cwd}/r.html`, title: "Bottleneck report", csv });

  const leader = analysis.categories[0].key;
  assert.ok(md.includes(leader), "the markdown names the leading category");
  assert.ok((html.bytes > 0), "the page rendered");
  const page = await import("node:fs/promises").then((fs) => fs.readFile(html.path, "utf8"));
  assert.ok(page.includes(leader), "the page names the same leading category");
  assert.ok(page.includes("inferred from the column NAME alone"), "provenance is on the page too");
});

test("a malformed CSV renders no report at all, in either format", async () => {
  const cwd = await makeTempWorkspace("nf-md-bad-");
  const file = await writeFixture(cwd, "ragged.csv", "a,b,c\n1,2\n");
  const csv = await csvRead({ path: file }, { boundary: { check: (p: string) => ({ allowed: true, reason: "test", resolved: p }), assert: (p: string) => p } } as never);
  assert.ok(csv.problems.length > 0, "the fixture is actually ragged");
  const result = await renderBottleneckReport({ path: `${cwd}/r.md`, csv, format: "markdown" });
  assert.equal(result.rendered, false, "no markdown from a malformed file either");
  assert.equal(result.markdown, undefined);
});
