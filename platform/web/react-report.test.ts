import test from "node:test";
import assert from "node:assert/strict";

import { toReactDashboard, DASHBOARD_DATA_ID, DASHBOARD_MOUNT_ID } from "./react-report.ts";
import { parseCsv } from "../conductor/capabilities.ts";
import { analyseBottlenecks, type BottleneckAnalysis } from "../conductor/bottlenecks.ts";
import { buildAnalysis } from "./react-report.test-support.ts";

/**
 * THE REACT DASHBOARD. The static report answered "what is in this file". A
 * commercial product has to answer "what do I do next", and the difference
 * between those two questions is interactivity: filtering, sorting, switching
 * depth without re-reading the file.
 *
 * TWO THINGS THIS TEST IS ACTUALLY ABOUT, both of which a "does it contain
 * React" assertion would miss:
 *
 *   1. THE PAYLOAD IS UNTRUSTED. The data embedded in the page is column names
 *      and cell values taken straight out of a file the user dropped. A column
 *      called `</script><script>alert(1)</script>` is not a hypothetical -- this
 *      product ingests whatever it is handed, and a report that executes the
 *      contents of a CSV is a remote-code-execution-shaped bug in a tool whose
 *      whole value proposition is that it reads your files. So the embedding is
 *      asserted, not assumed.
 *   2. THE ARTIFACT IS A STRING. Nothing here is served or compiled in tests,
 *      so the assertions are on structure: the mount point exists, the runtime
 *      is pinned, and the data block is inert.
 */

const analysis = await buildAnalysis();

/** The contents of the embedded data script, as a browser would see it. */
function payloadOf(html: string): string {
  const open = `id="${DASHBOARD_DATA_ID}"`;
  const start = html.indexOf(open);
  assert.ok(start > 0, `the page must embed its data in a script with ${open}`);
  const from = html.indexOf(">", start) + 1;
  const to = html.indexOf("</script>", from);
  return html.slice(from, to);
}

/** The application body, which Babel evaluates in the browser. */
function appSourceOf(html: string): string {
  const open = '<script type="text/babel"';
  const start = html.indexOf(open);
  assert.ok(start > 0, "the page must carry its application as a babel script");
  const from = html.indexOf(">", start) + 1;
  return html.slice(from, html.indexOf("</script>", from));
}

/** Every string anywhere in a parsed payload, so a check cannot miss a field. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsIn(v, out));
  else if (value !== null && typeof value === "object") Object.values(value).forEach((v) => stringsIn(v, out));
  return out;
}

/**
 * Parse and profile, with the rows MAPPED to records first.
 *
 * `parseCsv` returns `rows` as arrays of cells; the profiler expects one record
 * per row keyed by header. Passing the parse result straight through compiles,
 * type-checks and quietly produces an analysis with no numeric columns at all --
 * which is exactly how the first version of the XSS test ended up asserting on
 * an empty payload and calling it a pass.
 */
async function profile(text: string): Promise<BottleneckAnalysis> {
  const parsed = parseCsv(text);
  return await analyseBottlenecks({
    path: "hostile.csv",
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    columns: [],
    sample: [],
    problems: parsed.problems,
    rows: parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""]))),
  });
}

test("the generated page is a complete standalone document with a React mount point", async () => {
  const html = toReactDashboard(analysis, { title: "Operations review" });
  assert.match(html, /^<!doctype html>/i, "a standalone document, not a fragment");
  assert.match(html, /<html[^>]*lang=/i);
  assert.ok(html.includes(`id="${DASHBOARD_MOUNT_ID}"`),
    `the app needs a mount point the runtime can attach to (expected id="${DASHBOARD_MOUNT_ID}")`);
  assert.match(html, /<\/html>\s*$/, "and it is closed");
});

test("React is loaded from a CDN, at a PINNED version, and the pin is asserted", async () => {
  const html = toReactDashboard(analysis, {});
  const react = /<script[^>]+src="([^"]*react[^"]*)"/i.exec(html);
  assert.ok(react !== null, "React must be loaded for the app to run at all");
  // An unpinned CDN reference means the page's behaviour changes when someone
  // else publishes. A report about a production incident should not be able to
  // change because an unrelated package moved.
  assert.match(react[1], /react@[\d.]+(-[a-z0-9.]+)?\//i, `React must be version-pinned, got ${react[1]}`);
  const dom = /<script[^>]+src="([^"]*react-dom[^"]*)"/i.exec(html);
  assert.ok(dom !== null, "and so must react-dom, which is a separate package from react");
  assert.match(dom[1], /react-dom@[\d.]+(-[a-z0-9.]+)?\//i, `react-dom must be pinned, got ${dom[1]}`);
});

test("the analysis is embedded as inert JSON, so a hostile file cannot become script", async () => {
  // The payload is the whole point of the danger: it holds column names and
  // values from a file this product was handed.
  //
  // The hostile name is on a NUMERIC column on purpose. The first version of
  // this test used a text column, and the assertion then passed for the wrong
  // reason: a text column never reaches the numeric `columns` payload, so the
  // escaping was never exercised at all and the test proved nothing. A red-first
  // test that is vacuous on day one is worse than no test, because it is
  // believed in.
  const hostileName = "</script><script>alert(1)</script>";
  const rows = Array.from({ length: 12 }, (_, i) => `${i + 1},${i * 3}`);
  const html = toReactDashboard(await profile(`${hostileName},other\n${rows.join("\n")}\n`), {});
  const payload = payloadOf(html);

  assert.ok(!/<\/script/i.test(payload), "no script-closing sequence may survive inside the data block");
  assert.ok(!/<script/i.test(payload), "and no opening tag either");
  // The escape must be a JSON-level escape, so the data still parses back to
  // the original string. Escaping the data into something unparseable would
  // trade an injection for a silently broken dashboard.
  const parsed = JSON.parse(payload);
  assert.ok(stringsIn(parsed).some((s) => s === hostileName),
    "the hostile name must reach the payload AND round-trip through the escaping intact, or this test is vacuous");
});

test("the surface is interactive: the conversation changes what is rendered", async () => {
  // ASSERTED AT SOURCE LEVEL, and the limitation is worth stating plainly. React
  // builds these elements at runtime, so they are not in the static HTML and no
  // test in this repository can assert on a rendered DOM -- there is no browser
  // and no React installed, by design.
  //
  // WHAT CHANGED. This used to assert a severity <select> and a depth toggle.
  // Both were the dashboard's way of letting a user interrogate the file, and
  // the Owner's verdict was that the conversation was secondary to them. A chat
  // that asks "what is wrong with this file?" and gets the findings IS the
  // severity filter, with a language instead of a dropdown.
  //
  // So the property asserted here is the one underneath both: does user input
  // change state, and does that state reach the render? A control that sets
  // state nothing reads is the exact failure -- it looks like the product works.
  // ASSERTED ON THE LIVE PAGE, AND THAT MOVE IS THE POINT OF THIS EDIT.
  //
  // This used to assert the submit handler on the OFFLINE artifact. The export
  // work changed what an offline artifact IS: the composer is now SPLICED OUT
  // at generation time rather than gated at runtime, so the offline document
  // contains no composer to assert on. Reading the old assertion as "broken"
  // would have been wrong -- the control is not merely hidden there, it is
  // absent from the source, which is a stronger property.
  //
  // The property this test actually cares about is untouched by that: does user
  // input change state, and does that state reach the render? A composer that
  // sets state nothing reads is the exact failure. That question is only
  // meaningful where a composer exists, so it is now asked of the live page --
  // and the offline document's own absence of the control is pinned separately,
  // in react-chat.test.ts, so nothing is traded away here.
  const src = appSourceOf(toReactDashboard(analysis, { live: { path: "operations.csv" } }));
  assert.match(src, /useState/, "the app must actually hold state");
  assert.match(src, /messages\.map|thread\.map/, "and the state must reach what is rendered");
  // The send path: user input -> state -> the answer that replaces the transcript.
  assert.match(src, /push\(\[\{ role: "user"/, "a submitted sentence becomes a turn");
  assert.match(src, /push\(\[\{\s*$/m, "and the answer becomes a turn");
  assert.match(src, /onSubmit: function \(e\)/, "driven by the composer, not by a hidden control");
});

test("the app renders the findings the engine produced, not a placeholder", async () => {
  const html = toReactDashboard(analysis, {});
  const parsed = JSON.parse(payloadOf(html)) as {
    title: string; totalRows: number; columns: unknown[];
    anomalies: { column: string; severity: string }[];
  };
  assert.ok(parsed.totalRows > 0, "the real row count travels with the app");
  assert.ok(Array.isArray(parsed.columns) && parsed.columns.length > 0, "and the columns it measured");
  assert.ok(Array.isArray(parsed.anomalies), "anomalies must be a list the filter can act on");
  // Every anomaly carries a severity from a CLOSED set, because a filter
  // dropdown built from observed values silently loses options.
  for (const a of parsed.anomalies) {
    assert.ok(["critical", "warning", "info"].includes(a.severity), `unexpected severity ${a.severity}`);
  }
});

test("a clean file produces an app that says so, rather than an empty dashboard", async () => {
  const clean = await profile("a,b\n1,2\n3,4\n5,6\n7,8\n9,10\n11,12\n13,14\n15,16\n17,18\n");
  const html = toReactDashboard(clean, {});
  const parsed = JSON.parse(payloadOf(html)) as { anomalies: unknown[]; headline: string };
  assert.equal(parsed.anomalies.length, 0, "a clean file has nothing to filter");
  assert.ok(parsed.headline.length > 0, "and the dashboard must still say something true about it");
});

test("the document declares its own policy, and it is not the kernel's strict one", async () => {
  const html = toReactDashboard(analysis, {});
  const csp = /content-security-policy" content="([^"]+)"/i.exec(html);
  assert.ok(csp !== null, "a page that loads remote script must say what it permits");
  // This is the ONE place in the product where third-party script runs, and the
  // isolation is the point: the kernel's own page keeps default-src 'none' and
  // loads nothing remote. This page is a separate artifact with a separate
  // policy, and the test pins the difference so nobody quietly widens the
  // kernel's page to match this one.
  assert.match(csp[1], /script-src[^;]*https:\/\/unpkg\.com/, "and the CDN is named explicitly, not via a wildcard");
  assert.ok(!/script-src[^;]*\*/.test(csp[1]), "no wildcard script source");
  assert.ok(!/unsafe-eval/.test(csp[1]), "and no eval, which a pinned build does not need");
});
