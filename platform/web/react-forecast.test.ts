import test from "node:test";
import assert from "node:assert/strict";

import { toReactDashboard, DASHBOARD_DATA_ID } from "./react-report.ts";
import { parseCsv } from "../conductor/capabilities.ts";
import { analyseBottlenecks } from "../conductor/bottlenecks.ts";

/**
 * THE FORECAST, RENDERED.
 *
 * `forecasting.test.ts` covers the arithmetic. This covers the part that decides
 * whether a user can be MISLED by it, which is a rendering question and not a
 * modelling one.
 *
 * === THE THREE WAYS A FORECAST LIES ON A CHART ===
 *
 *   1. NO INTERVAL. A dashed line continuing past the last observation looks
 *      exactly like the solid line before it, at a glance and in a screenshot.
 *      The reader cannot tell measured from projected, and the whole chart
 *      becomes an assertion they have no way to check.
 *   2. NO BOUNDARY. If the divide between observed and projected is not drawn,
 *      nothing marks where the engine stopped knowing.
 *   3. NO WAY BACK. A forecast that cannot be turned off is a permanent claim
 *      about the future sitting above a description of the past.
 *
 * So all three are asserted, and the third is the one most likely to be dropped
 * in a later tidy-up, because a toggle is one more control and controls get
 * removed for being "redundant".
 */

const RISING = (() => {
  const lines = ["_time,query_snippet,total_elapsed_time_ms"];
  for (let i = 0; i < 20; i += 1) {
    lines.push(`2026-09-30T${String(i).padStart(2, "0")}:00:00.000,SELECT ${i},${100 + i * 10}`);
  }
  return `${lines.join("\n")}\n`;
})();

const SPARSE = `_time,query_snippet,total_elapsed_time_ms
2026-09-30T09:00:00.000,SELECT a,100
2026-09-30T10:00:00.000,SELECT b,110
2026-09-30T11:00:00.000,SELECT c,120`;

function analyseOf(csv: string) {
  const parsed = parseCsv(csv);
  const rows = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return analyseBottlenecks({
    path: "query_perf.csv",
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    columns: [], sample: [], rows, problems: parsed.problems,
  });
}

function payloadOf(html: string): Record<string, unknown> {
  const open = `id="${DASHBOARD_DATA_ID}"`;
  const start = html.indexOf(open);
  assert.ok(start > 0);
  const from = html.indexOf(">", start) + 1;
  return JSON.parse(html.slice(from, html.indexOf("</script>", from))) as Record<string, unknown>;
}

function appSourceOf(html: string): string {
  const open = '<script type="text/babel"';
  const start = html.indexOf(open);
  const from = html.indexOf(">", start) + 1;
  return html.slice(from, html.indexOf("</script>", from));
}

const LIVE = { live: { path: "query_perf.csv" } };

test("the payload carries a FORECAST for a file with enough history", () => {
  const data = payloadOf(toReactDashboard(analyseOf(RISING), LIVE));
  const fc = data.forecast as { ok?: boolean; points?: unknown[]; method?: string } | null;
  assert.ok(fc !== null, "twenty continuous hours must produce a forecast");
  assert.equal(fc!.ok, true);
  assert.equal(fc!.points?.length, 12, "twelve hours ahead");
  assert.match(String(fc!.method), /smoothing/i, "and it says what it did");
});

test("EVERY projected point carries its INTERVAL", () => {
  const fc = payloadOf(toReactDashboard(analyseOf(RISING), LIVE)).forecast as {
    points: { lower: number; upper: number; count: number }[];
  };
  assert.equal(fc.points.length, 12);
  for (const p of fc.points) {
    assert.ok(p.lower <= p.count && p.count <= p.upper,
      `an unbounded point is a guess in a number's clothes: ${JSON.stringify(p)}`);
  }
});

test("a file with too little history carries NO forecast, and says why", () => {
  const fc = payloadOf(toReactDashboard(analyseOf(SPARSE), LIVE)).forecast as
    { ok?: boolean; reason?: string } | null;
  assert.ok(fc !== null, "the payload must carry the REFUSAL, not omit the field");
  assert.equal(fc!.ok, false, "three hours cannot support a projection");
  assert.match(String(fc!.reason), /at least|need/i,
    `the reason must travel with the payload so the UI can say it: ${fc!.reason}`);
});

test("THE CHART CAN BE TOLD TO SHOW IT", () => {
  const src = appSourceOf(toReactDashboard(analyseOf(RISING), LIVE));
  assert.match(src, /Show [Ff]orecast|forecast-toggle/,
    "there must be a control -- a forecast nobody can summon is not a feature");
  assert.match(src, /D\.forecast/,
    "and it must be driven by the payload, not computed in the page");
});

test("PROJECTED POINTS ARE DISTINGUISHABLE FROM OBSERVED ONES", () => {
  // The lying-by-lookalike failure. Chart.js draws a dashed dataset and a solid
  // one differently; without that the projection is indistinguishable from data.
  const src = appSourceOf(toReactDashboard(analyseOf(RISING), LIVE));
  assert.match(src, /borderDash/,
    "the projected series must be DASHED, or it reads as measured");
  assert.match(src, /fill:\s*(true|"-1"|false)/,
    "and the band is drawn as a fill, which is what an interval looks like");
});

test("THE INTERVAL IS DRAWN, not just the line", () => {
  // A dashed line without a band is a point estimate that happens to be dashed.
  // The band is the entire honest part.
  const src = appSourceOf(toReactDashboard(analyseOf(RISING), LIVE));
  assert.match(src, /lower|upper/,
    "the chart config must reference the interval bounds");
  assert.match(src, /band|interval|range/i,
    "and name it, so a reader of the code knows what the fill means");
});

test("THE BOUNDARY between observed and projected is published", () => {
  const data = payloadOf(toReactDashboard(analyseOf(RISING), LIVE));
  const fc = data.forecast as { lastObservedHour?: string };
  assert.ok(fc.lastObservedHour !== undefined && fc.lastObservedHour !== null,
    "the chart needs to know where the engine stopped knowing");
  assert.match(String(fc.lastObservedHour), /^\d{4}-\d{2}-\d{2}T\d{2}$/,
    "as the hour key the timeline already uses");
});

test("IT CAN BE TURNED OFF", () => {
  // The control most likely to be removed in a tidy-up, because a toggle is one
  // more thing. A reader who wants the past must not be forced to look at a
  // claim about the future.
  const src = appSourceOf(toReactDashboard(analyseOf(RISING), LIVE));
  assert.match(src, /useState/, "the toggle holds state");
  assert.match(src, /checked:/, "and it is a real, driven control");
});

test("a page with no forecast still renders, and offers nothing", () => {
  // The refusal must not become a broken chart or a dead control.
  const src = appSourceOf(toReactDashboard(analyseOf(SPARSE), LIVE));
  assert.match(src, /D\.forecast/, "the toggle is gated on the payload, not assumed");
  assert.match(src, /reason/, "and the reason is rendered when there is no forecast");
});

test("the forecast does not invent hours the engine never observed", () => {
  const data = payloadOf(toReactDashboard(analyseOf(RISING), LIVE));
  const timeline = (data.timeline as { hour: string }[]).map((p) => p.hour);
  const fc = data.forecast as { points: { hour: string }[]; lastObservedHour: string };
  const overlap = fc.points.filter((p) => timeline.includes(p.hour));
  assert.equal(overlap.length, 0, "a projected hour must never coincide with an observed one");
  assert.ok(fc.points[0]!.hour > fc.lastObservedHour, "and every projection is after the last observation");
});