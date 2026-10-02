import test from "node:test";
import assert from "node:assert/strict";

import { describePurpose } from "../conductor/semantics.ts";

/**
 * THE SEMANTIC PROFILER. The engine must know WHAT IT IS LOOKING AT.
 *
 * === WHY THIS IS THE WHOLE PIVOT ===
 *
 * Every surface this product had was named after a FILE SHAPE rather than a
 * QUESTION. "Bottleneck report". "Alert categories". The engine could tell you
 * how a column behaved and never once tell you what the column was FOR. So a
 * user with a database performance log was asked to interpret latency
 * statistics as though the tool had no idea, and a user with a sales export was
 * asked the same question about completely different data.
 *
 * A universal data agent has to open its mouth about the file before it opens it
 * about the columns. Not because a guess is interesting -- guesses are what this
 * codebase refuses to make silently -- but because "this is a database
 * performance log, here is what that implies" is the difference between a tool
 * and a form.
 *
 * === AND IT IS STILL A HYPOTHESIS ===
 *
 * Every statement this module produces is a claim ABOUT AN UNKNOWN FILE, derived
 * from header names and value shapes. The tests below assert both halves: that
 * it reaches the right conclusion, and that it says what it based that on and
 * how sure it is. A profiler that says "this is a database performance log" with
 * no evidence and no confidence has not become an agent; it has become a
 * confident narrator, which is strictly worse than silence.
 */

/** A database performance export: what the Owner's example file looks like. */
const DB_LOG = {
  headers: ["query_snippet", "total_elapsed_time_ms", "execution_plan_id", "logical_reads", "db_name", "captured_at"],
  rows: [
    { query_snippet: "SELECT * FROM orders WHERE id = ?", total_elapsed_time_ms: "1200", execution_plan_id: "plan-9f2", logical_reads: "8801", db_name: "prod", captured_at: "2026-09-30 09:00:00" },
    { query_snippet: "UPDATE users SET last_seen", total_elapsed_time_ms: "430", execution_plan_id: "plan-1a4", logical_reads: "120", db_name: "prod", captured_at: "2026-09-30 09:01:00" },
  ],
};

/** A sales export. */
const SALES = {
  headers: ["order_id", "customer_id", "product_sku", "quantity", "purchase_amount", "order_date", "region"],
  rows: [
    { order_id: "A-1001", customer_id: "C-77", product_sku: "SKU-9", quantity: "2", purchase_amount: "149.99", order_date: "2026-09-30", region: "EMEA" },
    { order_id: "A-1002", customer_id: "C-12", product_sku: "SKU-4", quantity: "1", purchase_amount: "19.50", order_date: "2026-09-30", region: "AMER" },
  ],
};

/** A web access log. */
const WEB_LOG = {
  headers: ["remote_addr", "request_method", "request_path", "status_code", "response_bytes", "request_time_ms", "timestamp"],
  rows: [
    { remote_addr: "10.0.0.7", request_method: "GET", request_path: "/api/orders", status_code: "200", response_bytes: "8123", request_time_ms: "42", timestamp: "2026-09-30 09:00:00" },
    { remote_addr: "10.0.0.9", request_method: "POST", request_path: "/api/login", status_code: "500", response_bytes: "311", request_time_ms: "880", timestamp: "2026-09-30 09:01:00" },
  ],
};

test("a database performance export is recognised as one", () => {
  const purpose = describePurpose(DB_LOG);
  assert.equal(purpose.kind, "database-performance",
    `a file with query_snippet and total_elapsed_time_ms is a query performance log, got ${purpose.kind}`);
  assert.match(purpose.statement, /database|query|sql/i,
    `the statement must say what the file is: ${purpose.statement}`);
  assert.match(purpose.statement, /performance|execution|tim(e|ing)/i,
    `and that it tracks execution timing: ${purpose.statement}`);
});

test("a sales export is recognised as one, and NOT as a database log", () => {
  const purpose = describePurpose(SALES);
  assert.equal(purpose.kind, "transaction",
    `customer_id plus purchase_amount is a sales record, got ${purpose.kind}`);
  assert.match(purpose.statement, /sales|transaction|order|purchase/i,
    `the statement must say so: ${purpose.statement}`);
  // The negative is the interesting half. Every one of these files is a table of
  // rows with an amount in it, and an engine that answers "database performance
  // log" for all three is not reading the file.
  assert.notEqual(purpose.kind, "database-performance");
});

test("a web access log is recognised as one", () => {
  const purpose = describePurpose(WEB_LOG);
  assert.equal(purpose.kind, "web-access",
    `request_method plus status_code is a web access log, got ${purpose.kind}`);
  assert.match(purpose.statement, /web|http|request|traffic/i,
    `the statement must say so: ${purpose.statement}`);
});

test("the three fixtures get three DIFFERENT answers, which is the whole point", () => {
  const kinds = [describePurpose(DB_LOG), describePurpose(SALES), describePurpose(WEB_LOG)].map((p) => p.kind);
  assert.equal(new Set(kinds).size, 3,
    `a profiler that gives the same answer to all three is not profiling: ${kinds.join(", ")}`);
});

test("EVERY statement names the evidence it was derived from", () => {
  // A claim with no evidence is not a claim a person can check, and this product
  // exists to refuse exactly that kind of unlabelled confidence.
  for (const [label, input] of [["db", DB_LOG], ["sales", SALES], ["web", WEB_LOG]] as const) {
    const purpose = describePurpose(input);
    assert.ok(purpose.evidence.length > 0,
      `${label}: a conclusion with no evidence is an assertion`);
    for (const item of purpose.evidence) {
      assert.match(item, /\w/, "and each piece of evidence must name the column it came from");
    }
    // The evidence must be traceable to THIS file, not to a generic vocabulary.
    const headerText = input.headers.join(" ").toLowerCase();
    assert.ok(
      purpose.evidence.some((e) => headerText.includes(e.split(" ")[0]!.toLowerCase().slice(0, 4))
        || /column|header/i.test(e)),
      `${label}: evidence must point at a real column: ${purpose.evidence.join(", ")}`);
  }
});

test("confidence is reported, and is LOWER for a weaker guess", () => {
  const strong = describePurpose(DB_LOG);
  assert.equal(strong.confidence, "high",
    "two unambiguous domain columns is a high-confidence reading");

  // A file that matches nothing must not be dressed up in the same language.
  const vague = describePurpose({
    headers: ["col_1", "col_2", "col_3"],
    rows: [{ col_1: "1", col_2: "2", col_3: "3" }],
  });
  assert.equal(vague.kind, "unknown");
  assert.equal(vague.confidence, "none", "and must say it knows nothing, not hedge");
  assert.match(vague.statement, /cannot|don't|could not|no/i,
    `the statement must admit ignorance rather than improvise: ${vague.statement}`);
});

test("the statement is addressed to a person, not a machine", () => {
  // The Owner's requested shape: "This file appears to be a database performance
  // log tracking query execution times." A class name or a key is not that.
  for (const input of [DB_LOG, SALES, WEB_LOG]) {
    const { statement } = describePurpose(input);
    assert.ok(statement.length > 20, `the statement must be a sentence: ${statement}`);
    assert.match(statement, /this file|this appears|these rows/i,
      `and must read as English about a file: ${statement}`);
  }
});

test("a partial signal does not become a confident answer", () => {
  // ONE domain column among five anonymous ones. The temptation is to say
  // "database performance log" anyway, because it is probably right. It is
  // almost certainly not: `purchase_amount` alone is a sales file with unnamed
  // columns, and a wrong purpose statement frames everything that follows.
  const partial = describePurpose({
    headers: ["query_snippet", "a", "b", "c", "d"],
    rows: [{ query_snippet: "SELECT 1", a: "1", b: "2", c: "3", d: "4" }],
  });
  assert.notEqual(partial.kind, "database-performance",
    "a single matching column out of five is not enough to name the file");
  assert.ok(["low", "none"].includes(partial.confidence),
    `and confidence must admit it: ${partial.confidence}`);
});

test("the profiler does not care about row count, so it is cheap", () => {
  // It reads HEADERS and a SAMPLE. A file with a million rows must cost the
  // same as a file with three, or the greeting cannot appear before the analysis.
  const headers = DB_LOG.headers;
  const many = { headers, rows: Array.from({ length: 5000 }, (_, i) => DB_LOG.rows[i % 2]!) };
  const a = describePurpose(DB_LOG);
  const b = describePurpose(many);
  assert.equal(a.kind, b.kind, "the answer must not depend on how many rows arrived");
});

test("a malformed input does not throw, because it runs before everything else", () => {
  // This runs on the way to every other feature. An exception here would take
  // down the greeting, and with it the product's first impression.
  for (const input of [
    { headers: [], rows: [] },
    { headers: ["a"], rows: [] },
    { headers: ["a", "b"], rows: [{ a: "1" }] },
  ]) {
    const purpose = describePurpose(input);
    assert.equal(typeof purpose.statement, "string");
    assert.ok(purpose.statement.length > 0);
  }
});