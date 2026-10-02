import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

import {
  newSessionId, openSession, appendTurn, readSession, assertSessionId, SessionRefusal,
} from "./session-store.ts";

/**
 * CHAT THAT SURVIVES A RELOAD, WITHOUT BECOMING A DATA LEAK.
 *
 * A conversation is the most durable thing a user makes with this product. They
 * ask a question, get an answer, go to a meeting, come back -- and today all of
 * it is gone the moment they touch F5, because the transcript lives in React
 * state and React state does not survive a reload.
 *
 * === WHAT IS AND IS NOT STORED, AND THAT IS THE DESIGN ===
 *
 * Turns store TEXT and the widget payloads the page already holds. They do NOT
 * store file contents: a session records that the user was discussing
 * "e-commerce-transactions.csv", never a copy of the file. That distinction is
 * the difference between a chat log and a copy of somebody's data, and a demo
 * file left behind in a session directory is a demo file the next person can read.
 *
 * === THE ID IS A PATH SEGMENT, SO IT IS VALIDATED LIKE ONE ===
 *
 * A session id reaches the filesystem. `"../../.env"` as an id would read or
 * write outside the store, and the caller is a browser. So the id is constrained
 * to a charset that cannot express a path at all -- not sanitised, CONSTRAINED,
 * because a sanitiser has to predict what an attacker meant and a charset cannot
 * be argued with.
 *
 * Same reason the directory is resolved through the workspace boundary. The store
 * is inside the workspace on purpose, so that it inherits the same containment
 * every other write in this product has.
 */

const ROOT = path.resolve(process.cwd(), ".scratch", "test-sessions-" + process.pid);

// --- identity ---------------------------------------------------------------

test("a new id is unique, and ids are valid", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newSessionId()));
  assert.equal(ids.size, 200, "200 generated ids must not collide");
  for (const id of ids) assert.doesNotThrow(() => assertSessionId(id), `generated id rejected: ${id}`);
});

test("an id that could express a PATH is refused outright", () => {
  // Not sanitised -- constrained. A sanitiser has to guess what was meant; a
  // charset cannot be argued with.
  for (const bad of [
    "../../../.env", "..", "a/b", "a\\b", "with space", "", "x".repeat(200),
    "semi;colon", "null\u0000byte", "dot.dot", "UPPER_ok-but_underscores.no",
  ]) {
    assert.throws(() => assertSessionId(bad), SessionRefusal, `must refuse ${JSON.stringify(bad)}`);
  }
});

test("an accepted id is exactly the shape we generate", () => {
  assert.doesNotThrow(() => assertSessionId(newSessionId()));
});

// --- the round trip ----------------------------------------------------------

test("a session created empty reads back as empty, not as missing", () => {
  const id = newSessionId();
  const s = openSession(ROOT, id);
  assert.equal(typeof s.then, "function", "openSession is async");
  return s.then((record) => {
    assert.equal(record.id, id);
    assert.deepEqual(record.turns, [], "a new session is empty, not broken");
    assert.ok(record.created.length > 0, "and it says when it was made");
  });
});

test("a turn written is a turn READ BACK, in order", async () => {
  const id = newSessionId();
  await openSession(ROOT, id);
  await appendTurn(ROOT, id, { role: "user", text: "what is wrong with this file?" });
  await appendTurn(ROOT, id, { role: "agent", text: "One severe finding in latency_ms." });
  await appendTurn(ROOT, id, { role: "user", text: "will it get worse?" });

  const back = await readSession(ROOT, id);
  assert.ok(back !== undefined, "the session must exist on disk");
  assert.equal(back!.turns.length, 3, "every turn survives");
  assert.deepEqual(back!.turns.map((t) => t.role), ["user", "agent", "user"],
    "and the ORDER survives, or the conversation reads as nonsense");
  assert.equal(back!.turns[1]!.text, "One severe finding in latency_ms.");
});

test("widgets survive, because a transcript of bare text is not the page", async () => {
  const id = newSessionId();
  await openSession(ROOT, id);
  await appendTurn(ROOT, id, {
    role: "agent",
    text: "Here is the ranking.",
    widgets: [{ kind: "chart-bar", title: "Record categories", payload: { points: [{ key: "web", count: 300 }] } }],
    suggestions: ["what happens next?"],
  });
  const back = await readSession(ROOT, id);
  assert.equal(back!.turns[0]!.widgets?.length, 1, "the chart comes back");
  assert.deepEqual(back!.turns[0]!.suggestions, ["what happens next?"], "and the chips");
});

test("an applied correction is remembered as a CORRECTION", async () => {
  // Different from a turn: it is state about the file that outlives the
  // conversation, and the next page load should not ask again.
  const id = newSessionId();
  await openSession(ROOT, id);
  await appendTurn(ROOT, id, { role: "user", text: "channel is the category" });
  const back = await appendTurn(ROOT, id, {
    role: "agent", text: "I will treat channel as the category.",
    correction: { column: "channel", role: "category" },
  });
  assert.deepEqual(back.corrections, [{ column: "channel", role: "category" }],
    "the correction is recorded separately from the transcript");
});

test("reopening an existing session appends rather than replacing", async () => {
  const id = newSessionId();
  await openSession(ROOT, id);
  await appendTurn(ROOT, id, { role: "user", text: "first" });
  await openSession(ROOT, id);
  await appendTurn(ROOT, id, { role: "user", text: "second" });
  const back = await readSession(ROOT, id);
  assert.deepEqual(back!.turns.map((t) => t.text), ["first", "second"],
    "opening a session must not clear it -- that is the bug this whole feature is fixing");
});

// --- limits, because a log nobody bounds is a disk-full incident ------------

test("a turn is capped, so one paste cannot exhaust the disk", async () => {
  const id = newSessionId();
  await openSession(ROOT, id);
  await appendTurn(ROOT, id, { role: "user", text: "x".repeat(50_000) });
  const back = await readSession(ROOT, id);
  assert.ok(back!.turns[0]!.text.length <= 4200,
    `a turn must be bounded, got ${back!.turns[0]!.text.length}`);
});

test("a session is capped in TURNS, not just in bytes", async () => {
  const id = newSessionId();
  await openSession(ROOT, id);
  for (let i = 0; i < 260; i++) {
    await appendTurn(ROOT, id, { role: "user", text: `turn ${i}` });
  }
  const back = await readSession(ROOT, id);
  assert.ok(back!.turns.length <= 200,
    `the transcript must be bounded; got ${back!.turns.length}. The OLDEST turns are dropped first, because a ` +
    "truncated recent conversation is useful and a truncated ancient one is not.");
});

test("reading a session that does not exist returns undefined, not a throw", async () => {
  assert.equal(await readSession(ROOT, newSessionId()), undefined);
});

test("a corrupt session file does not take the page down", async () => {
  const id = newSessionId();
  await openSession(ROOT, id);
  const file = path.join(ROOT, `${id}.json`);
  fs.writeFileSync(file, "{ this is not json", "utf8");
  // A memory subsystem that throws takes the product down with it, which is
  // worse than a user who loses one conversation.
  assert.equal(await readSession(ROOT, id), undefined, "degrades to 'no session'");
});