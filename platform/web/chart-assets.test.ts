import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { toReactDashboard, dashboardCsp, DASHBOARD_DATA_ID } from "./react-report.ts";
import { startWedgeServer, type RunningWedge } from "./server.ts";
import { makeTempWorkspace, writeFixture } from "../test-support/temp-workspace.ts";
import { parseCsv } from "../conductor/capabilities.ts";
import { analyseBottlenecks, type BottleneckAnalysis } from "../conductor/bottlenecks.ts";

/**
 * TASK 1 -- THE CHARTS MUST ACTUALLY RENDER.
 *
 * The Owner saw "The charting library could not be loaded" -- this repository's
 * own fallback, shown because `typeof Chart` was undefined in a real browser --
 * and reported that the CSP had blocked the CDN.
 *
 * **THE CSP WAS INNOCENT.** `script-src` already named `https://unpkg.com` and
 * the tag carried the right origin. The real cause was a 404: the page asked
 * unpkg for `chart.js@4.4.1/dist/chart.umd.min.js`, and Chart.js v4 ships no
 * such file. It ships `chart.umd.js`, which is already minified -- `.min` was a
 * v3 convention dropped in v4.
 *
 * That distinction is why this file exists in the shape it does. From inside the
 * page a blocked script and a 404 are the SAME observation: a global that never
 * arrives. Everything else here follows from taking that seriously.
 */

const CSV = `_time,source_host,alertType,elapsed_time
2026-09-30 09:00:00.000,host-web,login,120
2026-09-30 09:01:00.000,host-bg,checkout,80
2026-09-30 10:00:00.000,host-db,search,43`;

async function analysis(): Promise<BottleneckAnalysis> {
  const parsed = parseCsv(CSV);
  const rows = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return await analyseBottlenecks({
    path: "operations.csv",
    headers: parsed.headers,
    rowCount: parsed.rows.length,
    columns: [], sample: [], rows, problems: parsed.problems,
  });
}

function appSourceOf(html: string): string {
  const open = '<script type="text/babel"';
  const start = html.indexOf(open);
  assert.ok(start > 0);
  const from = html.indexOf(">", start) + 1;
  return html.slice(from, html.indexOf("</script>", from));
}

test("THE CDN FILENAME IS THE ONE THAT ACTUALLY EXISTS", async () => {
  // The single defect that cost the Owner a release. Verified against the live
  // CDN by hand, and pinned here because no test in this repository makes a
  // network call and none of them should.
  const html = toReactDashboard(await analysis(), {});
  const src = /<script[^>]+src="([^"]*chart\.js[^"]*)"/.exec(html);
  assert.ok(src !== null, "the charting library must be referenced at all");
  const url = src[1]!;

  assert.match(url, /chart\.js@4\.4\.1\//, "pinned to a major.patch");
  assert.match(url, /\/dist\/chart\.umd\.js$/,
    `the v4 UMD bundle is chart.umd.js; \`chart.umd.min.js\` returns 404. Got: ${url}`);
  assert.ok(!url.includes(".min.js"),
    "v4 ships one already-minified UMD bundle; there is no .min.js variant");
});

test("every script the page loads is named in the policy, explicitly", async () => {
  // The tag needs an origin the policy permits. A mismatch here is the CSP
  // failure the Owner suspected -- and which was NOT this release's cause, but
  // will be the next one if an origin is added and forgotten.
  const html = toReactDashboard(await analysis(), {});
  const policy = /content="([^"]*default-src[^"]*)"/.exec(html)?.[1] ?? "";
  assert.ok(policy.length > 0, "the document must carry a policy");

  const origins = new Set<string>();
  for (const m of html.matchAll(/<script[^>]+src="(https:\/\/[^/"]+)[^"]*"/g)) origins.add(m[1]!);

  for (const origin of origins) {
    assert.ok(policy.includes(origin),
      `the page loads ${origin} but the policy does not permit it: ${policy}`);
  }
  // Two origins, both named. A wildcard would silently permit every script host
  // on the internet to rewrite this page, which reads a user's uploaded file.
  assert.deepEqual([...origins].sort(), ["https://cdn.tailwindcss.com", "https://unpkg.com"]);
});

test("the policy is now a single definition, not two that drifted", async () => {
  // The meta tag had accumulated `style-src` TWICE -- widened in one release and
  // widened again in another that added Tailwind without looking at what was
  // already there. Per the CSP spec duplicate directives are discarded, so which
  // one survives depends on parser order rather than on intent.
  for (const live of [true, false]) {
    const policy = dashboardCsp(live);
    const names = policy.split(";").map((d) => d.trim().split(/\s+/)[0]);
    assert.equal(new Set(names).size, names.length,
      `duplicate directive in the policy for live=${live}: ${policy}`);
    // And the meta tag must be that exact string, not a hand-written copy.
    const html = toReactDashboard(await analysis(), live ? { live: { path: "x.csv" } } : {});
    const meta = /content="([^"]*default-src[^"]*)"/.exec(html)?.[1];
    assert.equal(meta, policy, `the meta tag must BE the function's output (live=${live})`);
  }
});

test("the SERVER sends the policy as a header, not only as a meta tag", async () => {
  const cwd = await makeTempWorkspace("nf-csp-");
  await writeFixture(cwd, "operations.csv", CSV);
  const started = await startWedgeServer({ cwd, port: 0 });
  const server: RunningWedge = started;
  try {
    const response = await fetch(`${server.url}/api/dashboard?path=operations.csv`);
    assert.equal(response.status, 200);
    const header = response.headers.get("content-security-policy");
    assert.ok(header !== null,
      "the policy must be enforced at the HTTP layer; a meta tag is only honoured if it precedes every resource");
    assert.match(header, /script-src[^;]*https:\/\/unpkg\.com/, "unpkg named for React, Chart.js and Babel");
    assert.match(header, /script-src[^;]*https:\/\/cdn\.tailwindcss\.com/, "and Tailwind");
    assert.match(header, /connect-src 'self'/, "the live page may reach its own origin, for the correction");

    // The header and the document must be the SAME policy.
    const html = await response.text();
    const meta = /content="([^"]*default-src[^"]*)"/.exec(html)?.[1];
    assert.equal(meta, header, "header and meta tag must not disagree");
  } finally {
    await server.close();
  }
});

test("the fallback names BOTH causes, because from inside they look identical", async () => {
  // The Owner diagnosed this as a CSP block and was wrong. That is not a silly
  // mistake -- a missing global is a missing global -- and the only defence is a
  // message that says so and tells a reader where to look.
  const src = appSourceOf(toReactDashboard(await analysis(), {}));
  assert.match(src, /Content-Security-Policy/, "the blocked case");
  assert.match(src, /404|error/i, "and the case where the CDN answered with an error");
  assert.match(src, /console/i, "and where to look for the evidence");
});

test("a missing library still costs two pictures, never the report", async () => {
  const src = appSourceOf(toReactDashboard(await analysis(), {}));
  assert.match(src, /typeof Chart/, "feature-detected before use");
  // The numbers must remain reachable as text, or "charts unavailable" is a lie.
  // After the chat-first pivot this is the COLUMNS WIDGET and the provenance
  // footer rather than a "View raw data" disclosure -- the data did not shrink,
  // it moved into the conversation.
  assert.match(src, /"columns"/, "the exact column statistics are still renderable as a table");
  assert.match(src, /Data provenance/, "and the file's provenance is still stated");
});

test("the kernel's own landing page is STILL untouched by any of this", async () => {
  // The widening lives only in the generated dashboard. This is the property
  // that keeps the two artifacts distinguishable, and it is the thing a later
  // edit is most likely to "fix" by making them consistent.
  const cwd = await makeTempWorkspace("nf-csp-");
  const started = await startWedgeServer({ cwd, port: 0 });
  const server: RunningWedge = started;
  try {
    const response = await fetch(`${server.url}/`);
    const policy = response.headers.get("content-security-policy") ?? "";
    assert.match(policy, /default-src 'none'/, "the landing page keeps its strict policy");
    assert.ok(!policy.includes("unpkg.com"), "and names no CDN at all");
    const html = await response.text();
    assert.ok(!html.includes("cdn.tailwindcss.com"), "and loads nothing remote");
  } finally {
    await server.close();
  }
});