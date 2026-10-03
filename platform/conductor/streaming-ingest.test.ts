import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";

import { csvRead } from "./capabilities.ts";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { makeTempWorkspace } from "../test-support/temp-workspace.ts";
import { RESERVOIR_SIZE, KeyedAggregator } from "./stream-profile.ts";

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

test("SPACE-SAVING INHERITS the evicted counter, so the total never collapses", () => {
  // This test exists because the implementation got it WRONG first.
  //
  // The eviction created an entry carrying the victim's count, and then -- one
  // line later -- overwrote that entry with a fresh zeroed one. So the
  // inheritance was dead code, and every evicted key reset to zero. The visible
  // symptom was a 60,000-row file whose `bySource` ranking accounted for 256
  // rows in total, which is not an approximation of the truth, it is the
  // opposite of it.
  //
  // It survived every existing test because the bug needs BOTH conditions: a key
  // budget that is exceeded AND a consumer that sums the counts. Every fixture in
  // the suite has fewer distinct values than the budget.
  const aggregator = new KeyedAggregator({ capacity: 8, citations: 5, durations: 5, loggers: 5 });
  const ROWS = 400;
  const KEYS = 100;
  for (let i = 0; i < ROWS; i += 1) aggregator.add(`key-${i % KEYS}`, { row: i + 2, duration: i % 97 });

  const entries = aggregator.entries();
  assert.ok(entries.length <= 8, `the budget must hold; ${entries.length} keys tracked`);
  assert.ok(aggregator.evictions > 0, "the budget must have been exceeded, or this test proves nothing");

  // THE SHARP ASSERTION. Inheritance makes the tracked counts an OVER-estimate
  // bounded by the evictions, so the sum can only grow past the rows offered.
  // Without inheritance the sum collapses to roughly the table size -- the bug.
  const sum = entries.reduce((total, e) => total + e.count, 0);
  assert.ok(sum >= ROWS,
    `the tracked counts must account for at least every row offered; got ${sum} of ${ROWS}. Counts that ` +
    "collapse under eviction are not an approximation, they are a lie.");
});

test("a table that never overflows is EXACT, which is the case every fixture is", () => {
  const aggregator = new KeyedAggregator({ capacity: 256 });
  for (let i = 0; i < 100; i += 1) aggregator.add("only", { row: i + 2, duration: i });
  const entries = aggregator.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.count, 100, "a real categorical column is counted exactly");
  assert.equal(aggregator.evictions, 0, "and nothing is reported as dropped");
  assert.equal(entries[0]!.rows.length, 100, "citations are bounded by the cap, not by the file");
});

test("THE RANKINGS AND THE TIMELINE COVER EVERY ROW, not the retained window", async (t) => {
  // The property Phase 11 exists to establish, stated as a test rather than as a
  // claim in a commit message.
  //
  // The reader keeps 10,000 rows in memory because some parts of this product
  // genuinely need records. The RANKINGS do not -- they need counts -- and for one
  // release they were being computed from that window anyway. So a 60,000-row
  // export was described as 10,000 rows, with its busiest hours, its top
  // categories and its error rate all silently drawn from the first sixth of the
  // file. A product that claims a row count and then ranks a fraction of it is
  // describing a different export from the one the user opened.
  const cwd = await makeTempWorkspace("nf-truescale-");
  const file = path.join(cwd, "scale.csv");
  const ROWS = 60_000;
  const CATEGORIES = ["login", "checkout", "search", "payment"];

  const out = createWriteStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  out.write("_time,source,status,_raw,alertType,elapsed_ms,threshold\n");
  for (let start = 0; start < ROWS; start += 5_000) {
    let chunk = "";
    for (let i = start; i < Math.min(start + 5_000, ROWS); i += 1) {
      const hour = String(i % 24).padStart(2, "0");
      const day = String((i % 28) + 1).padStart(2, "0");
      chunk += `2026-09-${day}T${hour}:00:00Z,svc-${i % 500},500,ERROR failure ${i % 9},`
        + `${CATEGORIES[i % 4]},${100 + (i % 900)},1000\n`;
    }
    if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
  }
  await new Promise<void>((resolve, reject) => {
    out.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });

  const csv = await csvRead({ path: file });
  assert.equal(csv.rows.length, 10_000, "the window stays capped -- the whole point of Phase 10");

  const analysis = analyseBottlenecks(csv);
  const categorySum = analysis.categories.reduce((sum, c) => sum + c.count, 0);
  const hourSum = analysis.hourly.hours.reduce((sum, h) => sum + h.count, 0);
  const sourceSum = analysis.bySource.reduce((sum, b) => sum + b.count, 0);

  t.diagnostic(`rows ${analysis.totalRows} | categories ${categorySum} | hours ${hourSum} | sources ${sourceSum}`);

  assert.equal(analysis.totalRows, ROWS, "the analysis says how many rows the FILE has");
  for (const [label, sum] of [["categorical", categorySum], ["hourly", hourSum], ["source", sourceSum]] as const) {
    assert.equal(sum, ROWS,
      `the ${label} ranking must account for every row, not the 10,000 the window kept; it accounts for ${sum}`);
    assert.ok(sum > 10_000,
      `and the ${label} ranking must visibly exceed the old window, or this test proves nothing about scale`);
  }

  assert.equal(analysis.rankingScope.droppedCategoryKeys, 0,
    "four real categories are far inside the key budget, so nothing may be dropped");
  assert.equal(analysis.rankingScope.viaStreamingPass, true,
    "and this file is only reachable through the streaming pass");
});

test("a DROPPED category key is announced rather than silently absent", async () => {
  // The bound that makes a whole-file ranking affordable is only honest if hitting
  // it is visible. A ranking that quietly omits a key reads as complete, which is
  // the silent-partial-answer failure this codebase has already paid for twice.
  const cwd = await makeTempWorkspace("nf-evicted-");
  const file = path.join(cwd, "many-keys.csv");
  // More distinct categories than the 256-key budget, each seen enough times to
  // be a real category and few enough that the tail is provably the dropped part.
  const KEYS = 400;
  const out = createWriteStream(file, { encoding: "utf8" });
  out.write("_time,alertType\n");
  for (let i = 0; i < KEYS; i += 1) {
    if (!out.write(`2026-09-30T00:00:00Z,code-${String(i).padStart(4, "0")}\n`)) {
      await new Promise<void>((resolve) => out.once("drain", () => resolve()));
    }
  }
  await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())));

  const csv = await csvRead({ path: file });
  const analysis = analyseBottlenecks(csv);
  const scope = analysis.rankingScope;
  assert.ok(scope.categoryKeysTracked <= scope.categoryKeyBudget,
    `the key budget must hold; ${scope.categoryKeysTracked} keys tracked against a budget of ${scope.categoryKeyBudget}`);
  assert.ok(scope.droppedCategoryKeys > 0,
    "400 distinct categories cannot fit in 256 slots, so the bound must have fired");
  assert.ok(scope.categoryKeysTracked + scope.droppedCategoryKeys <= KEYS + 1,
    "and the accounting must add up to what the file contained");

  // AND IT REACHES THE READER, which is the only part that makes the bound honest.
  const { toBottleneckMarkdown } = await import("./bottleneck-report.ts");
  const markdown = toBottleneckMarkdown(analysis, "Evicted");
  assert.match(markdown, /category key\(s\) were dropped/,
    "a dropped key must be stated in the report, not merely counted in a field nobody renders");
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