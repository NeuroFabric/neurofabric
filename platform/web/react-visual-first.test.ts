import test from "node:test";
import assert from "node:assert/strict";

import { toReactDashboard } from "./react-report.ts";
import { parseCsv } from "../conductor/capabilities.ts";
import { analyseBottlenecks } from "../conductor/bottlenecks.ts";

/**
 * TASK 1 -- VISUAL-FIRST. The Owner opened a database performance CSV and was
 * shown a hundred rows of table.
 *
 * === WHY THIS FILE IS ABOUT ORDER, NOT ABOUT COLOURS ===
 *
 * A dashboard whose charts sit below its tables is a data dump with decoration
 * on top, and no amount of restyling changes that. The Owner's complaint was
 * never "it is ugly" -- it was "there are no visual charts and I have to scroll
 * past 105 rows". Those are one defect, and it is measured by POSITION.
 *
 * So the assertions here are about the order things are emitted in, and they
 * are made against the generated source rather than a rendered page, because no
 * browser exists in this environment. That limitation is stated rather than
 * papered over: these tests prove the page is BUILT the right way. They do not
 * prove it looks right, and `deploy.test.ts` is the precedent for saying so
 * honestly instead of claiming otherwise.
 */

const CSV = `_time,source_host,alertType,alert_code,elapsed_time,threshold
2026-09-30 09:00:00.000,host-web,login,PEGA0001,1200,1000
2026-09-30 09:01:00.000,host-bg,checkout,PEGA0028,800,1000
2026-09-30 09:02:00.000,host-web,login,PEGA0001,2500,1000
2026-09-30 10:00:00.000,host-db,search,PEGA0004,430,1000
2026-09-30 10:01:00.000,host-db,login,PEGA0007,910,1000
2026-09-30 11:00:00.000,host-web,logout,PEGA0011,120,1000`;

/** A file with the columns a chart needs, profiled through the real path. */
async function buildAnalysis() {
  const { resolveSchemaMemory } = await import("../conductor/conductor.ts").then(async () => ({
    resolveSchemaMemory: (await import("../conductor/schema-memory.ts")).resolveSchemaMemory,
  }));
  const parsed = parseCsv(CSV);
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

const analysis = await buildAnalysis();

function appSourceOf(html: string): string {
  const open = '<script type="text/babel"';
  const start = html.indexOf(open);
  assert.ok(start > 0, "the page must carry its application as a babel script");
  const from = html.indexOf(">", start) + 1;
  return html.slice(from, html.indexOf("</script>", from));
}

test("precondition: the fixture has both a ranking and hours to plot", () => {
  assert.ok(analysis.categories.length > 0, "a bar chart needs categories");
  assert.ok(analysis.hourly.hours.length > 0, "a line chart needs hours");
});

test("Tailwind is loaded, and PINNED", () => {
  const html = toReactDashboard(analysis, {});
  const script = /<script[^>]+src="([^"]*tailwind[^"]*)"/i.exec(html);
  assert.ok(script !== null, "the styling layer must actually be loaded");
  assert.match(script[1]!, /tailwindcss\.com\/[\d.]+/,
    `pinned to a version, got ${script[1]}`);
  assert.ok(!/cdn\.tailwindcss\.com\/(latest|[^/\d]*)$/i.test(script[1]!), "never a floating tag");
});

test("CHARTS COME BEFORE TABLES, which is the entire task", () => {
  const src = appSourceOf(toReactDashboard(analysis, {}));

  const bar = src.indexOf("BarChart");
  const line = src.indexOf("LineChart");
  const rawTable = src.indexOf("View raw data");

  assert.ok(bar > 0 && line > 0, "both charts must be rendered");
  assert.ok(rawTable > 0, "and the raw data must still exist somewhere");
  assert.ok(bar < rawTable,
    "the bar chart must be emitted BEFORE the raw data, or the user scrolls past it first");
  assert.ok(line < rawTable, "and so must the line chart");
});

test("the two charts are labelled the way the Owner asked for", () => {
  // The Owner's words were "Record categories" and "Rows by hour". A chart
  // called "Category frequency distribution" is the same chart and is not what
  // was asked for; these are the strings a user looks for.
  const src = appSourceOf(toReactDashboard(analysis, {}));
  assert.match(src, /"Record categories"/);
  assert.match(src, /"Rows by hour"/);
});

test("the raw tables are behind a DISCLOSURE, not deleted", () => {
  // Deleted would be a loss: a chart nobody can check is a claim, not a
  // finding. Demoted is the requirement -- present, reachable, not in the way.
  const src = appSourceOf(toReactDashboard(analysis, {}));
  assert.match(src, /createElement\("details"|h\("details"/,
    "the raw data must live inside a <details> element");
  assert.match(src, /"summary"|View raw data/,
    "with a summary line a user can see and click");

  const detailsAt = src.indexOf('"details"');
  const columnsTableAt = src.indexOf("D.columns.map");
  assert.ok(detailsAt > 0 && columnsTableAt > 0);
  assert.ok(detailsAt < columnsTableAt, "the column table must be inside the disclosure");
});

test("the summary numbers lead, so the file is characterised in one glance", () => {
  const src = appSourceOf(toReactDashboard(analysis, {}));
  assert.match(src, /"Rows read"/, "row count");
  assert.match(src, /"Findings"/, "finding count");
  assert.match(src, /"Spike hours"/, "and the engine's own spike verdict");

  const statAt = src.indexOf("Rows read");
  const chartAt = src.indexOf("h(BarChart)");
  assert.ok(statAt > 0 && chartAt > 0, "both the stat row and the bar chart must exist");
  assert.ok(statAt < chartAt, "the headline numbers come before the charts");
});

test("findings are capped at 5 by default, and the rest are one click away", () => {
  const src = appSourceOf(toReactDashboard(analysis, {}));
  assert.match(src, /var TOP = 5;/,
    "five is the cap, as a named constant rather than a magic number in a slice");
  // Capped is not hidden: the escape hatch must exist and must be wired to state.
  assert.match(src, /setShowAll\(true\)/, "and there must be a way to see the rest");
  assert.match(src, /shown\.length > listed\.length/,
    "offered only when there IS more to show, so the button never lies");
});

test("the page survives Tailwind NOT loading", () => {
  // The Play CDN is remote, and a page whose class names silently stop
  // applying must still be readable. The document is ordered so that the
  // unstyled reading order is findings -> charts -> raw data, and the charts
  // themselves already fall back to tables via ChartNote.
  const src = appSourceOf(toReactDashboard(analysis, {}));
  assert.match(src, /typeof Chart/, "the chart library is feature-detected");
  // Structural ordering is what makes the unstyled page usable, so assert the
  // ordering rather than trusting it.
  const findings = src.indexOf('"Findings"');
  const raw = src.indexOf("View raw data");
  assert.ok(findings > 0 && raw > 0);
  assert.ok(findings < raw, "the answer precedes the arithmetic even when nothing is styled");
});

test("the chat is a persistent rail, not something at the bottom of the page", () => {
  const src = appSourceOf(toReactDashboard(analysis, { live: { path: "operations.csv" } }));
  assert.match(src, /w-80 shrink-0 sticky top-6/,
    "a fixed-width sticky rail beside the content");
  // It must be a SIBLING of the main column, inside the flex row -- not a
  // descendant, which would put it under a hundred rows of table again.
  const chatAside = src.indexOf("ChatPanel)");
  const mainAt = src.indexOf('"main"');
  assert.ok(mainAt > 0 && chatAside > 0);
  assert.ok(chatAside > mainAt, "the rail is emitted after main, side by side in the flex row");
});

test("the chat INVITES a correction and shows the roles it accepts", () => {
  const src = appSourceOf(toReactDashboard(analysis, { live: { path: "operations.csv" } }));
  assert.match(src, /Notice a wrong column\? Tell me:/,
    "the Owner's own phrasing -- an unprimed user must know what to type");
  assert.match(src, /col_1 is the duration/, "and at least one sentence that actually works");
  assert.match(src, /Roles: category, time, source, duration/,
    "because the parser REFUSES unknown words, and an unprimed user's reasonable guess is refused");
});

test("the stylesheet is only what utilities cannot express", () => {
  // A bespoke stylesheet alongside Tailwind is how a design system rots: two
  // sources of truth for the same property, and the one nobody reads wins.
  const html = toReactDashboard(analysis, {});
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
  assert.ok(style.length > 0, "some CSS is still required");
  for (const forbidden of [".wrap {", "h1 {", "table {", "body {"]) {
    assert.ok(!style.includes(forbidden),
      `${forbidden} is a global restyle Tailwind already owns`);
  }
});

test("the CSP still permits the CDN and still grants no eval", () => {
  const html = toReactDashboard(analysis, {});
  const csp = /content="([^"]*default-src[^"]*)"/.exec(html);
  assert.ok(csp !== null);
  const policy = csp[1]!;
  assert.match(policy, /script-src[^;]*https:\/\/unpkg\.com/, "React and Chart.js");
  assert.match(policy, /script-src[^;]*https:\/\/cdn\.tailwindcss\.com/, "and Tailwind, named explicitly");
  assert.ok(!/script-src[^;]*\*/.test(policy), "no wildcard script source");
  assert.ok(!/unsafe-eval/.test(policy), "and no eval, which none of the three need");
});
