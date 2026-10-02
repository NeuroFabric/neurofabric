import test from "node:test";
import assert from "node:assert/strict";

import { replyTo, greet } from "./conversation.ts";

/**
 * STOP REFUSING THE QUESTIONS EVERYBODY ASKS FIRST.
 *
 * "Tell me more about this file" and "summarize this" were both answered with
 * the generic decline -- "I cannot answer that from what I have measured" --
 * which is a sentence about the AGENT's limits in a conversation the user
 * opened about THEIR file. It reads as the product being unable to describe
 * the very thing it just read, which is the least convincing sentence it could
 * possibly choose.
 *
 * === WHY THE OLD BRANCH MISSED THEM, WHICH IS NOT A MISSING KEYWORD ===
 *
 * The overview branch already existed and matched "summary" and "tell me about".
 * "summarize" does not contain "summary", and "tell me more about" does not
 * contain "tell me about" contiguously. So both fell past a branch that was
 * there, into the decline. The pattern had been written for the words an author
 * imagines rather than the words people type.
 *
 * === WHAT THE ANSWER IS FOR ===
 *
 * A synthesis, assembled from facts already computed -- rows, columns, purpose,
 * largest category, findings, busiest hour -- rather than a paraphrase of the
 * capabilities. Every sentence is a number the engine measured, so the paragraph
 * cannot drift from the file it describes.
 *
 * The decline is NOT removed. "What is the meaning of life" should still be
 * declined, and the honest refusal is what makes the rest of the agent
 * trustworthy. What changes is that a question ABOUT THE FILE is answered from
 * the file, and only a question the file cannot speak to gets the refusal.
 */

const DATA = {
  source: "e-commerce-transactions.csv",
  totalRows: 5539,
  purpose: {
    kind: "transaction",
    statement: "This appears to be a customer transaction or sales record, tracking orders and what was bought.",
    confidence: "high",
    evidence: ["order_value_usd (order_value)", "customer_id (customer_id)"],
    columns: ["order_value_usd", "customer_id"],
  },
  columns: [
    { name: "order_value_usd", mean: 109.32, min: 7.02, max: 250000, measured: 5539, dirty: 0, empty: 0 },
    { name: "status_code", mean: 200, min: 200, max: 200, measured: 5539, dirty: 0, empty: 0 },
  ],
  ranking: [{ key: "partner-api", count: 1420 }],
  timeline: [
    { hour: "2026-09-03T17", count: 70, share: 0.01, multiple: 2.6, spike: true, rule: "2.6x the hourly average" },
  ],
  anomalies: [
    { column: "order_value_usd", severity: "critical", kind: "extreme", detail: "past the fence", factor: 250 },
  ],
  learned: {},
  greeting: { text: "hello", widgets: [], suggestions: [] },
} as never;

const OPEN_ENDED = [
  "tell me more about this file",
  "summarize this",
  "summarise this",
  "what is this",
  "what is this file about",
  "give me an overview",
  "what can you tell me about this",
  "walk me through this data",
  "describe this file",
  "what do you see here",
  "give me a summary",
  "catch me up on this file",
];

for (const question of OPEN_ENDED) {
  test(`"${question}" gets an answer, not a punt`, () => {
    const reply = replyTo(DATA, question);
    assert.equal(reply.kind, "answer", "the user asked about their file");
    assert.doesNotMatch(reply.text, /I cannot answer that from what I have measured/,
      `must not refuse a question the file can answer: ${reply.text}`);
    assert.doesNotMatch(reply.text, /^I cannot|^Sorry|I don't know/i,
      "and must not open with a refusal");
  });
}

test("the synthesis actually contains the file's facts", () => {
  const reply = replyTo(DATA, "tell me more about this file");
  assert.match(reply.text, /5,539/, "the row count");
  assert.match(reply.text, /order_value_usd/, "the worst column by name");
  assert.match(reply.text, /partner-api/, "the largest category by name");
  assert.match(reply.text, /250,000/, "and the figure that made it severe");
  assert.match(reply.text, /severe/i, "with the severity stated");
});

test("it reads as a paragraph a person wrote, not a field dump", () => {
  const reply = replyTo(DATA, "tell me more about this file");
  assert.ok(reply.text.length > 120,
    `a real summary is more than a sentence: ${reply.text}`);
  assert.doesNotMatch(reply.text, /undefined|NaN|\[object Object\]/,
    "and it must not leak a missing value into the prose");
});

test("a file with NO findings says so rather than inventing some", () => {
  const clean = { ...(DATA as object), anomalies: [] } as never;
  const reply = replyTo(clean, "tell me more about this file");
  assert.doesNotMatch(reply.text, /severe anomal/i, "nothing severe to report");
  assert.match(reply.text, /nothing to flag|clean|no structural defect/i,
    `and it must say so: ${reply.text}`);
});

test("a question about the MEAT still declines honestly", () => {
  // The refusal is not removed. It is what makes every other answer worth
  // reading, and a product that invents an answer to "what is the meaning of
  // life" is worse than one that says it does not know.
  const reply = replyTo(DATA, "what is the meaning of life?");
  assert.match(reply.text, /I cannot answer|I have measured/i,
    "an unanswerable question still gets the honest refusal");
});

test("an unidentifiable file still gets a summary, not an apology as the WHOLE answer", () => {
  const unknown = {
    ...(DATA as object),
    purpose: { kind: "unknown", statement: "I cannot tell from the column names what this file is.", confidence: "none", evidence: [], columns: [] },
  } as never;
  const reply = replyTo(unknown, "tell me more about this file");
  assert.doesNotMatch(reply.text, /I cannot answer that from what I have measured/,
    "the refusal wording must not appear");
  assert.match(reply.text, /5,539/, "and the facts it DOES know must still be given");
});

test("the first greeting is unchanged", () => {
  // The greeting is a different job from a summary -- it opens a conversation
  // rather than answering one -- and changing it would churn every snapshot.
  const g = greet(DATA);
  assert.match(g.text, /What would you like to know/,
    `the invitation must survive: ${g.text}`);
});