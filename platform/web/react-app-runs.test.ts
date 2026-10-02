import test from "node:test";
import assert from "node:assert/strict";

import { toReactDashboard } from "./react-report.ts";
import { buildAnalysis } from "./react-report.test-support.ts";
import { appSourceOf, evaluateApp, evaluateAppForTest } from "./react-app-harness.ts";

/**
 * THE DASHBOARD MUST ACTUALLY RUN, NOT MERELY PARSE.
 *
 * A `ReferenceError: h is not defined` took the whole dashboard down -- blank
 * page, no charts, no chat -- and every one of the tests in this repository
 * passed. The reason is the most important thing in this file.
 *
 * EVERY PREVIOUS TEST HELD THE DOCUMENT AS A STRING. The parse test checks the
 * emitted source does not terminate its own script element. The report tests
 * check that a column name, a role or a number appears in the payload. Those are
 * real assertions and they all held, and none of them can see a name that is
 * undefined until a JavaScript engine tries to read it. A parse test proves the
 * text is well-formed; it says nothing about whether the page runs.
 *
 * The harness lives in `react-app-harness.ts` so the layout tests assert against
 * the same renderer rather than a second, subtly different one -- two harnesses
 * would differ exactly where it matters.
 */

const analysis = await buildAnalysis();

test("the emitted application RUNS, so the dashboard is not a blank page", () => {
  const html = toReactDashboard(analysis, {});
  const { rendered, errors } = evaluateApp(html);
  assert.deepEqual(errors, [],
    `the application threw while being evaluated, so the browser would too: ${errors.join(" | ")}`);
  assert.equal(rendered, true, "and it must reach the mount call, not merely run without throwing");
});

test("the LIVE page runs too, with the chat source spliced in", () => {
  const html = toReactDashboard(analysis, { live: { path: "operations.csv" } });
  const { rendered, errors } = evaluateApp(html);
  assert.deepEqual(errors, [], `the live application threw: ${errors.join(" | ")}`);
  assert.equal(rendered, true);
});

test("the element alias is declared BEFORE anything uses it", () => {
  // The narrow assertion that names that bug directly. Ordering matters as much
  // as existence: a declaration after the first call site still throws.
  const src = appSourceOf(toReactDashboard(analysis, {}));

  const declAt = /(^|[\s;{])var\s+h\s*=\s*React\.createElement\s*;/.exec(src);
  assert.ok(declAt !== null,
    "the alias must be DECLARED, or every render call throws a ReferenceError at runtime");

  const firstCall = /(^|[^A-Za-z0-9_$.])h\s*\(/.exec(src);
  assert.ok(firstCall !== null, "the app should render through the alias at all");
  assert.ok(declAt.index < firstCall.index,
    `the alias is declared at ${declAt.index} but first used at ${firstCall.index}; ` +
    "a declaration after the first call still throws");

  const calls = [...src.matchAll(/(^|[^A-Za-z0-9_$.])h\s*\(/g)];
  assert.ok(calls.length > 20,
    `expected the alias to be load-bearing across the app, found ${calls.length} call sites`);
});

test("the rendered tree is not empty", () => {
  // A harness that renders nothing passes every "does not throw" assertion in
  // this file. This is the check that it is still looking at something.
  const tree = evaluateAppForTest(toReactDashboard(analysis, { live: { path: "operations.csv" } }));
  assert.ok(tree.length > 10, `expected a real element tree, got ${tree.length} elements`);
  assert.ok(tree.some((e) => e.tag === "button"), "and buttons in it");
});
