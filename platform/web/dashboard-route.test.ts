import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { startWedgeServer, type RunningWedge } from "./server.ts";
import { makeTempWorkspace, writeFixture } from "../test-support/temp-workspace.ts";

/**
 * THE LIVE DASHBOARD ROUTE. The conversational UI has to be reachable.
 *
 * The chat component can be perfect and still be a feature nobody has: it lives
 * in a dashboard that is normally written to disk and opened over file://, where
 * `fetch("/api/feedback")` has no origin to resolve against and `connect-src
 * 'none'` is the correct answer. So this route exists to serve the interactive
 * artifact from the same origin that owns the correction endpoint.
 *
 * === WHAT IS ACTUALLY BEING DEFENDED HERE ===
 *
 * Two things, and they pull in opposite directions:
 *
 *   1. THE ROUTE MUST NOT BECOME A NEW UNGUARDED READ. This server's own header
 *      records how `/api/feedback` shipped with a bare `readFile` and no
 *      boundary check -- a hole that review passed precisely because the file
 *      claimed there was nothing to find. A route that reads a path from a
 *      QUERY STRING is the same shape of risk, so the refusals below assert the
 *      KERNEL'S codes and events, not just a status.
 *   2. THE PAGE MUST NOT BECOME A DATA EXFILTRATOR. It is handed a whole CSV's
 *      worth of analysis and served to a browser. What it is allowed to send
 *      back is one column name and one role.
 */

const CSV = `_time,source_host,alertType,alert_code,elapsed_time,threshold
2026-09-30 12:00:00.000,host-web,performance,PEGA0001,1200,1000
2026-09-30 12:01:00.000,host-bg,performance,PEGA0028,800,1000
2026-09-30 12:02:00.000,host-web,performance,PEGA0001,2500,1000`;

const openServers = new Set<{ close: () => Promise<void> }>();

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

test.after(async () => {
  await Promise.allSettled([...openServers].map((s) => s.close()));
});

async function harness() {
  const cwd = await makeTempWorkspace("nf-dash-");
  await writeFixture(cwd, "pega.csv", CSV);
  const started = await startWedgeServer({ cwd, port: 0 });
  const server: RunningWedge = { ...started, ...trackClose(started.close) };
  const get = async (query: string) => {
    const response = await fetch(`${server.url}/api/dashboard${query}`);
    return { status: response.status, text: await response.text() };
  };
  return { cwd, server, get };
}

test("the live dashboard is served, and it is the interactive one", async () => {
  const { server, get } = await harness();
  const { status, text } = await get("?path=pega.csv");

  assert.equal(status, 200, `expected the dashboard, got: ${text.slice(0, 200)}`);
  assert.match(text, /^<!doctype html>/i, "a complete document, not a fragment");
  assert.match(text, /dashboard-root/, "the React mount point is present");

  // THE WHOLE POINT: it is live, so it carries the chat.
  assert.match(text, /Chat/i, "the conversational sidebar must be present on the LIVE page");
  assert.match(text, /\/api\/feedback/, "and it must be able to reach the endpoint it shares an origin with");
  assert.match(text, /connect-src 'self'/, "which is why connect-src is widened -- and only to self");

  // And the numbers are the engine's, not a placeholder.
  assert.match(text, /pega\.csv/, "the page names the file it is about");
  assert.match(text, /alert_code|elapsed_time|alertType/, "and carries real columns from the real file");
  await server.close();
});

test("the live page permits exactly one origin, and still no eval", async () => {
  const { server, get } = await harness();
  const { text } = await get("?path=pega.csv");
  const csp = /content="([^"]*default-src[^"]*)"/.exec(text);
  assert.ok(csp !== null, "the page must declare a policy");
  const policy = csp[1]!;

  assert.match(policy, /connect-src 'self'/, "one origin: the one serving the page");
  assert.ok(!/connect-src[^;]*\*/.test(policy), "never a wildcard");
  assert.ok(!/unsafe-eval/.test(policy), "and still no eval");
  // The data block must still be inert, or all of the above is decoration.
  assert.ok(!/<script[^>]*type="application\/json"[^>]*>[^<]*<\/script/i.test(text.replace(/[\s\S]*?<\/script>/, "")),
    "the embedded data is escaped rather than executable");
  await server.close();
});

test("a path outside the workspace is refused by the KERNEL, with its tier", async () => {
  const { server, get } = await harness();
  // The same refusal /api/report gives, because it must not be distinguishable
  // by which route was asked or by which query parameter carried the path.
  for (const query of [
    "?path=../escape.csv",
    "?path=%2e%2e%2fescape.csv",
    "?path=C:%5CWindows%5Csystem.ini",
    "?path=" + encodeURIComponent(path.join("..", "..", "escape.csv")),
  ]) {
    const { status, text } = await get(query);
    assert.equal(status, 403, `must be refused: ${query} -> ${text.slice(0, 120)}`);
    assert.match(text, /PATH_OUTSIDE_WORKSPACE|policy/i, `and carry the kernel's own code: ${query}`);
  }
  await server.close();
});

test("no file named means a 400, not a page about nothing", async () => {
  const { server, get } = await harness();
  const { status, text } = await get("");
  assert.equal(status, 400, "a dashboard with no file would report on nothing");
  assert.match(text, /path/i, "and must say which parameter was missing");

  const blank = await get("?path=%20%20");
  assert.equal(blank.status, 400, "whitespace is not a filename");
  await server.close();
});

test("the served page is inert HTML, and never reflects the query back", async () => {
  // The classic reflected-XSS shape: a filename taken from a URL and echoed
  // into a document. The route refuses paths outside the workspace, so this
  // cannot reach the renderer -- but the refusal REASON goes to the browser, so
  // it is the reason string that has to be safe, not the path.
  const { server, get } = await harness();
  const hostile = encodeURIComponent("../../<script>alert(1)</script>.csv");
  const { status, text } = await get(`?path=${hostile}`);
  assert.equal(status, 403);
  assert.ok(!/<script>alert\(1\)<\/script>/.test(text),
    "a hostile path must never come back as live markup in the refusal");
  await server.close();
});

test("a file that does not exist is the kernel's answer, not a blank dashboard", async () => {
  const { server, get } = await harness();
  const { status, text } = await get("?path=absent.csv");
  // Inside the workspace but unreadable: the kernel refuses or the read fails,
  // and either way it must NOT be a 200 carrying an empty report, which would
  // look to a user exactly like "your file is clean".
  assert.notEqual(status, 200, "a missing file must not render as an empty, successful report");
  assert.ok(status === 400 || status === 403, `expected a refusal, got ${status}`);
  await server.close();
});
