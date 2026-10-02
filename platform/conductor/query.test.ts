import test from "node:test";
import assert from "node:assert/strict";

import { resolveQuery } from "./query.ts";

/**
 * THE QUERY RESOLVER. Natural language in, a COMPUTED answer out.
 *
 * === WHAT WAS MISSING, PRECISELY ===
 *
 * The router could hand a user the right CHART. It could not answer "how many
 * rows are over 5,000", because a summary is not invertible: a mean, a max and
 * an outlier count do not determine how many values fall in an arbitrary range.
 *
 * So the honest options were to decline, or to guess. Declining meant the agent
 * answered "what is the worst hour" and refused "how many queries took longer
 * than two seconds" -- which is the question a person with a slow database
 * actually opens the file to ask, and it would read as a product that cannot do
 * arithmetic.
 *
 * The answer is a bounded HISTOGRAM per numeric column, computed in the same pass
 * as the mean and the fences, so a summary and a histogram can never disagree
 * about which cells were measured.
 *
 * === AND THE LIMIT IS STATED RATHER THAN HIDDEN ===
 *
 * A bucket is a RANGE. "About 3,900 rows" is a defensible answer; "3,912 rows"
 * is a fabrication. Every answer built from a bucket carries its bounds, and a
 * question that cannot be answered within them is DECLINED rather than rounded
 * into a plausible-looking number. That is the whole difference between this and
 * a system that answers everything confidently and is wrong sometimes.
 */

/** Twenty buckets spanning 0..100, with a known distribution. */
const HISTOGRAM = [
  { lo: 0, hi: 5, count: 2 }, { lo: 5, hi: 10, count: 3 }, { lo: 10, hi: 15, count: 5 },
  { lo: 15, hi: 20, count: 8 }, { lo: 20, hi: 25, count: 14 }, { lo: 25, hi: 30, count: 22 },
  { lo: 30, hi: 35, count: 30 }, { lo: 35, hi: 40, count: 18 }, { lo: 40, hi: 45, count: 9 },
  { lo: 45, hi: 50, count: 4 }, { lo: 50, hi: 55, count: 2 }, { lo: 55, hi: 60, count: 1 },
  { lo: 60, hi: 65, count: 0 }, { lo: 65, hi: 70, count: 0 }, { lo: 70, hi: 75, count: 0 },
  { lo: 75, hi: 80, count: 0 }, { lo: 80, hi: 85, count: 0 }, { lo: 85, hi: 90, count: 0 },
  { lo: 90, hi: 95, count: 0 }, { lo: 95, hi: 100, count: 0 },
];

const DATA = {
  totalRows: 120,
  columns: [
    {
      name: "total_elapsed_time_ms",
      mean: 32.4, min: 1, max: 99, measured: 118,
      dirty: 0, empty: 2, histogram: HISTOGRAM,
    },
    {
      name: "logical_reads",
      mean: 800, min: 3, max: 40000, measured: 115,
      dirty: 3, empty: 2, histogram: [],
    },
  ],
  ranking: [{ key: "SELECT * FROM orders", count: 60 }],
  timeline: [
    { hour: "2026-09-30T09", count: 12, share: 0.1, multiple: 1, spike: false, rule: null },
    { hour: "2026-09-30T10", count: 96, share: 0.8, multiple: 8, spike: true, rule: "8x the mean hour" },
  ],
};

// === The headline case the directive named =================================

test("a DATA question is answered with a CALCULATION, not a schema refusal", () => {
  const q = resolveQuery(DATA, "how many rows have total_elapsed_time_ms over 40");
  assert.equal(q.matched, true, "this is a question about the DATA, not a column mapping");
  assert.equal(q.kind, "rows-above");
  assert.equal(q.column, "total_elapsed_time_ms");
  assert.equal(q.threshold, 40);
});

test("the answer is the SUM of the buckets above the threshold", () => {
  const q = resolveQuery(DATA, "how many rows have total_elapsed_time_ms over 40");
  // 9 + 4 + 2 + 1 = 16
  assert.equal(q.exact, 16, "the buckets above 40 hold 16 values");
  assert.match(String(q.answer), /16/, "and the answer says so");
});

test("'under' is the mirror of 'over', and the two never agree by accident", () => {
  const above = resolveQuery(DATA, "how many rows have total_elapsed_time_ms over 40");
  const below = resolveQuery(DATA, "how many rows have total_elapsed_time_ms under 40");
  assert.equal(above.exact, 16);
  assert.equal(below.exact, 102, "102 measured values lie below 40");
  assert.equal(above.exact + below.exact, 118, "and together they account for every measured value");
});

test("a threshold INSIDE a bucket is answered with a RANGE, never a point", () => {
  // 33 falls inside the 30..35 bucket, which holds 30 values. Claiming "30" would
  // be a fabrication, and it is the single most tempting lie this feature could
  // tell.
  const q = resolveQuery(DATA, "how many rows in total_elapsed_time_ms are over 33");
  assert.equal(q.matched, true);
  assert.equal(q.exact, null, "a bucket cannot produce an exact count");
  assert.equal(q.bounds !== null, true, "so the answer carries its bounds");
  assert.match(String(q.answer), /at least|at most|between|about/i,
    `and the wording must be approximate: ${q.answer}`);
  // The bound must be truthful, and the arithmetic is worth stating because it
  // is the whole point. The threshold 33 falls inside the 30..35 bucket, which
  // holds 30 values and SPLITS: some of them are above 33 and some are not, and
  // nothing in a histogram can say which. So they are excluded from the lower
  // bound. Whole buckets above 33 hold 18 + 9 + 4 + 2 + 1 = 34, and the
  // straddler adds at most 30 more.
  assert.match(String(q.answer), /At least 34/, `the lower bound must exclude the straddler: ${q.answer}`);
  assert.match(String(q.answer), /at most 64/, "and the upper bound must include it");
});

test("a threshold ON a bucket edge is exact, because the buckets are half-open", () => {
  const q = resolveQuery(DATA, "how many rows in total_elapsed_time_ms are over 40");
  assert.equal(q.exact, 16, "40 is a bucket edge, so every value above it is counted whole");
  assert.equal(q.bounds, null, "and nothing straddles it");
});

test("a range question with NO column named is declined, not guessed", () => {
  // "how many rows are over 40" does not say WHICH column. Picking the widest,
  // the first, or the one whose name happens to contain a shared word would all
  // be inventing the question. A count with no subject is not an answer.
  const q = resolveQuery(DATA, "how many rows are over 40");
  assert.equal(q.matched, false);
  assert.match(String(q.answer), /numeric columns here/i,
    `it must list the real columns so the user can see which one they meant: ${q.answer}`);
});

// === Metrics that do not need a threshold ================================

test("'which column has the most missing values' is answered from the profile", () => {
  const q = resolveQuery(DATA, "which column has the most missing values");
  assert.equal(q.matched, true);
  assert.equal(q.kind, "argmax-missing");
  assert.equal(q.column, "logical_reads", "5 missing beats 2");
  assert.match(String(q.answer), /logical_reads/);
  assert.match(String(q.answer), /5/, "and carries the count");
});

test("'what is the average X' answers with the mean the engine computed", () => {
  const q = resolveQuery(DATA, "what is the average total_elapsed_time_ms");
  assert.equal(q.matched, true);
  assert.equal(q.kind, "mean");
  assert.match(String(q.answer), /32\.4|32\.40/, `the mean, verbatim: ${q.answer}`);
});

test("'what is the worst hour' is a DATA question about the timeline", () => {
  const q = resolveQuery(DATA, "what was the worst hour");
  assert.equal(q.matched, true);
  assert.equal(q.kind, "worst-hour");
  assert.match(String(q.answer), /10|96/, "and names the hour and its count");
});

test("a percentage question returns a percentage, not a count", () => {
  const q = resolveQuery(DATA, "what percentage of rows are in the worst hour");
  assert.equal(q.matched, true);
  assert.match(String(q.answer), /80%|80\.0%|0\.8|80 percent/i,
    `a share must be stated as a share: ${q.answer}`);
});

// === What it must NOT do ==================================================

test("a question about a column that does not exist is DECLINED, not guessed", () => {
  const q = resolveQuery(DATA, "how many rows have revenue over 40");
  assert.equal(q.matched, false, "revenue is not a column in this file");
  assert.equal(q.exact, null);
  assert.match(String(q.answer), /not in this file|no column|numeric columns here/i,
    `and it must say why, and what IS available: ${q.answer}`);
  assert.match(String(q.answer), /total_elapsed_time_ms/,
    "listing the real columns is what lets the user correct themselves");
});

test("a column with no histogram is declined for RANGE questions only", () => {
  // logical_reads has measured/min/max/mean but no buckets, so a range question
  // is unanswerable. A MEAN question is still fine -- that is the point of
  // keeping both.
  assert.equal(resolveQuery(DATA, "how many rows have logical_reads over 1000").matched, false);
  assert.equal(resolveQuery(DATA, "what is the average logical_reads").matched, true);
});

test("a question with no number and no metric does not match", () => {
  assert.equal(resolveQuery(DATA, "what is this file").matched, false);
  assert.equal(resolveQuery(DATA, "hello there").matched, false);
  assert.equal(resolveQuery(DATA, "").matched, false);
});

test("it NEVER invents a number it did not compute", () => {
  // Every matched answer must be traceable to a computed field.
  for (const question of [
    "how many rows have total_elapsed_time_ms over 40",
    "which column has the most missing values",
    "what is the average total_elapsed_time_ms",
    "what was the worst hour",
  ]) {
    const q = resolveQuery(DATA, question);
    assert.equal(q.matched, true, question);
    assert.ok(q.answer.length > 0, "and carries an answer");
    // A range answer must expose its bounds so the renderer can show them.
    if (q.exact === null) assert.equal(q.bounds !== null, true, `${question}: no exact and no bounds`);
  }
});

test("the answer carries the COLUMN it is about, so the UI can label it", () => {
  const q = resolveQuery(DATA, "how many rows have total_elapsed_time_ms over 40");
  assert.equal(q.column, "total_elapsed_time_ms", "without this the answer is an orphan");
});

test("a widget is offered where there is a shape worth drawing", () => {
  // A range query over a column IS a histogram, and drawing it beats reciting
  // one number with no context.
  const q = resolveQuery(DATA, "how many rows have total_elapsed_time_ms over 40");
  assert.ok(q.widget !== undefined, "a distribution question should bring its distribution");
  assert.equal(q.widget!.kind, "histogram");
});

test("column names are matched loosely but confirmed exactly", () => {
  // People write "elapsed time" for "total_elapsed_time_ms". A resolver that
  // demands an exact column name would answer nothing.
  const q = resolveQuery(DATA, "how many rows have elapsed time over 40");
  assert.equal(q.matched, true, "a human-readable form must resolve");
  assert.equal(q.column, "total_elapsed_time_ms", "and resolve to the real column, not a guess");
});