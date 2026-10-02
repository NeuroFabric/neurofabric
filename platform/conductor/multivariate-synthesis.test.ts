import test from "node:test";
import assert from "node:assert/strict";

import { synthesize } from "./synthesis.ts";
import { findCrossColumnAnomalies } from "./multivariate.ts";
import type { SynthesisInput } from "./synthesis.ts";

/**
 * THE SUMMARY MUST ACTUALLY SAY IT.
 *
 * A detector that is computed and never rendered is a detector nobody gets.
 * This file exists to pin the WIRING, not the maths -- the maths is proven in
 * multivariate.test.ts. The thing that fails silently here is a summary that
 * quietly omits a cross-column finding, because every other line in it is
 * true.
 *
 * The omission would be the dangerous kind. A file whose per-column statistics
 * are entirely ordinary, but which contains a row that is impossible, would
 * read as CLEAN. "I read this file and found nothing" is the most damaging
 * thing this product can say, and it is exactly what it would say.
 */

const HEALTH = { columns: [], dirty: 0, empty: 0, outliers: [] } as never;

const CLEAN: SynthesisInput = {
  totalRows: 200,
  columns: [
    { column: "latency_ms", mean: 145, min: 100, max: 190, measured: 200, dirty: 0, empty: 0, outliers: 0 },
    { column: "total_bytes", mean: 6465, min: 6000, max: 7000, measured: 200, dirty: 0, empty: 0, outliers: 0 },
  ],
  health: HEALTH,
};

function rowsWithContradiction(): Record<string, number>[] {
  const rows: Record<string, number>[] = [];
  for (let i = 0; i < 200; i++) {
    const x = 100 + ((i * 37) % 90);
    rows.push({ latency_ms: x, total_bytes: 5000 + x * 10 + ((i * 13) % 40) });
  }
  rows[100] = { latency_ms: 1000, total_bytes: 20 };
  return rows;
}

test("a contradiction is named in the executive summary", () => {
  const cross = findCrossColumnAnomalies({ rows: rowsWithContradiction(), columns: ["latency_ms", "total_bytes"] });
  assert.ok(cross.length > 0, "the fixture must actually contain one");

  const summary = synthesize({ ...CLEAN, crossColumn: cross });
  const text = summary.paragraph;
  assert.match(text, /cross-column anomal/i, "the summary must name the class of finding");
  assert.match(text, /latency_ms/, "naming the column that is high");
  assert.match(text, /total_bytes/, "and the column that is low");
});

test("a file with no contradiction says nothing about cross-column findings", () => {
  const rows: Record<string, number>[] = [];
  for (let i = 0; i < 200; i++) {
    const x = 100 + ((i * 37) % 90);
    rows.push({ latency_ms: x, total_bytes: 5000 + x * 10 + ((i * 13) % 40) });
  }
  const cross = findCrossColumnAnomalies({ rows, columns: ["latency_ms", "total_bytes"] });
  const summary = synthesize({ ...CLEAN, crossColumn: cross });
  assert.doesNotMatch(summary.paragraph, /cross-column anomal/i,
    "a clean file must not be given a finding it does not have");
});

test("a summary with no cross-column input at all is unchanged", () => {
  // The field is optional, and a caller that has not wired it must still get
  // the summary it got before. A crash here would mean the cross-column work
  // had broken the product for every existing caller.
  const summary = synthesize(CLEAN);
  assert.ok(summary.paragraph.length > 0, "the ordinary summary still renders");
  assert.doesNotMatch(summary.paragraph, /cross-column/i);
});

test("the per-column verdict is not inflated by a cross-column finding", () => {
  // The contradiction is a real defect, but it is ONE row, and calling the
  // whole file "compromised" on that basis would be the summary crying wolf.
  // It is reported as its own sentence, not folded into the defect tally.
  const cross = findCrossColumnAnomalies({ rows: rowsWithContradiction(), columns: ["latency_ms", "total_bytes"] });
  const withIt = synthesize({ ...CLEAN, crossColumn: cross });
  const withoutIt = synthesize(CLEAN);
  assert.equal(withIt.verdict, withoutIt.verdict,
    "a cross-column finding must not change the per-column verdict");
});
