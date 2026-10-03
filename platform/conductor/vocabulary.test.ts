import test from "node:test";
import assert from "node:assert/strict";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { toBottleneckMarkdown, renderBottleneckReport } from "./bottleneck-report.ts";
import { resolveSchemaMemory } from "./schema-memory.ts";
import { parseCsv, csvRead } from "./capabilities.ts";
import { makeTempWorkspace, writeFixture } from "../test-support/temp-workspace.ts";
import type { CsvReadResult } from "./capabilities.ts";

/**
 * DYNAMIC VOCABULARY. The report must not assert what kind of file it read.
 *
 * The Stage 3 report said "13 alert(s)" and "over threshold" because every file
 * it had ever seen was a Pega alert export. That was a reasonable default and
 * it became a lie the moment the generic profiler let an access log through:
 * not merely wrong vocabulary, but an assertion that the file contained alerts.
 * A report that describes a CSV of HTTP statuses as a list of alerts is making a
 * claim about the data, and a reader has no way to see that it is unfounded.
 *
 * The second half is quieter and worse. "over threshold: 0" on a file with NO
 * threshold column is a false all-clear. Zero breaches against a limit the file
 * never stated means nothing at all, and printing it in a column is worse than
 * omitting the column, because a zero is a fact-shaped hole.
 */

function csvOf(text: string, file = "in.csv"): CsvReadResult {
  const parsed = parseCsv(text);
  const keyed = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return { path: file, headers: parsed.headers, rowCount: keyed.length, columns: [], sample: keyed.slice(0, 5), rows: keyed, problems: parsed.problems };
}

const ACCESS_LOG = `timestamp,client_ip,method,path,status,response_bytes,duration_ms,user_agent
2026-09-30 12:00:00,10.0.0.1,GET,/home,200,4096,120,Mozilla/5.0
2026-09-30 12:00:01,10.0.0.2,GET,/api/orders,200,8192,45,Mozilla/5.0
2026-09-30 12:00:02,10.0.0.1,POST,/api/orders,500,128,9800,curl/8.0
2026-09-30 12:00:03,10.0.0.3,GET,/home,200,4096,88,Mozilla/5.0
2026-09-30 12:00:04,10.0.0.4,GET,/login,302,0,31,Mozilla/5.0
2026-09-30 12:00:05,10.0.0.5,PUT,/api/orders,500,128,12400,curl/8.0
2026-09-30 12:00:06,10.0.0.6,GET,/health,200,15,4,Prometheus/2.0`;

/**
 * The same log shape, but with a stated limit, so a breach column is honest.
 *
 * Written out in full rather than derived from ACCESS_LOG by string surgery. An
 * earlier version appended the limit_ms HEADER and then patched one row's cells,
 * which left every other row one field short: the parser read user_agent's value
 * into limit_ms and classified it categorical, so the threshold role silently
 * vanished. The symptom was "the breach column will not appear", which reads
 * like a product bug and was a fixture bug. This is the fourth time in this
 * project that a string-replaced fixture has lied; the rule is emerging that
 * fixtures get written out, not assembled.
 */
const WITH_LIMIT = `timestamp,client_ip,method,path,status,response_bytes,duration_ms,limit_ms,user_agent
2026-09-30 12:00:00,10.0.0.1,GET,/home,200,4096,120,500,Mozilla/5.0
2026-09-30 12:00:01,10.0.0.2,GET,/api/orders,200,8192,45,500,Mozilla/5.0
2026-09-30 12:00:02,10.0.0.1,POST,/api/orders,500,128,9800,500,curl/8.0
2026-09-30 12:00:03,10.0.0.3,GET,/home,200,4096,88,500,Mozilla/5.0
2026-09-30 12:00:04,10.0.0.4,GET,/login,302,0,31,500,Mozilla/5.0
2026-09-30 12:00:05,10.0.0.5,PUT,/api/orders,500,128,12400,500,curl/8.0
2026-09-30 12:00:06,10.0.0.6,GET,/health,200,15,4,500,Prometheus/2.0`;

const PEGA = `_time,source_host,alertType,alert_code,elapsed_time,threshold
2026-09-30 12:00:00.000,host-web,performance,PEGA0001,1200,1000
2026-09-30 12:01:00.000,host-bg,performance,PEGA0002,800,1000
2026-09-30 12:02:00.000,host-web,performance,PEGA0001,1300,1000
2026-09-30 12:03:00.000,host-api,performance,PEGA0011,300,1000`;

async function genericAnalysis(text: string) {
  const csv = csvOf(text);
  const schema = await resolveSchemaMemory({ cwd: ".", headers: csv.headers, rows: csv.rows });
  assert.equal(schema?.source, "GENERIC", "the fixture really is being handled generically");
  return { csv, schema, analysis: await analyseBottlenecks(csv, schema) };
}

test("a generic file is described in records, never in alerts", async () => {
  const { analysis } = await genericAnalysis(ACCESS_LOG);
  assert.equal(analysis.vocabulary.unit, "record");
  assert.equal(analysis.vocabulary.unitPlural, "record(s)");
  const md = toBottleneckMarkdown(analysis, "Access log profile");
  assert.ok(!/alert/i.test(md), "not one word of 'alert' survives on a file with no alerts in it");
  assert.match(md, /record\(s\)/, "and the neutral term is actually used");
  assert.match(md, /Record categories by frequency/, "including in the section headings");
});

test("the html says records too", async () => {
  const cwd = await makeTempWorkspace("nf-vocab-");
  const file = await writeFixture(cwd, "access.csv", ACCESS_LOG);
  const csv = await csvRead({ path: file }, { boundary: { check: (p: string) => ({ allowed: true, reason: "t", resolved: p }), assert: (p: string) => p } } as never);
  // The renderer resolves its OWN memory from the workspace, so the vocabulary
  // only appears if that path is wired. Without workspaceCwd there is no schema,
  // no generic profile, and the page says "alert(s)" again -- which is exactly
  // the bug, and why this test goes through renderBottleneckReport rather than
  // calling a renderer with a hand-built analysis.
  const out = await renderBottleneckReport({ path: `${cwd}/r.html`, title: "Access log", csv, workspaceCwd: "configs/.." });
  const page = await import("node:fs/promises").then((fs) => fs.readFile(out.path, "utf8"));
  assert.ok(!/alert/i.test(page), "the page does not call HTTP statuses alerts");
  assert.match(page, /record\(s\)/);
});

test("the breach column is DROPPED, not zeroed, when the file states no threshold", async () => {
  const { analysis } = await genericAnalysis(ACCESS_LOG);
  assert.equal(analysis.vocabulary.thresholdLabel, null, "no threshold column means no threshold label");
  const md = toBottleneckMarkdown(analysis, "Access log profile");
  const header = md.split("\n").find((l) => l.startsWith("| # | category"))!;
  assert.ok(!header.includes("threshold"), "the column header is gone");
  assert.ok(!header.includes("limit"), "and nothing replaced it with an equally unfounded word");
  // The drop has to be REAL: a cell count that no longer matches the header count
  // is how a silently-dropped column turns into a misaligned table.
  const row = md.split("\n").find((l) => l.startsWith("| 1 |"))!;
  assert.equal(row.split("|").length, header.split("|").length, "row and header agree on cell count");
  assert.ok(!md.includes("over threshold"), "and the lead sentence drops it too");
});

test("the breach column APPEARS when the file really does state a limit", async () => {
  const { analysis } = await genericAnalysis(WITH_LIMIT);
  assert.equal(analysis.vocabulary.thresholdLabel, "over limit", "generic wording, because 'threshold' is not what the column is called");
  const md = toBottleneckMarkdown(analysis, "Access log profile");
  assert.match(md, /over limit/, "the column is back, because a zero is now a fact");
  const header = md.split("\n").find((l) => l.startsWith("| # | category"))!;
  const row = md.split("\n").find((l) => l.startsWith("| 1 |"))!;
  assert.equal(row.split("|").length, header.split("|").length, "and the row still lines up");
  // 9800 and 12400 are over the 500 limit; the 200 and 302 rows are not.
  const overLimit = md.split("\n").find((l) => /^\| \d+ \| 500 \|/.test(l))!;
  assert.ok(overLimit.startsWith("| 2 | 500 | 2 |"), `the 500 row is rank 2, 2 rows, and 2 of them breached: ${overLimit}`);
});

test("a Pega export keeps its own vocabulary -- this is not a global neutering", async () => {
  const csv = csvOf(PEGA);
  const schema = await resolveSchemaMemory({ cwd: "configs/..", headers: csv.headers, rows: csv.rows });
  assert.notEqual(schema?.source, "GENERIC");
  const analysis = await analyseBottlenecks(csv, schema);
  assert.equal(analysis.vocabulary.unit, "alert");
  assert.equal(analysis.vocabulary.thresholdLabel, "over threshold");
  const md = toBottleneckMarkdown(analysis, "Bottleneck report");
  assert.match(md, /alert\(s\)/);
  assert.match(md, /Alert categories by frequency/);
  assert.match(md, /over threshold/);
});

test("a Pega export with NO threshold column also drops the breach column", async () => {
  // The zero-brief is not a Pega problem, it is a problem with claiming a count
  // against a limit the file never stated.
  const analysis = await analyseBottlenecks(csvOf(`_time,source_host,alert_code,elapsed_time
2026-09-30 12:00:00.000,host-web,PEGA0001,1200
2026-09-30 12:01:00.000,host-bg,PEGA0002,800`));
  assert.equal(analysis.vocabulary.thresholdLabel, null);
  const md = toBottleneckMarkdown(analysis, "Bottleneck report");
  const header = md.split("\n").find((l) => l.startsWith("| # | category"))!;
  assert.ok(!header.includes("over threshold"), "no column, no all-clear");
});