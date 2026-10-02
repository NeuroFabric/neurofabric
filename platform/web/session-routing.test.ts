import test, { after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { startWedgeServer, type RunningWedge } from "./server.ts";
import { makeTempWorkspace, writeFixture, pathExists } from "../test-support/temp-workspace.ts";
import { appSourceOf } from "./react-app-harness.ts";
import { toReactDashboard } from "./react-report.ts";
import { buildAnalysis } from "./react-report.test-support.ts";
import { newSessionId } from "../conductor/session-store.ts";

/**
 * A CONVERSATION THAT SURVIVES F5.
 *
 * The transcript lives in React state, and React state does not survive a
 * reload. So until this wiring existed, a user asked a question, read a good
 * answer, walked into a meeting, came back -- and the exchange was gone. For a
 * product whose entire claim is a conversation, that was the most expensive bug
 * in it, and it was invisible to every test that held the page as a STRING.
 *
 * These tests assert the three halves that have to agree, because each one is
 * sufficient on its own to leave the user with nothing:
 *
 *   1. THE SERVER WRITES BOTH TURNS. A question restored without its answer is
 *      worse than nothing restored, because it reads as the engine forgetting
 *      its own reply.
 *   2. THE PAGE NAMES ITS SESSION. The id is minted when the page is served and
 *      kept by the browser; without it there is nothing to look up.
 *   3. THE PAGE ASKS. A restore that never fires, or a fetch the offline path
 *      still carries, is a feature that exists in a file rather than in a life.
 */

const CSV = `_time,source_host,alertType,alert_code,elapsed_time,threshold
2026-09-30 12:00:00.000,host-web,performance,PEGA0001,1200,1000
2026-09-30 12:01:00.000,host-bg,performance,PEGA0028,800,1000
2026-09-30 12:02:00.000,host-web,performance,PEGA0001,2500,1000`;

const openServers = new Set<{ close: () => Promise<void> }>();

/** A close that is safe to call twice, and forgotten once used. */
function trackClose(close: () => Promise<void>): { close: () => Promise<void> } {
  let closed = false;
  const handle = {
    close: async () => {
      if (closed) return;
      closed = true;
      openServers.delete(handle);
      await close();
    },
  };
  openServers.add(handle);
  return handle;
}

after(async () => {
  await Promise.allSettled([...openServers].map((server) => server.close()));
});

async function harness() {
  const cwd = await makeTempWorkspace("nf-session-");
  await writeFixture(cwd, "pega.csv", CSV);
  const started = await startWedgeServer({ cwd, port: 0 });
  const server: RunningWedge = { ...started, ...trackClose(started.close) };
  const ask = async (body: unknown) => {
    const response = await fetch(`${server.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const memory = async (id: string) => {
    const response = await fetch(`${server.url}/api/session?id=${encodeURIComponent(id)}`);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  /**
   * READ IT BACK, RETRYING BRIEFLY.
   *
   * The turns are written AFTER the response is flushed -- deliberately, because
   * bookkeeping must not delay an answer the user is waiting for. So a read that
   * races the write is a real ordering, not a flake to be papered over: the read
   * waits for the write instead, and the test still fails if it never happens.
   */
  const remembered = async (id: string, wanted: number) => {
    const deadline = Date.now() + 2000;
    for (;;) {
      const back = await memory(id);
      const session = back.body.session as { turns?: unknown[] } | null;
      if ((session?.turns?.length ?? 0) >= wanted) return back;
      if (Date.now() > deadline) return back;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return { cwd, server, ask, memory, remembered };
}

const analysis = await buildAnalysis();

// === 1. The server writes both turns =======================================

test("a question and its answer are BOTH written down, and read back in order", async () => {
  const { server, ask, remembered } = await harness();
  const sessionId = newSessionId();
  const asked = await ask({ path: "pega.csv", message: "what is wrong with this file?", sessionId });
  assert.equal(asked.status, 200, `body=${JSON.stringify(asked.body)}`);
  const reply = asked.body.reply as { text?: string } | undefined;
  assert.equal(typeof reply?.text, "string", "and the answer was actually produced");

  // The response is not evidence that anything was PERSISTED, so the only
  // evidence that counts is a second request that found it.
  const back = await remembered(sessionId, 2);
  assert.equal(back.status, 200);
  const session = back.body.session as { turns?: { role: string; text: string }[] } | null;
  assert.ok(session !== null, "the session must exist after one exchange");
  const turns = session!.turns ?? [];
  assert.deepEqual(turns.map((t) => t.role), ["user", "agent"],
    "BOTH turns, in order. A question without its answer is worse than no memory.");
  assert.equal(turns[0]!.text, "what is wrong with this file?");
  assert.equal(turns[1]!.text, reply!.text, "and the stored answer is the answer that was given");
  await server.close();
});

test("no file CONTENTS cross into the store, only the conversation", async () => {
  const { server, ask, remembered } = await harness();
  const sessionId = newSessionId();
  await ask({ path: "pega.csv", message: "how many rows are there?", sessionId });
  const back = await remembered(sessionId, 2);
  const raw = JSON.stringify(back.body);
  assert.ok(!raw.includes("PEGA0001"),
    "a session records that a file was discussed, never a copy of the file: a demo file left in a " +
    "session directory is a demo file the next person on the machine can read");
  await server.close();
});

test("a question sent WITHOUT a session is still answered", async () => {
  // A browser that has lost its id must not be met with a refusal. Losing
  // memory is the product degrading; refusing to answer is the product broken.
  const { server, ask } = await harness();
  const asked = await ask({ path: "pega.csv", message: "what is worst here?" });
  assert.equal(asked.status, 200);
  assert.match(String(asked.body.sessionId), /^[0-9a-f-]{8,64}$/,
    "and it is handed back an id it can use from here on");
  await server.close();
});

test("viewing a dashboard writes NOTHING: an empty file per page view is twenty files", async () => {
  const { cwd, server } = await harness();
  const response = await fetch(`${server.url}/api/dashboard?path=pega.csv`);
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(await pathExists(path.join(cwd, "workspace", "sessions")), false,
    "the id is minted when the page is served; only a question should create a session");
  await server.close();
});

// === 2. The page names its session =========================================

test("the served page carries the id of the conversation it belongs to", async () => {
  const { server } = await harness();
  const response = await fetch(`${server.url}/api/dashboard?path=pega.csv`);
  const html = await response.text();
  assert.match(html, /"sessionId":"[0-9a-f-]{8,64}"/,
    "the page must know which conversation is its own, or there is nothing to restore");
  await server.close();
});

test("reading a session that does not exist is an empty conversation, not a failure", async () => {
  const { server, memory } = await harness();
  const back = await memory(newSessionId());
  assert.equal(back.status, 200, "'you have no conversation here yet' is the normal first-load state");
  assert.equal(back.body.session, null);
  await server.close();
});

test("an id that could express a PATH is refused, not answered as empty", async () => {
  // Both would otherwise be a 200 with nothing in it, and a caller could not
  // tell "nothing is remembered" from "you asked for something you may not have".
  const { server, memory } = await harness();
  const back = await memory("../../.env");
  assert.equal(back.status, 400);
  assert.equal((back.body.failure as { code?: string } | undefined)?.code, "BAD_SESSION_ID");
  await server.close();
});

// === 3. The page asks ======================================================

test("the LIVE page restores its transcript, and the OFFLINE one cannot try", async () => {
  const live = appSourceOf(toReactDashboard(analysis, { live: { path: "operations.csv" } }));
  assert.match(live, /fetch\("\/api\/session\?id="/,
    "a live page must read the conversation back");
  assert.match(live, /function loadSession/,
    "and the helper is the same code the refresh path uses, not a second implementation");
  assert.match(live, /React\.useEffect\(function \(\) \{\s*if \(!SESSION_ID\) return;\s*loadSession\(setThread\);\s*\}, \[\]\);/,
    "the restore is an effect with NO dependencies: it is a restore, not a subscription, and a " +
    "restore that fires again would overwrite the turns the user is reading");

  const offline = appSourceOf(toReactDashboard(analysis, {}));
  assert.ok(!offline.includes("/api/session"),
    "an offline artifact must contain no endpoint it cannot reach");
  assert.ok(!offline.includes("function loadSession"),
    "and no machinery to call, so nothing can attempt it");
});

test("the question carries the session id, so the server can find the conversation again", async () => {
  const live = appSourceOf(toReactDashboard(analysis, { live: { path: "operations.csv" } }));
  assert.match(live, /JSON\.stringify\(\{ path: D\.source, message: said, sessionId: SESSION_ID \}\)/,
    "without the id in the body the server has nothing to write the exchange to");
  // The invariant that keeps this safe -- nothing but a mapping crosses the wire
  // -- now has a second request to protect.
  for (const [, body] of live.matchAll(/JSON\.stringify\(\{([^}]*)\}\)/g)) {
    assert.ok(!/rows|cells|values|timeline|ranking|columns/i.test(body!),
      `a request body carries file contents: {${body!}}`);
  }
});

test("the browser keeps the id across reloads, because the page's own id does not survive one", async () => {
  const live = appSourceOf(toReactDashboard(analysis, { live: { path: "operations.csv" } }));
  // Trusting the payload id alone gives a fresh conversation on EVERY reload,
  // which is a memory that resets every time it is used.
  assert.match(live, /window\.localStorage\.getItem\(SESSION_KEY\)/);
  assert.match(live, /window\.localStorage\.setItem\(SESSION_KEY, SESSION_ID\)/);
  // And every read is guarded, because localStorage THROWS rather than returning
  // null in private browsing and on a file:// document.
  assert.match(live, /try \{[\s\S]*?\} catch \(storageRefused\) \{/,
    "a storage API that refuses must not take the page down with it");
});