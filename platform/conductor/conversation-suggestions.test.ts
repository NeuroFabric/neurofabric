import test from "node:test";
import assert from "node:assert/strict";

import { replyTo } from "./conversation.ts";

/**
 * SUGGESTIONS THAT KNOW WHAT IS IN THE FILE.
 *
 * Five fixed chips sat under every answer, including the ones that could not
 * possibly apply: "show me the worst hour" on a file with no readable
 * timestamps, "what are the top categories" on a file with no categorical
 * column. A suggestion is an invitation, and an invitation to ask a question
 * that is guaranteed to be refused teaches the user that the agent's suggestions
 * are noise -- which is the fastest way to make nobody click anything again.
 *
 * So the chips are derived from the same facts the answer was built from. Each
 * is offered only when the data can answer it, and the question just answered
 * is never offered back, because re-suggesting what the user just clicked is
 * the clearest possible sign nobody is paying attention.
 *
 * These are still SUGGESTIONS. The agent never refuses to answer a question
 * because no chip proposed it; the chips are an invitation, not a gate, and
 * that distinction is pinned below.
 */

const BASE = {
  source: "sales.csv",
  totalRows: 500,
  purpose: {
    kind: "transaction", statement: "This appears to be a sales record.",
    confidence: "high", evidence: ["order_value (order_value)"], columns: ["order_value"],
  },
  columns: [
    { name: "order_value", mean: 100, min: 1, max: 9000, measured: 500, dirty: 0, empty: 0 },
    { name: "status_code", mean: 200, min: 200, max: 500, measured: 500, dirty: 0, empty: 0 },
  ],
  ranking: [{ key: "web", count: 300 }],
  timeline: [{ hour: "2026-09-01T09", count: 40, share: 0.08, multiple: 2, spike: true, rule: "2x the mean" }],
  anomalies: [{ column: "order_value", severity: "critical", kind: "extreme", detail: "past the fence", factor: 9 }],
  learned: {},
  greeting: { text: "hello", widgets: [], suggestions: [] },
} as never;

const asks = (data: unknown, question: string): string[] => replyTo(data as never, question).suggestions;

test("a chip is offered only when the data can answer it", () => {
  const chips = asks(BASE, "what is wrong with this file?");
  assert.ok(chips.some((c) => /worst hour/.test(c)), `a file with a timeline can show one: ${chips}`);
  assert.ok(chips.some((c) => /top categories/.test(c)), `and it has categories: ${chips}`);
  assert.ok(chips.length >= 2 && chips.length <= 5, `a short list, not a menu: ${chips}`);
});

test("no timeline means NO worst-hour chip", () => {
  const chips = asks({ ...(BASE as object), timeline: [] }, "what is wrong with this file?");
  assert.ok(!chips.some((c) => /worst hour/.test(c)),
    `offering it on a file with no hours is an invitation to be refused: ${chips}`);
  assert.ok(chips.some((c) => /top categories/.test(c)),
    "but the questions that CAN be answered are still offered");
});

test("no categories means NO categories chip", () => {
  const chips = asks({ ...(BASE as object), ranking: [] }, "what is wrong with this file?");
  assert.ok(!chips.some((c) => /top categories/.test(c)),
    `a file with no categorical column cannot rank one: ${chips}`);
});

test("a CLEAN file is not offered 'what is wrong with this file?'", () => {
  const chips = asks({ ...(BASE as object), anomalies: [] }, "tell me more about this file");
  assert.ok(!chips.some((c) => /what is wrong/.test(c)),
    `there is nothing wrong to report, so do not invite the question: ${chips}`);
});

test("a file with SEVERE findings IS offered the findings question", () => {
  const chips = asks(BASE, "tell me more about this file");
  assert.ok(chips.some((c) => /what is wrong/.test(c)),
    `a severe finding is worth surfacing: ${chips}`);
});

test("an unidentified file is offered the chance to identify it", () => {
  const chips = asks({
    ...(BASE as object),
    purpose: { kind: "unknown", statement: "unknown", confidence: "none", evidence: [], columns: [] },
  }, "tell me more about this file");
  assert.ok(chips.some((c) => /what (this file )?is for|tell me what/i.test(c)),
    `the one thing that would help most: ${chips}`);
});

test("the question just answered is never suggested back", () => {
  // The clearest possible evidence that nothing is looking at the data.
  const chips = asks(BASE, "show me the busiest hour");
  assert.ok(!chips.some((c) => /busiest hour|worst hour/.test(c)),
    `they just asked for the hour; do not ask again: ${chips}`);
});

test("two numeric columns is enough to offer the cross-column check", () => {
  const chips = asks(BASE, "tell me more about this file");
  assert.ok(chips.some((c) => /complex anomal|discord/i.test(c)),
    `two numeric columns can contradict each other: ${chips}`);
});

test("one numeric column cannot, so it is not offered", () => {
  const chips = asks({ ...(BASE as object), columns: [BASE.columns[0]!] }, "tell me more about this file");
  assert.ok(!chips.some((c) => /complex anomal|discord/i.test(c)),
    `there is nothing to pair a single column with: ${chips}`);
});

test("chips are an invitation, never a gate", () => {
  // The agent must still answer a question that no chip proposed. Otherwise
  // "only answer what you suggested" becomes true by accident, and the refusal
  // this phase is removing comes straight back through the suggestions.
  const reply = replyTo(BASE, "show me the busiest hour");
  assert.equal(reply.kind, "answer");
  assert.doesNotMatch(reply.text, /I cannot answer that from what I have measured/);
});