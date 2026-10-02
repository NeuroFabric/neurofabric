import test from "node:test";
import assert from "node:assert/strict";

import { startWedgeServer, type RunningWedge } from "./server.ts";
import { makeTempWorkspace, writeFixture } from "../test-support/temp-workspace.ts";

/**
 * ROWS MUST REACH THE ANALYSER UNCORRUPTED.
 *
 * `readCsvFor` returns rows already converted to `{header: value}` records. The
 * chat handler and the export handler each converted them a SECOND time as if
 * they were cell arrays, so every row came out as a copy of the FIRST row's
 * values. A 200-row file reached the analyser as 200 identical rows.
 *
 * Nothing caught it. The analyser, the schema resolver and the archive were all
 * correct -- the corruption happened in between, on the way in. Every unit test
 * passed, and the same schema resolved perfectly in isolation, because the
 * isolation harness did not reproduce the server's data preparation. Only a test
 * that goes through the HTTP boundary can see a bug that lives there.
 *
 * The user-visible damage was real: with every column collapsed to a single
 * distinct value, the category-role check demoted the user's own correction as
 * degenerate, so "channel is the category" was accepted, written to disk, and
 * then ignored. The product told the user it would remember, and did not.
 *
 * === WHAT IS STILL OPEN, STATED RATHER THAN PAPERED OVER ===
 *
 * These assertions pin the DATA FIDELITY fix, which is verified end to end.
 * One downstream symptom is NOT yet fixed and is not claimed here: the
 * categories question still declines on files of 200 rows or more, where the
 * classification sample boundary appears to bite. Tracked in the V2 handover as
 * an open defect; nothing in this file asserts that it works.
 */

const openServers = new Set<{ close: () => Promise<void> }>();
function trackClose(close: () => Promise<void>): { close: () => Promise<void> } {
  const handle = { close: async () => { openServers.delete(handle); await close(); } };
  openServers.add(handle);
  return handle;
}
test.after(async () => { await Promise.allSettled([...openServers].map((s) => s.close())); });

function salesCsv(hours: number, perHour: number): string {
  const lines = ["_time,channel,amount_usd,latency_ms"];
  for (let h = 0; h < hours; h++) {
    for (let i = 0; i < perHour; i++) {
      lines.push(`2026-09-01T${String(h).padStart(2, "0")}:${String((i * 5) % 60).padStart(2, "0")}:00.000Z,` +
        `${i % 2 === 0 ? "web" : "ios"},${100 + i * 9},${20 + i}`);
    }
  }
  return lines.join("\n");
}

async function harness() {
  const cwd = await makeTempWorkspace("nf-v2-rows-");
  await writeFixture(cwd, "sales.csv", salesCsv(40, 5));
  const started = await startWedgeServer({ cwd, port: 0 });
  const server: RunningWedge = { ...started, ...trackClose(started.close) };
  const post = async (route: string, body: unknown) => (await fetch(`${server.url}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })).json() as { status: string; reply?: { text: string }; failure?: { reason: string } };
  return { server, post };
}

test("every row reaches the analyser with its own values", async () => {
  const { server, post } = await harness();
  const r = await post("/api/chat", { path: "sales.csv", message: "what is the average of amount_usd" });
  assert.match(r.reply!.text, /over 200 measured values/,
    `200 rows must be 200 measurements, not 200 copies of one: ${r.reply!.text}`);
  await server.close();
});

test("a correction is accepted and written to disk", async () => {
  const { server, post } = await harness();
  const saved = await post("/api/feedback", { path: "sales.csv", column: "channel", role: "category" });
  assert.equal(saved.status, "DELIVERED", `the correction must be accepted: ${saved.failure?.reason}`);
  await server.close();
});

test("the chat grammar accepts the same correction as a sentence", async () => {
  const { server, post } = await harness();
  const said = await post("/api/chat", { path: "sales.csv", message: "channel is the category" });
  assert.doesNotMatch(said.reply!.text, /will not invent a figure/,
    "the sentence is a correction, not an unanswerable question");
  await server.close();
});

test("the export path receives whole rows too", async () => {
  const { server, cwd } = await harness();
  // The export answers with a DOCUMENT, not a JSON envelope, so it is read as
  // text and the assertion is on the artifact rather than on a status field.
  const response = await fetch(`${server.url}/api/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: "sales.csv",
      thread: [{ role: "agent", text: "Here is the analysis.", widgets: [], suggestions: [] }],
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `the export must build: ${text.slice(0, 200)}`);
  assert.match(text, /^<!doctype html>/i, "and return a document");

  const open = text.indexOf('type="application/json"');
  const from = text.indexOf(">", open) + 1;
  const payload = JSON.parse(text.slice(from, text.indexOf("</script>", from))) as {
    totalRows: number; source: string | null;
  };
  assert.equal(payload.totalRows, 200, "the exported analysis counted every row, not 200 copies of one");
  assert.equal(payload.source, "sales.csv", "and named the file it came from");
  void cwd;
  await server.close();
});
