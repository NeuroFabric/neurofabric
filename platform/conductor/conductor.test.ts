import test from "node:test";
import assert from "node:assert/strict";

import { Conductor } from "./agent-router.ts";
import { AGENTS } from "./agent-router.ts";

/**
 * ONE ROUTER, MANY SPECIALISTS.
 *
 * `replyTo` grew into a long chain of `if (regex) return ...`, each branch owning
 * both the DECISION (is this my question?) and the ANSWER (what do I say?). The
 * two concerns had fused, which is why adding a capability meant finding the
 * right branch number and why the ordering was load-bearing but undocumented.
 *
 * The Conductor owns the decision and nothing else. Each subagent owns one
 * question and the answer to it. Nothing an agent needs in order to answer lives
 * in the router, and nothing in the router knows how to answer anything.
 *
 * === WHAT "ROUTING" HAS TO MEAN HERE, PRECISELY ===
 *
 * A router that returns the winning agent's NAME is decoration. The value is
 * that the branch ORDER is now data rather than control flow: adding an agent
 * means adding an entry, not inserting a conditional above five others and
 * hoping the new one is not shadowed by an existing regex. So `route` returns
 * the ANSWER, and the agent that produced it, and the test asserts which agent
 * ran -- otherwise a monolith wearing a class would pass every one of these.
 *
 * FIRST MATCH WINS, and that is a real property with a real cost: "what will
 * happen tomorrow" and "what is wrong with this file" are unambiguous, but a
 * prompt could in principle match two agents. The order in AGENTS is therefore
 * the specification, and it is asserted here so that reordering it is a
 * deliberate act rather than a diff that happens to compile.
 */

const base = {
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
  rows: Array.from({ length: 200 }, (_, i) => {
    const x = 100 + ((i * 37) % 90);
    return { order_value: x, status_code: 5000 + x * 10 };
  }),
} as never;

const GOOD_FORECAST = {
  ok: true,
  method: "damped exponential smoothing with a local linear trend",
  points: Array.from({ length: 12 }, (_, i) => ({ hour: `2026-09-02T${String(i).padStart(2, "0")}`, value: 100 + i * 4, lower: 90 + i * 3, upper: 110 + i * 5 })),
  explanation: "12 hours projected from 500 observed hours.",
  reason: null,
  lastObservedHour: "2026-09-01T23",
} as never;

const ctx = { ...(base as object), forecast: GOOD_FORECAST } as never;

// --- routing to the right specialist ----------------------------------------

test("a data-quality question goes to the AnomalyAgent", () => {
  const r = Conductor.route("what is wrong with this file?", ctx);
  assert.equal(r.agent, "anomaly", "and the test says WHICH agent, or a monolith would pass");
  assert.ok(r.reply !== undefined);
  assert.match(r.reply!.text, /order_value/, "and the agent actually answered");
});

test("a contradiction question goes to the AnomalyAgent", () => {
  const r = Conductor.route("are there any complex anomalies?", ctx);
  assert.equal(r.agent, "anomaly");
});

test("a purpose or overview question goes to the ProfilerAgent", () => {
  const r = Conductor.route("tell me more about this file", ctx);
  assert.equal(r.agent, "profiler");
  assert.match(r.reply!.text, /500/, "the profiler answers with facts about the file");
});

test("a categories question goes to the ProfilerAgent", () => {
  assert.equal(Conductor.route("what are the top categories", ctx).agent, "profiler");
});

test("a FORWARD-LOOKING question goes to the ForecastingAgent", () => {
  // This capability had no intent at all before Phase 8: the forecast existed
  // on the dashboard and nothing in the chat could ask about it.
  const r = Conductor.route("what happens over the next 12 hours?", ctx);
  assert.equal(r.agent, "forecasting");
  assert.match(r.reply!.text, /12 hours|projected|forecast/i, "and it actually projects");
});

test("an unmatched question returns NO agent rather than a wrong one", () => {
  const r = Conductor.route("what is the meaning of life?", ctx);
  assert.equal(r.agent, null, "and nothing is invented to fill the slot");
  assert.equal(r.reply, undefined, "with no reply, so the caller can decline honestly");
});

// --- the routing itself, not just the answers --------------------------------

test("every agent is registered and reachable", () => {
  assert.deepEqual(AGENTS.map((a) => a.name), ["anomaly", "forecasting", "profiler"]);
});

test("an agent that does not handle a prompt declines to answer", () => {
  const anomaly = AGENTS.find((a) => a.name === "anomaly")!;
  assert.equal(anomaly.handles("what happens next?"), false);
  assert.equal(anomaly.handles("what is wrong with this file?"), true);
});

test("routing is deterministic and does not depend on object identity", () => {
  const a = Conductor.route("what is wrong with this file?", ctx);
  const b = Conductor.route("what is wrong with this file?", { ...(ctx as object) });
  assert.equal(a.agent, b.agent);
  assert.equal(a.reply!.text, b.reply!.text);
});

test("the FORECASTING agent declines when there is no forecast to report", () => {
  // The refusal must come from the agent, not from the router, and it must be
  // the CONTINUITY reason -- a user asking about a projection deserves to know
  // why there is not one.
  const noForecast = { ...(ctx as object), forecast: { ok: false, reason: "The hours in this file are not continuous.", points: [], method: "damped exponential smoothing", explanation: "" } } as never;
  const r = Conductor.route("what happens over the next 12 hours?", noForecast);
  assert.equal(r.agent, "forecasting");
  assert.doesNotMatch(r.reply!.text, /I cannot answer that from what I have measured/,
    "a known, explained absence is not the generic punt");
  assert.match(r.reply!.text, /not continuous/i, "it gives the actual reason");
});

test("routing never throws on a malformed context", () => {
  // It runs before the analysis has necessarily happened, so a missing field
  // must degrade to 'no agent' rather than take the process down.
  const r = Conductor.route("what is wrong with this file?", { source: null } as never);
  assert.ok(r.agent === null || r.reply !== undefined);
});