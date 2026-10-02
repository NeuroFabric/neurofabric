import test from "node:test";
import assert from "node:assert/strict";

import { startWedgeServer, type RunningWedge } from "./server.ts";
import { makeTempWorkspace, writeFixture } from "../test-support/temp-workspace.ts";

/**
 * THE TOP-CATEGORIES QUESTION, AT EVERY SIZE.
 *
 * This was reported as a V1 limitation and carried into V2 as a "fatal UX
 * flaw for enterprise files": the categories question declined on files of 200
 * rows or more, while working below that. A user who demos with the small
 * sample and is then handed the real export gets a different product.
 *
 * === WHAT WAS ACTUALLY WRONG, AND IT WAS NOT A ROW COUNT ===
 *
 * The last session hunted for a classification-sample boundary at 200 rows and
 * did not find one, because there is not one. Sweeping the real path --
 * `resolveSchemaMemory` into `analyseBottlenecks` -- resolves the category at
 * 50, 200, 250 and 400 rows without trouble.
 *
 * The cause was upstream of all of that. `readCsvFor` already returns rows as
 * `{header: value}` records, and the chat handler converted them a SECOND time
 * as if they were cell arrays, so every row became a copy of the first row's
 * values. The whole file collapsed to a single distinct value per column, the
 * category-role check demoted it as degenerate, and the question declined.
 *
 * That is why the symptom looked size-dependent and was not: whether it fired
 * depended on whether a given row count happened to trip some other threshold
 * on the way past, so it read as a boundary at 200 when it was a corruption
 * with no boundary at all. The fix is in 2d8d86b.
 *
 * This file is the regression net for that, at the sizes where it appeared and
 * far past them, because the point of the assertion is that there is NO
 * boundary rather than that a particular one was moved.
 */

const openServers = new Set<{ close: () => Promise<void> }>();
function trackClose(close: () => Promise<void>): { close: () => Promise<void> } {
  const handle = { close: async () => { openServers.delete(handle); await close(); } };
  openServers.add(handle);
  return handle;
}
test.after(async () => { await Promise.allSettled([...openServers].map((s) => s.close())); });

/** A file whose category column is `channel` -- not in the hardcoded name list. */
function salesCsv(rows: number): string {
  const lines = ["_time,channel,amount_usd,latency_ms"];
  for (let i = 0; i < rows; i++) {
    const h = i % 24;
    const m = Math.floor(i / 24) % 60;
    lines.push(`2026-09-01T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z,` +
      `${i % 2 === 0 ? "web" : "ios"},${100 + (i % 50)},${20 + (i % 30)}`);
  }
  return lines.join("\n");
}

async function ask(rows: number, message: string): Promise<{ text: string; server: RunningWedge }> {
  const cwd = await makeTempWorkspace("nf-v2-cat-");
  await writeFixture(cwd, "sales.csv", salesCsv(rows));
  const started = await startWedgeServer({ cwd, port: 0 });
  const server: RunningWedge = { ...started, ...trackClose(started.close) };
  const body = (await (await fetch(`${server.url}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "sales.csv", message }),
  })).json()) as { reply?: { text: string } };
  return { text: body.reply?.text ?? "", server };
}

for (const rows of [120, 200, 250, 400, 2_000]) {
  test(`the top categories are answered on a ${rows}-row file`, async () => {
    const { text, server } = await ask(rows, "what are the top categories");
    assert.doesNotMatch(text, /could not find a categorical column/i,
      `size must not change the answer: ${text}`);
    assert.match(text, /web|ios/, `the real buckets must be ranked: ${text}`);
    // Half the rows, exactly. A count that collapses or doubles is the
    // corruption this whole file is about, so it is asserted rather than
    // inferred.
    assert.match(text, new RegExp(`with ${String(rows / 2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} rows`),
      `the largest bucket must hold half the file, which is the arithmetic's check: ${text}`);
    await server.close();
  });
}

test("a stated mapping still works at size", async () => {
  const cwd = await makeTempWorkspace("nf-v2-cat-");
  await writeFixture(cwd, "sales.csv", salesCsv(250));
  const started = await startWedgeServer({ cwd, port: 0 });
  const server: RunningWedge = { ...started, ...trackClose(started.close) };
  await fetch(`${server.url}/api/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "sales.csv", column: "channel", role: "category" }),
  });
  const body = (await (await fetch(`${server.url}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "sales.csv", message: "what are the top categories" }),
  })).json()) as { reply?: { text: string } };
  assert.doesNotMatch(body.reply!.text, /could not find a categorical column/i);
  await server.close();
});
