import test from "node:test";
import assert from "node:assert/strict";

import { toReactDashboard, DASHBOARD_DATA_ID } from "./react-report.ts";
import { parseCsv } from "../conductor/capabilities.ts";
import { analyseBottlenecks } from "../conductor/bottlenecks.ts";

/**
 * TASK 2 -- A CORRECTION MUST MOVE THE CHARTS, NOT JUST A LIST OF WORDS.
 *
 * === WHAT WAS ALREADY TRUE, AND WAS NOT ENOUGH ===
 *
 * The chat already POSTed to /api/feedback and already replaced the learned
 * mapping in state. So after a correction the panel showed "category ->
 * alertType", the endpoint answered 200, and the server had genuinely
 * re-profiled and regenerated the report.
 *
 * And the charts did not move. Because they are drawn from the JSON block that
 * was embedded in the page when it was served, and nothing re-read it. The user
 * corrects a column, watches the panel confirm it, looks up at the bar chart
 * that is categorising by the old column, and concludes the correction did
 * nothing -- which, for everything they can see, is true.
 *
 * This is the same class of bug as the missing navigation in the first commit:
 * a feature that is complete at every layer and invisible at the one that
 * matters. The correction loop's entire payoff is watching the analysis CHANGE.
 *
 * === WHY THE REFRESH RE-FETCHES THE DASHBOARD RATHER THAN A NEW ENDPOINT ===
 *
 * The dashboard document IS the data carrier; it is generated from the same
 * analysis the server just regenerated. Re-fetching it and re-reading its JSON
 * block means the charts are rendered from exactly the payload the engine would
 * have produced on a first load -- one source of truth, no second serialisation
 * of the same analysis that could drift from the first.
 */

const CSV = `_time,source_host,alertType,alert_code,elapsed_time,threshold
2026-09-30 09:00:00.000,host-web,login,PEGA0001,1200,1000
2026-09-30 09:01:00.000,host-bg,checkout,PEGA0028,800,1000
2026-09-30 09:02:00.000,host-web,login,PEGA0001,2500,1000`;

async function buildAnalysis() {
  const { resolveSchemaMemory } = await import("../conductor/schema-memory.ts");
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
  assert.ok(start > 0);
  const from = html.indexOf(">", start) + 1;
  return html.slice(from, html.indexOf("</script>", from));
}

const live = () => appSourceOf(toReactDashboard(analysis, { live: { path: "operations.csv" } }));

test("a successful correction RE-READS the data the charts are drawn from", () => {
  const src = live();
  // The dashboard is re-fetched and its data block re-parsed, so the charts are
  // rendered from the engine's CURRENT analysis rather than the one captured
  // when the page was served.
  assert.match(src, /\/api\/dashboard\?path=/,
    "the page must re-read the dashboard after a correction");
  assert.match(src, new RegExp(DASHBOARD_DATA_ID),
    "and re-parse the very block the charts read from, not a parallel copy");
});

test("the re-read data REPLACES the old, and the app re-renders", () => {
  const src = live();
  // Object.assign onto the shared payload rather than a second variable, so
  // every component reading D.ranking / D.timeline sees the new analysis. A
  // parallel `freshData` object that only the chat reads would update the panel
  // and leave the charts stale -- which is the bug this file exists to prevent.
  assert.match(src, /Object\.assign\(D,|D = Object\.assign/,
    "the shared payload must be replaced in place");
  assert.match(src, /setVersion\(function \(v\) \{ return v \+ 1; \}\)/,
    "and a state change must force a re-render -- the functional form, so a second " +
    "correction cannot read a stale version");
});

test("THE CHARTS REDRAW, rather than keeping the canvas they were born with", () => {
  // THE REAL HALF OF THE FIX. `useChart` creates the chart in an effect with an
  // EMPTY dependency array -- deliberately, because recreating on every render
  // is the stacking bug `react-charts.test.ts` pins. But that same choice means
  // a new payload is drawn into a canvas showing the old one.
  //
  // So the effect gains ONE dependency: the version the chat bumps. That keeps
  // the no-stacking guarantee for ordinary re-renders while making the refresh
  // actually repaint, and the destroy-teardown already in place prevents the
  // old chart from being left underneath the new one.
  const src = live();
  assert.match(src, /React\.useEffect\(function \(\) \{[\s\S]*?\}, \[version\]\)/,
    "the chart effect must depend on the version, or the canvas keeps the old drawing");
  assert.match(src, /useChart\(function \(\) \{[\s\S]*?\}, props\.version\)/,
    "and the version must be passed into the chart hook");
});

test("the correction flow still refuses before it sends anything", () => {
  // Unchanged by the pivot and still asserted, because it is the property most
  // likely to be broken by a careless edit to the refresh path. What CHANGED is
  // where the refusal is decided: the page still gates /api/feedback on a
  // SUCCESSFUL parse, and the server router now decides whether a non-correction
  // sentence was a question or a refused correction. Neither half may reach the
  // correction endpoint.
  const src = live();
  const refuse = src.indexOf("if (parsed.ok)");
  const send = src.indexOf('fetch("/api/feedback"');
  const refresh = src.indexOf("refreshFromServer(setVersion, function");
  assert.ok(refuse > 0 && send > 0 && refresh > 0, "all three must exist");
  assert.ok(refuse < send, "the correction endpoint is reached only from the accepted branch");
  assert.ok(send < refresh, "and the refresh can only follow a send that succeeded");
});

test("a failed REFRESH is reported rather than silently leaving stale charts", () => {
  // The dangerous version of this feature is the one that appears to work: the
  // correction is saved, the panel updates, the re-read fails, and the charts
  // silently keep showing the old analysis. The user has been told their change
  // was applied -- which it was -- and is looking at a picture that no longer
  // describes their file.
  const src = live();
  assert.match(src, /\.catch\(function \(error\) \{/,
    "the re-read must have a failure path");
  assert.match(src, /could not refresh|still showing|refresh/i,
    "and it must tell the user the charts may be stale, in words they can act on");
});

test("the request body is STILL only a mapping, now that a second request exists", () => {
  // A re-fetch is a second network call on a page that holds a whole CSV's
  // analysis. The invariant that keeps this safe -- nothing but a mapping ever
  // crosses the wire -- now has two call sites to protect instead of one.
  const bodies = [...live().matchAll(/JSON\.stringify\(\{([^}]*)\}\)/g)].map((m) => m[1] ?? "");
  for (const body of bodies) {
    assert.ok(!/rows|cells|values|timeline|ranking|columns/i.test(body),
      `a request body carries file contents: {${body}}`);
  }
});

test("the standalone page is unaffected: no chat, no refresh, no second request", () => {
  const src = appSourceOf(toReactDashboard(analysis, {}));
  assert.ok(!src.includes("/api/dashboard?path="),
    "an offline artifact must not contain a refresh it cannot perform");
  assert.ok(!src.includes("function refreshFromServer"),
    "the re-read helper itself is not spliced into a standalone artifact");
  assert.ok(!src.includes("/api/dashboard?path="),
    "so there is nothing for a re-read to fetch");
  // WHAT CHANGED WITH THE EXPORT WORK, and it is a strengthening. The comment
  // this replaces described the OLD arrangement: the call site survived in
  // shared `ask` code, and only the DEFINITION was left out, so the combination
  // was safe because of a runtime guard. That guard is now unnecessary, because
  // the endpoints are resolved at generation time and neither the call sites nor
  // the definition reach a standalone document. So there is no dangling call
  // left to guard -- which is why the assertion is now ABSENCE, the same claim
  // expressed without the thing it was compensating for.
  assert.ok(!/D\.live\s*\?/.test(src) && !/onSubmit: function \(e\)/.test(src),
    "and the composer control itself is spliced out, not merely gated");
});

test("THE EMITTED SOURCE CONTAINS NO LITERAL </script>, ever", () => {
  // THE BUG THAT ALMOST SHIPPED, AND IT BELONGS HERE RATHER THAN IN A COMMENT.
  //
  // The refresh function searches the re-read document for the end of its data
  // block, so its own source contains the literal text `</script>`. That source
  // lives inside an HTML <script> element, and the HTML TOKENIZER -- unlike a JS
  // parser -- has no idea it is inside a string. It ends the block at the first
  // `</script` it finds.
  //
  // In a real browser the babel block therefore terminated a third of the way
  // through, right after the refresh function, and the ENTIRE chat panel -- the
  // input, the send handler, the refusal gate, the POST -- was parsed as markup
  // rather than script. The page would have shown its charts and no chat at all:
  // the Owner's original complaint, returned in a new form.
  //
  // `react-app-parses.test.ts` found it only because its extractor is naive on
  // purpose: `indexOf("</script>")` reproduces the browser's reading of the
  // document. A cleverer extractor would have hidden the bug.
  for (const [label, options] of [
    ["standalone", {}],
    ["live", { live: { path: "operations.csv" } }],
  ] as const) {
    const src = appSourceOf(toReactDashboard(analysis, options));
    assert.ok(!src.includes("</script>"),
      `${label}: a literal </script in the emitted source ends the block early in a browser`);
  }
});

test("the chat's send path survives ALL the way to the end of the block", () => {
  // The regression guard for the bug that shipped a page with no chat at all.
  // If the block truncates early again the transcript renders and the composer
  // renders, and pressing Enter does nothing -- which looks like a slow server.
  const src = live();
  const gate = src.indexOf("if (parsed.ok)");
  const send = src.indexOf('fetch("/api/feedback"');
  const refresh = src.indexOf("refreshFromServer(setVersion, function");
  assert.ok(gate > 0, "the correction branch must be present");
  assert.ok(send > gate, "and the send must follow it");
  assert.ok(refresh > send, "with the refresh last");
  // And the input the user types into, which is what was actually invisible.
  assert.match(src, /type: "text"/, "the text input must survive to the browser");
  assert.match(src, /onSubmit: function \(e\)/, "and be wired to the handler");
});
