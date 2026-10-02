import test from "node:test";
import assert from "node:assert/strict";

import { parseCorrection, ROLE_VOCABULARY } from "./chat-parse.ts";

/**
 * THE CHAT PARSER. Natural language in, one correction out.
 *
 * === THE DESIGN DECISION THIS FILE EXISTS TO GET RIGHT ===
 *
 * The Owner's example sentence is "col_15 is actually the amount", and the
 * obvious implementation maps "amount" onto the nearest role -- `duration`, the
 * engine's numeric role -- and accepts it.
 *
 * That would be confidently wrong, and the codebase has already rejected it in
 * another place for the same reason. `schema-memory.ts` says it outright: "a
 * numeric column is not a duration. `revenue` is numeric... `duration` is only
 * ever filled from a name that says so." Labelling a currency column a
 * `duration` would make the report publish a latency finding about money, and
 * every downstream number would inherit that error while looking perfectly
 * normal.
 *
 * So the parser distinguishes two kinds of word:
 *
 *   - a SYNONYM, accepted only where the meaning genuinely matches
 *     ("host" is a source, "timestamp" is a time, "state" is a status);
 *   - an explicit ROLE NAME, accepted verbatim, because a human saying "this is
 *     the duration" is a statement of authority and not an inference.
 *
 * And a word with no counterpart -- "amount", "cost", "total" -- is REFUSED with
 * the list of roles the engine does have. A refusal costs the user one sentence
 * of typing. A wrong mapping costs them a report they have to notice is wrong.
 *
 * === THE FUNCTION MUST STAND ALONE ===
 *
 * `parseCorrection` is serialised into the generated page by
 * `Function.prototype.toString`, so that the browser and the test suite run the
 * SAME implementation. That only works if it closes over nothing: every
 * constant it needs is declared inside its own body, and it takes one argument.
 * A helper in module scope would work perfectly here and fail silently in the
 * browser, which is the exact failure this comment exists to prevent.
 */

test("the Owner's own sentence is refused, because no role means 'amount'", () => {
  // THIS IS THE INTERESTING CASE, and it is the reason the module exists. The
  // tempting answer is `duration`, and answering that way would tell the engine
  // that a currency column is a latency measurement.
  const result = parseCorrection("col_15 is actually the amount");
  assert.equal(result.ok, false, "a magnitude with no role must not be forced into the nearest one");
  if (result.ok) throw new Error("unreachable");
  assert.match(result.reason, /duration|category|role/i, "and the refusal must say what IS available");
  assert.ok(result.known.length > 0, "so the user can correct themselves in one more sentence");
});

test("an explicit role name is accepted verbatim, because a human stating it is authority", () => {
  for (const [text, column, role] of [
    ["col_15 is the duration", "col_15", "duration"],
    ["alert_code should be the category", "alert_code", "category"],
    ["use host_name as the source", "host_name", "source"],
    ["set created_at as the time", "created_at", "time"],
  ] as const) {
    const result = parseCorrection(text);
    assert.equal(result.ok, true, `"${text}" must be understood`);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.column, column);
    assert.equal(result.role, role);
    assert.equal(result.confidence, "explicit", "and it must be recorded as a human statement, not a guess");
  }
});

test("plain-English synonyms map only where the meaning genuinely matches", () => {
  for (const [text, role] of [
    ["created_at is the timestamp", "time"],
    ["alert_type is the kind", "category"],
    ["outcome is the state", "status"],
    ["sla_target is the limit", "threshold"],
    ["upstream is the origin", "source"],
  ] as const) {
    const result = parseCorrection(text);
    assert.equal(result.ok, true, `"${text}" must be understood`);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.role, role);
    assert.equal(result.confidence, "synonym", `"${text}" is a synonym, not a role name`);
  }
});

test("a real role name is 'explicit' even when it reads as an ordinary word", () => {
  // The first version of this file listed "host_name is the source" among the
  // SYNONYMS and asserted `synonym`. It is not: `source` is a role the engine
  // has, so the user named a role outright. The distinction is not cosmetic --
  // it decides whether the report presents the mapping as a human statement or
  // as a rough paraphrase the engine may want to confirm -- and getting it
  // backwards would label every confident correction as tentative.
  const result = parseCorrection("host_name is the source");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.role, "source");
  assert.equal(result.confidence, "explicit");
});

test("the REVERSED sentence works, because people phrase it both ways", () => {
  // "the category is alert_code" is the same correction as "alert_code is the
  // category", and a parser that only reads one word order silently refuses a
  // request the user has made perfectly clearly.
  const result = parseCorrection("the category is alert_code");
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.column, "alert_code");
  assert.equal(result.role, "category");
});

test("the vocabulary is the engine's own, so the backend cannot reject what the chat accepted", () => {
  // The single most important consistency property in this file. `applyFeedback`
  // refuses a role it does not know, and the chat runs in a browser where that
  // refusal comes back as an error the user cannot act on. If the two lists
  // drift, the conversation accepts something the engine will not store.
  for (const role of ROLE_VOCABULARY) {
    assert.match(role, /^[a-z_]+$/, "roles are machine keys, not prose");
  }
  for (const expected of ["category", "time", "source", "duration", "threshold", "alias", "status", "message"]) {
    assert.ok(ROLE_VOCABULARY.includes(expected), `${expected} must be offered, or the chat cannot express it`);
  }
});

test("a column name with spaces, punctuation or unicode survives intact", () => {
  // The column is written into the archive and used to key a real CSV header.
  // Truncating it at the first space would store a correction against a column
  // that does not exist, and the report would say "column not in this file".
  for (const column of ["Alert Code", "total (USD)", "col_15", "délai_ms", "a.b.c"]) {
    const result = parseCorrection(`${column} is the category`);
    assert.equal(result.ok, true, `"${column}" must be understood`);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.column, column, `the column must survive verbatim, got "${result.column}"`);
  }
});

test("prose that is not a correction is refused without inventing one", () => {
  // The dangerous failure is a parser that finds a word somewhere in a sentence
  // and reports a correction the user never made. Applying a wrong role is worse
  // than doing nothing, so nothing here may produce a column.
  for (const text of [
    "what does this file contain?",
    "thanks, that looks right",
    "the report is wrong",
    "",
    "   ",
    "is the category",
    "col_15 is",
  ]) {
    const result = parseCorrection(text);
    assert.equal(result.ok, false, `"${text}" must not produce a correction`);
  }
});

test("a rejected correction never carries a column, so nothing can be applied by accident", () => {
  // Belt and braces on the rule above: even a bug in the matching must not yield
  // a half-built correction that the caller treats as actionable.
  for (const text of ["what is col_15 though?", "tell me about amount", "????"]) {
    const result = parseCorrection(text);
    if (result.ok) continue;
    assert.equal("column" in result, false, `a rejection must not carry a column: ${text}`);
    assert.equal("role" in result, false, `a rejection must not carry a role: ${text}`);
  }
});

test("the reason names the word it did not understand, so the user knows what to change", () => {
  const result = parseCorrection("col_15 is actually the amount");
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.match(result.reason, /amount/, `the refusal must quote the word it rejected: ${result.reason}`);
});

test("the function serialises into a browser, which is the constraint that shapes it", () => {
  // Asserted rather than assumed. If a future edit adds a module-scope helper,
  // the browser gets a ReferenceError at parse time and the chat dies silently
  // -- which is exactly what happened to the FIRST version of the dashboard,
  // where a security header quietly blocked its own feature.
  const source = parseCorrection.toString();
  assert.ok(!/\brequire\s*\(/.test(source), "no module loading; the page has no bundler");
  assert.ok(!/\bimport\b/.test(source), "no imports; the function is serialised, not bundled");
  assert.ok(!/getVocabulary|ROLE_VOCABULARY/.test(source),
    "and no reference to module scope -- every constant must be inside the body");
  // And it must actually run when evaluated on its own, which is the browser's
  // exact situation: the source, with nothing else in scope.
  const standalone = new Function(`return (${source})`)() as (t: string) => ReturnType<typeof parseCorrection>;
  const result = standalone("alert_code is the category");
  assert.equal(result.ok, true, "it must work with no surrounding module at all");
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.role, "category");
});
