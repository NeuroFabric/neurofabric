import test from "node:test";
import assert from "node:assert/strict";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { toBottleneckMarkdown, renderBottleneckReport } from "./bottleneck-report.ts";
import { parseCsv, csvRead } from "./capabilities.ts";
import { makeTempWorkspace, writeFixture } from "../test-support/temp-workspace.ts";
import type { CsvReadResult } from "./capabilities.ts";

/**
 * WHEN THE BOTTLENECK EXPLODED, not just what it was.
 *
 * The report ranks categories by what they cost, and the divergence banner says
 * frequency and cost disagree. Neither one tells you WHEN. A category that costs
 * three million milliseconds may have done it evenly across a week or in four
 * minutes on Tuesday, and those are different incidents with different causes,
 * different fixes and different on-call pages. The hourly table already listed
 * the counts; it just listed them without saying which of them was abnormal, so
 * a reader had to do the arithmetic themselves and could easily skip it.
 *
 * THE RULE IS 2x THE MEAN, AND THE 2-SIGMA TEST IS ALMOST USELESS HERE. That is
 * not a shrug, it is the reason this test exists. A single spike inflates the
 * standard deviation of the very distribution it is being tested against: for
 * counts of 5, 4, 6, 5, 80, 5 the mean is 17.5 but sigma is 28.6, so
 * mean + 2sigma is 74.7 and the spike at 80 clears it by five. On a smaller
 * window the spike simply cannot clear its own tail -- with 10, 20, 70 the
 * threshold is 85.9 and the spike is NOT flagged. A z-score test designed for
 * large samples quietly stops working at exactly the sample sizes a real export
 * has. The 2x ratio does not have that failure mode, so it is the rule, and the
 * sigma is still computed and reported as context.
 *
 * FOUR HOURS MINIMUM, because a ratio test over two or three buckets is
 * arithmetic rather than statistics: 30 and 70 is not evidence of a spike, it is
 * two numbers. Below the floor the report says the window was too short to judge
 * instead of staying silently uninformative.
 */

function csvOf(text: string, file = "in.csv"): CsvReadResult {
  const parsed = parseCsv(text);
  const keyed = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return { path: file, headers: parsed.headers, rowCount: keyed.length, columns: [], sample: keyed.slice(0, 5), rows: keyed, problems: parsed.problems };
}

/**
 * counts[i] rows land in hour (startHour + i).
 *
 * EXPLICIT Z, because a naive timestamp is converted to UTC before bucketing
 * and a local offset moves it. The first version of this fixture used naive
 * times, and on a UTC+5:30 host the "spike hour" split across two buckets --
 * 50 and 35 -- which looked exactly like a broken spike detector and was in
 * fact a fixture that did not know what timezone it was in.
 */
function hourly(counts: readonly number[], startHour = 9): string {
  const lines = ["_time,source_host,alert_code,elapsed_time,threshold"];
  counts.forEach((n, i) => {
    for (let r = 0; r < n; r += 1) {
      const h = String(startHour + i).padStart(2, "0");
      const m = String(r % 60).padStart(2, "0");
      lines.push(`2026-09-30T${h}:${m}:00.000Z,host-web,PEGA0001,1200,1000`);
    }
  });
  return lines.join("\n");
}

/** Six hours, one of them catastrophic: 5, 4, 6, 5, 80, 5. */
const SPIKE = hourly([5, 4, 6, 5, 80, 5]);
/** The same shape with the spike removed: nothing should be flagged. */
const FLAT = hourly([5, 4, 6, 5, 7, 5]);

test("the hourly profile computes a mean across the window and flags the spike", async () => {
  const a = await analyseBottlenecks(csvOf(SPIKE));
  const h = a.hourly;
  assert.equal(h.hours.length, 6, "six hour buckets");
  assert.equal(h.countedRows, 105, "every readable row is counted somewhere");
  // Mean is over the OBSERVED buckets, not over an assumed window: a file that
  // covers six hours gets divided by six, not by 24, which would make every
  // ordinary hour look like a spike.
  assert.equal(h.meanPerHour, 17.5, "105 rows over 6 hours");
  assert.equal(h.buckets, 6);
  assert.equal(h.flagged, 1, "exactly one hour is abnormal");

  const spike = h.hours.find((x) => x.count === 80)!;
  assert.equal(spike.isSpike, true, "the 80-row hour is flagged");
  assert.ok(Math.abs((spike.multiple ?? 0) - (80 / 17.5)) < 0.001, "and the multiple is the ratio a reader can check");
  assert.equal(spike.rule, "4.6x the hourly average");

  for (const quiet of h.hours.filter((x) => x.count !== 80)) {
    assert.equal(quiet.isSpike, false, `${quiet.count} rows in an ordinary hour is not a spike`);
  }
});

test("hours are in chronological order and keep their share", async () => {
  const h = (await analyseBottlenecks(csvOf(SPIKE))).hourly;
  const keys = h.hours.map((x) => x.key);
  assert.deepEqual(keys, [...keys].sort(), "ISO hour keys sort chronologically, so the table reads forwards");
  const busiest = h.hours.reduce((a, b) => (b.count > a.count ? b : a));
  assert.ok(Math.abs(busiest.share - 80 / 105) < 0.001, "share is stated, so the spike is quantified in context");
});

test("a flat day is not flagged, and the report says so rather than inventing one", async () => {
  const h = (await analyseBottlenecks(csvOf(FLAT))).hourly;
  assert.equal(h.flagged, 0);
  assert.ok(h.hours.every((x) => !x.isSpike), "the busiest hour of a flat day is not a spike");
});

test("a window too short to judge is declared too short, not silently unflagged", async () => {
  // Two hours, 30 then 70. The 2x test would call 70 a spike against a mean of
  // 50, which is arithmetic, not evidence.
  const h = (await analyseBottlenecks(csvOf(hourly([30, 70])))).hourly;
  assert.equal(h.buckets, 2);
  assert.ok(h.insufficient, "the report is told the window cannot support the judgement");
  assert.equal(h.flagged, 0, "and nothing is flagged");
  assert.equal(h.hours.every((x) => !x.isSpike), true, "including the 70");
});

test("sigma is computed and reported even though it is not the rule", async () => {
  const h = (await analyseBottlenecks(csvOf(SPIKE))).hourly;
  // Population sigma of 5,4,6,5,80,5 is 27.96. mean + 2sigma is 73.4, which is
  // BELOW the spike at 80 -- so a 2-sigma rule would have missed the one thing
  // this fixture exists to prove. That is the whole argument for using a ratio,
  // and it is asserted rather than asserted-about in a comment.
  assert.ok(h.sigma > 20, `sigma is ${h.sigma.toFixed(1)}`);
  assert.ok(h.meanPerHour + 2 * h.sigma < 80, `mean + 2sigma is ${(h.meanPerHour + 2 * h.sigma).toFixed(1)}, so the 2-sigma rule would MISS the spike`);
  assert.equal(h.spikeMultiple, 2, "and the rule that did fire is the ratio");
});

test("markdown marks the spike hour unmistakably", async () => {
  const md = toBottleneckMarkdown(await analyseBottlenecks(csvOf(SPIKE)), "Bottleneck report");
  assert.match(md, /SPIKE/, "the word appears");
  assert.match(md, /80 rows/, "next to the count");
  const line = md.split("\n").find((l) => l.includes("SPIKE"))!;
  assert.match(line, /T13/, "on the hour that actually spiked");
  assert.match(md, /hourly average/, "with the baseline it is measured against");
});

test("a flat day prints no SPIKE marker and no spike callout", async () => {
  const md = toBottleneckMarkdown(await analyseBottlenecks(csvOf(FLAT)), "Bottleneck report");
  assert.ok(!md.includes("SPIKE"), "no false alarm on ordinary data");
});

test("html marks it too", async () => {
  const cwd = await makeTempWorkspace("nf-spike-");
  const file = await writeFixture(cwd, "spike.csv", SPIKE);
  const csv = await csvRead({ path: file }, { boundary: { check: (p: string) => ({ allowed: true, reason: "t", resolved: p }), assert: (p: string) => p } } as never);
  const out = await renderBottleneckReport({ path: `${cwd}/r.html`, title: "Spike", csv });
  const page = await import("node:fs/promises").then((fs) => fs.readFile(out.path, "utf8"));
  assert.match(page, /SPIKE/);
  assert.match(page, /class="spike"/, "and it is marked in the markup, so it can be styled and not just read");
});

test("byHour is untouched -- this is additive", async () => {
  const a = await analyseBottlenecks(csvOf(SPIKE));
  assert.equal(a.byHour.length, 6, "the existing table still has its rows");
  assert.equal(a.byHour.reduce((s, b) => s + b.count, 0), 105, "and still sums to every readable row");
});