import test from "node:test";
import assert from "node:assert/strict";

import { synthesize, type SynthesisInput } from "./synthesis.ts";
import { parseCsv } from "./capabilities.ts";
import { analyseBottlenecks } from "./bottlenecks.ts";
import type { ColumnHealth, DataHealth, NumericColumnStat } from "./bottlenecks.ts";

/**
 * THE "SO WHAT?" ENGINE. Statistics into a sentence a person can act on.
 *
 * The rest of this pipeline computes numbers very well and says nothing about
 * what they mean. A report that tells you col_15 has one value beyond the outer
 * fence has done the statistics and left the interpretation to the reader, which
 * is the part that actually requires judgement. This module is the judgement.
 *
 * THE HARD PART IS NOT THE TEMPLATE, IT IS THE OPENING CLAUSE.
 *
 * The shape everyone writes is "The dataset is generally stable, but <problem>".
 * That is only true when the dataset IS generally stable. A file where 60% of
 * its cells hold text in a numeric column cannot be described as stable, and a
 * template that says so anyway produces the most dangerous sentence this product
 * can emit: a reassuring first clause attached to a catastrophic second one. A
 * reader skims the first clause. So the opening is derived from the measured
 * proportion of compromised cells, and the tests below pin that it changes.
 *
 * THE FACTOR IS DEFINED, NOT INVENTED. It is the ratio of the worst value to the
 * 3x-IQR outer fence that value cleared, because one absurd value inflates the
 * very standard deviation it would have to clear, while a quartile cannot be
 * moved by a single point. The fence is already published in the report, so the
 * claim is checkable against a number the engine prints.
 */

/** A column with one planted extreme value, and nothing else wrong with it. */
function extremeFixture(over: { readonly fence: number; readonly worst: number; readonly measured?: number; readonly mean?: number }): SynthesisInput {
  const stat: NumericColumnStat = {
    column: "col_15",
    measured: over.measured ?? 200,
    missing: 0,
    empty: 0,
    dirty: 0,
    dirtyExamples: [],
    min: -2,
    max: over.worst,
    mean: over.mean ?? 49995,
    spread: over.worst,
    outliers: 1,
    outlierMax: over.worst,
    outlierMin: null,
    extremeOutliers: 1,
    fenceExtremeLower: -over.fence,
    fenceExtremeUpper: over.fence,
    fenceLower: -over.fence / 2,
    fenceUpper: over.fence / 2,
    method: "IQR",
  };
  const health: ColumnHealth = {
    column: "col_15",
    dirty: 0,
    empty: 0,
    outliers: 1,
    marginalOutliers: 1,
    worstValue: over.worst,
    fence: over.fence,
    examples: [],
  };
  const data: DataHealth = {
    columns: [health], dirtyColumns: 0, outlierColumns: 1,
    dirtyCells: 0, emptyCells: 0, outlierCells: 1, clean: false,
  };
  return { totalRows: 200, columns: [stat], health: data };
}

const HEALTHY: SynthesisInput = {
  totalRows: 1000,
  columns: [{ column: "elapsed", measured: 1000, missing: 0, empty: 0, dirty: 0, dirtyExamples: [], min: 10, max: 90, mean: 50, spread: 80, outliers: 0, outlierMax: null, outlierMin: null, extremeOutliers: 0, fenceExtremeLower: 0, fenceExtremeUpper: 200, fenceLower: 0, fenceUpper: 100, method: "IQR" }],
  health: { columns: [], dirtyColumns: 0, outlierColumns: 0, dirtyCells: 0, emptyCells: 0, outlierCells: 0, clean: true },
};

// === THE CASE IN THE BRIEF, VERBATIM =====================================

test("the brief's own example: a 9,999,999.99 outlier against a 50,000 fence is a factor of 200", () => {
  // 9,999,999.99 / 50,000 = 200.0. This is the sentence the Owner asked for,
  // and the fixture is the arithmetic behind it rather than a number chosen to
  // make a test pass.
  const summary = synthesize(extremeFixture({ fence: 50_000, worst: 9_999_999.99 }));
  assert.match(summary.paragraph, /col_15/, "it names the column");
  assert.match(summary.paragraph, /factor of 200\b/i, "and quantifies the excess as a factor of 200");
  assert.match(summary.paragraph, /9,999,999\.99/, "and gives the value, not just the ratio");
  assert.match(summary.paragraph, /50,000/, "and the fence it cleared, so the claim can be checked");
});

test("and it says the data is compromised, because it is", () => {
  const summary = synthesize(extremeFixture({ fence: 50_000, worst: 9_999_999.99 }));
  assert.match(summary.paragraph, /compromised/i);
  assert.equal(summary.verdict, "compromised");
  // One value in 200 is still a small fraction of the cells, so the stable
  // opening is honest here and must be present.
  assert.match(summary.paragraph, /^The dataset is generally stable/, "a 1-in-200 defect does not destabilise the whole file");
});

// === THE HONESTY TEST: THE OPENING MUST TRACK THE DATA ===================

test("a broadly broken file must NOT be described as generally stable", () => {
  // 900 of 1000 cells hold text in a numeric column. Every template ever
  // written would open this with "generally stable", and a reader who skims
  // the first clause is told the file is fine.
  const dirty: ColumnHealth[] = [{ column: "amount", dirty: 900, empty: 0, outliers: 0, marginalOutliers: 0, worstValue: null, fence: null, examples: ["N/A"] }];
  const summary = synthesize({
    totalRows: 1000,
    columns: [],
    health: { columns: dirty, dirtyColumns: 1, outlierColumns: 0, dirtyCells: 900, emptyCells: 0, outlierCells: 0, clean: false },
  });
  assert.ok(!/generally stable/i.test(summary.paragraph),
    `a file that is 90% unusable must not open by saying it is stable: ${summary.paragraph}`);
  assert.equal(summary.verdict, "unusable");
});

test("a type mismatch is named as a producer defect, with its offending value", () => {
  // "N/A" in a float column is not variation. It is a broken producer, a
  // sentinel, or a locale change, and the reader's next action is completely
  // different from the one for a big number.
  const summary = synthesize({
    totalRows: 500,
    columns: [],
    health: {
      columns: [{ column: "elapsed_time", dirty: 12, empty: 0, outliers: 0, marginalOutliers: 0, worstValue: null, fence: null, examples: ["N/A", "null"] }],
      dirtyColumns: 1, outlierColumns: 0, dirtyCells: 12, emptyCells: 0, outlierCells: 0, clean: false,
    },
  });
  assert.match(summary.paragraph, /type mismatch/i);
  assert.match(summary.paragraph, /elapsed_time/);
  assert.match(summary.paragraph, /N\/A/, "and quotes the offending value, so the reader can search their pipeline for it");
  assert.match(summary.paragraph, /producer|broke|written|text/i, "and says it is a structural fault rather than a measurement");
});

// === THE FAILURE THIS MODULE REINTRODUCED, AND THEN FIXED ==============
//
// The Owner's own file produced a summary that led with "ordinary variation in
// col_7 ... which is not a defect" and never mentioned col_15's 9,999,999.99
// anywhere in the prose. That is the SAME defect the 3x-IQR fence was introduced
// to fix, reintroduced one layer up: the statistics were right and the sentence
// buried them. All three tests below were written after seeing that output and
// all three failed against it.

test("the most serious finding leads, whatever order the columns appear in", () => {
  // col_a is an ordinary marginal wobble; col_z is the 9,999,999.99. Findings
  // are collected in column order, so a first-wins selection leads with col_a
  // and the file's one real problem becomes a footnote.
  const summary = synthesize({
    totalRows: 200,
    columns: [
      { column: "col_a", measured: 200, missing: 0, empty: 0, dirty: 0, dirtyExamples: [], min: -1, max: 1, mean: 0, spread: 2, outliers: 1, outlierMax: 1, outlierMin: null, extremeOutliers: 0, fenceExtremeLower: -5, fenceExtremeUpper: 5, fenceLower: -3, fenceUpper: 3, method: "IQR" },
      { column: "col_z", measured: 200, missing: 0, empty: 0, dirty: 0, dirtyExamples: [], min: -2, max: 9_999_999.99, mean: 49_995, spread: 9_999_999.99, outliers: 1, outlierMax: 9_999_999.99, outlierMin: null, extremeOutliers: 1, fenceExtremeLower: -50_000, fenceExtremeUpper: 50_000, fenceLower: -25_000, fenceUpper: 25_000, method: "IQR" },
    ],
    health: {
      columns: [
        { column: "col_a", dirty: 0, empty: 0, outliers: 0, marginalOutliers: 1, worstValue: null, fence: null, examples: [] },
        { column: "col_z", dirty: 0, empty: 0, outliers: 1, marginalOutliers: 1, worstValue: 9_999_999.99, fence: 50_000, examples: [] },
      ],
      dirtyColumns: 0, outlierColumns: 1, dirtyCells: 0, emptyCells: 0, outlierCells: 1, clean: false,
    },
  });
  const lead = summary.paragraph.indexOf("The most serious is");
  const wobble = summary.paragraph.indexOf("ordinary variation");
  const extreme = summary.paragraph.indexOf("9,999,999.99");
  assert.ok(lead > -1 && extreme > -1, `the extreme value must be described at all: ${summary.paragraph}`);
  assert.ok(extreme < wobble || wobble === -1,
    `the lead finding must be the extreme one, not an ordinary wobble: ${summary.paragraph}`);
});

test("an extreme anomaly is described even when its factor is enormous", () => {
  // A "do not repeat it if the factor is big" rule sounds reasonable and is
  // catastrophic: the Owner's file has a factor near 1.9 million, so the rule
  // suppressed the single most important sentence in the report. Repetition is
  // a cosmetic problem; omission is the finding disappearing.
  const summary = synthesize(extremeFixture({ fence: 5.2969, worst: 9_999_999.99 }));
  assert.match(summary.paragraph, /9,999,999\.99/,
    `an enormous factor must not suppress the finding: ${summary.paragraph}`);
  assert.match(summary.paragraph, /col_15/);
});

test("ordinary variation is not counted as a problem in the opening clause", () => {
  // The first version opened "severely compromised by 14 problems" and then
  // explained that ten of them were "not a defect". A sentence that contradicts
  // itself in the same breath is worse than either sentence alone: a reader who
  // skims gets the alarming half and believes it.
  const summary = synthesize({
    totalRows: 1000,
    columns: Array.from({ length: 8 }, (_, i) => ({
      column: `c${i}`, measured: 1000, missing: 0, empty: 0, dirty: 0, dirtyExamples: [],
      min: 0, max: 10, mean: 5, spread: 10, outliers: 2, outlierMax: 10, outlierMin: null,
      extremeOutliers: 0, fenceExtremeLower: 0, fenceExtremeUpper: 40, fenceLower: 0, fenceUpper: 20, method: "IQR",
    })),
    health: { columns: [], dirtyColumns: 0, outlierColumns: 0, dirtyCells: 0, emptyCells: 0, outlierCells: 0, clean: true },
  });
  assert.ok(!/compromised/i.test(summary.paragraph),
    `variation inside the 1.5x fence is not a defect and must not be called one: ${summary.paragraph}`);
  assert.equal(summary.verdict, "minor");
});

test("repeated variation across many columns is summarised, not narrated ten times", () => {
  // One clause per column is how a summary becomes a wall. Ten identical
  // sentences is not more informative than one, and it buries the real finding.
  const summary = synthesize({
    totalRows: 1000,
    columns: Array.from({ length: 10 }, (_, i) => ({
      column: `c${i}`, measured: 1000, missing: 0, empty: 0, dirty: 0, dirtyExamples: [],
      min: 0, max: 10, mean: 5, spread: 10, outliers: 3, outlierMax: 10, outlierMin: null,
      extremeOutliers: 0, fenceExtremeLower: 0, fenceExtremeUpper: 40, fenceLower: 0, fenceUpper: 20, method: "IQR",
    })),
    health: { columns: [], dirtyColumns: 0, outlierColumns: 0, dirtyCells: 0, emptyCells: 0, outlierCells: 0, clean: true },
  });
  const occurrences = (summary.paragraph.match(/ordinary variation/gi) ?? []).length;
  assert.ok(occurrences <= 1, `variation must be grouped into one clause, saw ${occurrences}: ${summary.paragraph}`);
});

// === NEVER FABRICATE ======================================================

test("a clean file is reported clean, with no anomaly, no factor and no warning", () => {
  const summary = synthesize(HEALTHY);
  assert.equal(summary.verdict, "clean");
  assert.match(summary.paragraph, /clean|stable|no /i);
  // The important half: it must NOT invent a problem, because a summary that
  // hedges about a clean file trains people to ignore it.
  assert.ok(!/factor of/i.test(summary.paragraph), `no factor may be claimed when there is no anomaly: ${summary.paragraph}`);
  assert.ok(!/anomal/i.test(summary.paragraph), `no anomaly may be invented: ${summary.paragraph}`);
  assert.equal(summary.findings.length, 0);
});

test("a value with no computed fence yields no factor, rather than a division by zero", () => {
  // A column too short to support a fence has `fence: null`. Dividing by it
  // gives Infinity or NaN, and "a factor of Infinity" in a report is a joke
  // that a reader will forward.
  const summary = synthesize({
    totalRows: 4,
    columns: [],
    health: {
      columns: [{ column: "tiny", dirty: 0, empty: 0, outliers: 0, marginalOutliers: 0, worstValue: null, fence: null, examples: [] }],
      dirtyColumns: 0, outlierColumns: 0, dirtyCells: 0, emptyCells: 0, outlierCells: 0, clean: true,
    },
  });
  assert.ok(!/Infinity|NaN|factor of (0|undefined|null)/i.test(summary.paragraph), summary.paragraph);
});

// === THE INSIGHT THAT MAKES IT A DATA SCIENTIST AND NOT A TEMPLATE =======

test("when one value dominates the mean, the summary says the mean cannot be trusted", () => {
  // 199 values near zero and one at 9,999,999.99 give a mean around 50,000 --
  // a number that describes no row in the file. This is the single most
  // misleading thing about a column with an extreme outlier, and it is not
  // visible in the outlier count, the fence, or the value. It comes from
  // comparing them.
  const summary = synthesize(extremeFixture({ fence: 50_000, worst: 9_999_999.99, measured: 200, mean: 50_000 }));
  assert.match(summary.paragraph, /mean/i, "the mean must be addressed when an outlier dominates it");
  assert.match(summary.paragraph, /unreliable|do not trust|not representative|dominat/i,
    `the mean is contaminated and the summary must say so: ${summary.paragraph}`);
});

test("a mean that is NOT dominated is left alone", () => {
  // One outlier in 200 barely moves a mean, so claiming contamination here
  // would be the same class of error in the other direction: a warning that
  // fires on ordinary variation is not a warning.
  const summary = synthesize(extremeFixture({ fence: 50_000, worst: 9_999_999.99, measured: 20_000, mean: 12_000 }));
  assert.ok(!/mean.*(unreliable|dominat)/i.test(summary.paragraph),
    `a mean of ${"12,000"} over 20,000 rows is not dominated by one value: ${summary.paragraph}`);
});

// === IT WORKS ON REAL ENGINE OUTPUT =======================================

// === IT REACHES BOTH REPORTS, AND THEY AGREE =============================

test("the summary is injected at the TOP of the markdown, above the row count", async () => {
  const { toBottleneckMarkdown } = await import("./bottleneck-report.ts");
  const rows = Array.from({ length: 40 }, (_, i) => `${i % 5},${i === 20 ? "9999999.99" : (i * 1.5).toFixed(3)}`);
  const parsed = parseCsv(`host,amount\n${rows.join("\n")}\n`);
  const analysis = analyseBottlenecks({
    path: "ops.csv", headers: parsed.headers, rowCount: parsed.rows.length,
    columns: [], sample: [], problems: parsed.problems,
    rows: parsed.rows.map((c) => Object.fromEntries(parsed.headers.map((h, i) => [h, c[i] ?? ""]))),
  });
  const summary = synthesize({ totalRows: analysis.totalRows, columns: analysis.numerical.columns, health: analysis.health });
  const markdown = toBottleneckMarkdown(analysis, "Ops", summary.paragraph);

  // Placement is the argument, so it is the assertion: a summary filed under
  // the tables is a summary nobody reads.
  const summaryAt = markdown.indexOf(summary.paragraph.slice(0, 40));
  const rowCountAt = markdown.indexOf("row(s)");
  assert.ok(summaryAt > -1, `the summary must appear in the markdown: ${markdown.slice(0, 300)}`);
  assert.ok(summaryAt < rowCountAt, "and it must come before the row count, not under the tables");
});

test("the markdown and the dashboard cannot disagree, because both come from one synthesis", async () => {
  const { toBottleneckMarkdown } = await import("./bottleneck-report.ts");
  const { toReactDashboard, DASHBOARD_DATA_ID } = await import("../web/react-report.ts");
  const rows = Array.from({ length: 40 }, (_, i) => `${i % 5},${i === 20 ? "9999999.99" : (i * 1.5).toFixed(3)}`);
  const parsed = parseCsv(`host,amount\n${rows.join("\n")}\n`);
  const analysis = analyseBottlenecks({
    path: "ops.csv", headers: parsed.headers, rowCount: parsed.rows.length,
    columns: [], sample: [], problems: parsed.problems,
    rows: parsed.rows.map((c) => Object.fromEntries(parsed.headers.map((h, i) => [h, c[i] ?? ""]))),
  });

  // The claim is that there is ONE opinion in the system. Asserted by checking
  // the dashboard's headline is derived from the same verdict, not written by a
  // second generator that would eventually disagree with the first.
  const html = toReactDashboard(analysis, {});
  const from = html.indexOf(">", html.indexOf(`id="${DASHBOARD_DATA_ID}"`)) + 1;
  const payload = JSON.parse(html.slice(from, html.indexOf("</script>", from))) as { headline: string };
  const summary = synthesize({ totalRows: analysis.totalRows, columns: analysis.numerical.columns, health: analysis.health });
  assert.equal(payload.headline, summary.headline, "one synthesis, one headline");
  // WITH the thousands separator. The first version of this assertion looked
  // for the unseparated `9999999.99` and failed against a report that plainly
  // contained the number -- because the formatter groups it. A test that fails
  // on correct output trains people to stop reading failures.
  assert.match(toBottleneckMarkdown(analysis, "Ops", summary.paragraph), /9,999,999\.99/);
});

test("it reads what the profiler actually produces, not a convenient shape", () => {
  // The integration risk is drift: a hand-built input like the fixtures above
  // can be satisfied while the real object has a field this module never reads.
  const rows = Array.from({ length: 40 }, (_, i) => `${(i % 7)},${i === 20 ? "9999999.99" : (i * 1.5).toFixed(3)}`);
  const parsed = parseCsv(`name,amount\n${rows.join("\n")}\n`);
  const analysis = analyseBottlenecks({
    path: "real.csv", headers: parsed.headers, rowCount: parsed.rows.length,
    columns: [], sample: [], problems: parsed.problems,
    rows: parsed.rows.map((c) => Object.fromEntries(parsed.headers.map((h, i) => [h, c[i] ?? ""]))),
  });
  const summary = synthesize({ totalRows: analysis.totalRows, columns: analysis.numerical.columns, health: analysis.health });
  assert.ok(summary.paragraph.length > 40, "a real analysis produces a real paragraph");
  assert.ok(!/undefined|NaN|\[object/.test(summary.paragraph), `no template holes: ${summary.paragraph}`);
  assert.match(summary.paragraph, /amount/, "and it speaks about the column that is actually wrong");
});
