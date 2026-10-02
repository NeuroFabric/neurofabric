import test from "node:test";
import assert from "node:assert/strict";

import { replyTo, greet, CAPABILITIES, type ConversationData } from "./conversation.ts";
import { parseCorrection } from "../web/chat-parse.ts";

/**
 * THE CONVERSATION. What the user types, and what the engine does about it.
 *
 * === WHY THIS IS A MODULE AND NOT PART OF THE PAGE ===
 *
 * The chat is the PRODUCT now. So the decision of what a sentence means cannot
 * live inside a string that is only ever read by a browser -- there would be no
 * way to test it except by shipping it and looking at it, which is exactly how
 * the previous two releases shipped a dashboard nobody could see and a chart
 * that 404ed.
 *
 * So the conversation is a pure function: data in, reply out. It is tested here
 * in Node, exhaustively, and the React page is a thin renderer over its output.
 *
 * === AND WHAT IT IS NOT, STATED PLAINLY ===
 *
 * **This is not a language model.** It is a deterministic intent router over the
 * analysis the engine has already computed. That is a real and useful thing --
 * "show me the worst hour" genuinely returns the worst hour -- and it is what
 * can be built and verified without inventing an API key or pretending a regex
 * is intelligence.
 *
 * The consequence is honest and worth naming: it does not answer arbitrary
 * questions about the data. It routes what it recognises, says plainly what it
 * cannot do, and never invents a number. The place a model would slot in is
 * exactly here -- this module is the tool surface a model would call -- and
 * pretending otherwise today would be the kind of claim this repository refuses
 * to make.
 */

const DB_LOG: ConversationData = {
  source: "query_perf.csv",
  totalRows: 200,
  purpose: {
    kind: "database-performance",
    statement: "This file appears to be a database performance log tracking query execution times.",
    confidence: "high",
    evidence: ["query_snippet (query_snippet)", "total_elapsed_time_ms (elapsed_time)"],
    columns: ["query_snippet", "total_elapsed_time_ms", "execution_plan_id", "db_name", "captured_at"],
  },
  columns: [
    { name: "total_elapsed_time_ms", mean: 412, min: 12, max: 9800, measured: 200, dirty: 0, empty: 0 },
    { name: "logical_reads", mean: 2210, min: 3, max: 90000, measured: 200, dirty: 2, empty: 0 },
  ],
  anomalies: [
    { column: "total_elapsed_time_ms", severity: "critical", kind: "extreme value", detail: "9,800 against a fence of 2,000", factor: 4.9 },
    { column: "logical_reads", severity: "warning", kind: "type mismatch", detail: "2 cell(s) hold something that is not a number", factor: null },
    { column: "logical_reads", severity: "info", kind: "missing values", detail: "3 empty cell(s)", factor: null },
  ],
  ranking: [
    { key: "SELECT * FROM orders", count: 88 },
    { key: "UPDATE users SET last_seen", count: 51 },
    { key: "INSERT INTO audit", count: 22 },
  ],
  timeline: [
    { hour: "2026-09-30T09", count: 12, share: 0.06, multiple: 1.1, spike: false, rule: null },
    { hour: "2026-09-30T10", count: 14, share: 0.07, multiple: 1.2, spike: false, rule: null },
    { hour: "2026-09-30T11", count: 96, share: 0.48, multiple: 8.4, spike: true, rule: "8.4x the mean hour" },
  ],
  learned: { category: "alertType" },
};

const clean: ConversationData = {
  ...DB_LOG,
  source: "empty.csv",
  anomalies: [],
  timeline: [],
  ranking: [],
};

// === The greeting =========================================================

test("the greeting OPENS with the semantic purpose, in the Owner's own shape", () => {
  const greeting = greet(DB_LOG);
  const text = greeting.text;

  assert.match(text, /database performance log/i,
    `the purpose must be the FIRST thing said: ${text}`);
  assert.match(text, /200 rows/, "and how much was read");
  assert.match(text, /1 severe|1 critical/i, "and what was found");
  assert.match(text, /What would you like to know/i, "and an invitation to go on");
});

test("the greeting does NOT claim more certainty than the engine has", () => {
  // "This file IS a database performance log" is a different claim from "This
  // file appears to be one", and the difference is the whole point of shipping
  // confidence alongside the kind.
  assert.match(greet(DB_LOG).text, /appears to be/i, "high confidence, hedged phrasing");

  const unsure = greet({ ...DB_LOG, purpose: { ...DB_LOG.purpose, confidence: "low" } });
  assert.ok(unsure.text.length > 0);
  assert.match(unsure.text, /based on the column names|might|may be|cannot be sure/i,
    `a low-confidence reading must hedge visibly: ${unsure.text}`);
});

test("a file the engine cannot place gets an HONEST greeting, not an invented one", () => {
  const greeting = greet({ ...DB_LOG, purpose: { ...clean.purpose, kind: "unknown", confidence: "none", statement: "I cannot tell from the column names what this file is." } });
  assert.match(greeting.text, /cannot tell|could not/i, `must admit it: ${greeting.text}`);
  assert.doesNotMatch(greeting.text, /database performance log/i,
    "and must NOT fall back to the old guess just because it has nothing else");
  assert.match(greeting.text, /200 rows/, "but still says what it DID learn");
});

test("a clean file is greeted as clean, with no invented findings", () => {
  const greeting = greet(clean);
  assert.doesNotMatch(greeting.text, /anomal|severe|problem/i, `nothing to report: ${greeting.text}`);
  assert.match(greeting.text, /clean|nothing to flag|no findings/i);
});

// === Intent routing =======================================================

test("'show me the worst hour' returns the LINE CHART, as a widget", () => {
  const reply = replyTo(DB_LOG, "show me the worst hour");
  assert.equal(reply.kind, "answer");
  const chart = reply.widgets.find((w) => w.kind === "chart-line");
  assert.ok(chart !== undefined,
    `the hour question must produce a timeline widget, got ${JSON.stringify(reply.widgets.map((w) => w.kind))}`);
  assert.equal(chart!.title, "Rows by hour");
});

test("'what are the top categories' returns the BAR CHART", () => {
  const reply = replyTo(DB_LOG, "what are the top categories?");
  const bar = reply.widgets.find((w) => w.kind === "chart-bar");
  assert.ok(bar !== undefined, `expected a category bar chart, got ${JSON.stringify(reply.widgets.map((w) => w.kind))}`);
  assert.equal(bar!.title, "Record categories");
});

test("'what is wrong with this file' returns the FINDINGS, not a paragraph", () => {
  const reply = replyTo(DB_LOG, "what is wrong with this file");
  assert.ok(reply.widgets.some((w) => w.kind === "findings"),
    "the findings widget IS the answer to this question; prose would be a downgrade");
});

test("'how did you read the columns' returns the MAPPINGS and admits what was guessed", () => {
  const reply = replyTo(DB_LOG, "how did you read the columns?");
  assert.ok(reply.widgets.some((w) => w.kind === "mappings"));
  assert.match(reply.text, /inferred|guessed|hypothesis|assumed/i,
    `the answer must not imply the readings were verified: ${reply.text}`);
});

test("a question the engine cannot answer says so, and does NOT invent one", () => {
  const reply = replyTo(DB_LOG, "what is the customers lifetime value in dollars");
  assert.equal(reply.kind, "answer");
  assert.ok(reply.widgets.length === 0,
    `no widget can be honest here: ${JSON.stringify(reply.widgets.map((w) => w.kind))}`);
  assert.match(reply.text, /cannot|could not|don't have|not in this file/i,
    `it must decline rather than improvise: ${reply.text}`);
  // AND it must not have produced a number.
  assert.doesNotMatch(reply.text, /\d+\s*(dollars|usd|\$)/i,
    "an unanswerable question must never come back with a figure");
});

test("every reply can state what it CAN do, so the user is never stuck", () => {
  const reply = replyTo(DB_LOG, "xyzzy");
  assert.ok(reply.suggestions.length > 0, "an unrecognised message still offers somewhere to go");
  const help = replyTo(DB_LOG, "what can you do?");
  assert.ok(help.widgets.some((w) => w.kind === "capabilities") || help.text.length > 40,
    "and the capabilities themselves are answerable");
});

// === Corrections keep working, and are NOT a separate product ============

test("a correction is recognised by the SAME parser the browser runs", async () => {
  // The single-implementation property from chat-parse.ts must survive the
  // move. If the router used its own grammar, the page and the engine would
  // disagree about what a sentence means.
  const reply = replyTo(DB_LOG, "alertType is the category");
  assert.equal(reply.kind, "correction",
    `a correction must not fall through to the generic answer path: ${reply.text}`);

  // And the parse agrees with the module the browser is given.
  assert.equal(parseCorrection("alertType is the category").ok, true);
});

test("a correction reports what it changed AND what the file is", () => {
  const reply = replyTo(DB_LOG, "alertType is the category");
  assert.equal(reply.correction?.column, "alertType");
  assert.equal(reply.correction?.role, "category");
});

test("an UNPARSEABLE correction says why, rather than being answered as a question", () => {
  // "col_15 is actually the amount" is a correction attempt the engine cannot
  // honour. Answering it as a general question would be answering a different
  // sentence than the one typed.
  const reply = replyTo(DB_LOG, "col_15 is actually the amount");
  assert.equal(reply.kind, "correction");
  assert.ok(reply.correction === undefined, "and carries no correction to apply");
  assert.match(reply.text, /amount|role/i, `it must say what it could not do: ${reply.text}`);
});

// === Widgets are data, not markup ========================================

test("a widget carries DATA, so the renderer cannot invent any", () => {
  // This is the discipline the whole pivot rests on. A widget that carried
  // pre-rendered HTML would put an untrusted-data path back into the chat, on
  // the surface that now handles every column name in the file.
  const reply = replyTo(DB_LOG, "show me the worst hour");
  for (const widget of reply.widgets) {
    assert.equal(typeof widget.title, "string");
    assert.ok(!("html" in widget), "no widget may carry pre-rendered HTML");
    assert.ok(!("markdown" in widget), "nor markdown");
    const serialised = JSON.stringify(widget);
    assert.ok(serialised.length > 2, `widget ${widget.kind} carries nothing`);
  }
});

test("the timeline widget carries the engine's spike verdict, not a redraw of it", () => {
  const reply = replyTo(DB_LOG, "show me the worst hour");
  const chart = reply.widgets.find((w) => w.kind === "chart-line");
  assert.ok(chart !== undefined);
  const points = (chart!.payload as { points: { hour: string; spike: boolean }[] }).points;
  const spiked = points.filter((p) => p.spike);
  assert.equal(spiked.length, 1, "and exactly the engine's spikes, not a re-detection");
  assert.equal(spiked[0]?.hour, "2026-09-30T11");
});

test("CAPABILITIES is a list, so the UI cannot drift from the router", () => {
  assert.ok(CAPABILITIES.length >= 4, "the agent must be able to describe itself");
  for (const c of CAPABILITIES) {
    assert.equal(typeof c.label, "string");
    assert.equal(typeof c.ask, "string");
    assert.ok(c.ask.length > 0, "and every capability must be askable");
  }
});

test("a QUESTION containing a copula is a question, not a failed correction", () => {
  // A REAL BUG, and one that made the agent look broken rather than limited.
  //
  // The first router decided "is this a refused correction?" by looking for a
  // copula anywhere in the sentence. So:
  //
  //     what ARE THE TOP categories?   -> "are the top" matches the shape
  //     what IS WRONG with this file?   -> "is wrong" matches the shape
  //     what is the customer's LIFETIME VALUE in dollars?  -> "value" is a role
  //
  // All three were answered with a refusal to map a column. A user asking an
  // ordinary question got a correction error, and the reasonable conclusion was
  // that the agent was not working.
  //
  // The rule that fixes it is not more pattern matching; it is that A
  // CORRECTION IS DECLARATIVE. It names a column and asserts something about
  // one. Every one of those sentences opens with an interrogative, and no amount
  // of shape-matching on the rest of the sentence can distinguish them -- the
  // word they share with a role is an accident of English.
  for (const question of [
    "what are the top categories?",
    "what is wrong with this file?",
    "what is the customer's lifetime value in dollars?",
    "how many rows are there?",
    "show me the count of errors",
    "why is this hour slow?",
  ]) {
    const reply = replyTo(DB_LOG, question);
    assert.equal(reply.kind, "answer",
      `"${question}" is a question and must not be answered as a correction attempt`);
  }
});

test("and a DECLARATIVE correction attempt still gets the correction answer", () => {
  // The other half of the rule above, so the fix cannot be "stop treating
  // copulas as corrections" -- that would break the refusal this product needs.
  for (const attempt of [
    "col_15 is actually the amount",
    "alert_code is the sparklines",
    "total is the duration",
  ]) {
    const reply = replyTo(DB_LOG, attempt);
    assert.equal(reply.kind, "correction",
      `"${attempt}" names a column and a role; it must not be answered as a question`);
  }
});

// === THE RESOLVER RUNS FIRST ==============================================

test("a DATA question is answered with a CALCULATION, not a schema refusal", () => {
  // THE CASE THE DIRECTIVE NAMED, and the one the router could not serve before.
  //
  // "How many rows took longer than 5000ms" contains no category word, no hour
  // word and no copula-shaped correction, so it fell through every branch to the
  // DECLINE -- which meant the agent could find a chart but not count anything.
  // For somebody with a slow database that is the question they opened the file
  // to ask.
  //
  // It is asserted here at the ROUTER rather than only in query.test.ts, because
  // the resolver being correct is not the same claim as the router calling it.
  const withHistogram = {
    ...DB_LOG,
    columns: DB_LOG.columns.map((c) => ({
      ...c,
      histogram: [
        { lo: 0, hi: 100, count: 40 }, { lo: 100, hi: 200, count: 60 },
        { lo: 200, hi: 300, count: 50 }, { lo: 300, hi: 400, count: 30 },
        { lo: 400, hi: 500, count: 20 },
      ],
    })),
  };

  const reply = replyTo(withHistogram, "how many rows have total_elapsed_time_ms over 200");
  assert.equal(reply.kind, "answer", "and it must be an ANSWER, not a correction attempt");
  // Buckets [200,300) + [300,400) + [400,500) = 50 + 30 + 20 = 100. The
  // boundary convention is stated on countOnSide: "over 200" counts buckets
  // whose lower bound is >= 200, so a value exactly 200 counts in.
  assert.match(reply.text, /\b100\b/,
    `the whole buckets at or above 200 hold 50 + 30 + 20 = 100 rows: ${reply.text}`);
  assert.ok(!/not a role|is the category|correction/i.test(reply.text),
    "and specifically NOT a schema refusal");
  assert.ok(reply.widgets.some((w) => w.kind === "histogram"),
    "with the distribution attached, because a bare count has no context");
});

test("a data question does NOT reach the coarse routes", () => {
  // "categories" is a category-route keyword, and the hour route has "worst".
  // The resolver has to sit above both or a question that happens to contain a
  // keyword will be routed to a chart instead of computed.
  const reply = replyTo(DB_LOG, "how many rows are over 40");
  assert.equal(reply.kind, "answer");
  assert.ok(reply.widgets.every((w) => w.kind !== "chart-bar"),
    "a question with no category named must not return the category chart");
});

test("a question the resolver DECLINES still falls through to the old routes", () => {
  // The resolver is additive. It must not have swallowed the router's existing
  // vocabulary, or the previous release's twenty tests would have caught it --
  // which is exactly what happened when the correction heuristic was tightened.
  const reply = replyTo(DB_LOG, "show me the worst hour");
  assert.ok(reply.widgets.some((w) => w.kind === "chart-line"), "the hour route still works");
  const categories = replyTo(DB_LOG, "what are the top categories?");
  assert.ok(categories.widgets.some((w) => w.kind === "chart-bar"), "and so does the category route");
});

test("a WIDGET is never offered where the answer is a bound, not a number", () => {
  // If the threshold falls inside a bucket the honest answer is a range. A
  // histogram is still right -- it SHOWS why the answer is a range -- but the
  // prose must not imply precision it does not have.
  const partial = {
    ...DB_LOG,
    columns: DB_LOG.columns.map((c) => ({
      ...c,
      histogram: [{ lo: 0, hi: 100, count: 10 }, { lo: 100, hi: 200, count: 20 }],
    })),
  };
  const reply = replyTo(partial, "how many rows have total_elapsed_time_ms over 150");
  assert.match(reply.text, /at least|at most|between/i,
    `a straddling threshold must not produce a bare count: ${reply.text}`);
});

test("routing is PURE: the same question twice gives the same answer", () => {
  const a = replyTo(DB_LOG, "show me the worst hour");
  const b = replyTo(DB_LOG, "show me the worst hour");
  assert.deepEqual(a, b, "and it must not mutate the data it was handed");
  // The input is untouched -- a router that sorted D.ranking in place would be a
  // difference between the first answer and the second.
  assert.equal(DB_LOG.ranking[0]?.key, "SELECT * FROM orders");
});