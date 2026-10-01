import test from "node:test";
import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { csvRead, parseCsv } from "./capabilities.ts";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { makeTempWorkspace, pathExists, writeFixture } from "../test-support/temp-workspace.ts";

/**
 * READER SHAPE — the two defects a REAL export found and a synthetic one could
 * not.
 *
 * Both were discovered by profiling `data/splunk-export.csv`, a genuine export,
 * and neither was reachable from the Stage-2 fixture. That is the lesson worth
 * more than the fixes: a fixture written by the same person who wrote the parser
 * can only contain assumptions that person already holds.
 *
 * 1. A TRAILING NEWLINE produced a phantom ragged row. `parseCsv` pushed a row
 *    on every `\n` unconditionally, so a file ending in the conventional final
 *    newline -- which is nearly every CSV that exists -- reported a last row of
 *    one empty value against a twelve-column header. The renderer then correctly
 *    refused to draw a report, on a file that was not actually ragged.
 *
 * 2. THE ANALYSER ONLY SAW 50 ROWS. It iterated `CsvReadResult.sample`, which
 *    `csvRead` caps at 50 for charting. A 101-row export was silently
 *    half-analysed; a 100,000-row export would be 99.95% discarded, with no
 *    indication on the page. The one-page requirement is that the OUTPUT is one
 *    page, not that the INPUT is truncated.
 */

test("R1 a trailing newline does not create a row", () => {
  const withoutNewline = parseCsv("a,b\n1,2");
  const withNewline = parseCsv("a,b\n1,2\n");
  assert.equal(withoutNewline.rows.length, withNewline.rows.length,
    "a trailing newline must not change the row count");
  assert.deepEqual(withNewline.problems, [],
    `a trailing newline must not report raggedness: ${withNewline.problems.join("; ")}`);
});

test("R2 blank lines are skipped wherever they appear", () => {
  const parsed = parseCsv("a,b\n1,2\n\n3,4\n");
  assert.equal(parsed.rows.length, 2, "blank lines are not records");
  assert.deepEqual(parsed.problems, [], parsed.problems.join("; "));
});

test("R3 a real ragged row is still reported", async () => {
  // The fix must not have been "stop noticing raggedness".
  const cwd = await makeTempWorkspace("nf-ragged-");
  await writeFixture(cwd, "ragged.csv", "a,b,c\n1,2,3\n4,5\n6,7,8\n");
  const csv = await csvRead({ path: path.join(cwd, "ragged.csv") });
  assert.equal(csv.problems.length, 1, `expected exactly one problem, got: ${csv.problems.join("; ")}`);
  assert.match(csv.problems[0], /row 3 has 2 value\(s\) but the header declares 3/);
});

test("R4 the analysis sees every row, not the charting sample", async () => {
  const cwd = await makeTempWorkspace("nf-volume-");
  const lines = ["_time,source,status,_raw"];
  for (let i = 0; i < 400; i += 1) {
    lines.push(`2026-09-01T00:${String(i % 60).padStart(2, "0")}:00Z,svc-${i},500,ERROR failure mode ${i % 7}`);
  }
  await writeFixture(cwd, "big.csv", `${lines.join("\n")}\n`);

  const csv = await csvRead({ path: path.join(cwd, "big.csv") });
  assert.equal(csv.rowCount, 400, "the reader counted every row");
  assert.ok(csv.sample.length <= 50, "the charting sample stays small by design");

  const analysis = analyseBottlenecks(csv);
  assert.equal(analysis.totalRows, 400,
    `the analyser only saw ${analysis.totalRows} rows; a silently truncated analysis is worse than a slow one`);
  assert.equal(analysis.errorRows, 400, "every row is an error here");
  assert.equal(analysis.bySource.length, 400, "every distinct source is ranked");
});

test("R5 a ranking that omitted most rows would now be visible", async () => {
  // The failure mode this guards is silence. 400 rows across 400 sources cannot
  // be summarised by the first 50 without the page looking merely incomplete.
  const cwd = await makeTempWorkspace("nf-truncation-");
  const lines = ["_time,source,status,_raw"];
  for (let i = 0; i < 60; i += 1) {
    lines.push(`2026-09-01T00:00:00Z,svc-${String(i).padStart(3, "0")},500,ERROR failure ${i}`);
  }
  await writeFixture(cwd, "sixty.csv", `${lines.join("\n")}\n`);
  const csv = await csvRead({ path: path.join(cwd, "sixty.csv") });
  const analysis = analyseBottlenecks(csv);
  assert.equal(analysis.totalRows, 60, "60 rows in, 60 rows analysed");
  assert.equal(analysis.bySource.length, 60, "the tail beyond the sample cap is not dropped");
});

test("R6 the real-export shape is still analysable end to end", async () => {
  // A Pega-shaped export: no `status`, no `source`, no `_raw`, all-blank columns,
  // ISO timestamps with zero spread, and a trailing newline. This is the shape
  // the real file has, and it must produce an HONEST EMPTY ranking rather than
  // invented numbers.
  const cwd = await makeTempWorkspace("nf-pega-");
  const rows = ["time,source_host,nodeid,userid,thread_name,logger_name,alertType,alert_code,elapsed_ms,threshold,pega_time,service_url"];
  for (let i = 0; i < 5; i += 1) {
    rows.push(`2026-09-30,pega-psd-prt-background-6594d,,,PegaRULE,com.pega.exception,exception,EXCP0001,0,0,"2026-09-30 11:15:22,000",`);
  }
  await writeFixture(cwd, "pega.csv", `${rows.join("\n")}\n`);
  const csv = await csvRead({ path: path.join(cwd, "pega.csv") });

  assert.deepEqual(csv.problems, [],
    `the real export's trailing newline must not read as ragged: ${csv.problems.join("; ")}`);

  const analysis = analyseBottlenecks(csv);
  assert.equal(analysis.totalRows, 5);
  assert.equal(analysis.errorRows, 0, "no status column means no errors are claimed");
  assert.deepEqual(analysis.recurring, [], "and no message column means no invented signatures");
  assert.ok(analysis.missing.includes("message"), "the absent message field is named");

  // This fixture is deliberately UNIFORM, and the R9 rule fires on it: every
  // row carries the same alert_code, so ranking by it would put all five rows in
  // one bucket. A null category with the column reported as degenerate is the
  // honest answer, where an earlier version of this test expected a populated
  // ranking and would have rendered a one-bucket table that looked like a result.
  assert.equal(analysis.categoryColumn, null, "a single-valued alert_code cannot rank anything");
  const degenerate = analysis.degenerateColumns.find((d) => d.column === "alert_code");
  assert.ok(degenerate, "and the demotion is reported, not silent");
  assert.equal(degenerate.distinctValues, 1);

  // source_host IS a credible source and is now mapped, so the ranking is real
  // rather than empty. This assertion was written when nothing was recognised;
  // R9 mapping changed the answer, and the change is the point -- an empty
  // ranking would have been the absence of a reading, not a finding.
  assert.equal(analysis.bySource.length, 1);
  assert.equal(analysis.bySource[0].key, "pega-psd-prt-background-6594d");
});