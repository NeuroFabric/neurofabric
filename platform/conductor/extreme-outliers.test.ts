import test from "node:test";
import assert from "node:assert/strict";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { toBottleneckMarkdown } from "./bottleneck-report.ts";
import { parseCsv } from "./capabilities.ts";
import type { CsvReadResult } from "./capabilities.ts";

/**
 * 1.5x IQR IS TOO NOISY TO AUTOMATE A WARNING ON.
 *
 * FOUND BY RUNNING THE OWNER'S OWN FILE. random_data_with_issue.csv is 200 rows
 * of standard-normal noise, 4,000 values across 20 columns. A 1.5x-IQR fence
 * flags roughly 1.4 per cent of a normal distribution BY DEFINITION, so it
 * reported 37 "outliers" across 17 columns. That is statistically correct and
 * completely useless as a report: the one genuine finding, col_15 at
 * 9,999,999.99, was a single clause among seventeen, and a reader learned
 * nothing from the other sixteen.
 *
 * So the engine now computes BOTH fences and the health section reports only the
 * OUTER one, at 3x IQR. On normal noise that flags about 3 in 10,000, so a clean
 * random file reports nothing, and col_15 still stands out by six orders of
 * magnitude. That is the behaviour that makes a warning worth reading.
 *
 * THE 1.5x COUNT IS STILL COMPUTED AND STILL PUBLISHED, because the tabular
 * summary is a different job from the warning. A reader comparing two columns
 * wants the conventional outlier count; an automated health line wants the one
 * that means something. Deleting the marginal count would make the table
 * wrong, and silencing it entirely would lose a real statistical statement.
 *
 * FIXTURES AND THE BOUNDARIES, since the house rule is that a fixture sitting on
 * a threshold must say so. Three floors matter here and all three are crossed
 * explicitly and documented at the point of use: the profiler's 0.8 numeric
 * ratio, the 8-sample minimum for a fence at all, and now the 1.5-versus-3x
 * fence separation, which is the whole subject of this file.
 */

function csvOf(text: string, file = "in.csv"): CsvReadResult {
  const parsed = parseCsv(text);
  const keyed = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return { path: file, headers: parsed.headers, rowCount: keyed.length, columns: [], sample: keyed.slice(0, 5), rows: keyed, problems: parsed.problems };
}

/** Deterministic pseudo-noise, so every expectation below is reproducible. */
function noise(n: number, seed: number): number[] {
  const out: number[] = [];
  let x = seed;
  for (let i = 0; i < n; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(Math.round(((x / 2147483648) * 4 - 2) * 1e6) / 1e6);
  }
  return out;
}

const stat = async (text: string, column: string) =>
   (await analyseBottlenecks(csvOf(text))).numerical.columns.find((c) => c.column === column)!;

/**
 * 24 values, comfortably over the 8-sample floor, with a spread tight enough to
 * leave room between the two fences. The appended value sits at 1000 while the
 * 1.5x fence lands near 4, so it clears BOTH -- which is not what this file is
 * about.
 *
 * For the MARGINAL case the value is placed at 6, which clears 1.5x and not 3x.
 * That placement is the entire subject of the file, so it is spelled out:
 * with IQR near 1, the outer fence is roughly Q3 + 3, and Q3 is near 1.
 */
const base = noise(24, 17);
const spread24 = (extra: number) => `c1,c2\n${[...base, extra].map((v, i) => `${v},${i}`).join("\n")}`;

test("an extreme value clears BOTH fences", async () => {
  const c1 = await stat(spread24(1000), "c1");
  assert.equal(c1.outliers, 1, "beyond the conventional 1.5x fence");
  assert.equal(c1.extremeOutliers, 1, "and beyond the 3x outer fence, which is what the report says");
  assert.ok(c1.fenceExtremeUpper !== null && c1.fenceExtremeUpper < 100, `the outer fence is ${c1.fenceExtremeUpper}`);
});

test("a MARGINAL outlier clears 1.5x and NOT 3x, and that is the case this file exists for", async () => {
  // The boundary under test, placed deliberately. With IQR near 1, 1.5x puts the
  // fence near Q3+1.5 (about 2.5) and 3x puts it near Q3+3 (about 4), so a value
  // of 6 is unambiguous: standard-outlier, not extreme.
  const c1 = await stat(spread24(6), "c1");
  assert.equal(c1.outliers, 1, "it IS a conventional outlier");
  assert.equal(c1.extremeOutliers, 0, "and it is NOT extreme");
  assert.ok(c1.outlierMax === 6);
  // Both fences are still published, so the distinction is checkable.
  assert.ok(c1.fenceUpper !== null && c1.fenceUpper < 6, "beyond the 1.5x fence");
  assert.ok(c1.fenceExtremeUpper !== null && c1.fenceExtremeUpper > 6, "inside the 3x fence");
});

test("a clean column has neither", async () => {
  const c1 = await stat(`c1,c2\n${noise(20, 3).map((v, i) => `${v},${i}`).join("\n")}`, "c1");
  assert.equal(c1.outliers, 0);
  assert.equal(c1.extremeOutliers, 0);
});

test("THE HEALTH SECTION REPORTS ONLY THE EXTREME COUNT", async () => {
  const marginal = toBottleneckMarkdown(await analyseBottlenecks(csvOf(spread24(6))), "Marginal");
  assert.ok(!/Extreme values/.test(marginal),
    `a marginal outlier must not raise a warning:\n${marginal.split("## Data health insights")[1]?.slice(0, 400)}`);

  const extreme = toBottleneckMarkdown(await analyseBottlenecks(csvOf(spread24(1000))), "Extreme");
  assert.match(extreme, /Extreme values/, "an extreme one must");
});

test("the marginal count is still in the table, because that is a different job", async () => {
  const md = toBottleneckMarkdown(await analyseBottlenecks(csvOf(spread24(6))), "Marginal");
  // Located BY NAME, not by row number. The summary is ordered by spread, and
  // c2 (0..24) has a wider spread than c1, so the offending column is not row 1.
  const row = md.split("\n").find((l) => /^\| \d+ \| c1 \|/.test(l))!;
  assert.match(row, /ANOMALY: OUTLIER/, "the conventional count is still reported per column");
  // ...and the health section stayed quiet about it, which is the point.
  assert.ok(!/Extreme values/.test(md), "while the automated warning does not fire");
});

test("below the 8-sample floor NO fence is computed at either width", async () => {
  // The sample floor is crossed DOWNWARD deliberately, and the point is that a
  // short column produces no claim of any kind rather than a confident one.
  const c1 = await stat(`c1,c2\n1,1\n2,2\n3,3\n4,4\n1000,5\n6,6\n7,7\n8,8\n9,9\n10,10`, "c1");
  assert.equal(c1.measured, 10, "ten values, so this one IS above the floor");
  const short = await stat(`c1,c2\n1,1\n2,2\n3,3\n4,4\n1000,5`, "c1");
  assert.equal(short.measured, 5, "five values, below it");
  assert.equal(short.method, null);
  assert.equal(short.outliers, 0);
  assert.equal(short.extremeOutliers, 0);
  assert.equal(short.fenceExtremeUpper, null, "no outer fence is invented either");
});
