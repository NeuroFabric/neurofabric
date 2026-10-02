import test from "node:test";
import assert from "node:assert/strict";

import { Conductor } from "./agent-router.ts";
import { evaluate } from "./subagents/forecasting-agent.ts";

/**
 * THE ANOMALY AGENT TALKS TO THE FORECASTING AGENT.
 *
 * A critical finding is a statement about a moment. "latency_ms hit 1,200ms"
 * tells a user what happened and leaves the only question they actually have
 * unanswered: is this getting worse? The data to answer that is already
 * computed -- the forecasting agent has the method, the continuity rules and the
 * band -- and it is sitting in a different module from the one holding the
 * finding.
 *
 * So the anomaly agent asks. Not the router: the ROUTER decides who answers a
 * user's question, and a subagent asking a colleague something is a different
 * relationship entirely. Mixing them would mean the router orchestrating its own
 * specialists, which is how a router stops being a router.
 *
 * === WHAT THE HANDOFF MUST NOT DO ===
 *
 * It must not escalate the TONE. A projection attached to a finding makes both
 * halves more confident-sounding, and the projection is the soft part: it is a
 * model, not a measurement, and the user has already been told that elsewhere.
 * So the sentence says what the model did and stops there.
 *
 * And it must not fire on anything but a CRITICAL finding. An agent that
 * consults a colleague on every small finding is an agent that produces two
 * paragraphs about a rounding error, and a user who learns to skim will skim
 * the real one too.
 */

/**
 * Rows whose `latency_ms` climbs steadily over 40 CONTINUOUS hours, plus one
 * critical spike inside the range.
 *
 * The first draft walked hour 0..39 of a single day, which produces "T39" -- not
 * an hour -- and appended the spike on the following day, leaving a 24-hour gap.
 * Both are exactly what the forecaster refuses to cross, so the fixture was
 * testing its own bug rather than the handoff. Hours are counted from a real
 * instant so the range is genuinely unbroken.
 */
function rowsWithClimb(): Record<string, number | string>[] {
  const start = Date.UTC(2026, 8, 1, 0, 0, 0);
  const rows: Record<string, number | string>[] = [];
  for (let n = 0; n < 40; n++) {
    const iso = new Date(start + n * 3_600_000).toISOString();
    for (let i = 0; i < 2; i++) {
      rows.push({ _time: iso, latency_ms: 200 + n * 4 + i });
    }
  }
  // The spike sits INSIDE the continuous range, in the hour before the end, so
  // the series stays unbroken and the finding is a point rather than a cliff.
  rows.push({ _time: new Date(start + 38 * 3_600_000).toISOString(), latency_ms: 1200 });
  return rows;
}

const CRITICAL = {
  source: "mesh.csv",
  totalRows: 81,
  purpose: {
    kind: "web-access", statement: "This appears to be a web access log.",
    confidence: "high", evidence: ["latency_ms (latency_ms)"], columns: ["latency_ms"],
  },
  columns: [
    { name: "latency_ms", mean: 300, min: 200, max: 1200, measured: 81, dirty: 0, empty: 0 },
    { name: "bytes", mean: 900, min: 10, max: 2000, measured: 81, dirty: 0, empty: 0 },
  ],
  ranking: [],
  timeline: Array.from({ length: 40 }, (_, h) => ({
    hour: new Date(Date.UTC(2026, 8, 1) + h * 3_600_000).toISOString().slice(0, 13),
    count: 2, share: 0.025, multiple: 1, spike: false, rule: null,
  })),
  anomalies: [{
    column: "latency_ms", severity: "critical", kind: "extreme",
    detail: "1,200 against a fence of 236", factor: 5,
  }],
  learned: {},
  greeting: { text: "hi", widgets: [], suggestions: [] },
  rows: rowsWithClimb(),
} as never;

const WARNING_ONLY = {
  ...(CRITICAL as object),
  anomalies: [{
    column: "latency_ms", severity: "warning", kind: "marginal",
    detail: "past the inner fence", factor: 2,
  }],
} as never;

test("a CRITICAL finding brings a projection with it", () => {
  const r = Conductor.route("what is wrong with this file?", CRITICAL);
  assert.equal(r.agent, "anomaly");
  const text = r.reply!.text;
  assert.match(text, /latency_ms/, "names the column");
  assert.match(text, /1,200|1200/, "and the value that made it critical");
  assert.match(text, /forecast|project/i, "and says a projection was consulted");
  assert.match(text, /12 hours|next 12/i, "with a horizon the user can reason about");
});

test("the projection is attributed to the AGENT that made it", () => {
  // The user needs to know which half is measured and which half is modelled.
  // A blended sentence with no attribution reads as one claim, and the modelled
  // half is the one that can be wrong.
  const text = Conductor.route("what is wrong with this file?", CRITICAL).reply!.text;
  assert.match(text, /forecast/i, "the projected half is named as a projection");
});

test("a WARNING does NOT trigger a handoff", () => {
  const text = Conductor.route("what is wrong with this file?", WARNING_ONLY).reply!.text;
  assert.doesNotMatch(text, /forecast|project/i,
    "consulting a colleague about a marginal finding produces two paragraphs about a rounding error");
});

test("without rows the handoff degrades to the plain finding", () => {
  // A missing input must not take the answer down with it. The finding is still
  // true without a projection attached.
  const noRows = { ...(CRITICAL as object), rows: undefined } as never;
  const text = Conductor.route("what is wrong with this file?", noRows).reply!.text;
  assert.match(text, /latency_ms/, "the finding survives");
  assert.doesNotMatch(text, /cannot read|undefined|NaN/, "and nothing leaks a missing value into the prose");
});

test("evaluate() projects a NAMED column, not the file", () => {
  // The whole point of the handoff: the projection is about the column that
  // went wrong, so a file-level projection of row counts would answer a
  // different question than the one the user asked.
  const out = evaluate(CRITICAL, "latency_ms");
  assert.equal(out.ok, true, `a climbing column should project: ${out.reason ?? ""}`);
  assert.ok(out.points.length > 0, "with real points");
  assert.ok(out.horizon === 12, "over the stated horizon");
});

test("evaluate() says why when it cannot project, rather than guessing", () => {
  const out = evaluate(CRITICAL, "no_such_column");
  assert.equal(out.ok, false);
  assert.ok((out.reason ?? "").length > 0, "with a reason a user could act on");
});

test("a column too short to project is refused, not extrapolated from noise", () => {
  const tiny = {
    ...(CRITICAL as object),
    rows: [
      { _time: "2026-09-01T00:00:00.000Z", latency_ms: 1 },
      { _time: "2026-09-01T01:00:00.000Z", latency_ms: 2 },
    ],
  } as never;
  const out = evaluate(tiny, "latency_ms");
  assert.equal(out.ok, false, "two points are arithmetic, not a trend");
});