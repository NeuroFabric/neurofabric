import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";

import { csvRead } from "./capabilities.ts";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { makeTempWorkspace } from "../test-support/temp-workspace.ts";
import { RESERVOIR_SIZE } from "./stream-profile.ts";

/**
 * THE MEMORY WALL, MEASURED.
 *
 * Every other test in this repository holds a fixture in a string and asserts on
 * what came out. That is the right way to test correctness and the wrong way to
 * test MEMORY, because a memory wall is invisible to an assertion: the old
 * reader loaded a whole export as one string and every behavioural test in the
 * suite still passed. It passed at 400 rows. It would have passed at 400,000
 * rows too, right up until the process was killed.
 *
 * So this file measures the thing that actually broke. The claim under test is
 * NOT "the reader is fast" and NOT "the answer is right" -- both are covered
 * elsewhere. It is:
 *
 *   MEMORY IS A FUNCTION OF THE WINDOW, NOT OF THE FILE.
 *
 * === WHY THE TWO SIZES MATTER MORE THAN THE NUMBER ===
 *
 * One size proves nothing. A pipeline that holds a whole file in memory passes
 * at 500,000 rows if the fixture is small enough and fails at 5,000,000, so a
 * single threshold is a claim about a file that does not exist. So the file is
 * read at two sizes an order of magnitude apart and the COMPARISON is the
 * assertion: doubling-plus the data must not double-plus the heap. A reader that
 * scaled with the file shows a heap difference proportional to the row
 * difference; a streaming reader shows a difference that is a few megabytes of
 * window and nothing else.
 *
 * The second assertion is the sharper one and it is about the WRITER: a 500,000
 * row fixture cannot be built with `writeFileSync` inside a test suite without
 * the test itself being the memory problem. So the fixture is written in
 * batches, which means the thing measuring memory is never the thing holding it.
 */

/** The ceiling, as a fraction of the file's own size. See THE THRESHOLD. */
const HEAP_CEILING_MB = 150;

/**
 * Write a CSV in batches, so the test's own memory is flat.
 *
 * This is not incidental. `writeFileSync(lines.join("\n"))` on 500,000 rows
 * builds the entire 40 MB string, holds it, and hands it to the filesystem --
 * which means the process is holding the dataset it is about to measure the
 * reader's memory against, and the reading becomes meaningless.
 */
async function writeLargeCsv(target: string, rows: number): Promise<void> {
  const out = createWriteStream(target, { encoding: "utf8", highWaterMark: 1 << 20 });
  const header = "_time,source_host,alertType,alert_code,elapsed_time,threshold,note\n";
  if (!out.write(header)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));

  const CATEGORIES = ["login", "checkout", "search", "payment"];
  const BATCH = 5_000;
  for (let start = 0; start < rows; start += BATCH) {
    let chunk = "";
    for (let i = start; i < Math.min(start + BATCH, rows); i += 1) {
      // One absurd value in the whole file, planted where a reader would have to
      // have kept every row to notice it: the anomaly this test exists to keep.
      const elapsed = i === rows - 3 ? "99999999" : String(100 + (i % 900));
      const minute = String(i % 60).padStart(2, "0");
      const second = String(i % 60).padStart(2, "0");
      chunk += `2026-09-30 ${String(i % 24).padStart(2, "0")}:${minute}:${second}.000,host-${i % 64},`
        + `${CATEGORIES[i % 4]!},PEGA${String(i % 997).padStart(4, "0")},${elapsed},1000,run ${i}\n`;
    }
    if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
  }
  await new Promise<void>((resolve, reject) => {
    out.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });
}

/** Heap in MB, after a GC has been offered the chance to run. */
function heapMb(): number {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

test("MEMORY IS A FUNCTION OF THE WINDOW, not of the file", async (t) => {
  const cwd = await makeTempWorkspace("nf-stream-");
  const small = path.join(cwd, "small.csv");
  const large = path.join(cwd, "large.csv");
  const SMALL = 50_000;
  const LARGE = 500_000;

  await writeLargeCsv(small, SMALL);
  await writeLargeCsv(large, LARGE);
  const largeBytes = (await stat(large)).size;

  // A baseline taken AFTER the fixtures exist, so the writer's garbage is not
  // counted against the reader. Without this the first measurement inherits the
  // 40 MB the fixture left behind and the comparison is noise.
  if (typeof globalThis.gc === "function") globalThis.gc();
  const before = heapMb();

  const first = await csvRead({ path: small });
  if (typeof globalThis.gc === "function") globalThis.gc();
  const afterSmall = heapMb();

  const second = await csvRead({ path: large });
  if (typeof globalThis.gc === "function") globalThis.gc();
  const afterLarge = heapMb();

  t.diagnostic(`file: ${(largeBytes / (1024 * 1024)).toFixed(1)} MB, ${LARGE} rows`);
  t.diagnostic(`heap before: ${before.toFixed(1)} MB -> after ${SMALL} rows: ${afterSmall.toFixed(1)} MB -> after ${LARGE} rows: ${afterLarge.toFixed(1)} MB`);

  assert.equal(first.rowCount, SMALL, "the small file is read whole");
  assert.equal(second.rowCount, LARGE,
    "and the large file reports its REAL row count. The old reader reported 10,001 for both, which is " +
    "how a 500,000-row export came to be described as '10,001 rows read' with nothing saying otherwise.");

  // THE COMPARISON, which is the actual claim.
  const grew = afterLarge - afterSmall;
  const rowsGrew = LARGE / SMALL;
  assert.ok(grew < 40,
    `reading 10x the rows grew the heap by ${grew.toFixed(1)} MB. A streaming reader's footprint is ` +
    "the window, not the file; growth proportional to rows means something is still holding the dataset.");

  // AND THE ABSOLUTE CEILING, because a comparison alone would be satisfied by
  // two enormous numbers.
  assert.ok(afterLarge < HEAP_CEILING_MB,
    `heapUsed reached ${afterLarge.toFixed(1)} MB, over the ${HEAP_CEILING_MB} MB ceiling. The old reader held ` +
    `the whole ${(largeBytes / (1024 * 1024)).toFixed(0)} MB file as a string before parsing a single row.`);

  await rm(large, { force: true });
});

test("THE RETAINED WINDOW IS CAPPED, and the statistics are not", async (t) => {
  const cwd = await makeTempWorkspace("nf-stream-window-");
  const file = path.join(cwd, "large.csv");
  await writeLargeCsv(file, 60_000);

  const csv = await csvRead({ path: file });
  assert.equal(csv.rowCount, 60_000, "every row counted");
  assert.ok(csv.rows.length <= 10_000,
    `the retained window must stay capped; it kept ${csv.rows.length} rows. This is the part that is allowed to be big.`);
  assert.equal(csv.sample.length, 50, "and the charting sample is still 50");

  // THE PART THAT MATTERS. The window is capped, so anything that needs every
  // row must not be reading it from the window -- and the streamed statistics
  // are not: these counts are over all 60,000 rows.
  const elapsed = csv.columns.find((column) => column.name === "elapsed_time");
  assert.ok(elapsed?.kind === "number", "elapsed_time is numeric");

  const analysis = analyseBottlenecks(csv);
  const stat = analysis.numerical.columns.find((column) => column.column === "elapsed_time");
  assert.ok(stat !== undefined, "the numeric column is described");
  assert.equal(stat!.measured, 60_000,
    `the numeric statistics must cover all 60,000 rows, not the 10,000 the window kept; got ${stat!.measured}`);
  assert.equal(stat!.min, 100, "and the minimum is the file's, not the window's");

  // THE PLANTED VALUE. It sits at row 59,997 -- far outside the window, so an
  // analyser reading the window cannot see it. This is the assertion that says
  // the rewrite changed what the product KNOWS, not only how much memory it uses.
  assert.equal(stat!.max, 99_999_999, "the extreme value past the window is still found");
  assert.ok(stat!.outliers > 0, "and it is still counted as an outlier");
  assert.equal(stat!.quantilesSampled, true,
    "and the quantiles that placed the fence are STATED as sampled rather than presented as a measurement");

  t.diagnostic(`measured ${stat!.measured}, outliers ${stat!.outliers}, fence upper ${stat!.fenceUpper}`);
  await rm(file, { force: true });
});

test("THE OUTLIER COUNT IS EXACT even when the fences were estimated", async (t) => {
  // The reader verifies the count with a second streaming pass, precisely so a
  // figure the user reads as "how many cells are wrong" is a measurement of the
  // FILE and not of the 4096 values the reservoir held.
  const cwd = await makeTempWorkspace("nf-stream-exact-");
  const file = path.join(cwd, "planted.csv");
  const out = createWriteStream(file, { encoding: "utf8" });
  out.write("value\n");
  const rows = 50_000;
  const BAD = 137;
  for (let i = 0; i < rows; i += 1) {
    // Every BAD-th row is absurd; everything else sits in a tight band, so the
    // fences are tight and every planted value must be counted.
    const bad = i > 0 && i % BAD === 0;
    const value = bad ? 5_000_000 : 100 + (i % 20);
    if (!out.write(`${value}\n`)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
  }
  await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));

  const csv = await csvRead({ path: file });
  const expectedBad = Math.floor((rows - 1) / BAD);
  const shot = csv.profile!.outliers!["value"]!;
  assert.equal(shot.outliers, expectedBad,
    `every planted outlier must be counted, not estimated from a sample; expected ${expectedBad}, got ${shot.outliers}`);

  // AND THE STATISTIC IS EXACT TOO: the sum and the mean do not come from a
  // sample at all, at any size.
  const stat = csv.profile!.columns["value"]!;
  assert.equal(stat.measured, rows, "measured over every row");
  assert.equal(stat.min, 100);
  assert.equal(stat.max, 5_000_000);

  t.diagnostic(`planted ${expectedBad} outliers in ${rows} rows, counted ${shot.outliers}`);
  await rm(file, { force: true });
});

test("the reservoir is BOUNDED, which is the whole claim", async () => {
  const cwd = await makeTempWorkspace("nf-reservoir-");
  const file = path.join(cwd, "huge.csv");
  const out = createWriteStream(file, { encoding: "utf8" });
  out.write("value\n");
  const rows = 200_000;
  for (let i = 0; i < rows; i += 1) {
    if (!out.write(`${i % 97}\n`)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
  }
  await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));

  const csv = await csvRead({ path: file });
  const shot = csv.profile!.columns["value"]!;
  assert.equal(shot.measured, rows, "but measured over every one of them");
  assert.equal(shot.sample.length, RESERVOIR_SIZE,
    `the sample must not grow with the column; it holds ${shot.sample.length} values`);
  assert.equal(shot.exact, false, "and it must admit that it is a sample");

  // The sum is exact regardless, which is why the mean is trustworthy at any size.
  let expectedSum = 0;
  for (let i = 0; i < rows; i += 1) expectedSum += i % 97;
  assert.equal(shot.sum, expectedSum, "the sum is exact, because it is accumulated and not sampled");

  await rm(file, { force: true });
});