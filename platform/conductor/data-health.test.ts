import test from "node:test";
import assert from "node:assert/strict";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { toBottleneckMarkdown, renderBottleneckReport } from "./bottleneck-report.ts";
import { parseCsv, csvRead } from "./capabilities.ts";
import { makeTempWorkspace, writeFixture } from "../test-support/temp-workspace.ts";
import type { CsvReadResult } from "./capabilities.ts";

/**
 * THE SECTION THAT SAYS WHAT IS WRONG, IN SENTENCES.
 *
 * Dirty counts and outlier flags are the ingredients. A reader still has to find
 * them in a table, and a table row reading "c7 | 200 | 0 | 1 | ..." is not the
 * same as being told "column c7 contains a type-mismatched string". The second
 * one is actionable; the first is a lookup.
 *
 * THE SCOPE IS EVERY NUMERIC COLUMN, NOT THE TEN THAT GET DISPLAYED. This is the
 * part that is easy to get wrong and matters most: the numerical summary caps at
 * ten columns and says so, but a health check that read only those ten would
 * report "no dirty data" while a dirty column sat silently in the hidden ten.
 * A health report that is scoped to the visible rows is worse than none, because
 * it issues a clean bill of health for a file that is not clean.
 *
 * Health is also computed for a Pega-shaped file and simply finds nothing to say,
 * rather than being omitted -- the section's presence then means "checked", and
 * its absence would mean "not looked at".
 */

function csvOf(text: string, file = "in.csv"): CsvReadResult {
  const parsed = parseCsv(text);
  const keyed = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return { path: file, headers: parsed.headers, rowCount: keyed.length, columns: [], sample: keyed.slice(0, 5), rows: keyed, problems: parsed.problems };
}

function noise(n: number, seed: number): number[] {
  const out: number[] = [];
  let x = seed;
  for (let i = 0; i < n; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(Math.round(((x / 2147483648) * 4 - 2) * 1e6) / 1e6);
  }
  return out;
}

/** Two bad columns in one file, exactly the shape the Owner reported. */
const MESSY = (() => {
  const cleanA = noise(20, 3);
  const cleanB = noise(20, 5);
  const withOutlier = [...noise(19, 7), 9999999.99];
  const withDirty = noise(20, 13);
  withDirty[4] = "oops_wrong_type";
  return `c1,c2,c3,c4\n${withDirty.map((v, i) => `${v},${cleanA[i]},${cleanB[i]},${withOutlier[i]}`).join("\n")}`;
})();

const CLEAN = (() => {
  const a = noise(20, 3);
  const b = noise(20, 5);
  return `c1,c2\n${a.map((v, i) => `${v},${b[i]}`).join("\n")}`;
})();

test("dirty cells are counted per column and named", () => {
  const h = analyseBottlenecks(csvOf(MESSY)).health;
  assert.equal(h.dirtyColumns, 1);
  assert.equal(h.dirtyCells, 1);
  const c1 = h.columns.find((c) => c.column === "c1")!;
  assert.equal(c1.dirty, 1);
  assert.deepEqual(c1.examples, ["oops_wrong_type"], "and the offending value is carried through");
});

test("outliers are counted per column, with the magnitude", () => {
  const h = analyseBottlenecks(csvOf(MESSY)).health;
  assert.equal(h.outlierColumns, 1);
  assert.equal(h.outlierCells, 1);
  const c4 = h.columns.find((c) => c.column === "c4")!;
  assert.equal(c4.outliers, 1);
  assert.equal(c4.worstValue, 9999999.99);
  assert.ok(c4.fence !== null, "the fence it cleared is carried, so the claim is checkable");
});

test("a clean file says so, rather than saying nothing", () => {
  const h = analyseBottlenecks(csvOf(CLEAN)).health;
  assert.equal(h.dirtyColumns, 0);
  assert.equal(h.outlierColumns, 0);
  assert.equal(h.clean, true, "clean is a finding, not the absence of one");
  const md = toBottleneckMarkdown(analyseBottlenecks(csvOf(CLEAN)), "Clean");
  assert.match(md, /No dirty cells and no statistical outliers/, "and the report states it in words");
});

test("health covers EVERY numeric column, including the ones the summary hides", () => {
  // The whole reason health is a separate pass. Twenty numeric columns, the
  // summary shows ten, and the dirty one is deliberately CONSTANT -- spread
  // zero, so it sorts last and is hidden. My first attempt gave it a huge
  // spread, which put it FIRST and quietly tested the opposite of what this
  // test is about.
  const width = 20;
  const names = Array.from({ length: width }, (_, i) => `c${i + 1}`);
  const rows: string[] = [];
  for (let r = 0; r < 20; r += 1) {
    const cells = names.map((_, i) => (i === width - 1 ? (r === 4 ? "oops_wrong_type" : "3") : String(r + i)));
    rows.push(cells.join(","));
  }
  const text = [[...names].join(","), ...rows].join("\n");
  const a = analyseBottlenecks(csvOf(text));
  assert.equal(a.numerical.truncated, true, "the summary really does hide ten columns");
  assert.ok(!a.numerical.columns.some((c) => c.column === "c20"), "and c20 is one of the hidden");
  assert.equal(a.health.dirtyColumns, 1, "yet health still finds it");
  assert.equal(a.health.columns[0].column, "c20");
});

test("markdown puts the health section ABOVE the numerical summary", () => {
  const md = toBottleneckMarkdown(analyseBottlenecks(csvOf(MESSY)), "Messy");
  const healthAt = md.indexOf("## Data health insights");
  const summaryAt = md.indexOf("## Numerical data summary");
  assert.ok(healthAt !== -1, "the section exists");
  assert.ok(healthAt < summaryAt, "and comes first: what is wrong outranks what the numbers are");
});

test("the warning names the column, the count and the offending value", () => {
  const md = toBottleneckMarkdown(analyseBottlenecks(csvOf(MESSY)), "Messy");
  assert.match(md, /Data Quality Warning/, "it is labelled as a warning");
  assert.match(md, /c1/, "it names the column");
  assert.match(md, /type-mismatched/, "it says what kind of problem it is");
  assert.match(md, /oops_wrong_type/, "and shows the value, so it can be found in the raw file");
});

test("the outlier warning states the value and the fence it cleared", () => {
  const md = toBottleneckMarkdown(analyseBottlenecks(csvOf(MESSY)), "Messy");
  assert.match(md, /c4/, "names the column");
  assert.match(md, /outlier/i, "says what it found");
  assert.match(md, /9,999,999\.99/, "with the magnitude");
});

test("the html renders it too", async () => {
  const cwd = await makeTempWorkspace("nf-health-");
  const file = await writeFixture(cwd, "messy.csv", MESSY);
  const csv = await csvRead({ path: file }, { boundary: { check: (p: string) => ({ allowed: true, reason: "t", resolved: p }), assert: (p: string) => p } } as never);
  const out = await renderBottleneckReport({ path: `${cwd}/r.html`, title: "Messy", csv });
  const page = await import("node:fs/promises").then((fs) => fs.readFile(out.path, "utf8"));
  assert.match(page, /Data health insights/);
  assert.match(page, /Data Quality Warning/);
  assert.ok(page.indexOf("Data health insights") < page.indexOf("Numerical data summary"), "same order as the markdown");
});

test("a Pega-shaped file gets the section too, reporting that it found nothing", () => {
  const md = toBottleneckMarkdown(analyseBottlenecks(csvOf(`_time,source_host,alert_code,elapsed_time,threshold
2026-09-30 12:00:00.000,host-web,PEGA0001,1200,1000
2026-09-30 12:01:00.000,host-bg,PEGA0002,800,1000
2026-09-30 12:02:00.000,host-web,PEGA0001,1300,1000`)), "Bottleneck report");
  // Presence means checked; absence would mean not looked at.
  assert.match(md, /## Data health insights/, "the section is present even when there is nothing wrong");
  assert.match(md, /No dirty cells and no statistical outliers/, "and it says so");
});