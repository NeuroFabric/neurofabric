import test from "node:test";
import assert from "node:assert/strict";

import { PAGE_HTML } from "./page.ts";

/**
 * THE OWNER DROPPED A FILE AND SAW NO CHARTS.
 *
 * That is the whole report, and it is not a styling complaint. Every chart, the
 * tooltip and the entire conversational UI existed in the generated dashboard --
 * tested, type-checked, parsed by `react-app-parses.test.ts` -- and none of it
 * was ever shown to a single human.
 *
 * === WHAT WAS ACTUALLY HAPPENING ===
 *
 * The dropzone calls `/api/report`, which returns MARKDOWN, and injects it with
 * `innerHTML`. The React dashboard was served by a second route,
 * `/api/dashboard`, which existed, was tested, and had exactly zero callers.
 *
 * So the product had two front ends: the one a user reaches, which renders a
 * markdown string into a div, and the one built for them, which nobody loaded.
 * The Owner saw a wall of table rows because that is what the markdown
 * generator emits -- and the charts were in the other document entirely.
 *
 * This is the failure mode the suite could not see and should have. Every test
 * asserted that the dashboard CONTAINS charts, and every one of them passed,
 * because each held the dashboard in a variable and read it as a string. Not one
 * asked whether the product ever navigated a user to it. Tests of a generator
 * prove the generator works. Only a test of the product proves the generator is
 * REACHED.
 *
 * === WHAT IS ASSERTED HERE ===
 *
 * That the dropzone, on a delivered report, goes to the live dashboard. The
 * assertions are on the page's own source because it is a script string with no
 * DOM to drive: the honest alternative, a headless browser, is not available in
 * this environment and pretending otherwise would be the D-034 mistake in a new
 * place.
 */

test("a delivered report takes the user to the DASHBOARD, not a wall of markdown", () => {
  // THE FIX. Without this line every other chart in this product is unreachable.
  assert.match(
    PAGE_HTML,
    /\/api\/dashboard/,
    "the dropzone must navigate to the live dashboard once the file is read",
  );
});

test("the dashboard is reached on SUCCESS, and not before the kernel has answered", () => {
  // Ordering matters and is easy to get wrong. Navigating optimistically -- on
  // drop, before the POST -- would show the user a dashboard for a file the
  // kernel may have refused, which is the precise thing this product exists not
  // to do. A refusal must stay on the dropzone and be shown with its tier.
  const delivered = PAGE_HTML.indexOf('"DELIVERED"');
  const navigate = PAGE_HTML.indexOf("/api/dashboard");
  assert.ok(delivered > 0, "the page must branch on the kernel's own status");
  assert.ok(navigate > 0, "and must navigate somewhere");
  assert.ok(navigate > delivered,
    "navigation must come after the DELIVERED check, so a refusal is never a redirect");
});

test("the file name is ENCODED into the dashboard URL, or a name with a space breaks it", () => {
  // `"my file.csv"` interpolated raw produces `/api/dashboard?path=my file.csv`,
  // which the browser resolves as two query parameters and the server reads as
  // the file `my`. The user is told their file does not exist, for a file that
  // does. One call to encodeURIComponent, and the test that catches its absence.
  // lastIndexOf, because the explanatory comment above also names the route and
  // asserting on the first occurrence would be asserting on prose.
  const navAt = PAGE_HTML.lastIndexOf("/api/dashboard");
  const window = PAGE_HTML.slice(navAt - 60, navAt + 120);
  assert.match(window, /encodeURIComponent/,
    "the path must be encoded as it goes into the query string");
});

test("a refusal STILL lands on the dropzone, with the kernel's tier", () => {
  // The counterpart to the ordering assertion above, and the reason it exists:
  // the easy way to "fix" a blank-looking page is to navigate unconditionally,
  // and that throws away the one thing this product is for -- telling the user
  // no, with a reason, instead of rendering something plausible.
  assert.match(PAGE_HTML, /kernelReasonCode/, "the refusal tier is still rendered");
  assert.match(PAGE_HTML, /failure\.reason|failure && failure\.reason/,
    "and so is the reason");
  // Exactly one navigation site: a second one, on the failure branch, would be
  // the unconditional navigation this test exists to prevent.
  const occurrences = PAGE_HTML.split("/api/dashboard").length - 1;
  assert.ok(occurrences <= 2,
    `expected the dashboard URL to appear at most twice (string + test aid), got ${occurrences}`);
});

test("the dropzone page still loads NOTHING remote", () => {
  // Unchanged and load-bearing. The kernel's own page keeps `default-src 'none'`
  // and no CDN; the widening lives only in the generated dashboard. A report
  // about somebody's infrastructure must not phone a third party to be shown,
  // and this page is what they land on first.
  assert.ok(!/<script[^>]+src=/.test(PAGE_HTML), "no external script on the landing page");
  assert.ok(!/unpkg\.com/.test(PAGE_HTML), "and no CDN reference at all");
});
