import test from "node:test";
import assert from "node:assert/strict";

import { toReactDashboard } from "./react-report.ts";
import { buildAnalysis } from "./react-report.test-support.ts";

/**
 * THE APPLICATION SOURCE MUST ACTUALLY PARSE.
 *
 * Every other test in this directory asserts on the generated application with
 * a regex. That is a real blind spot, and it is blind in the worst direction:
 * a regex cannot tell a balanced brace from an unbalanced one. The application
 * is a STRING assembled by string substitution -- `__DATA_ID__`, `__MOUNT_ID__`,
 * `__CHAT__`, plus a parser spliced in from `toString` -- so a splice that
 * lands in the wrong place, or a chat block that is emitted for a standalone
 * page, produces output that still matches every pattern anybody thought to
 * write while being, in a browser, a blank screen with a syntax error in the
 * console.
 *
 * Nothing else in the suite would notice. The page is never executed here; the
 * tests read it as text. So this file is the one that COMPILES it.
 *
 * The parse is done with `new Function`, which builds a real function object and
 * therefore throws on a syntax error, without ever calling it. React, ReactDOM
 * and Chart are referenced but not required at parse time -- which is exactly
 * the browser's situation at the moment Babel hands the source over.
 */

const analysis = await buildAnalysis();

/** The babel body, as the browser receives it. */
function appSourceOf(html: string): string {
  const open = '<script type="text/babel"';
  const start = html.indexOf(open);
  assert.ok(start > 0, "the page must carry its application as a babel script");
  const from = html.indexOf(">", start) + 1;
  return html.slice(from, html.indexOf("</script>", from));
}

/** Parse, and fail loudly with the offending text if it will not. */
function assertParses(label: string, source: string): void {
  try {
    // Constructed, never invoked: this is a syntax check, not an execution.
    new Function(source);
  } catch (error) {
    assert.fail(
      `${label} does not parse as JavaScript: ${error instanceof Error ? error.message : String(error)}\n` +
      `A regex assertion cannot catch this, and a blank dashboard in a browser is the result.\n` +
      `--- source ---\n${source}`,
    );
  }
}

test("the STANDALONE application parses, with no chat spliced in", () => {
  const source = appSourceOf(toReactDashboard(analysis, {}));
  assertParses("the standalone application", source);
  // The re-read helper is spliced in ONLY for a live page, so a standalone
  // artifact has nothing to call and nothing that calls it. Asserting the
  // STRING is absent is the wrong test -- `ask` still mentions the function,
  // and it must, because the function body is shared code. What matters is
  // that it cannot run, which is what the gate asserts.
  assert.ok(!source.includes("function refreshFromServer"),
    "and no re-read helper, which is spliced in only when live");
  assert.match(source, /if \(!D\.live\) return;/,
    "and a guard so no question can reach the network from a file that has none");
});

test("the LIVE application parses, with the parser AND the re-read helper spliced in", () => {
  const source = appSourceOf(toReactDashboard(analysis, { live: { path: "operations.csv" } }));
  assertParses("the live application", source);
  // The parser is emitted even on a live page, because `ask` calls it in the
  // browser to recognise a correction BEFORE the sentence is sent to the router.
  // That is deliberate: a correction changes the engine's memory, so it cannot
  // be just another chat turn.
  assert.ok(source.includes("function parseCorrection"), "and the parser, verbatim");
  assert.ok(source.includes("function refreshFromServer"), "and the re-read helper");
});

test("the spliced parser still parses ON ITS OWN, as the browser evaluates it", () => {
  // The chat block is a separate string joined to the app with a newline. If
  // either half is malformed the join does not repair it, and Babel reports one
  // error with no useful line. So both halves are checked separately as well as
  // together.
  const source = appSourceOf(toReactDashboard(analysis, { live: { path: "operations.csv" } }));

  const parserAt = source.indexOf("function parseCorrection");
  assert.ok(parserAt > 0, "precondition: the parser is emitted");
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf("{", parserAt); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert.ok(end > 0, "the parser's braces must balance");
  assertParses("the spliced parser", source.slice(parserAt, end));
});

test("every substitution marker was actually replaced", () => {
  // The failure this catches is quiet and total: an unreplaced `__MOUNT_ID__`
  // renders a page whose React root is `null`, which throws on load and shows
  // nothing, while every regex in every other test still passes.
  for (const [label, options] of [
    ["standalone", {}],
    ["live", { live: { path: "operations.csv" } }],
  ] as const) {
    const html = toReactDashboard(analysis, options);
    const source = appSourceOf(html);
    for (const marker of ["__DATA_ID__", "__MOUNT_ID__", "__CHAT__"]) {
      assert.ok(!html.includes(marker), `${label}: ${marker} survived into the document`);
      assert.ok(!source.includes(marker), `${label}: ${marker} survived into the application`);
    }
  }
});

test("the document's script tags are balanced and the babel block is last", () => {
  // A splice that emitted the chat AFTER `ReactDOM.createRoot(...).render(...)`
  // would parse fine and still break: `ChatPanel` would be referenced before
  // its declaration is evaluated, because function declarations hoist but the
  // call site does not. Ordering is therefore asserted, not assumed.
  const html = toReactDashboard(analysis, { live: { path: "operations.csv" } });

  const open = (html.match(/<script\b/g) ?? []).length;
  const close = (html.match(/<\/script>/g) ?? []).length;
  assert.equal(open, close, `unbalanced script tags: ${open} open, ${close} close`);

  const source = appSourceOf(html);
  const refreshAt = source.indexOf("function refreshFromServer");
  const mountAt = source.lastIndexOf("ReactDOM.createRoot");
  assert.ok(refreshAt > 0 && mountAt > 0, "both must be present");
  // The order that matters is the one inside the transcript: a correction is
  // recognised, sent, applied, and only THEN re-read.
  const parsedAt = source.indexOf("var parsed = parseCorrection");
  const fetchAt = source.indexOf('fetch("/api/feedback"');
  assert.ok(parsedAt > 0 && fetchAt > parsedAt,
    "a correction is parsed before it is sent, so a refusal never reaches the network");
  assert.ok(refreshAt > 0, "and the re-read helper is emitted for the live page");
});
