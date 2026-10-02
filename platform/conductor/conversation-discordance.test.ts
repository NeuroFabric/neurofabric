import test from "node:test";
import assert from "node:assert/strict";

import { replyTo } from "./conversation.ts";

/**
 * ASKING ABOUT DISCORDANCE, IN WORDS.
 *
 * The MAD detector is proven in multivariate.test.ts and reaches the executive
 * summary in multivariate-synthesis.test.ts. Neither is a question a person can
 * ask. A capability the user has to know to exist, and cannot name, is a
 * capability most users never get.
 *
 * The branch is placed BEFORE the findings branch on purpose. "Are there any
 * complex anomalies?" contains the word "anomalies", and the findings branch
 * matches on `anomal` -- so a branch added after it would never be reached, and
 * the question would answer something true and unrelated. That ordering is
 * pinned below, because it is invisible until somebody reorders the branches.
 *
 * The check runs ON DEMAND rather than on every message. It is O(pairs x n)
 * with a sort on each axis, and a chat message is not the place to pay for a
 * scan the user did not ask for. `rows` is therefore optional on the
 * conversation data, and a caller that has not wired it gets an honest "I
 * cannot check that from what I was given" rather than a fabricated "no".
 */

const COLUMNS = [
  { name: "latency_ms", mean: 145, min: 100, max: 190, measured: 200, dirty: 0, empty: 0 },
  { name: "total_bytes", mean: 6465, min: 6000, max: 7000, measured: 200, dirty: 0, empty: 0 },
];

/** Rows where the two columns rise together, with one impossible row planted. */
function rowsWithContradiction(): Record<string, number>[] {
  const rows: Record<string, number>[] = [];
  for (let i = 0; i < 200; i++) {
    const x = 100 + ((i * 37) % 90);
    rows.push({ latency_ms: x, total_bytes: 5000 + x * 10 + ((i * 13) % 40) });
  }
  rows[45] = { latency_ms: 1000, total_bytes: 20 };
  return rows;
}

const DATA = {
  source: "sales.csv",
  totalRows: 200,
  purpose: "an order log",
  columns: COLUMNS,
  ranking: [{ key: "web", count: 100 }],
  timeline: [{ hour: "2026-09-01T09", count: 20, share: 0.1, multiple: 1, spike: false, rule: null }],
  anomalies: [],
  learned: {},
  greeting: { text: "hello", widgets: [], suggestions: [] },
  rows: rowsWithContradiction(),
} as never;

// The same rows WITHOUT the planted contradiction. Rebuilt from scratch rather
// than patched: an earlier draft kept index 45 (`i === 45 ? r : ...`), which is
// the one row that had to go, so the "clean" fixture was the dirty one and the
// false-positive test was passing for the wrong reason.
const CLEAN = {
  ...(DATA as object),
  rows: Array.from({ length: 200 }, (_, i) => {
    const x = 100 + ((i * 37) % 90);
    return { latency_ms: x, total_bytes: 5000 + x * 10 + ((i * 13) % 40) };
  }),
} as never;

test("'are there any complex anomalies?' runs the cross-column check", () => {
  const reply = replyTo(DATA, "are there any complex anomalies?");
  assert.equal(reply.kind, "answer");
  assert.match(reply.text, /latency_ms/, "naming the column that is high");
  assert.match(reply.text, /total_bytes/, "and the column that is low");
  assert.match(reply.text, /row 4[56]/i, "and the row, so the user can go and look at it");
});

test("'what is discordant?' reaches the same answer", () => {
  const reply = replyTo(DATA, "what is discordant?");
  assert.match(reply.text, /latency_ms/, "the same finding, by either phrasing");
});

test("the answer is not the generic decline", () => {
  const reply = replyTo(DATA, "are there any complex anomalies?");
  assert.doesNotMatch(reply.text, /will not invent a figure/,
    "this question IS answerable, so declining it would be a regression");
});

test("a clean file is told there is nothing, not given a finding", () => {
  const reply = replyTo(CLEAN, "are there any complex anomalies?");
  assert.doesNotMatch(reply.text, /unusually high/i,
    "a false positive here teaches the user to ignore the real one");
  assert.match(reply.text, /no|not|nothing/i, "and is told plainly that there is nothing");
});

test("the findings question is NOT hijacked by this branch", () => {
  // The ordering hazard: "what is wrong with this file" must still answer with
  // per-column findings, not with a cross-column report.
  const withFindings = {
    ...(DATA as object),
    anomalies: [{ column: "latency_ms", severity: "critical", kind: "extreme", detail: "past the fence", factor: 9 }],
  } as never;
  const reply = replyTo(withFindings, "what is wrong with this file?");
  assert.doesNotMatch(reply.text, /discord/i, "the per-column findings branch still owns this question");
});

test("a caller that wired no rows is told so, rather than given a false 'no'", () => {
  const noRows = { ...(DATA as object), rows: undefined } as never;
  const reply = replyTo(noRows, "are there any complex anomalies?");
  assert.match(reply.text, /cannot|not able|need the rows|could not/i,
    "an honest limit, not a fabricated absence of findings");
});
