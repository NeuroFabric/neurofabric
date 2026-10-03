import test from "node:test";
import assert from "node:assert/strict";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { parseCsv } from "./capabilities.ts";
import type { CsvReadResult } from "./capabilities.ts";

/**
 * A BLANK AND A GARBAGE STRING ARE DIFFERENT FACTS.
 *
 * The numerical fallback lumped them together as "missing", and the Owner called
 * that failing the data-scientist test, correctly. In his 200-row file, col_7
 * holds one cell reading "oops_wrong_type". Reporting that as a MISSING value is
 * not a rounding error, it is a different DIAGNOSIS with a different REMEDY:
 *
 *   EMPTY  -- the cell is blank. The pipeline that wrote it dropped a value.
 *            Usually a null, and usually benign.
 *   DIRTY  -- the cell holds something, and it is not a number. Something wrote
 *            TEXT into a numeric column. That is a type mismatch, and it is the
 *            signature of a broken producer, a bad cast, a locale change, or a
 *            column that is not what its name says.
 *
 * Both are "not a measurement", which is why they were conflated. But the report
 * is a diagnostic instrument: a blank and a corrupted row call for completely
 * different investigations, and reporting them identically means a reader has to
 * go find the raw file to learn which one they are looking at. A health report
 * that cannot tell you WHICH is not a health report.
 *
 * `missing` is kept as the sum, because "this many cells were not usable" is
 * still a true and useful sentence, and because renaming it would churn every
 * existing assertion for no gain. The two new counts are what carry the
 * diagnosis.
 */

function csvOf(text: string, file = "in.csv"): CsvReadResult {
  const parsed = parseCsv(text);
  const keyed = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return { path: file, headers: parsed.headers, rowCount: keyed.length, columns: [], sample: keyed.slice(0, 5), rows: keyed, problems: parsed.problems };
}

/**
 * A rectangular grid, at least TWO columns wide.
 *
 * Two columns minimum is not decoration. With a single column a blank cell is
 * an empty LINE, and the CSV reader counts rows rather than guessing -- so a
 * fixture testing "one blank cell" was silently testing "one fewer row", and
 * the blank never reached the profiler at all.
 */
function grid(width: number, rowCount: number, extra?: Record<string, Record<number, string>>): string {
  const names = Array.from({ length: Math.max(2, width) }, (_, i) => `c${i + 1}`);
  const rows = Array.from({ length: rowCount }, (_, r) =>
    names.map((name, i) => extra?.[name]?.[r] ?? String(r + i)).join(","));
  return [[...names].join(","), ...rows].join("\n");
}

const columns = (width: number, extra?: Record<string, Record<number, string>>): string => grid(width, 10, extra);

const stat = async (text: string, column: string) =>
   (await analyseBottlenecks(csvOf(text))).numerical.columns.find((c) => c.column === column)!;

test("a string in a numeric column is DIRTY, and an empty cell is EMPTY", async () => {
  const text = columns(2, { c1: { 3: "oops_wrong_type" }, c2: { 4: "" } });
  const c1 = await stat(text, "c1");
  const c2 = await stat(text, "c2");

  assert.equal(c1.dirty, 1, "a string in a float column is a type mismatch");
  assert.equal(c1.empty, 0, "and it is not a blank");
  assert.equal(c2.empty, 1, "a whitespace cell is empty");
  assert.equal(c2.dirty, 0, "and it is not a type mismatch");
});

test("missing remains the sum of the two, so the old sentence stays true", async () => {
  const text = columns(2, { c1: { 2: "oops" }, c2: { 5: "" } });
  const c1 = await stat(text, "c1");
  const c2 = await stat(text, "c2");
  assert.equal(c1.dirty, 1, "c1 holds a string");
  assert.equal(c1.empty, 0);
  assert.equal(c1.missing, 1);
  assert.equal(c2.empty, 1, "c2 holds a blank");
  assert.equal(c2.dirty, 0);
  assert.equal(c2.missing, 1);
  assert.equal(c1.measured, 9, "and each still counts only its own good cells");
  assert.equal(c2.measured, 9);
});

test("neither count ever reaches the arithmetic", async () => {
  // c1's first row is a string and c2's second is blank. Each vanishes from its
  // OWN column's arithmetic, so c1 runs 1..9: min 1, mean 5.
  const text = columns(2, { c1: { 0: "oops" }, c2: { 1: "" } });
  const c1 = await stat(text, "c1");
  assert.equal(c1.min, 1, "not 0: the string never became a zero");
  assert.equal(c1.measured, 9);
  assert.equal(c1.mean, 5);
});

test("the offending value is shown, so a reader can act on it", async () => {
  // "1 type-mismatched cell" is a symptom. "the cell reads oops_wrong_type" is
  // a diagnosis the reader can take to whoever produces the file. The count
  // alone sends them back to the raw data to find it.
  const text = columns(2, { c1: { 4: "oops_wrong_type" } });
  assert.deepEqual((await stat(text, "c1")).dirtyExamples, ["oops_wrong_type"]);
});

test("examples are deduplicated and capped, so a broken column cannot flood the report", async () => {
  // 20 rows, so 3 dirty in 20 is 0.85 and the column stays numeric. At ten rows
  // three dirty was enough to drop it under the profiler's 0.8 floor and the
  // whole column was reclassified as text -- a correct profiler decision that
  // made this test untestable.
  const text = grid(2, 20, { c1: { 2: "N/A", 7: "N/A", 11: "N/A" } });
  const c1 = await stat(text, "c1");
  assert.equal(c1.dirty, 3, "the count is the truth");
  assert.deepEqual(c1.dirtyExamples, ["N/A"], "but the same value is listed once");
  assert.equal(c1.measured, 17);
});

test("a fully clean column reports zeros, not nulls", async () => {
  const c1 = await stat(columns(2), "c1");
  assert.equal(c1.dirty, 0);
  assert.equal(c1.empty, 0);
  assert.deepEqual(c1.dirtyExamples, []);
});

test("a column that is ENTIRELY dirty is not summarised as numeric at all", async () => {
  // The profiler should never hand this through -- below the numeric floor it
  // is categorical -- but if the two ever disagree, the counts must still be
  // coherent rather than producing a mean over nothing.
  const text = `c1\nN/A\nN/A\nN/A\nnope\nnil\n-\n?\n--\n+\nx`;
  const n = (await analyseBottlenecks(csvOf(text))).numerical;
  const c1 = n.columns.find((c) => c.column === "c1");
  if (c1 !== undefined) {
    assert.equal(c1.measured, 0);
    assert.equal(c1.mean, null, "no mean is computed from nothing");
    assert.ok(c1.dirty + c1.empty === 10);
  } else {
    assert.equal(n.numericColumns, 0, "correctly never classified numeric at all");
  }
});