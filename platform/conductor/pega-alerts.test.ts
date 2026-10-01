import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { csvRead } from "./capabilities.ts";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { makeTempWorkspace, writeFixture } from "../test-support/temp-workspace.ts";

/**
 * PEGA ALERT EXPORTS — the shape `data/splunk_pega_alerts.csv` actually has.
 *
 * Modelled from the profile of the real file, NOT copied from it: the values are
 * invented, only the shape is shared. The real file is git-ignored and never
 * enters the repository.
 *
 * The trap this suite exists for is a semantic one, and it is worth stating
 * plainly because the column names point the wrong way:
 *
 *   `alertType` is named like the category dimension and holds exactly ONE
 *   distinct value across the whole export. Ranking by it produces a single
 *   bucket containing every row, which renders as a confident table and answers
 *   nothing. `alert_code` holds four.
 *
 *   So the obvious mapping is the useless one. R9 says column NAMES are evidence
 *   -- which they are, and here the evidence is misleading, because a name
 *   describes the column's purpose and says nothing about its cardinality.
 */

/** The real file's shape: 12 columns, 4 alert codes, one alert type, LF, no BOM. */
const PEGA_HEADER = "_time,source_host,nodeId,userid,thread_name,logger_name,alertType,alert_code,elapsed_time,threshold,pega_time,service_uri";

function pegaRow(code, elapsed, host, time, type = "performance") {
  return `${time},${host},node-1,user-1,thread-1,logger-${code},${type},${code},${elapsed},1000,${time},`;
}

async function pegaExport(rows, name = "pega.csv") {
  const cwd = await makeTempWorkspace("nf-pega-");
  await writeFixture(cwd, name, `${PEGA_HEADER}\n${rows.join("\n")}\n`);
  return csvRead({ path: path.join(cwd, name) });
}

const realShape = [
  ...Array.from({ length: 13 }, () => pegaRow("PEGA0001", 1200, "host-web", "2026-09-30 12:00:00.000")),
  ...Array.from({ length: 5 }, () => pegaRow("PEGA0028", 800, "host-bg", "2026-09-30 12:10:00.000")),
  ...Array.from({ length: 4 }, () => pegaRow("PEGA0005", 2500, "host-web", "2026-09-30 12:20:00.000")),
  ...Array.from({ length: 2 }, () => pegaRow("PEGA0011", 300, "host-api", "2026-09-30 12:30:00.000")),
];

test("G1 the obvious category column is degenerate and must not win", async () => {
  const csv = await pegaExport(realShape);
  const analysis = analyseBottlenecks(csv);

  assert.equal(analysis.categoryColumn, "alert_code",
    "ranking by alertType would put all 24 rows in one bucket and answer nothing");
  assert.equal(analysis.categories.length, 4, `got ${analysis.categories.length} categories`);
  assert.equal(analysis.categories[0].key, "PEGA0001");
  assert.equal(analysis.categories[0].count, 13);
});

test("G2 a degenerate dimension is reported, not silently used", async () => {
  const csv = await pegaExport(realShape);
  const analysis = analyseBottlenecks(csv);
  const degenerate = analysis.degenerateColumns.find((d) => d.column === "alertType");
  assert.ok(degenerate, "alertType was single-valued and that fact must be reported");
  assert.equal(degenerate.distinctValues, 1);
});

test("G3 ranking by frequency, as the owner's question asks", async () => {
  const csv = await pegaExport(realShape);
  const analysis = analyseBottlenecks(csv);
  assert.deepEqual(analysis.categories.map((c) => c.key), ["PEGA0001", "PEGA0028", "PEGA0005", "PEGA0011"]);
  assert.deepEqual(analysis.categories.map((c) => c.count), [13, 5, 4, 2]);
});

test("G4 ranking by TOTAL ELAPSED, which is a DIFFERENT order", async () => {
  // PEGA0001 leads on both, which is why a report that ranked only one way would
  // look correct. The divergence is one place down: PEGA0005 is THIRD by
  // frequency and SECOND by total elapsed. A frequency-only ranking buries the
  // category that actually cost the most, while still looking like an answer.
  const csv = await pegaExport(realShape);
  const analysis = analyseBottlenecks(csv);

  const byFreq = analysis.categories.map((c) => c.key);
  const byElapsed = analysis.categoriesByElapsed.map((c) => c.key);
  assert.notDeepEqual(byFreq, byElapsed, "the two rankings must actually disagree, or this test proves nothing");

  const top = analysis.categoriesByElapsed[0];
  assert.equal(top.key, "PEGA0001");
  assert.equal(top.totalElapsed, 15_600, "13 rows x 1200");
  assert.equal(byFreq.indexOf("PEGA0005"), 2, "third by frequency");
  assert.equal(byElapsed.indexOf("PEGA0005"), 1, "but second by total elapsed");
  assert.equal(analysis.categoriesByElapsed.find((c) => c.key === "PEGA0005")!.totalElapsed, 10_000);
});

test("G5 every category cites its evidence rows", async () => {
  const csv = await pegaExport(realShape);
  const analysis = analyseBottlenecks(csv);
  for (const category of analysis.categories) {
    assert.equal(category.rows.length, category.count, `${category.key} cites the wrong number of rows`);
  }
  assert.equal(analysis.categories[0].rows[0], 2, "row numbering must be file lines, header excluded");
});

test("G6 elapsed time sums, and the unit is now RULED rather than guessed", async () => {
  const csv = await pegaExport(realShape);
  const analysis = analyseBottlenecks(csv);
  const mapping = analysis.mappings.find((m) => m.role === "duration");
  assert.ok(mapping, "elapsed_time must be recognised as a duration");
  assert.equal(mapping.column, "elapsed_time");
  // R10 supersedes this pin. It used to assert the unit was a HYPOTHESIS,
  // because no export stated one. The owner has now ruled it to milliseconds,
  // so it is established fact and the page may print ms.
  assert.match(mapping.note, /ruling R10/i, "the note must name the ruling, not a guess");
  assert.equal(analysis.durationUnit, "ms");
});

test("G7 a threshold comparison is a breach count, flagged as inferred", async () => {
  const csv = await pegaExport(realShape);
  const analysis = analyseBottlenecks(csv);
  const pega1 = analysis.categories.find((c) => c.key === "PEGA0001");
  const pega5 = analysis.categories.find((c) => c.key === "PEGA0005");
  const pega11 = analysis.categories.find((c) => c.key === "PEGA0011");
  assert.equal(pega1.breachCount, 13, "every PEGA0001 row is over the 1000 threshold");
  assert.equal(pega5.breachCount, 4);
  assert.equal(pega11.breachCount, 0, "PEGA0011 rows are under the threshold, and saying so is useful");
  assert.ok(analysis.mappings.some((m) => m.role === "threshold" && m.hypothesis),
    "that a breach means 'elapsed exceeded threshold' is inferred from the shape, not stated");
});

test("G8 time buckets span the export, not one instant", async () => {
  // Explicit UTC (trailing Z) on purpose. This fixture once used NAIVE
  // timestamps and passed only because this host's timezone is Asia/Calcutta --
  // a half-hour offset, which pushed 12:00 local into UTC hour 06 and 12:30 into
  // hour 07, manufacturing two buckets. On a UTC runner the same data yields one
  // and the test failed. A fixture that depends on the developer's timezone is a
  // fixture that tests the developer.
  const cwd = await makeTempWorkspace("nf-pega-tz-");
  const header = "_time,alertType,alert_code,elapsed_time,threshold";
  const rows = [
    "2026-09-30T12:00:00.000Z,performance,PEGA0001,1200,1000",
    "2026-09-30T13:10:00.000Z,performance,PEGA0028,800,1000",
    "2026-09-30T14:20:00.000Z,performance,PEGA0005,2500,1000",
    "2026-09-30T15:30:00.000Z,performance,PEGA0011,300,1000",
  ];
  await writeFixture(cwd, "tz.csv", `${header}\n${rows.join("\n")}\n`);
  const csv = await csvRead({ path: path.join(cwd, "tz.csv") });
  const analysis = analyseBottlenecks(csv);
  assert.equal(analysis.byHour.length, 4, `expected four hourly buckets, got ${analysis.byHour.length}`);
  assert.equal(analysis.byHour[0].key, "2026-09-30T12");
  assert.equal(analysis.timestampsAreNaive, false, "a trailing Z makes them unambiguous");
});

test("G8b NAIVE timestamps are reported as ambiguous, not silently localised", async () => {
  // The real Pega export carries timestamps with no zone. Bucketing those under
  // a heading that says UTC is only true on a host whose zone IS UTC -- and this
  // one is not, so the buckets would be silently shifted by half an hour.
  const cwd = await makeTempWorkspace("nf-pega-naive-");
  const header = "_time,alertType,alert_code,elapsed_time,threshold";
  const rows = [
    "2026-09-30 12:00:00.000,performance,PEGA0001,1200,1000",
    "2026-09-30 13:00:00.000,performance,PEGA0028,800,1000",
  ];
  await writeFixture(cwd, "naive.csv", `${header}\n${rows.join("\n")}\n`);
  const csv = await csvRead({ path: path.join(cwd, "naive.csv") });
  const analysis = analyseBottlenecks(csv);
  assert.equal(analysis.timestampsAreNaive, true,
    "timestamps without a zone are host-relative, and the page must say so");
  assert.ok(analysis.byHour.length >= 1, "they are still bucketed, just not claimed to be UTC");
});

test("G9 a missing field is named, not degraded silently", async () => {
  // No free-text message column exists in this export, so recurring SIGNATURES
  // are impossible. That has to be stated on the page rather than rendered as
  // an empty table that reads like "nothing recurred".
  const csv = await pegaExport(realShape);
  const analysis = analyseBottlenecks(csv);
  assert.ok(analysis.missing.includes("message"),
    `expected 'message' to be reported missing, got: ${analysis.missing.join(", ")}`);
});

test("G10 a required field that IS present is never reported missing", async () => {
  const csv = await pegaExport(realShape);
  const analysis = analyseBottlenecks(csv);
  assert.equal(analysis.missing.includes("time"), false);
  assert.equal(analysis.missing.includes("category"), false);
  assert.equal(analysis.missing.includes("duration"), false);
});

// === R10-R13: owner rulings, ratified after the first real run ==========

test("R10a the elapsed unit is milliseconds, not a guess", async () => {
  // R10. Previously this was flagged as a hypothesis because no unit was stated
  // anywhere in the export. The owner has now ruled it, so it is established
  // fact and the page may print "ms" rather than an uninterpretable number.
  const csv = await pegaExport(realShape);
  const analysis = analyseBottlenecks(csv);
  assert.equal(analysis.durationUnit, "ms");
  assert.equal(analysis.durationUnitIsRuled, true, "a ruling is not a hypothesis");
});

test("R11a timestamps are UTC, so the hourly table may say so", async () => {
  const csv = await pegaExport(realShape);
  const analysis = analyseBottlenecks(csv);
  assert.equal(analysis.timeZoneIsRuled, true);
});

test("R13 a category carries its logger alias", async () => {
  // R13: the code alone is not readable. "PEGA0005" means nothing to the person
  // who has to act on it, so the label becomes "PEGA0005 (<logger>)".
  const csv = await pegaExport(realShape);
  const analysis = analyseBottlenecks(csv);
  assert.equal(analysis.categories[0].label, "PEGA0001 (logger-PEGA0001)",
    "the alias is appended, not substituted");
  assert.equal(analysis.categories[0].key, "PEGA0001", "the key stays machine-readable");
});

test("R13b an alias is only appended when it is unambiguous", async () => {
  // One logger mapping to several codes is not an alias, it is a coincidence.
  // Asserting an alias there would print a label that is wrong for most rows.
  const cwd = await makeTempWorkspace("nf-alias-");
  const header = "_time,alertType,alert_code,logger_name,elapsed_time,threshold";
  const rows = [
    "2026-09-30T12:00:00Z,performance,PEGA0001,shared,1200,1000",
    "2026-09-30T12:01:00Z,performance,PEGA0002,shared,900,1000",
    "2026-09-30T12:02:00Z,performance,PEGA0001,shared,1300,1000",
  ];
  await writeFixture(cwd, "ambiguous.csv", `${header}\n${rows.join("\n")}\n`);
  const analysis = analyseBottlenecks(await csvRead({ path: path.join(cwd, "ambiguous.csv") }));
  assert.equal(analysis.categories[0].label, "PEGA0001", "an ambiguous mapping must not be printed");
  assert.ok(analysis.ambiguousAliases.length > 0, "and the ambiguity is reported");
});

test("D1 a divergence between the two rankings is measured, not just noticed", async () => {
  // Shaped like the REAL export, where the two orderings disagree at the top:
  // a noisy category that fires constantly and costs almost nothing, and a rare
  // one that costs a thousand times more. The synthetic Pega fixture above does
  // NOT diverge at the top -- both orderings lead with PEGA0001 there -- which is
  // why this needs its own data rather than borrowing that one.
  const cwd = await makeTempWorkspace("nf-diverge-");
  const header = "_time,alertType,alert_code,logger_name,elapsed_time,threshold";
  const rows = [];
  for (let i = 0; i < 20; i += 1) rows.push(`2026-09-30T12:00:00Z,performance,PEGA_NOISY,logger-noisy,100,1000`);
  for (let i = 0; i < 2; i += 1) rows.push(`2026-09-30T13:00:00Z,performance,PEGA_MEGA,logger-mega,1000000,1000`);
  await writeFixture(cwd, "diverge.csv", `${header}\n${rows.join("\n")}\n`);

  const analysis = analyseBottlenecks(await csvRead({ path: path.join(cwd, "diverge.csv") }));
  assert.ok(analysis.divergence !== null, "the orderings disagree, so divergence must be reported");
  assert.equal(analysis.divergence.byFrequency.key, "PEGA_NOISY");
  assert.equal(analysis.divergence.byElapsed.key, "PEGA_MEGA");
  assert.equal(analysis.divergence.totalRatio, 1000, "2,000,000 over 2,000");
  assert.equal(analysis.divergence.alertRatio, 0.1, "a tenth of the alerts");
});

test("D2 no divergence is reported when both rankings agree", async () => {
  // A headline that always shouts is a headline nobody reads.
  const cwd = await makeTempWorkspace("nf-agreed-");
  const header = "_time,alertType,alert_code,logger_name,elapsed_time,threshold";
  const rows = [];
  for (let i = 0; i < 6; i += 1) rows.push(`2026-09-30T12:0${i}:00Z,performance,PEGA0001,logger-a,1000,1000`);
  for (let i = 0; i < 2; i += 1) rows.push(`2026-09-30T13:0${i}:00Z,performance,PEGA0002,logger-b,900,1000`);
  await writeFixture(cwd, "agree.csv", `${header}\n${rows.join("\n")}\n`);
  const analysis = analyseBottlenecks(await csvRead({ path: path.join(cwd, "agree.csv") }));
  assert.equal(analysis.divergence, null, "one leader on both orderings is not news");
});