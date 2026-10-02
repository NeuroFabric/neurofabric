import test from "node:test";
import assert from "node:assert/strict";

import {
  toReactDashboard,
  DASHBOARD_DATA_ID,
  DASHBOARD_MOUNT_ID,
} from "./react-report.ts";
import { buildAnalysis } from "./react-report.test-support.ts";
import { parseCorrection } from "./chat-parse.ts";

/**
 * THE CONVERSATIONAL UI. The report is an opinion; this is the reply.
 *
 * A generated report is a wall the user reads and then works around by hand.
 * The moment the engine is wrong -- and on an unfamiliar file it is wrong often
 * enough -- the only remedy is to open a JSON file and edit a mapping. That is
 * a developer's answer to a question a person with a spreadsheet is asking, so
 * the correction loop is the feature, not the polish.
 *
 * === WHAT THESE TESTS HOLD THE IMPLEMENTATION TO ===
 *
 * The dangerous failure is a chat that LOOKS conversational and quietly does
 * nothing, or does the wrong thing confidently. Three properties carry that
 * risk, and each is asserted here:
 *
 *   1. THE BROWSER RUNS THE SAME PARSER AS THE SUITE. `parseCorrection` is
 *      serialised into the page, so there is one implementation, not two that
 *      agree until somebody changes one of them. The test evaluates the emitted
 *      source exactly as the browser does -- as a bare function with nothing
 *      else in scope -- because that is the only way to catch a closure over
 *      module scope, which type-checks, passes a naive test, and dies in the
 *      browser with a ReferenceError.
 *   2. A REFUSAL IS SHOWN AS A REFUSAL. "col_15 is actually the amount" has no
 *      counterpart in the engine's vocabulary. The UI must say so rather than
 *      mapping it onto the nearest numeric role, because a wrong mapping
 *      publishes a latency finding about money and looks entirely normal.
 *   3. THE CHAT SENDS A COLUMN NAME, NEVER THE FILE. The codebase's stated
 *      position is that a dashboard which phones home is a dashboard that
 *      exfiltrated the CSV. The request body is asserted field by field, so
 *      adding a row of data to it later fails here instead of in a breach.
 */

const analysis = await buildAnalysis();

/** The contents of the embedded data script, as a browser would see it. */
function payloadOf(html: string): Record<string, unknown> {
  const open = `id="${DASHBOARD_DATA_ID}"`;
  const start = html.indexOf(open);
  assert.ok(start > 0, `the page must embed its data in a script with ${open}`);
  const from = html.indexOf(">", start) + 1;
  const to = html.indexOf("</script>", from);
  return JSON.parse(html.slice(from, to)) as Record<string, unknown>;
}

/** The application body, which Babel evaluates in the browser. */
function appSourceOf(html: string): string {
  const open = '<script type="text/babel"';
  const start = html.indexOf(open);
  assert.ok(start > 0, "the page must carry its application as a babel script");
  const from = html.indexOf(">", start) + 1;
  return html.slice(from, html.indexOf("</script>", from));
}

const LIVE = { live: { path: "operations.csv" } };

test("the dashboard carries a chat the user can type into", () => {
  const html = toReactDashboard(analysis, LIVE);
  const src = appSourceOf(html);

  assert.match(src, /Chat/i, "the sidebar must be labelled, so the user knows it exists");
  // A real input, not a paragraph inviting the user to email support.
  assert.match(src, /<input|"input"|type: "text"/, "there must be a text field to type a correction into");
  assert.match(src, /onSubmit|onClick/, "and a way to send it");
  // The refusal path is not optional; it is the most likely thing a user hits.
  assert.match(src, /parse|PARSE/, "the sentence must be parsed in the page, not sent raw");
});

test("the browser runs the SAME parser the test suite runs", () => {
  const html = toReactDashboard(analysis, LIVE);
  const src = appSourceOf(html);

  // The emitted source must contain a function that behaves identically to the
  // imported one on the sentences that decide whether the product works.
  assert.match(src, /function parseCorrection|parseCorrection\s*=/,
    "the parser must be present in the page, not imported by a bundler that does not exist");

  const embedded = extractParser(src);
  assert.ok(embedded !== null, "the emitted parser must be extractable to be tested at all");

  for (const sentence of [
    "alert_code is the category",
    "col_15 is actually the amount",
    "the category is alert_code",
    "outcome is the state",
    "total (USD) is the category",
  ]) {
    const inBrowser = embedded(sentence);
    const inSuite = parseCorrection(sentence);
    assert.deepEqual(
      { ...inBrowser },
      { ...inSuite },
      `the browser and the suite must agree on: ${sentence}`,
    );
  }
});

/**
 * Pull the emitted parser back out of the generated source.
 *
 * Extracted as TEXT and re-evaluated, because that is precisely the browser's
 * situation. An import of the real function here would prove only that the real
 * function works -- which the parser's own suite already does -- and would pass
 * even if the page shipped a subtly different copy.
 */
function extractParser(src: string): ((t: string) => ReturnType<typeof parseCorrection>) | null {
  const start = src.indexOf("function parseCorrection");
  if (start < 0) return null;
  // Walk braces to find the end of the function body, respecting strings.
  let depth = 0;
  let seenBody = false;
  for (let i = src.indexOf("{", start); i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "{") { depth += 1; seenBody = true; }
    else if (ch === "}") {
      depth -= 1;
      if (seenBody && depth === 0) {
        const text = src.slice(start, i + 1);
        // The browser's exact condition: nothing else in scope.
        return new Function(`return (${text})`)() as (t: string) => ReturnType<typeof parseCorrection>;
      }
    }
  }
  return null;
}

test("a refusal is shown to the user as a refusal, never silently applied", () => {
  const html = toReactDashboard(analysis, LIVE);
  const src = appSourceOf(html);

  // The Owner's own sentence, which must NOT produce a correction.
  const rejected = parseCorrection("col_15 is actually the amount");
  assert.equal(rejected.ok, false, "precondition: the engine has no role meaning 'amount'");

  assert.match(src, /reason/, "the page must have somewhere to put the engine's reason");
  assert.match(src, /known/, "and must offer the vocabulary, so the user can finish the sentence");
  // A refusal must not reach the network. This is the assertion that matters:
  // an implementation that shows the reason AND still fires the request is
  // worse than one that never parses at all.
  assert.match(src, /if \(!parsed\.ok\)|if \(parsed\.ok === false\)|if \(parsed\.ok === false\) return/,
    "the send must be gated on the parse having succeeded");
});

test("a correction is sent as a column name and a role, and never as file contents", () => {
  const html = toReactDashboard(analysis, LIVE);
  const src = appSourceOf(html);

  // The request body is the whole privacy story, so it is pinned exactly.
  assert.match(src, /JSON\.stringify\(\{[^}]*path[^}]*column[^}]*role/s,
    "the body must be path + column + role");
  assert.match(src, /\/api\/feedback/, "posted to the correction endpoint");

  // And the negative: nothing that smells like the data itself.
  assert.ok(!/JSON\.stringify\(\{[^}]*(rows|cells|data|values|content)/s.test(src),
    "no row data may be sent -- a correction is a mapping, not a copy of the file");
  assert.ok(!/D\.columns\.map\([^)]*\)\s*:\s*JSON\.stringify/.test(src),
    "nor the column table as a side-channel");
});

test("the dashboard learns: a successful correction updates what is on screen", () => {
  const html = toReactDashboard(analysis, LIVE);
  const src = appSourceOf(html);
  const data = payloadOf(html);

  assert.ok(data.learned !== null && typeof data.learned === "object" && !Array.isArray(data.learned),
    "the payload must carry the learned mapping as role -> column, even when empty");
  // A first run may legitimately know nothing; what it must not do is OMIT the
  // field, because the chat reads it on first paint and an absent one throws.
  for (const [role, column] of Object.entries(data.learned as Record<string, string>)) {
    assert.match(role, /^[a-z_]+$/, `a learned key is a role, got ${role}`);
    assert.equal(typeof column, "string", "and every value is a column name");
  }

  assert.match(src, /useState/, "the app holds state, so an update can re-render without a reload");
  assert.match(src, /setLearned|setFeedback|setMessages/, "and a setter the successful response drives");
  // THE POINT OF THE WHOLE FEATURE: no reload.
  assert.ok(!/location\.reload\(\)/.test(src), "a hard reload would throw away the user's place in the report");
});

test("the standalone dashboard still makes no network call at all", () => {
  // The default artifact is a file on disk that anybody can open. It must not
  // gain a chat that posts nowhere -- that is a control the user can see and
  // press, and it would fail silently in a way that reads as a broken product.
  const html = toReactDashboard(analysis, {});
  const csp = /content="([^"]*default-src[^"]*)"/.exec(html);
  assert.ok(csp !== null, "a CSP must be declared");
  assert.match(csp[1]!, /connect-src 'none'/,
    "with no network permitted, so the offline artifact cannot phone home even if asked");
  assert.ok(!html.includes("/api/feedback"), "and no correction endpoint it could never reach");
});

test("a live dashboard permits exactly one origin for the correction call", () => {
  const html = toReactDashboard(analysis, LIVE);
  const csp = /content="([^"]*default-src[^"]*)"/.exec(html);
  assert.ok(csp !== null);
  assert.match(csp[1]!, /connect-src 'self'/,
    "the chat needs to reach the API, and 'self' is the narrowest way to say so");
  assert.ok(!/connect-src[^;]*\*/.test(csp[1]!), "and never a wildcard");
  assert.ok(!/unsafe-eval/.test(csp[1]!), "and still no eval");
});

test("the page tells the user which file the correction will apply to", () => {
  // A correction applied to the wrong file is worse than no correction: it is
  // confidently wrong. The user must be able to see the target before they say
  // the sentence.
  const html = toReactDashboard(analysis, LIVE);
  const data = payloadOf(html);
  assert.equal((data as { source?: unknown }).source, "operations.csv",
    "the file under discussion travels with the payload");
  assert.ok(appSourceOf(html).includes("D.source"), "and is rendered, not merely carried");
});

test("the mount and data ids are unchanged, so a saved report keeps opening", () => {
  // Regression guard on the one thing a user would notice immediately.
  const html = toReactDashboard(analysis, LIVE);
  assert.ok(html.includes(`id="${DASHBOARD_MOUNT_ID}"`), "the mount point must still be there");
  assert.ok(html.includes(`id="${DASHBOARD_DATA_ID}"`), "and so must the data block");
});
