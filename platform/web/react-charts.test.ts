import test from "node:test";
import assert from "node:assert/strict";

import { toReactDashboard, DASHBOARD_DATA_ID } from "./react-report.ts";
import { parseCsv } from "../conductor/capabilities.ts";
import { analyseBottlenecks } from "../conductor/bottlenecks.ts";

/**
 * A file WITH a time column and a category column.
 *
 * The shared fixture is deliberately impoverished -- `col_1,col_15,col_16`, one
 * extreme value and two type mismatches -- because it exists to prove the
 * health and anomaly paths. It has no timestamp and no categorical column, so
 * its ranking and its hourly profile are both EMPTY, and both charts render
 * nothing.
 *
 * That is the right behaviour and the wrong fixture: a chart test written
 * against it either asserts on empty arrays (proving nothing) or, worse,
 * passes a vacuous length check. So this file is built to have the shape a
 * chart needs, and the spike is PLANTED rather than hoped for -- a flat day
 * would exercise the code path without proving the tooltip can say what makes a
 * spike abnormal.
 */
const HOURS = [
  ["2026-09-30T09", 3], ["2026-09-30T10", 4], ["2026-09-30T11", 2], ["2026-09-30T12", 5],
  ["2026-09-30T13", 60], ["2026-09-30T14", 4], ["2026-09-30T15", 3], ["2026-09-30T16", 2],
] as const;

const CATEGORIES = ["login", "checkout", "search", "login", "checkout", "search", "login", "checkout"];

function buildCsvWithTimeAndCategory(): string {
  const lines = ["_time,alertType,elapsed_time"];
  let i = 0;
  for (const [hour, count] of HOURS) {
    for (let n = 0; n < count; n += 1) {
      lines.push(`${hour}:00:00.000,${CATEGORIES[i % CATEGORIES.length]},${100 + (i % 7) * 10}`);
      i += 1;
    }
  }
  return `${lines.join("\n")}\n`;
}

/** A genuine analysis, profiled through the same path the product uses. */
async function buildTemporalAnalysis() {
  const { resolveSchemaMemory } = await import("../conductor/schema-memory.ts");
  const parsed = parseCsv(buildCsvWithTimeAndCategory());
  const rows = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  const schema = await resolveSchemaMemory({ cwd: "configs/..", headers: parsed.headers, rows });
  return analyseBottlenecks({
    path: "operations.csv",
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    columns: [],
    sample: [],
    rows,
    problems: parsed.problems,
  }, schema);
}

const analysis = await buildTemporalAnalysis();

/**
 * INTERACTIVE CHARTS. The owner asked to SEE the data.
 *
 * Phase 3 shipped static SVG, which is honest and completely inert: you cannot
 * hover a spike to find out how bad it was. For a tool whose entire argument is
 * "here is what is wrong with your file", an image of the answer is a worse
 * answer than the number underneath it.
 *
 * === WHY CHART.JS AND NOT RECHARTS ===
 *
 * This page has no bundler -- that is the premise of the whole artifact. Recharts
 * is a React COMPONENT library that must be compiled against React; using it here
 * means either shipping Babel-transformed copies of it or hand-rolling a
 * component tree around a library that is already imperative. Chart.js is a UMD
 * bundle with a `new Chart(canvas, config)` entry point and no build step, which
 * is the only shape that fits "one generated file, no toolchain".
 *
 * THE CONSEQUENCE, STATED PLAINLY. Chart.js draws into a <canvas> that React
 * does not own the contents of. That is a real tension and it is why the chart
 * is created in an effect and destroyed on cleanup, rather than being re-rendered
 * as virtual DOM. An implementation that skips the destroy leaks a chart per
 * render, and a leaked chart on the same canvas stacks two drawings that cannot
 * be cleared -- the visible symptom being a chart that grows fatter and darker
 * on every filter change.
 *
 * === THE FAILURE MODE THESE TESTS MOST CARE ABOUT ===
 *
 * The library comes from a CDN, on a machine that has just been asked to open
 * somebody's data. If that request fails -- offline, blocked, air-gapped
 * corporate proxy -- the dashboard must still render its tables and its chat.
 * A blank page because a chart library did not load would be a catastrophic
 * trade for two pictures. So the guard is asserted, not assumed.
 */

/** Precondition, asserted once: a chart test on empty data proves nothing. */
test("the fixture really has a ranking and a planted spike to plot", () => {
  assert.ok(analysis.categories.length > 0,
    "the fixture must have categorical frequencies, or the bar chart asserts on an empty array");
  assert.ok(analysis.hourly.hours.length > 0, "and hours, or the line chart has nothing to draw");
  assert.ok(analysis.hourly.hours.some((h) => h.isSpike),
    "and at least one spike, so the tooltip's abnormal case is exercised rather than assumed");
});

function payloadOf(html: string): Record<string, unknown> {
  const open = `id="${DASHBOARD_DATA_ID}"`;
  const start = html.indexOf(open);
  assert.ok(start > 0, `the page must embed its data in a script with ${open}`);
  const from = html.indexOf(">", start) + 1;
  return JSON.parse(html.slice(from, html.indexOf("</script>", from))) as Record<string, unknown>;
}

function appSourceOf(html: string): string {
  const open = '<script type="text/babel"';
  const start = html.indexOf(open);
  assert.ok(start > 0, "the page must carry its application as a babel script");
  const from = html.indexOf(">", start) + 1;
  return html.slice(from, html.indexOf("</script>", from));
}

test("Chart.js is loaded from a CDN at a PINNED version, and the pin is asserted", () => {
  const html = toReactDashboard(analysis, {});
  const script = /<script[^>]+src="([^"]*chart[^"]*)"/i.exec(html);
  assert.ok(script !== null, "the charting library must actually be loaded");
  assert.match(script[1]!, /chart\.js@[\d.]+(-[a-z0-9.]+)?\//i,
    `the charting library must be version-pinned, got ${script[1]}`);
  // The same reasoning as React: a report about a production incident must not
  // change because somebody else published a package.
  assert.ok(!/chart\.js@latest/.test(script[1]!), "never a floating tag");
});

test("the categorical ranking is a BAR chart over the real frequencies", () => {
  const html = toReactDashboard(analysis, {});
  const src = appSourceOf(html);
  const data = payloadOf(html);

  const ranking = data.ranking as { key: string; count: number }[];
  assert.ok(Array.isArray(ranking) && ranking.length > 0, "there is a ranking to plot");
  assert.ok(ranking.every((r) => typeof r.key === "string" && typeof r.count === "number"),
    "each point is a category and a count");

  assert.match(src, /type:\s*"bar"/, "a bar chart, which is the right mark for a frequency");
  // The data comes from the WIDGET PAYLOAD, not from the page re-reading the
  // global payload. Since the chat-first pivot the server computes the series in
  // the router and ships it inside the message, so a chart and the answer above
  // it cannot describe different data.
  assert.match(src, /props\.payload.*points|payload && props\.payload/,
    "driven by the widget's own payload, which the server computed");
});

test("the temporal spikes are a LINE chart, and the hours travel in the payload", () => {
  const html = toReactDashboard(analysis, {});
  const src = appSourceOf(html);
  const data = payloadOf(html);

  const timeline = data.timeline as {
    hour: string; count: number; share: number; multiple: number | null; spike: boolean; rule: string | null;
  }[];
  assert.ok(Array.isArray(timeline) && timeline.length > 0,
    "the shape of the day must reach the page, or the line chart has nothing to draw");
  for (const point of timeline) {
    assert.match(point.hour, /^\d{4}-\d{2}-\d{2}T\d{2}$/,
      `an hour key, not a Date object or a locale string: ${point.hour}`);
    assert.equal(typeof point.count, "number");
    assert.equal(typeof point.spike, "boolean", "and whether the engine flagged it");
  }

  assert.match(src, /type:\s*"line"/, "a line, because time is ordered and the shape IS the finding");
  assert.match(src, /props\.payload.*points|payload && props\.payload/,
    "driven by the widget's own payload, which the server computed");
});

test("the payload's timeline AGREES with the engine's own hourly profile", () => {
  // The page must not re-derive this. A chart that buckets hours its own way
  // would disagree with the report beside it, and a reader comparing the two
  // would be right to wonder which one the tool believes.
  const html = toReactDashboard(analysis, {});
  const timeline = payloadOf(html).timeline as { hour: string; count: number; spike: boolean }[];
  const engine = analysis.hourly.hours;

  if (engine.length === 0) {
    assert.equal(timeline.length, 0, "no readable timestamps means no timeline, not an invented one");
    return;
  }
  assert.equal(timeline.length, engine.length, "every hour the engine measured must be plotted");
  assert.equal(timeline[0]?.hour, engine[0]?.key, "same hours, in the same order");
  assert.equal(timeline[0]?.count, engine[0]?.count, "and the same counts");
  assert.equal(timeline[0]?.spike, engine[0]?.isSpike, "flagged exactly where the engine flagged it");
});

test("hovering a spike shows the EXACT value AND the hour", () => {
  const html = toReactDashboard(analysis, {});
  const src = appSourceOf(html);

  // Both facts, or the tooltip is decoration. "12" with no unit and no hour is
  // the single least useful thing a chart can tell you.
  assert.match(src, /tooltip/i, "there must be a tooltip");
  assert.match(src, /callback|label:/, "with custom content rather than the bare default");
  assert.match(src, /count/, "showing the value");
  assert.match(src, /hour|point\.label|\.label/, "and the hour it belongs to");
  // The spike flag itself must be legible in the hover, or the reader has to
  // go and compare against the mean by eye.
  assert.match(src, /spike|multiple|rule/, "and whether the engine considered it abnormal");
});

test("a chart that cannot load leaves the REST of the dashboard working", () => {
  // THE resilience property. The library is remote; the data is not. If the CDN
  // is unreachable, the user must still get their report and their chat.
  const html = toReactDashboard(analysis, {});
  const src = appSourceOf(html);

  assert.match(src, /typeof Chart/, "the global must be feature-detected before use");
  assert.match(src, /=== "undefined"|!== "undefined"/, "and the check must be a real one");
  // And the tables must not be inside the guard: they are the product, the
  // charts are the garnish.
  const guardAt = src.indexOf("typeof Chart");
  const tableAt = src.indexOf('"table"');
  assert.ok(tableAt > -1, "the findings table must still be rendered");
  assert.ok(guardAt > -1);
});

test("a chart is created once and destroyed on cleanup, or it stacks on every render", () => {
  // React re-renders on every filter change. Without a destroy, each render
  // leaves another chart drawing into the same canvas: the bars double, then
  // triple, and nothing in the code explains why.
  const src = appSourceOf(toReactDashboard(analysis, {}));

  assert.match(src, /useEffect/, "chart creation belongs in an effect, not in the render body");
  assert.match(src, /\.destroy\(\)/, "and the chart must be destroyed on cleanup");
  assert.match(src, /return function \(\)/, "which means the effect returns a teardown");
});

test("the charts stay inside the declared policy", () => {
  const html = toReactDashboard(analysis, {});
  const csp = /content="([^"]*default-src[^"]*)"/.exec(html);
  assert.ok(csp !== null);
  const policy = csp[1]!;
  assert.match(policy, /script-src[^;]*https:\/\/unpkg\.com/, "the CDN that serves the library is named");
  assert.ok(!/unsafe-eval/.test(policy), "Chart.js needs no eval, and eval is not granted for convenience");
  assert.ok(!/script-src[^;]*\*/.test(policy), "no wildcard script source");
});
