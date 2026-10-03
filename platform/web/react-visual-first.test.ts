import test from "node:test";
import assert from "node:assert/strict";

import { toReactDashboard, DASHBOARD_DATA_ID } from "./react-report.ts";
import { parseCsv } from "../conductor/capabilities.ts";
import { analyseBottlenecks, type BottleneckAnalysis } from "../conductor/bottlenecks.ts";
import { replyTo } from "../conductor/conversation.ts";

/**
 * VISUAL-FIRST, AFTER THE CHAT-FIRST PIVOT.
 *
 * This file used to assert a page ORDER: header, stat cards, charts, findings,
 * disclosures. That order is gone, on purpose -- the Owner judged the last
 * release's chat to be "shoved into a sidebar" and the dashboard it was beside
 * to be a wall. Replacing a chat-first surface with a sidebar chat would be
 * replacing the complaint with its mirror image.
 *
 * So this is no longer a test about where things sit. It is a test about the
 * three claims that survived the pivot and still decide whether the product
 * shows data or performs it:
 *
 *   1. THE DATA IS SHOWN AS PICTURES. The charts are Chart.js configurations,
 *      not bars made of divs, and the numbers under them are the engine's.
 *   2. THE NUMBERS ARE ALSO TEXT. Every charted series is reachable as a table.
 *      A chart nobody can check is a claim, not a finding, and that was true
 *      before the pivot and is more true now that the charts arrive as answers
 *      to questions rather than as a page somebody has to trust.
 *   3. THE LIBRARY IS PINNED AND ITS FAILURE IS SURVIVABLE.
 *
 * The layout questions that used to live here now live in
 * `react-chat-first.test.ts`, which asserts that the conversation is the primary
 * surface and that the charts are inside it.
 */

const DB_LOG = `_time,query_snippet,total_elapsed_time_ms,execution_plan_id,logical_reads
2026-09-30 09:00:00.000,SELECT * FROM orders,1200,plan-9f2,8801
2026-09-30 09:01:00.000,UPDATE users SET last_seen,430,plan-1a4,120
2026-09-30 10:00:00.000,SELECT COUNT(*) FROM audit,9800,plan-3c7,91000
2026-09-30 11:00:00.000,SELECT * FROM orders,2400,plan-9f2,8800`;

const analysis = await (async () => {
  const parsed = parseCsv(DB_LOG);
  const rows = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return await analyseBottlenecks({
    path: "query_perf.csv",
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    columns: [], sample: [], rows, problems: parsed.problems,
  });
})();

function appSourceOf(html: string): string {
  const open = '<script type="text/babel"';
  const start = html.indexOf(open);
  assert.ok(start > 0);
  const from = html.indexOf(">", start) + 1;
  return html.slice(from, html.indexOf("</script>", from));
}

function payloadOf(html: string): Record<string, unknown> {
  const open = `id="${DASHBOARD_DATA_ID}"`;
  const start = html.indexOf(open);
  assert.ok(start > 0);
  const from = html.indexOf(">", start) + 1;
  return JSON.parse(html.slice(from, html.indexOf("</script>", from))) as Record<string, unknown>;
}

const LIVE = { live: { path: "query_perf.csv" } };

test("the charts are REAL CHART CONFIGURATIONS, not bars made of divs", async () => {
  const src = appSourceOf(toReactDashboard(analysis, LIVE));
  assert.match(src, /type:\s*"bar"/, "a bar chart for the categorical ranking");
  assert.match(src, /type:\s*"line"/, "a line chart for the shape of the day");
  // Chart.js writes into a canvas. If this ever becomes a DOM bar chart the
  // pinning and the CDN stop mattering, and that is a change worth noticing.
  assert.match(src, /["(]canvas["),]/, "drawn into a canvas by the pinned library");
});

test("the charts are INSIDE ANSWERS, not on the page", async () => {
  // This is the load-bearing change. `renderWidget` is reached from the message
  // renderer, so a chart appears because somebody asked a question.
  const src = appSourceOf(toReactDashboard(analysis, LIVE));
  assert.match(src, /function renderWidget/, "widgets are rendered by a widget renderer");
  assert.match(src, /renderWidget\(w, props\.version\)/, "and the renderer is called per widget");
  assert.match(src, /role === "agent"/, "inside an agent message, which is where widgets live");
});

test("the numbers are ALSO TEXT, because a chart nobody can check is a claim", async () => {
  // True before the pivot and MORE true now: the charts arrive as answers, so a
  // reader is being asked to believe them rather than to browse them.
  const src = appSourceOf(toReactDashboard(analysis, LIVE));
  assert.match(src, /"columns"/, "the full column statistics are renderable as a table");
  assert.match(src, /Data provenance/, "and the file's provenance is stated, not buried");
});

test("the library is pinned, and its absence costs two pictures", async () => {
  const html = toReactDashboard(analysis, LIVE);
  const script = /<script[^>]+src="([^"]*chart\.js[^"]*)"/.exec(html);
  assert.ok(script !== null, "the charting library must be referenced");
  assert.match(script[1]!, /chart\.js@[\d.]+\/dist\/chart\.umd\.js$/,
    `pinned, and to the v4 bundle name that resolves: ${script[1]}`);

  const src = appSourceOf(html);
  assert.match(src, /typeof Chart/, "feature-detected before every use");
  assert.match(src, /Charts unavailable/, "and its absence is reported rather than silent");
});

test("the page carries the styling it needs, and only that", async () => {
  const html = toReactDashboard(analysis, LIVE);
  const src = appSourceOf(html);

  assert.match(src, /max-w-3xl/, "a centred reading column");
  assert.match(html, /cdn\.tailwindcss\.com/, "Tailwind, pinned, from the CDN");
  // Two sources of truth for one property is how a design system rots, so the
  // bespoke stylesheet is cut back to what utilities cannot express.
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
  for (const forbidden of ["h1 {", "table {", "body {"]) {
    assert.ok(!style.includes(forbidden), `${forbidden} is a global restyle Tailwind already owns`);
  }
});

test("the TOP-N rule survived the move into the conversation", async () => {
  // It used to be a slice in the page. It is now in the router, which is where
  // it belongs -- and the assertion follows it, because a ranking nobody can
  // scroll to is still a data dump, only now it is 400 pixels tall instead of
  // 4000.
  const reply = replyTo({
    source: "query_perf.csv",
    totalRows: analysis.totalRows,
    purpose: analysis.purpose,
    columns: analysis.numerical.columns.map((c) => ({
      name: c.column, mean: c.mean, min: c.min, max: c.max,
      measured: c.measured, dirty: c.dirty, empty: c.empty,
    })),
    anomalies: [],
    ranking: Array.from({ length: 20 }, (_, i) => ({ key: `q${i}`, count: 100 - i })),
    timeline: [],
    learned: {},
  }, "what are the top categories");
  const bar = reply.widgets.find((w) => w.kind === "chart-bar");
  assert.ok(bar !== undefined, "expected the category chart");
  const points = (bar!.payload as { points: unknown[] }).points;
  assert.ok(points.length > 0 && points.length <= 10,
    `a chart of ${points.length} bars is a data dump; the depth cap must apply`);
});

test("the engine's own spike verdict reaches the chart, unre-derived", async () => {
  // The page must not decide what a spike is. If it did, the chart and the
  // report could disagree, and a reader comparing them would be right to wonder
  // which one the tool believes.
  const data = payloadOf(toReactDashboard(analysis, LIVE));
  const timeline = data.timeline as { hour: string; spike: boolean }[];
  const engine = analysis.hourly.hours;
  if (engine.length === 0) {
    assert.equal(timeline.length, 0, "no readable hours means no invented timeline");
    return;
  }
  assert.equal(timeline.length, engine.length, "every hour the engine measured is plotted");
  assert.equal(timeline[0]?.spike, engine[0]?.isSpike, "flagged exactly where the engine flagged it");
});

test("the CSP still permits the CDN, names it explicitly, and grants no eval", async () => {
  // The chart dependency is third. The rule that bounds all three is in D-035
  // and D-036, and this is the test that keeps it from being widened.
  const html = toReactDashboard(analysis, LIVE);
  const policy = /content="([^"]*default-src[^"]*)"/.exec(html)?.[1] ?? "";
  assert.ok(policy.length > 0);
  assert.match(policy, /script-src[^;]*https:\/\/unpkg\.com/, "React, Chart.js and Babel");
  assert.match(policy, /script-src[^;]*https:\/\/cdn\.tailwindcss\.com/, "and Tailwind");
  assert.ok(!/script-src[^;]*\*/.test(policy), "no wildcard script source");
  assert.ok(!/unsafe-eval/.test(policy), "and no eval, which none of the three need");
});