import test from "node:test";
import assert from "node:assert/strict";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { toBottleneckMarkdown, renderBottleneckReport } from "./bottleneck-report.ts";
import { parseCsv } from "./capabilities.ts";
import { makeTempWorkspace, writeFixture } from "../test-support/temp-workspace.ts";
import { csvRead } from "./capabilities.ts";
import type { CsvReadResult } from "./capabilities.ts";

/**
 * ADVANCED DURATION MEASURES. Mean, median and p95, per category, beside the
 * total.
 *
 * WHY THE THREE, AND WHY NOT JUST THE MEAN. The mean is what a total divided
 * by a count gives you, and it is what this report already showed, so printing
 * it again is only worth it when it can differ from the reader's own arithmetic
 * -- which it can, because a total counts every row while the mean is taken over
 * the rows that carried a MEASURABLE duration.
 *
 * Median and p95 are the ones that carry the argument. A category can top the
 * elapsed table on a mean dragged up by a handful of enormous values, and the
 * row-by-row experience is nothing like that mean. p95 answers "how bad is a
 * typical bad row", which is the question a person tuning a threshold actually
 * has, and it is the measure that stays honest when the distribution has a long
 * tail. So: the total says what it cost, the mean says what one costs on
 * average, the median says what one usually costs, and p95 says what the worst
 * ordinary row costs. A report with only the first two invites a reader to
 * average their way to the wrong conclusion.
 */

function csvOf(text: string, file = "in.csv"): CsvReadResult {
  const parsed = parseCsv(text);
  const keyed = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return { path: file, headers: parsed.headers, rowCount: keyed.length, columns: [], sample: keyed.slice(0, 5), rows: keyed, problems: parsed.problems };
}

/**
 * ONE_CAT has a duration distribution chosen to break the mean.
 *
 * EIGHTEEN rows at 100ms and TWO at 10,000ms: total 21,800, mean 1,090, median
 * 100, p95 10,000. Every measure disagrees with every other, which is the whole
 * argument for printing three of them. The mean understates a typical row by
 * ~11x and overstates p95 by ~1.5x; only the median says what a row usually
 * costs. If a renderer ever puts the mean where the median belongs, this
 * fixture makes the mistake visible rather than plausible.
 *
 * TWO heavy values, not one, and that is not padding either. p95 is
 * NEAREST-RANK, so with one heavy row in twenty it lands at rank 19 of 20 and
 * correctly reports 100: a single row in twenty is not a p95 event, and a
 * percentile that reached for it would be overstating how often the tail bites.
 * The tail has to be two rows wide before p95 legitimately reports it, which is
 * exactly what this fixture does.
 *
 * THE DECOY ROW IS NOT PADDING EITHER. Every fixture here carries a second,
 * rare category, and without it R9's cardinality guard does exactly what it
 * exists to do: `alert_code` holds ONE distinct value, so it is rejected as
 * unrankable, `categories` comes back empty, and every assertion below fails
 * with "cannot read properties of undefined". That guard is correct and is
 * pinned elsewhere; these tests are about arithmetic, so they give the guard
 * what it wants and stop tripping over it.
 */
const ONE_CAT = `_time,source_host,alert_code,elapsed_time,threshold
2026-09-30 12:00:00.000,h,PEGA0001,100,1000
2026-09-30 12:00:01.000,h,PEGA0001,100,1000
2026-09-30 12:00:02.000,h,PEGA0001,100,1000
2026-09-30 12:00:03.000,h,PEGA0001,100,1000
2026-09-30 12:00:04.000,h,PEGA0001,100,1000
2026-09-30 12:00:05.000,h,PEGA0001,100,1000
2026-09-30 12:00:06.000,h,PEGA0001,100,1000
2026-09-30 12:00:07.000,h,PEGA0001,100,1000
2026-09-30 12:00:08.000,h,PEGA0001,100,1000
2026-09-30 12:00:09.000,h,PEGA0001,100,1000
2026-09-30 12:00:10.000,h,PEGA0001,100,1000
2026-09-30 12:00:11.000,h,PEGA0001,100,1000
2026-09-30 12:00:12.000,h,PEGA0001,100,1000
2026-09-30 12:00:13.000,h,PEGA0001,100,1000
2026-09-30 12:00:14.000,h,PEGA0001,100,1000
2026-09-30 12:00:15.000,h,PEGA0001,100,1000
2026-09-30 12:00:16.000,h,PEGA0001,100,1000
2026-09-30 12:00:17.000,h,PEGA0001,100,1000
2026-09-30 12:00:18.000,h,PEGA0001,10000,1000
2026-09-30 12:00:19.000,h,PEGA0001,10000,1000
2026-09-30 12:00:20.000,h,PEGA0009,50,1000`;

test("mean, median and p95 are computed per category from the measured durations", async () => {
  const a = await analyseBottlenecks(csvOf(ONE_CAT));
  const c = a.categories[0];
  assert.equal(c.count, 20);
  assert.equal(c.totalElapsed, 21800, "the total counts every measured row");
  assert.equal(c.meanElapsed, 1090, "the mean is dragged up by the tail -- which is why it is not the only measure");
  assert.equal(c.medianElapsed, 100, "the median is unmoved by the tail -- this is the point");
  assert.equal(c.p95Elapsed, 10000, "nearest-rank p95 = ceil(0.95*20) = 19, and 18 rows are below 10,000");
  // The whole argument for printing three measures: they do not agree.
  assert.ok((c.medianElapsed ?? 0) < (c.meanElapsed ?? 0), "median below mean means a right-skewed distribution");
  assert.ok((c.p95Elapsed ?? 0) > (c.meanElapsed ?? 0), "and p95 above it means the tail is real");
});

test("median averages the two middle values on an even count", async () => {
  // 4 durations: 10, 20, 30, 40 -> median 25, not 20 or 30.
  const a = await analyseBottlenecks(csvOf(`_time,source_host,alert_code,elapsed_time,threshold
2026-09-30 12:00:00.000,h,PEGA0001,40,1000
2026-09-30 12:00:01.000,h,PEGA0001,10,1000
2026-09-30 12:00:02.000,h,PEGA0001,30,1000
2026-09-30 12:00:03.000,h,PEGA0001,20,1000
2026-09-30 12:00:04.000,h,PEGA0009,5,1000`));
  assert.equal(a.categories[0].medianElapsed, 25, "even n takes the midpoint, and rounding stays exact at .5");
  assert.equal(a.categories[0].p95Elapsed, 40, "nearest-rank p95 = ceil(0.95*4)=4 -> the 4th value");
});

test("every measure is null, not zero, when no credible duration column exists", async () => {
  // No elapsed_time. A zero here would be a claim that the work was free.
  const a = await analyseBottlenecks(csvOf(`_time,source_host,alert_code,threshold
2026-09-30 12:00:00.000,h,PEGA0001,1000
2026-09-30 12:00:01.000,h,PEGA0002,1000`));
  const c = a.categories[0];
  assert.equal(c.totalElapsed, null);
  assert.equal(c.meanElapsed, null);
  assert.equal(c.medianElapsed, null);
  assert.equal(c.p95Elapsed, null);
});

test("unparseable durations are excluded rather than counted as zero", async () => {
  // A blank or non-numeric elapsed_time must not drag the mean toward zero.
  // Counting it as 0 is the single easiest way to make this report lie.
  const a = await analyseBottlenecks(csvOf(`_time,source_host,alert_code,elapsed_time,threshold
2026-09-30 12:00:00.000,h,PEGA0001,200,1000
2026-09-30 12:00:01.000,h,PEGA0001,,1000
2026-09-30 12:00:02.000,h,PEGA0001,n/a,1000
2026-09-30 12:00:03.000,h,PEGA0001,400,1000
2026-09-30 12:00:04.000,h,PEGA0009,7,1000`));
  const c = a.categories[0];
  assert.equal(c.count, 4, "the ROW count is still every row -- nothing is hidden");
  assert.equal(c.totalElapsed, 600, "the total sums only what was measured");
  assert.equal(c.meanElapsed, 300, "200 and 400, over the TWO measured rows");
  assert.equal(c.medianElapsed, 300);
  assert.equal(c.p95Elapsed, 400);
});

test("markdown prints mean, median and p95 with ms headers beside the total", async () => {
  const md = toBottleneckMarkdown(await analyseBottlenecks(csvOf(ONE_CAT)), "Bottleneck report");
  assert.match(md, /\| total elapsed \(ms\) \| mean \(ms\) \| median \(ms\) \| p95 \(ms\) \|/, "all four headers, all stating the unit");
  const row = md.split("\n").find((l) => l.startsWith("| 1 |"))!;
  assert.ok(row.includes("| 21,800 |"), "the total is in the row");
  assert.ok(row.includes("| 1,090 |"), "the mean is in the row");
  assert.ok(row.includes("| 100 |"), "the median is in the row");
  assert.ok(row.includes("| 10,000 |"), "p95 is in the row, formatted like every other figure");
});

test("markdown prints 'not measurable' rather than a zero when there is no duration", async () => {
  const md = toBottleneckMarkdown(await analyseBottlenecks(csvOf(`_time,source_host,alert_code
2026-09-30 12:00:00.000,h,PEGA0001
2026-09-30 12:00:01.000,h,PEGA0002`)), "Bottleneck report");
  const row = md.split("\n").find((l) => l.startsWith("| 1 |"))!;
  const header = md.split("\n").find((l) => l.startsWith("| # | category"))!;
  // Located BY HEADER NAME, not by index. This test used to slice cells 5..8 and
  // passed for a while only because the breach column happened to be present; when
  // the vocabulary work made that column conditional, the fixture without a
  // threshold shifted every measure one cell left and the assertion quietly
  // started checking the wrong column. A positional assertion on a table whose
  // shape is now variable is an assertion about nothing.
  const cols = header.split("|").map((s) => s.trim());
  const measures = ["total elapsed (ms)", "mean (ms)", "median (ms)", "p95 (ms)"].map((h) => {
    const at = cols.indexOf(h);
    assert.notEqual(at, -1, `the ${h} column is present even when there is nothing to put in it`);
    return row.split("|")[at].trim();
  });
  assert.deepEqual(measures, ["not measurable", "not measurable", "not measurable", "not measurable"], "total, mean, median and p95 all decline to state a figure");
  assert.ok(!measures.some((m) => /^0(\.0+)?$/.test(m)), "and none of them claims zero");
});

test("the html table carries the same four columns and the same numbers", async () => {
  const cwd = await makeTempWorkspace("nf-stats-");
  const file = await writeFixture(cwd, "one.csv", ONE_CAT);
  const csv = await csvRead({ path: file }, { boundary: { check: (p: string) => ({ allowed: true, reason: "t", resolved: p }), assert: (p: string) => p } } as never);
  const out = await renderBottleneckReport({ path: `${cwd}/r.html`, title: "B", csv });
  const page = await import("node:fs/promises").then((fs) => fs.readFile(out.path, "utf8"));
  for (const header of ["total elapsed (ms)", "mean (ms)", "median (ms)", "p95 (ms)"]) {
    assert.ok(page.includes(header), `${header} is on the page`);
  }
  // The two renderings must not drift: one analysis, two outputs.
  assert.ok(page.includes(">21,800<"), "the total reaches the page");
  assert.ok(page.includes(">1,090<"), "the mean reaches the page");
  assert.ok(page.includes(">100<"), "and so does the median");
  assert.ok(page.includes(">10,000<"), "and p95");
  // A gap is an em-dash, never a zero, in the page too.
  const bare = await renderBottleneckReport({ path: `${cwd}/r2.html`, title: "B", csv: await csvRead({ path: await writeFixture(cwd, "nodur.csv", "_time,source_host,alert_code\n2026-09-30 12:00:00.000,h,PEGA0001\n2026-09-30 12:00:01.000,h,PEGA0002") }, { boundary: { check: (p: string) => ({ allowed: true, reason: "t", resolved: p }), assert: (p: string) => p } } as never) });
  const barePage = await import("node:fs/promises").then((fs) => fs.readFile(bare.path, "utf8"));
  // 2 categories x 4 measures x 2 rank tables.
  assert.equal(barePage.match(/class="num">&mdash;</g)?.length, 16, "every unmeasurable figure is an em-dash on the page, in both tables");
});