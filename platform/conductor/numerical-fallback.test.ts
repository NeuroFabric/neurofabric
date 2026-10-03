import test from "node:test";
import assert from "node:assert/strict";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { toBottleneckMarkdown, renderBottleneckReport } from "./bottleneck-report.ts";
import { parseCsv, csvRead } from "./capabilities.ts";
import { makeTempWorkspace, writeFixture } from "../test-support/temp-workspace.ts";
import type { CsvReadResult } from "./capabilities.ts";

/**
 * THE NUMERICAL FALLBACK. A file of numbers is still worth reading.
 *
 * The Owner's random_data_with_issue.csv is 200 rows of 20 anonymous numeric
 * columns with no category, no timestamp and no source. Every ranking this
 * product knows how to compute is empty, so the report was almost empty -- which
 * is the correct conclusion drawn from the wrong question. The file has 4,000
 * numbers in it and the right answer to "what is in this file" is descriptive
 * statistics, not silence.
 *
 * WHICH COLUMNS, AND WHY IT IS A CAP AND NOT A RULE. Twenty numeric columns is
 * four thousand figures and no analysis; a table of twenty min/mean/max rows is
 * a data dictionary with a straight face. So the widest-spread ten are shown and
 * the report SAYS how many it left out. Truncation that is not announced is the
 * thing this codebase already has a rule about, and an unannounced cap here
 * would read as "these are all the numeric columns" when it is not.
 *
 * SPREAD, NOT FILE ORDER. Ten of twenty columns chosen by position would show
 * col_1..col_10 and hide the eleven most informative, so the order is by
 * max minus min. A column where every value is the same is the least
 * informative thing in a numeric file.
 *
 * BLANK AND WRONG-TYPED CELLS ARE COUNTED, NOT ZEROED. The Owner's file has one
 * blank and one cell reading "oops_wrong_type". Both are excluded from the
 * arithmetic and BOTH are reported as a missing count, because a column that
 * silently drops two rows of twenty is not summarising the column. This is the
 * same rule that fixed the duration total two sessions ago, applied to the place
 * it had not reached.
 */

function csvOf(text: string, file = "in.csv"): CsvReadResult {
  const parsed = parseCsv(text);
  const keyed = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return { path: file, headers: parsed.headers, rowCount: keyed.length, columns: [], sample: keyed.slice(0, 5), rows: keyed, problems: parsed.problems };
}

/** Small enough to check the arithmetic by hand. */
const SMALL = `col_1,col_2,col_3,col_4,col_5
1.5,2.25,-3.0,0.5,100
-2.5,4.0,1.25,-1.0,250
3.75,-0.5,2.0,2.5,175
0.0,1.0,-1.5,1.5,225`;

/**
 * Ten rows per column, so ONE bad cell in ten stays above the profiler's 0.8
 * numeric floor and the column is still classified numeric.
 *
 * THE EARLIER VERSION OF THIS FIXTURE HAD THREE ROWS, and one wrong-typed cell
 * in three is 0.67 -- below the floor -- so the profiler classified c1 as
 * CATEGORICAL and excluded the whole column. The profiler was right and the
 * fixture was misrepresenting the Owner's file, where one bad cell in two
 * hundred leaves the column at 0.995. Fixtures that are too small stop testing
 * the thing they are named after.
 */
function dirtyNumeric(width: number, labelCol: boolean): string {
  const names = Array.from({ length: width }, (_, i) => `c${i + 1}`);
  const header = labelCol ? `${names.join(",")},label_col` : names.join(",");
  const rows = Array.from({ length: 10 }, (_, r) => {
    const cells = names.map((_, i) => (r === 9 && i === 0) ? "oops_wrong_type" : (r === 9 && i === 2 ? "" : String(r + i)));
    return labelCol ? `${cells.join(",")},${["alpha", "beta", "gamma"][r % 3]}` : cells.join(",");
  });
  return [header, ...rows].join("\n");
}

/** Five numeric columns, one of them wrongly typed, one of them blank in a row. */
const DIRTY = dirtyNumeric(5, true);

/** Wide enough to trip the ten-column cap. */
const DIRTY_WIDE = dirtyNumeric(12, true);

test("descriptive statistics are computed for the numeric columns", async () => {
  const n = (await analyseBottlenecks(csvOf(SMALL))).numerical;
  const col = (name: string) => n.columns.find((c) => c.column === name)!;
  assert.equal(n.numericColumns, 5, "all five columns are numeric");
  assert.equal(n.rows, 4);
  assert.equal(n.truncated, false);

  const c1 = col("col_1");
  assert.equal(c1.measured, 4);
  assert.equal(c1.min, -2.5);
  assert.equal(c1.max, 3.75);
  assert.equal(c1.spread, 6.25);
  assert.ok(Math.abs((c1.mean ?? 0) - 0.6875) < 1e-9, "1.5 - 2.5 + 3.75 + 0 = 2.75, over 4");

  const c5 = col("col_5");
  assert.equal(c5.min, 100);
  assert.equal(c5.max, 250);
  assert.equal(c5.mean, 187.5, "750 over 4");
});

test("columns are ordered by spread, so the informative ones survive the cap", async () => {
  const n = (await analyseBottlenecks(csvOf(SMALL))).numerical;
  // col_5 spans 150, col_1 spans 6.25, col_3 5, col_2 4.5, col_4 3.5.
  assert.deepEqual(n.columns.map((c) => c.column), ["col_5", "col_1", "col_3", "col_2", "col_4"],
    "widest spread first, and the name breaks ties so the order is stable across runs");
});

test("blank and wrongly-typed cells are counted as missing, never as zero", async () => {
  const n = (await analyseBottlenecks(csvOf(DIRTY))).numerical;
  assert.equal(n.numericColumns, 5, "one bad cell in ten is still a numeric column");
  const c3 = n.columns.find((c) => c.column === "c3")!;
  assert.equal(c3.measured, 9, "the blank cell is not a measurement");
  assert.equal(c3.missing, 1, "and it is reported rather than absorbed");
  assert.equal(c3.min, 2, "and definitely not a 0.0 that would drag the mean down");
  assert.equal(c3.mean, 6, "values 2..10 average 6, over the nine that exist");

  // c1 holds a wrongly-typed cell. The column stays numeric at 0.9, so the
  // summary has to cope with the bad cell per CELL rather than per column.
  const c1 = n.columns.find((c) => c.column === "c1")!;
  assert.equal(c1.measured, 9);
  assert.equal(c1.missing, 1);
});

test("a column that is MOSTLY text is not summarised as a number at all", async () => {
  // The other side of the same floor, and worth pinning because the fix for the
  // test above could have been "stop trusting the profiler". Two of three rows
  // parsing is 0.67, below 0.8, and a column that fails to parse two thirds of
  // the time is text with numbers in it, not a measurement with noise in it.
  const mostlyText = `a,b
1,10
2,20
x,30
y,40
z,50`;
  const n = (await analyseBottlenecks(csvOf(mostlyText))).numerical;
  assert.ok(!n.columns.some((c) => c.column === "a"), "a is text with numbers in it");
  assert.deepEqual(n.columns.map((c) => c.column), ["b"]);
  assert.equal(n.columns[0].measured, 5, "and b, which really is numeric, keeps all five of its values");
  assert.equal(n.columns[0].mean, 30);
});

test("a text column is not summarised as if it were a number", async () => {
  const n = (await analyseBottlenecks(csvOf(DIRTY_WIDE))).numerical;
  assert.ok(!n.columns.some((c) => c.column === "label_col"), "alpha/beta/gamma are not statistics");
  assert.equal(n.numericColumns, 12, "and they are not counted among the numeric columns either");
});

test("more than ten numeric columns are capped, and the cap is announced", async () => {
  const n = (await analyseBottlenecks(csvOf(DIRTY_WIDE))).numerical;
  assert.equal(n.numericColumns, 12, "the file really does have twelve");
  assert.equal(n.columns.length, 10, "ten are shown");
  assert.equal(n.truncated, true, "and the report is told it hid two");
  assert.ok(!n.columns.some((c) => c.column === "c1"),
    "and the hidden ones are the narrowest, which is the point of ordering by spread");

  const md = toBottleneckMarkdown(await analyseBottlenecks(csvOf(DIRTY_WIDE)), "Wide file");
  assert.match(md, /2 further numeric column\(s\) are not shown/, "the markdown says so too");
});

test("markdown renders a Numerical Data Summary with mean, min, max and count", async () => {
  const md = toBottleneckMarkdown(await analyseBottlenecks(csvOf(SMALL)), "Numerical file");
  assert.match(md, /^## Numerical data summary$/m, "the section exists and is named");
  const header = md.split("\n").find((l) => l.startsWith("| # | column"))!;
  for (const h of ["measured", "empty", "dirty", "min", "max", "mean", "spread"]) {
    assert.ok(header.includes(h), `the ${h} column is present`);
  }
  const row = md.split("\n").find((l) => l.startsWith("| 1 |"))!;
  assert.ok(row.includes("| 250 |") && row.includes("| 100 |") && row.includes("| 187.5 |"),
    `the widest-spread column carries its min, max and mean: ${row}`);
});

test("the summary appears where the ranking tables would have been", async () => {
  const md = toBottleneckMarkdown(await analyseBottlenecks(csvOf(SMALL)), "Numerical file");
  assert.match(md, /No categorical columns found/, "and the reader is told what was skipped");
  assert.match(md, /## Numerical data summary/, "and given the analysis that IS available");
  // The empty ranking headings must not reappear alongside it.
  assert.ok(!md.includes("categories by frequency"));
});

test("a file WITH categories is not given a numerical summary", async () => {
  // The fallback is a fallback. A Pega export has 24 rows of alert codes and a
  // threshold, and a min/mean/max table of four elapsed figures would displace
  // the answer that actually matters.
  const md = toBottleneckMarkdown(await analyseBottlenecks(csvOf(`_time,source_host,alert_code,elapsed_time,threshold
2026-09-30 12:00:00.000,host-web,PEGA0001,1200,1000
2026-09-30 12:01:00.000,host-bg,PEGA0002,800,1000`)), "Bottleneck report");
  assert.ok(!md.includes("Numerical data summary"), "no fallback on a file with a ranking");
  assert.match(md, /categories by frequency/);
});

test("the html renders it too", async () => {
  const cwd = await makeTempWorkspace("nf-num-");
  const file = await writeFixture(cwd, "numeric.csv", SMALL);
  const csv = await csvRead({ path: file }, { boundary: { check: (p: string) => ({ allowed: true, reason: "t", resolved: p }), assert: (p: string) => p } } as never);
  const out = await renderBottleneckReport({ path: `${cwd}/r.html`, title: "Numeric", csv });
  const page = await import("node:fs/promises").then((fs) => fs.readFile(out.path, "utf8"));
  assert.match(page, /Numerical data summary/);
  assert.match(page, /mean/);
});