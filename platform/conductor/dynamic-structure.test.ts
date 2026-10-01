import test from "node:test";
import assert from "node:assert/strict";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { toBottleneckMarkdown, renderBottleneckReport } from "./bottleneck-report.ts";
import { parseCsv, csvRead } from "./capabilities.ts";
import { makeTempWorkspace, writeFixture } from "../test-support/temp-workspace.ts";
import type { CsvReadResult } from "./capabilities.ts";

/**
 * THE REPORT'S STRUCTURE FOLLOWS THE DATA, NOT THE TEMPLATE.
 *
 * A table heading is a claim: "Alert categories by frequency" says there are
 * categories and that one of them leads. When the file has no categorical column
 * at all, printing that heading and then an empty body produces a report that is
 * confidently answering a question nobody asked -- a form with the word
 * "RESULTS" on it and nothing inside. Worse, an empty table reads as "we looked
 * and found none", which is a DIFFERENT and much stronger claim than "this file
 * has nothing to rank on", and only one of them is true.
 *
 * So the tables are conditional. What replaces them is one line saying what was
 * looked for and not found, which is the version a reader can act on.
 *
 * Empty SECTIONS are removed; empty CELLS are not. A duration the file cannot
 * measure is an em-dash inside a real table, because there the column exists and
 * one value is missing -- a different fact from the whole ranking being absent.
 */

function csvOf(text: string, file = "in.csv"): CsvReadResult {
  const parsed = parseCsv(text);
  const keyed = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return { path: file, headers: parsed.headers, rowCount: keyed.length, columns: [], sample: keyed.slice(0, 5), rows: keyed, problems: parsed.problems };
}

/** No categorical column anywhere: nothing can be ranked. */
const NUMERIC_ONLY = `col_1,col_2,col_3,col_4,col_5
1.5,2.25,-3.0,0.5,100
-2.5,4.0,1.25,-1.0,250
3.75,-0.5,2.0,2.5,175
0.0,1.0,-1.5,1.5,225`;

/** Categorical, so the tables must still be there. */
const CATEGORICAL = `_time,source_host,alert_code,elapsed_time,threshold
2026-09-30 12:00:00.000,host-web,PEGA0001,1200,1000
2026-09-30 12:01:00.000,host-bg,PEGA0002,800,1000
2026-09-30 12:02:00.000,host-web,PEGA0001,1300,1000
2026-09-30 12:03:00.000,host-api,PEGA0011,300,1000`;

test("a file with no categorical column prints NO ranking headings", () => {
  const analysis = analyseBottlenecks(csvOf(NUMERIC_ONLY));
  assert.equal(analysis.categoryColumn, null, "the fixture really has nothing to rank on");
  assert.equal(analysis.categories.length, 0);
  assert.equal(analysis.categoriesByElapsed.length, 0);

  const md = toBottleneckMarkdown(analysis, "Numerical file");
  assert.ok(!md.includes("categories by frequency"), "no frequency heading");
  assert.ok(!md.includes("categories by total elapsed"), "no elapsed heading");
  assert.ok(!md.includes("#1 by frequency"), "no headline about a leader that does not exist");
  // NOT "no row starting | 1 |". The numerical fallback table has one, and it is
  // a real result. This assertion used to sweep that up and has to name the
  // RANKING tables specifically, which is what it was always trying to say.
});

test("the one-line note says what was missing, in plain words", () => {
  const md = toBottleneckMarkdown(analyseBottlenecks(csvOf(NUMERIC_ONLY)), "Numerical file");
  assert.match(md, /^> No categorical columns found; skipping categorical rankings\.$/m,
    "exactly the agreed sentence, as its own line");
});

test("the provenance table is omitted too when NO column could be read as a role", () => {
  // Found by running the OWNER'S ACTUAL FILE rather than by reasoning about it.
  // A header with no body is the same defect as an empty ranking table, and it
  // was still there: twenty columns named col_1..col_20 match no role candidate
  // at all, so the report printed role/column/basis/note over zero readings.
  const md = toBottleneckMarkdown(analyseBottlenecks(csvOf(NUMERIC_ONLY)), "Numerical file");
  assert.ok(!md.includes("| role | column | basis | note |"), "no empty provenance table");
  assert.match(md, /no readings to report/, "and it says what that means");
  // The gap statement is real information and must survive.
  assert.match(md, /cannot answer anything requiring/, "what could not be answered is still reported");
});

test("a categorical file still gets both tables", () => {
  const md = toBottleneckMarkdown(analyseBottlenecks(csvOf(CATEGORICAL)), "Bottleneck report");
  assert.match(md, /## Record categories by frequency/);
  assert.match(md, /## Record categories by total elapsed time/);
  assert.ok(!md.includes("skipping categorical rankings"), "and the note does not appear when there is something to say");
});

test("the html omits the tables too, rather than rendering empty ones", async () => {
  const cwd = await makeTempWorkspace("nf-struct-");
  const file = await writeFixture(cwd, "numeric.csv", NUMERIC_ONLY);
  const csv = await csvRead({ path: file }, { boundary: { check: (p: string) => ({ allowed: true, reason: "t", resolved: p }), assert: (p: string) => p } } as never);
  const out = await renderBottleneckReport({ path: `${cwd}/r.html`, title: "Numeric", csv });
  const page = await import("node:fs/promises").then((fs) => fs.readFile(out.path, "utf8"));
  assert.ok(!page.includes("categories by frequency"), "no heading for a ranking that does not exist");
  // NOT "no <tbody> anywhere". The provenance table is real and must survive --
  // it is what tells a reader the file has columns and what was inferred about
  // them. Blanket-asserting the absence of tables would pass by deleting
  // something true.
  assert.ok(!/<h2>[^<]*categor/i.test(page), "no section heading claims a categorical ranking");
  // The page still explains itself rather than just being shorter.
  assert.match(page, /No categorical columns found/, "the same note, so both renderings agree");
  assert.match(page, /<h2>How this page was read<\/h2>/, "and the provenance table is still there");
});

test("a table with an UNMEASURABLE column still renders -- absence of a row is not absence of data", () => {
  // The distinction this whole change must not blur. The RANKING exists here;
  // one duration is unknown. Dropping the table would throw away a real answer
  // because one cell was empty, which is the opposite mistake.
  const md = toBottleneckMarkdown(analyseBottlenecks(csvOf(`_time,source_host,alert_code
2026-09-30 12:00:00.000,host-web,PEGA0001
2026-09-30 12:01:00.000,host-bg,PEGA0002`)), "Bottleneck report");
  assert.match(md, /## Record categories by frequency/, "the ranking is real and stays");
  assert.match(md, /not measurable/, "with an honest gap inside it");
  assert.ok(!md.includes("skipping categorical rankings"));
});