import test from "node:test";
import assert from "node:assert/strict";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { toBottleneckMarkdown } from "./bottleneck-report.ts";
import { parseCsv } from "./capabilities.ts";
import type { CsvReadResult } from "./capabilities.ts";

/**
 * NAMING THE OUTLIER, NOT JUST SORTING IT ABOVE IT.
 *
 * Sorting by spread did put col_15 at the top, and the Owner was right that this
 * is not detection. A row at the top of a table sorted by max-minus-min is a
 * CONSEQUENCE of being extreme; nothing tells the reader the value is anomalous
 *rather than merely the largest, so nothing tells them whether to investigate.
 * The whole point of an anomaly engine is the difference between "here is the
 * biggest number" and "this number does not belong to this distribution".
 *
 * IQR, NOT Z-SCORE, and for the same reason the hourly detector uses a ratio
 * rather than 2-sigma. A z-score compares a point to the mean and standard
 * deviation OF THE DISTRIBUTION CONTAINING IT, so one absurd value inflates the
 * very sigma it must clear: col_15 has 199 values near zero and one at
 * 9,999,999.99, which drives sigma to roughly 700,000 and puts the point at
 * about 13 sigma -- detectable only because it is so extreme, and a merely
 * awkward 50 against the same column would be invisible. Tukey fences are built
 * from the QUARTILES, which one value cannot move.
 *
 * 1.5x IQR, the standard choice, and the fences are published on every column so
 * a reader can check the judgement rather than accept it. A flag with no
 * threshold stated is an oracle.
 *
 * EIGHT VALUES MINIMUM. Quartiles over four points are interpolation dressed up
 * as a distribution, and flagging an outlier from four samples manufactures
 * certainty. Below the floor the engine says it did not look, which is a
 * different and more honest sentence than "nothing found".
 */

function csvOf(text: string, file = "in.csv"): CsvReadResult {
  const parsed = parseCsv(text);
  const keyed = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return { path: file, headers: parsed.headers, rowCount: keyed.length, columns: [], sample: keyed.slice(0, 5), rows: keyed, problems: parsed.problems };
}

/** A realistic small deterministic noise generator, so fixtures are reproducible. */
function noise(n: number, seed: number): number[] {
  const out: number[] = [];
  let x = seed;
  for (let i = 0; i < n; i += 1) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out.push(Math.round(((x / 2147483648) * 4 - 2) * 1e6) / 1e6);
  }
  return out;
}

function twoColumn(a: readonly number[], b: readonly number[]): string {
  return `c1,c2\n${a.map((x, i) => `${x},${b[i]}`).join("\n")}`;
}

const stat = (text: string, column: string) =>
  analyseBottlenecks(csvOf(text)).numerical.columns.find((c) => c.column === column)!;

test("a value far outside the fences is flagged as an OUTLIER, not merely sorted first", () => {
  const base = noise(19, 7);
  const dirty = [...base, 9999999.99];
  const c1 = stat(twoColumn(dirty, noise(20, 11)), "c1");
  assert.equal(c1.outliers, 1, "the one absurd value is named");
  assert.equal(c1.outlierMax, 9999999.99, "and its magnitude is given");
  assert.equal(c1.method, "IQR", "using a method that survives the outlier");
  assert.ok(c1.fenceUpper !== null && c1.fenceUpper < 100, `the upper fence is ${c1.fenceUpper}, far below the value`);
});

test("the fences are published so the judgement can be checked", () => {
  const c1 = stat(twoColumn([...noise(19, 7), 9999999.99], noise(20, 11)), "c1");
  // 19 values inside roughly [-2, 2]: Q1 about -0.9, Q3 about 0.9, IQR about
  // 1.8, upper fence about 3.6. Asserted loosely because the point is that a
  // NUMBER is exposed, not that this generator's noise lands on a particular one.
  assert.ok(c1.fenceLower !== null && c1.fenceLower > -10, "a lower fence exists and is finite");
  assert.ok(c1.fenceUpper !== null && c1.fenceUpper < 10, "an upper fence exists and is finite");
  assert.ok(c1.fenceUpper! > c1.fenceLower!, "and the fences bracket the data");
});

test("a clean column is not flagged", () => {
  const c1 = stat(twoColumn(noise(20, 3), noise(20, 5)), "c1");
  assert.equal(c1.outliers, 0, "uniform-ish noise has no outliers, and saying so is a real answer");
  assert.equal(c1.outlierMax, null);
});

test("a column that is CONSTANT produces no outliers and does not divide by zero", () => {
  // IQR is 0, so both fences sit on the single value. Every value equals them,
  // so nothing is beyond. The degenerate case is the one most likely to produce
  // Infinity or a spurious flag, so it is pinned rather than assumed.
  const c1 = stat(twoColumn(Array.from({ length: 20 }, () => 7), noise(20, 5)), "c1");
  assert.equal(c1.outliers, 0);
  assert.equal(c1.fenceUpper, 7);
  assert.equal(c1.fenceLower, 7);
});

test("a lone extreme value among identical values IS caught", () => {
  const c1 = stat(twoColumn([...Array.from({ length: 19 }, () => 0), 100], noise(20, 5)), "c1");
  assert.equal(c1.outliers, 1, "one non-zero among nineteen zeroes is exactly the case IQR is good at");
});

test("too few values means the engine says it did not look", () => {
  const c1 = stat(twoColumn([1, 2, 3, 4, 1000], [1, 2, 3, 4, 5]), "c1");
  assert.equal(c1.measured, 5);
  assert.equal(c1.method, null, "no method was applied, and that is stated rather than implied");
  assert.equal(c1.outliers, 0);
  assert.equal(c1.fenceUpper, null, "and no fence is invented");
});

test("the markdown flags the outlier in the table", () => {
  const text = twoColumn([...noise(19, 7), 9999999.99], noise(20, 11));
  const md = toBottleneckMarkdown(analyseBottlenecks(csvOf(text)), "Noisy file");
  assert.match(md, /ANOMALY: OUTLIER/, "the flag appears in the report, not only in the analysis");
  const row = md.split("\n").find((l) => l.includes("ANOMALY: OUTLIER"))!;
  assert.match(row, /^\| \d+ \| c1 \|/, `the flag is on the offending column: ${row}`);
});

test("a clean file prints no outlier flag", () => {
  const md = toBottleneckMarkdown(analyseBottlenecks(csvOf(twoColumn(noise(20, 3), noise(20, 5)))), "Clean file");
  assert.ok(!md.includes("ANOMALY: OUTLIER"), "no false alarm on ordinary data");
});