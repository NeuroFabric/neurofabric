import test from "node:test";
import assert from "node:assert/strict";

import { resolveQuery } from "./query.ts";
import { replyTo } from "./conversation.ts";

/**
 * GAP ONE: A MISSPELT COLUMN GETS A GENERIC DECLINE.
 *
 * This one was written down in the V1 user guide as a known limitation:
 *
 *   "A wrong or missing column name yields a generic decline rather than the
 *    list of valid columns. The router can produce that list; the message does
 *    not currently reach the user."
 *
 * That sentence describes a plumbing accident, not a design decision.
 * `resolveQuery` HAS ALWAYS known the numeric columns and has always composed a
 * message naming them. It returned that message as `matched: false`, and the
 * caller reads `matched: false` as "not a question I recognise" -- so it fell
 * through every branch to the generic "I cannot answer that from what I have
 * measured".
 *
 * The user typed a perfectly reasonable question about a column that does not
 * exist, and was told the agent cannot answer it. That reads as the agent being
 * INCAPABLE rather than the COLUMN being absent, which is the worse error: it
 * invites the user to conclude the product does less than it does.
 *
 * The fix is a THIRD state. A router that does not recognise a question should
 * fall through to the generic decline. A router that recognised the SHAPE and
 * is missing one input should ASK for that input. Collapsing those two states
 * is what caused the gap.
 */

const HISTOGRAM = [
  { lo: 0, hi: 5, count: 2 }, { lo: 5, hi: 10, count: 3 }, { lo: 10, hi: 15, count: 5 },
  { lo: 15, hi: 20, count: 8 }, { lo: 20, hi: 25, count: 14 }, { lo: 25, hi: 30, count: 22 },
  { lo: 30, hi: 35, count: 30 }, { lo: 35, hi: 40, count: 18 }, { lo: 40, hi: 45, count: 9 },
  { lo: 45, hi: 50, count: 4 }, { lo: 50, hi: 55, count: 2 }, { lo: 55, hi: 60, count: 1 },
];

const DATA = {
  source: "sales.csv",
  totalRows: 120,
  purpose: "an order log",
  columns: [
    { name: "amount_usd", mean: 120, min: 1, max: 99, measured: 118, dirty: 0, empty: 2, histogram: HISTOGRAM },
    { name: "balance_usd", mean: 800, min: 3, max: 40000, measured: 115, dirty: 3, empty: 2, histogram: HISTOGRAM },
  ],
  ranking: [],
  timeline: [{ hour: "2026-09-01T09", count: 20, share: 0.2, multiple: 1, spike: false, rule: null }],
  anomalies: [],
  learned: {},
  greeting: { text: "hello", widgets: [], suggestions: [] },
} as never;

test("a misspelt column is ASKED ABOUT, not ignored", () => {
  const r = resolveQuery(DATA as never, "how many cost are over 500?");
  assert.equal(r.clarify, true,
    "a threshold question about an absent column is a clarification, not an unrecognised question");
  assert.match(r.answer, /cost/, "and it names the word it could not find");
  assert.match(r.answer, /amount_usd/, "offering the nearest real column");
});

test("the clarification survives all the way to the user", () => {
  const reply = replyTo(DATA as never, "how many cost are over 500?");
  assert.equal(reply.kind, "answer", "the user gets an answer, not a decline");
  assert.doesNotMatch(reply.text, /will not invent a figure/, "and specifically not the generic decline");
  assert.match(reply.text, /amount_usd/, "with a real column to try instead");
});

test("a column name that is merely misremembered is still a clarification", () => {
  // `balances_usd` is not a typo of `balance_usd` by edit distance 1 on a long
  // word, but it is unmistakably the user reaching for a column in the file.
  const r = resolveQuery(DATA as never, "how many balances_usd are over 500?");
  assert.equal(r.clarify, true, "a near-miss name is exactly the case this fixes");
  assert.match(r.answer, /balance_usd/, "and gets pointed at the real one");
});

test("a genuinely unrecognised sentence still declines generically", () => {
  // The fix must NOT turn every unknown sentence into a clarification, or the
  // agent would start inventing column names at people who never asked about
  // one.
  const r = resolveQuery(DATA as never, "tell me a story about this file");
  assert.equal(r.clarify, false, "an unrecognised sentence is not a clarification");
  assert.equal(replyTo(DATA as never, "tell me a story about this file").text.includes("will not invent"), true,
    "and still declines honestly");
});

test("a correct column name is never mistaken for a missing one", () => {
  const r = resolveQuery(DATA as never, "how many amount_usd are over 500?");
  assert.equal(r.matched, true, "the correctly-spelled question still answers");
  assert.equal(r.clarify, false, "and is not a clarification");
});

test("a mean question about an absent column asks rather than declines", () => {
  const r = resolveQuery(DATA as never, "what is the average of price?");
  assert.equal(r.clarify, true, "the same fix applies to the mean branch");
  assert.match(r.answer, /amount_usd/, "naming the nearest column");
});
