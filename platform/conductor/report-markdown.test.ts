import test from "node:test";
import assert from "node:assert/strict";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { toBottleneckMarkdown, renderBottleneckReport } from "./bottleneck-report.ts";
import { parseCsv, csvRead } from "./capabilities.ts";
import { resolveSchemaMemory } from "./schema-memory.ts";
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
  // NOTE ON THE HEADING BELOW. These fixtures are Pega-shaped but are analysed
  // with NO schema, and a file nothing has been verified about is described in
  // records. So the neutral heading is the correct one to split on, and this is
  // the fourth test in the suite that was silently relying on the old leak.
  // Pega wording through the VERIFIED path is pinned in vocabulary-guard.ts.
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
  const frequencyTable = md.split("## Record categories by frequency")[1].split("## ")[0];
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

/**
 * THE RESTORATION. Three things the merge put back into the Stage 2 shape, each
 * pinned here because none of them can fail loudly.
 *
 * The Markdown divergence block is the clearest case: it was simply ABSENT, and
 * a renderer that renders less than it should produces valid Markdown. Nothing
 * went red, the build was green, and the product quietly stopped stating its
 * main finding. A test that asserts a string EXISTS is the only thing that
 * catches that class of loss.
 *
 * The fixture is shaped like the real export -- one noisy code with small
 * durations, one rare code with enormous ones -- because on a fixture where the
 * two rankings AGREE the divergence is null by design (D2) and every assertion
 * here would pass vacuously.
 */
const DIVERGING = `_time,source_host,logger_name,alert_code,elapsed_time,threshold
2026-09-30 12:00:00.000,host-web,com.pega.pegarules.session.internal.engineinterface.service.HttpAPI,PEGA0001,1200,1000
2026-09-30 12:01:00.000,host-bg,com.pega.pegarules.exec.internal.Declarative,PEGA0005,900000,1000
2026-09-30 12:02:00.000,host-web,com.pega.pegarules.session.internal.engineinterface.service.HttpAPI,PEGA0001,1300,1000
2026-09-30 12:03:00.000,host-api,com.pega.pegarules.exec.internal.declare.infengine.pages.Declarative,PEGA0005,900000,1000`;

test("markdown leads with a dedicated DIVERGENCE block naming the time-cost multiplier", () => {
  const md = toBottleneckMarkdown(analyseBottlenecks(csvOf(DIVERGING)), "Bottleneck report");
  assert.match(md, /\[!WARNING\]/, "the divergence is a callout, not a clause in the lead sentence");
  assert.match(md, /The two rankings disagree/, "and it says what it is about");
  // PEGA0001 costs 1,200 + 1,300 = 2,500 ms. PEGA0005 costs 900,000 x 2 =
  // 1,800,000 ms. The multiple is 1,800,000 / 2,500 = 720. Pinned exactly,
  // because a banner that printed a wrong multiplier would still read as a
  // confident, correct number.
  assert.match(md, /\*\*720x the total elapsed time\*\*/, "the cost multiple is stated, and bold");
  assert.match(md, /Most frequent:\*\*.*PEGA0001/, "both leaders are named");
  assert.match(md, /Most expensive:\*\*.*PEGA0005/, "both leaders are named");
  assert.match(md, /would have pointed at PEGA0001 and buried PEGA0005/, "and which one frequency alone would have lost");
  // It must not be buried in the lead sentence the way it was: the lead is still
  // there, but the headline is its own block.
  const bannerAt = md.indexOf("[!WARNING]");
  const leadAt = md.indexOf("**#1 by frequency:**");
  assert.ok(bannerAt > leadAt && bannerAt - leadAt < 400, "the warning follows the lead rather than replacing it");
});

test("D2 survives into markdown: no divergence block when the two rankings agree", () => {
  // PEGA0001 wins on both frequency and cost, so there is nothing to warn about.
  const md = toBottleneckMarkdown(analyseBottlenecks(csvOf(PEGA)), "Bottleneck report");
  assert.ok(analyseBottlenecks(csvOf(PEGA)).divergence === null, "the fixture really does agree");
  assert.ok(!md.includes("[!WARNING]"), "a headline that always shouts is one nobody reads");
  assert.ok(!md.includes("x the total elapsed time"), "and no stale multiple is printed either");
});

test("R13 the markdown tables carry the alias, and column names keep their underscores", () => {
  const md = toBottleneckMarkdown(analyseBottlenecks(csvOf(DIVERGING)), "Bottleneck report");
  const table = md.split("## Record categories by frequency")[1].split("## ")[0];
  assert.ok(table.includes("PEGA0001 (HttpAPI)"), "the unambiguous alias is appended to the code");
  assert.ok(table.includes("| PEGA0005 |") || table.includes("PEGA0005 |"), "the bare key is still the prefix, so matching on the code still works");

  // The underscore bug. mdCell used to DELETE `*` and `_`, so the report's own
  // provenance table cited `alertcode` and `loggername` -- columns that do not
  // exist in the file it claims to have read.
  // The heading is now "Data provenance" and sits at the FOOT of the report: it
  // used to be "How this report was read", near the top, where it answered a
  // question the reader had not asked yet and buried the one they had. The
  // property under test is untouched -- mdCell must not mangle a column name --
  // and the mapping table moved with the heading, so this split follows it.
  const mappings = md.split("## Data provenance")[1].split("\n## ")[0];
  assert.ok(mappings !== undefined, "the provenance block must still exist and still carry the table");
  assert.ok(mappings.includes("alert\\_code"), "the escaped column name still renders as alert_code");
  assert.ok(!mappings.includes("| alertcode |"), "and it is not the mangled name the old code produced");
});

test("R10 the elapsed columns state their unit in the header", () => {
  const md = toBottleneckMarkdown(analyseBottlenecks(csvOf(DIVERGING)), "Bottleneck report");
  assert.match(md, /total elapsed \(ms\)/, "markdown states the unit");
  const html = toBottleneckMarkdown(analyseBottlenecks(csvOf(DIVERGING)), "Bottleneck report");
  assert.ok(html.includes("total elapsed (ms)"));
});

test("the shipped Pega schema establishes alert_code AND logger_name", async () => {
  // Read through the real resolver, against the real shipped config. A role that
  // is only established because a test passed an inline schema proves nothing
  // about what a customer gets.
  const headers = DIVERGING.split("\n")[0].split(",");
  const schema = await resolveSchemaMemory({ cwd: "configs/..", headers });
  assert.equal(schema?.id, "pega-alert-export");
  assert.equal(schema?.roles.category, "alert_code", "the category role is stored, not inferred");
  assert.equal(schema?.roles.alias, "logger_name", "the alias role is stored, so it stops printing as a hypothesis");
  const analysis = analyseBottlenecks(csvOf(DIVERGING), schema);
  for (const role of ["category", "alias", "duration", "time", "source", "threshold"]) {
    const m = analysis.mappings.find((x) => x.role === role);
    assert.equal(m?.hypothesis, false, `${role} must be established, not a hypothesis`);
  }
  // And the label survives all the way into the table.
  const md = toBottleneckMarkdown(analysis, "Bottleneck report");
  assert.ok(md.includes("| alias | logger\\_name | established |"), "the alias mapping is reported as established");
  assert.ok(md.includes("PEGA0001 (HttpAPI)"), "and the alias is still printed");
});
