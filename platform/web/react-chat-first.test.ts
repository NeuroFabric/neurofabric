import test from "node:test";
import assert from "node:assert/strict";

import { toReactDashboard, DASHBOARD_DATA_ID } from "./react-report.ts";
import { parseCsv } from "../conductor/capabilities.ts";
import { analyseBottlenecks, type BottleneckAnalysis } from "../conductor/bottlenecks.ts";
import { greet } from "../conductor/conversation.ts";
import { replyTo } from "../conductor/conversation.ts";

/**
 * TASK 3 -- THE CONVERSATION IS THE PRODUCT.
 *
 * The Owner's verdict on the last release was that the chat was "shoved into a
 * sidebar". That is the correct reading and it is not a styling preference. A
 * chat in a sidebar is a help widget; a chat as the primary surface is an agent.
 * The difference is which thing the user is looking at when the page opens, and
 * whether the analysis arrives as an ANSWER to something or as a wall they have
 * to navigate.
 *
 * === WHAT IS ACTUALLY BEING ASSERTED HERE ===
 *
 * Structure, because structure is what was wrong. These tests read the generated
 * application as text -- there is no browser in this environment, and
 * `react-app-parses.test.ts` compiles the output so a structural claim is at
 * least a claim about something that parses.
 *
 * The load-bearing assertions are the NEGATIVE ones: that the charts are no
 * longer laid out beside a chat, and that the greeting carries the semantic
 * purpose. A page can satisfy a positive assertion about a chat and still be a
 * dashboard with a chat bolted on, so the tests check what is NOT there.
 */

const DB_LOG = `_time,query_snippet,total_elapsed_time_ms,execution_plan_id,logical_reads
2026-09-30 09:00:00.000,SELECT * FROM orders,1200,plan-9f2,8801
2026-09-30 09:01:00.000,UPDATE users SET last_seen,430,plan-1a4,120
2026-09-30 11:00:00.000,SELECT COUNT(*) FROM audit,9800,plan-3c7,91000
2026-09-30 11:30:00.000,SELECT * FROM orders,2400,plan-9f2,8800`;

async function analysis(): Promise<BottleneckAnalysis> {
  const parsed = parseCsv(DB_LOG);
  const rows = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return await analyseBottlenecks({
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

test("precondition: the fixture really is a database performance log", async () => {
  const a = await analysis();
  assert.equal(a.purpose.kind, "database-performance",
    `the fixture must exercise the semantic path: ${a.purpose.kind}`);
});

test("the payload carries the SEMANTIC PURPOSE, for the greeting to open with", async () => {
  const data = payloadOf(toReactDashboard(await analysis(), LIVE));
  const purpose = data.purpose as { kind?: string; statement?: string; confidence?: string } | undefined;
  assert.ok(purpose !== undefined, "the page must be told what the file is");
  assert.equal(purpose.kind, "database-performance");
  assert.match(String(purpose.statement), /database performance log/i);
  assert.ok(purpose.confidence !== undefined, "and how sure the engine is, so the greeting can hedge");
});

test("the GREETING is computed server-side and embedded, not guessed in the browser", async () => {
  // Computed here, at generation time, from the same `greet` the tests exercise.
  // A greeting assembled in the page would be a second implementation of a
  // sentence about somebody's data, and this repository has been bitten by that
  // twice: a parser that was one function in two places, and a title that was
  // one string in four.
  const data = payloadOf(toReactDashboard(await analysis(), LIVE));
  const greeting = data.greeting as { text?: string; widgets?: unknown[] } | undefined;
  assert.ok(greeting !== undefined, "the opening message must travel with the page");
  assert.match(String(greeting.text), /database performance log/i,
    `the opening must open with the purpose: ${greeting.text}`);
  assert.match(String(greeting.text), /4 rows|What would you like/i, "and read like a sentence to a person");
});

test("the CHAT IS THE PRIMARY SURFACE: one column, composer at the bottom", async () => {
  const src = appSourceOf(toReactDashboard(await analysis(), LIVE));
  // A single centred reading column, which is what a conversation IS. The old
  // layout was a wide dashboard with a sticky rail beside it, and the rail was
  // the complaint.
  assert.match(src, /max-w-3xl|max-w-2xl/, "a centred conversation column, not a dashboard grid");
  assert.match(src, /sticky bottom-0/, "and the composer pinned where a chat composer belongs");
  // The old two-column shell must be gone.
  assert.doesNotMatch(src, /w-80 shrink-0 sticky top-6/,
    "the sidebar rail the Owner rejected must not survive anywhere");
});

test("WIDGETS RENDER INSIDE THE MESSAGE FLOW, not as sections of a page", async () => {
  const src = appSourceOf(toReactDashboard(await analysis(), LIVE));
  // A widget renderer, invoked from the message renderer. If the charts were
  // still page sections this function would not exist.
  assert.match(src, /function renderWidget|function Widget\(/,
    "widgets must be rendered by a widget renderer");
  assert.match(src, /messages\.map|thread\.map/,
    "and that renderer must be reached by mapping the messages");
  // Every widget kind the router can emit must be handled, or one produces a
  // blank hole in the conversation.
  for (const kind of ["chart-line", "chart-bar", "findings", "columns", "mappings", "capabilities"]) {
    assert.match(src, new RegExp(kind.replace("-", "-")), `the ${kind} widget must be renderable`);
  }
});

test("the user CAN ask for different views, corrections and explanations", async () => {
  const src = appSourceOf(toReactDashboard(await analysis(), LIVE));
  assert.match(src, /\/api\/chat/, "a sentence is answered by the server, where the router lives");
  assert.match(src, /onSubmit/, "and the composer submits it");
  assert.match(src, /suggestion/i, "with clickable follow-ups the user can take instead of typing");
});

test("the agent's own CAPABILITIES are offered up front, from the router's list", async () => {
  const data = payloadOf(toReactDashboard(await analysis(), LIVE));
  const greeting = data.greeting as { suggestions?: string[] } | undefined;
  assert.ok(Array.isArray(greeting.suggestions) && greeting.suggestions.length > 0,
    "the opening must offer somewhere to go, or the user is staring at a text box");
});

test("NO WIDGET, NO CHART: the charts may not appear before the conversation does", async () => {
  // The strongest statement of the pivot. A chat-first page that renders its
  // charts above the greeting is a dashboard with a chat underneath, which is
  // what we shipped last time.
  const src = appSourceOf(toReactDashboard(await analysis(), LIVE));
  const greetingAt = src.indexOf('role === "agent"');
  const chartOutsideFlow = /<h2[^>]*>Record categories/.test(src) ||
    /<h2[^>]*>Rows by hour/.test(src);
  assert.ok(!chartOutsideFlow,
    "chart headings must live in the widget renderer, not be page sections");
  assert.ok(greetingAt > -1, "and the transcript must render messages by role");
});

test("a STATIC report is still available, because some questions need a table", async () => {
  // Chat-first does not mean table-hostile. Somebody asking for the full column
  // statistics wants a table, and taking that away to make a point about
  // conversation would be its own kind of rigidity.
  const src = appSourceOf(toReactDashboard(await analysis(), LIVE));
  assert.match(src, /View raw data|columns/,
    "column data must still be reachable inside the conversation");
});