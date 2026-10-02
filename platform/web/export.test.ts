import test from "node:test";
import assert from "node:assert/strict";

import { startWedgeServer, type RunningWedge } from "./server.ts";
import { makeTempWorkspace, writeFixture } from "../test-support/temp-workspace.ts";

/**
 * ENTERPRISE EXPORT. One self-contained file somebody can send to a colleague.
 *
 * === WHY THIS IS A POST, DESPITE THE DIRECTIVE SUGGESTING A GET ===
 *
 * The directive sketched `GET /api/export?path=...`. That cannot work, and the
 * reason is worth stating rather than quietly deviating: the CONVERSATION lives
 * in the browser's React state. A GET can carry a path; it cannot carry the
 * transcript the user is looking at, and an export that silently omitted the
 * conversation would be the one thing this feature exists to include.
 *
 * So the export is a POST carrying `{path, thread}`, and the server renders it.
 * The alternative -- the browser assembling the file from its own state -- was
 * rejected for a second reason: it would mean a SECOND implementation of "what
 * an export is", living in the page, which is how this product ended up with a
 * chart that 404ed and a chat that was dead markup.
 *
 * === THE PROPERTY THAT MAKES IT SAFE TO SEND SOMEWHERE ===
 *
 * The exported artifact is built through the STANDALONE path -- no `live` option
 * -- which means it carries `connect-src 'none'` and NO COMPOSER. That is the
 * point. An export is a document: it is opened by people with no server, and a
 * copy of our chat widget inside it would be a visible control wired to an
 * endpoint that cannot exist. This is the same gate built for the standalone
 * dashboard, and this test is what proves the export actually goes through it
 * rather than around it.
 */

const CSV = `_time,query_snippet,total_elapsed_time_ms,logical_reads
2026-09-30 09:00:00.000,SELECT 1,120,8801
2026-09-30 10:00:00.000,UPDATE t,430,120
2026-09-30 11:00:00.000,SELECT COUNT,9800,91000`;

const THREAD = [
  {
    role: "agent",
    text: "I read 3 rows (query_perf.csv). This file appears to be a database performance log tracking query execution times.",
    widgets: [],
    suggestions: ["show me the worst hour"],
  },
  { role: "user", text: "show me the worst hour", widgets: [], suggestions: [] },
  {
    role: "agent",
    text: "The busiest hour is 2026-09-30 11:00, with 3 rows.",
    widgets: [{ kind: "chart-line", title: "Rows by hour", payload: { points: [] } }],
    suggestions: [],
  },
];

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
  const cwd = await makeTempWorkspace("nf-export-");
  await writeFixture(cwd, "query_perf.csv", CSV);
  const started = await startWedgeServer({ cwd, port: 0 });
  const server: RunningWedge = { ...started, ...trackClose(started.close) };
  const post = async (body: unknown) => {
    const response = await fetch(`${server.url}/api/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { response, text: await response.text() };
  };
  return { cwd, server, post };
}

test("the export is a complete, self-contained HTML document", async () => {
  const { server, post } = await harness();
  const { response, text } = await post({ path: "query_perf.csv", thread: THREAD });

  assert.equal(response.status, 200, `expected an artifact: ${text.slice(0, 200)}`);
  assert.match(text, /^<!doctype html>/i, "a complete document, not a fragment");
  assert.match(text, /<\/html>\s*$/, "and it is closed");
  assert.ok(text.length > 2000, `and it carries something: ${text.length} bytes`);
  await server.close();
});

test("it is served as a DOWNLOAD, not rendered in place", async () => {
  const { server, post } = await harness();
  const { response } = await post({ path: "query_perf.csv", thread: THREAD });
  const disposition = response.headers.get("content-disposition");
  assert.ok(disposition !== null, "a shareable artifact must download");
  assert.match(disposition!, /attachment/, "as an attachment");
  assert.match(disposition!, /filename="?[^"]*\.html"?/i, "with a .html filename");
  await server.close();
});

test("IT CONTAINS THE CONVERSATION, which is the thing being shared", async () => {
  const { server, post } = await harness();
  const { text } = await post({ path: "query_perf.csv", thread: THREAD });

  assert.match(text, /database performance log/i, "the semantic purpose statement");
  assert.match(text, /show me the worst hour/, "a turn the user typed");
  assert.match(text, /The busiest hour is/, "and the answer the agent gave");
  await server.close();
});

test("IT CONTAINS THE DATA PAYLOAD, so the recipient gets the numbers too", async () => {
  const { server, post } = await harness();
  const { text } = await post({ path: "query_perf.csv", thread: THREAD });

  const open = text.indexOf('type="application/json"');
  assert.ok(open > 0, "the analysis must travel with the document");
  const from = text.indexOf(">", open) + 1;
  const payload = JSON.parse(text.slice(from, text.indexOf("</script>", from))) as Record<string, unknown>;

  assert.ok(Array.isArray(payload.timeline), "the hourly series travels");
  assert.ok(payload.timeline!.length > 0, "and it is populated");
  assert.equal(payload.source, "query_perf.csv", "naming the file it came from");
  assert.ok(payload.purpose !== undefined, "with the semantic purpose");
  await server.close();
});

test("IT DOES NOT CONTAIN THE LIVE COMPOSER, or the export would phone home", async () => {
  // THE LOAD-BEARING ASSERTION, and the reason this endpoint goes through the
  // STANDALONE generator rather than the live one.
  //
  // An export is a document. It gets emailed, and opened by people with no
  // server. A copy of the chat widget inside it is a visible control wired to
  // endpoints that do not exist -- it fails silently, reads as a broken product,
  // and its policy still says connect-src 'none', so every question typed into it
  // is refused by the document's own rules.
  const { server, post } = await harness();
  const { text } = await post({ path: "query_perf.csv", thread: THREAD });

  assert.ok(!text.includes("/api/feedback"), "no correction endpoint");
  assert.ok(!text.includes("/api/chat"), "no chat endpoint");
  assert.ok(!/Ask about this file, or say/.test(text), "and no composer inviting a question");
  assert.match(text, /connect-src 'none'/, "the artifact carries the offline policy");
  await server.close();
});

test("the payload is INERT, so a hostile column name cannot become script", async () => {
  const { cwd, server, post } = await harness();
  // A column called </script> is not a hypothetical: this product ingests
  // whatever it is handed.
  await writeFixture(cwd, "hostile.csv", `_time,evil
2026-09-30 09:00:00.000,</script><script>alert(1)</script>`);
  const { text } = await post({ path: "hostile.csv", thread: THREAD });

  const open = text.indexOf('type="application/json"');
  const from = text.indexOf(">", open) + 1;
  const block = text.slice(from, text.indexOf("</script>", from));
  assert.ok(!block.includes("<"), "no raw '<' may survive inside the data block");
  await server.close();
});

test("a path outside the workspace is refused by the KERNEL, with its tier", async () => {
  // An export endpoint that reads an arbitrary path is an exfiltration endpoint
  // with a download header on it. It must go through the same boundary as every
  // other route, and be indistinguishable from them.
  const { server, post } = await harness();
  for (const bad of ["../../secrets.csv", "/etc/passwd"]) {
    const { response, text } = await post({ path: bad, thread: THREAD });
    assert.equal(response.status, 403, `must refuse ${bad}`);
    assert.match(text, /PATH_OUTSIDE_WORKSPACE|policy/i, "with the kernel's own code");
  }
  await server.close();
});

test("a request with no transcript still exports, rather than erroring", async () => {
  // Somebody may export the analysis before asking anything. An empty transcript
  // is a thin export, not a failure.
  const { server, post } = await harness();
  const { response, text } = await post({ path: "query_perf.csv" });
  assert.equal(response.status, 200);
  assert.match(text, /^<!doctype html>/i);
  await server.close();
});

test("a missing file is refused, not exported as an empty document", async () => {
  // An empty document reads to the recipient as "your file was clean", which is
  // the precise outcome this product exists not to produce.
  const { server, post } = await harness();
  const { response } = await post({ path: "absent.csv", thread: THREAD });
  assert.notEqual(response.status, 200, "a missing file must not export as success");
  await server.close();
});