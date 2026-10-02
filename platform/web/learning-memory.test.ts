import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { startWedgeServer, type RunningWedge } from "./server.ts";
import { makeTempWorkspace, writeFixture, pathExists } from "../test-support/temp-workspace.ts";

/**
 * TASK 2 — THE LEARNING MEMORY ENGINE. Red first.
 *
 * `/api/feedback` already existed and already wrote somewhere. Neither fact is
 * the requirement. The requirement is that a correction SURVIVES: that the next
 * file this checkout analyses is shaped by what the user just said, with no
 * re-upload, no re-instruction and no hand-edited JSON in between.
 *
 * A correction that is stored but not READ BACK is the failure this file exists
 * to catch, and it is a silent one -- every existing test still passes. The
 * endpoint returns 200, the archive on disk contains the mapping, the UI shows a
 * green tick, and the very next report quietly re-guesses the same thing. The
 * user is left believing they fixed it.
 *
 * So the assertions are deliberately two-handed. First the file is read from
 * disk, because "we wrote it" is not "it is there". Then a SECOND, DIFFERENT
 * file is analysed, because "it is there" is still not "it is used". Only the
 * second proves the engine learned.
 *
 * === WHY THE ARCHIVE, AND NOT configs/default-schemas.json ===
 *
 * The baseline holds mappings a person verified against real exports. A guess
 * about one stranger's CSV does not belong beside them, and a user correcting
 * their own file must not be able to alter what every other checkout believes.
 * That is a correctness argument, and it is also the reason the learned map is
 * reported separately: provenance is the only thing that distinguishes a
 * verified mapping from an assertion somebody made.
 */

const FIRST = `_time,source_host,alertType,alert_code,elapsed_time,threshold
2026-09-30 12:00:00.000,host-web,performance,PEGA0001,1200,1000
2026-09-30 12:01:00.000,host-bg,performance,PEGA0028,800,1000
2026-09-30 12:02:00.000,host-web,performance,PEGA0001,2500,1000`;

/**
 * A SECOND file, with headers that match no shipped schema.
 *
 * Two things are deliberate here, and both were got wrong first.
 *
 * It is NOT the same file. Re-analysing the corrected file would pass even if
 * the archive were ignored, because the correction is already visible in the
 * report the user is looking at. The learned rule has to travel to a file the
 * engine has never seen, or nothing has been learned -- it has merely been
 * noted.
 *
 * And it DOES contain the corrected column name. This was the first mistake:
 * the fixture originally named every column differently, on the assumption that
 * a learned rule is a global truth. It is not. The archive records
 * role -> column, and every application of it is checked against the file's own
 * header row -- a correction about `alertType` says nothing about a file that
 * has no `alertType`, and applying it anyway would invent a column that is not
 * there. The engine refused, correctly, and the first version of this test
 * "proved" a bug that was the product behaving properly.
 *
 * So the file is new, and differently shaped, but genuinely carries the column
 * the user corrected. That is the case the feature exists for.
 */
const SECOND = `when_it_happened,which_box,alertType,how_long
2026-10-01 09:00:00.000,box-a,login,420
2026-10-01 09:05:00.000,box-b,login,380
2026-10-01 09:10:00.000,box-a,logout,90`;

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

const ARCHIVE = path.join(".session-archive", "schema-memory.json");

async function harness() {
  const cwd = await makeTempWorkspace("nf-learn-");
  await writeFixture(cwd, "pega.csv", FIRST);
  const started = await startWedgeServer({ cwd, port: 0 });
  const server: RunningWedge = { ...started, ...trackClose(started.close) };

  const send = async (route: string, body: unknown) => {
    const response = await fetch(`${server.url}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  return {
    cwd,
    server,
    report: (p: string) => send("/api/report", { path: p }),
    feedback: (p: string, column: string, role: string) => send("/api/feedback", { path: p, column, role }),
    readArchive: async () => JSON.parse(await readFile(path.join(cwd, ARCHIVE), "utf8")) as { id?: string; roles?: Record<string, string> }[],
  };
}

test("a correction through the endpoint is written to the archive on disk", async () => {
  const { cwd, server, feedback, readArchive } = await harness();

  assert.equal(await pathExists(path.join(cwd, ARCHIVE)), false,
    "precondition: nothing has been learned yet, so a file appearing means this call wrote it");

  const { status, body } = await feedback("pega.csv", "alertType", "category");
  assert.equal(status, 200, `a correction naming a real column and a real role must apply: ${JSON.stringify(body).slice(0, 250)}`);

  const archive = await readArchive();
  assert.ok(Array.isArray(archive) && archive.length > 0, "the archive is written as entries");
  assert.equal(archive[0]?.roles?.category, "alertType",
    "and it records the mapping the user asserted, role -> column");
  await server.close();
});

test("THE NEXT FILE UPLOADED USES THE LEARNED RULE", async () => {
  // The assertion the whole feature rests on, and the one every weaker test
  // misses. Stored is not learned.
  const { cwd, server, report, feedback, readArchive } = await harness();

  const corrected = await feedback("pega.csv", "alertType", "category");
  assert.equal(corrected.status, 200, `precondition: the correction applies. ${JSON.stringify(corrected.body).slice(0, 250)}`);

  // A file the engine has never seen, with headers that match nothing.
  await writeFixture(cwd, "later.csv", SECOND);
  const { status, body } = await report("later.csv");
  assert.equal(status, 200, `precondition: the second file analyses. ${JSON.stringify(body).slice(0, 250)}`);

  const schema = body.schema as { source?: string; learnedRoles?: string[] } | undefined;
  assert.ok(schema !== undefined, "the response must carry the schema, or the UI can never show provenance");

  assert.equal(schema.source, "SESSION_ARCHIVE",
    "the engine must say the mapping came from what this checkout has been told");
  assert.ok((schema.learnedRoles ?? []).includes("category"),
    `and name category among the learned roles, got ${JSON.stringify(schema.learnedRoles)}`);

  // And the rule must still be on disk afterwards -- a report that consumed the
  // memory and deleted it would pass the assertion above exactly once.
  const archive = await readArchive();
  assert.equal(archive[0]?.roles?.category, "alertType", "learning is not consuming");
  await server.close();
});

test("a correction is REPORTED as learned, never as verified", async () => {
  // Naming a column "duration" says which column the user means. It does not
  // make the unit known, and a report that starts claiming milliseconds because
  // somebody asserted a role would be inventing the one fact nobody supplied.
  const { server, feedback } = await harness();
  const { body } = await feedback("pega.csv", "elapsed_time", "duration");
  const schema = body.schema as { source?: string } | undefined;
  assert.equal(schema?.source, "SESSION_ARCHIVE", "the provenance must stay visible to the user");
  await server.close();
});

test("a refused correction leaves NO trace in the archive", async () => {
  // A half-written archive is worse than none: the next reader cannot tell a
  // refused request from a saved one, and the engine cannot either.
  const { cwd, server, feedback } = await harness();

  const unknownColumn = await feedback("pega.csv", "no_such_column", "category");
  assert.equal(unknownColumn.status, 400, "a column that is not in the file cannot be corrected");
  assert.match(String((unknownColumn.body.failure as { reason?: string } | undefined)?.reason ?? ""),
    /not in this file/i, "and the reason says so");

  const unknownRole = await feedback("pega.csv", "alertType", "sparklines");
  assert.equal(unknownRole.status, 400, "a role the engine does not have is a typo, not a request");

  assert.equal(await pathExists(path.join(cwd, ARCHIVE)), false,
    "a refused correction must not create the archive at all");
  await server.close();
});

test("the shipped baseline is never written to", async () => {
  // configs/default-schemas.json holds mappings a person verified. A correction
  // about one stranger's file must not be able to alter what every other
  // checkout believes -- so this asserts the file is byte-identical afterwards.
  const { server, feedback } = await harness();
  const before = await readFile(path.resolve("configs/default-schemas.json"), "utf8");

  await feedback("pega.csv", "alertType", "category");
  await feedback("pega.csv", "source_host", "source");

  const afterBytes = await readFile(path.resolve("configs/default-schemas.json"), "utf8");
  assert.equal(afterBytes, before, "the shipped baseline must be untouched by a user's correction");
  await server.close();
});

test("a correction survives a restart of the server", async () => {
  // Memory that lives in a process is a cache, not memory. The archive is the
  // durable half, and this is the only test that can tell the two apart.
  const { cwd, server, report, feedback } = await harness();
  await feedback("pega.csv", "alertType", "category");
  await server.close();

  const restarted = await startWedgeServer({ cwd, port: 0 });
  const server2: RunningWedge = { ...restarted, ...trackClose(restarted.close) };
  try {
    await writeFixture(cwd, "later.csv", SECOND);
    const response = await fetch(`${server2.url}/api/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "later.csv" }),
    });
    const body = await response.json() as { schema?: { learnedRoles?: string[] } };
    assert.equal(response.status, 200);
    assert.ok((body.schema?.learnedRoles ?? []).includes("category"),
      "a fresh process must still know what the last one was told");
  } finally {
    await server2.close();
  }
});

test("a learned rule does NOT travel to a file that lacks the column", async () => {
  // Found while writing the test above, and worth pinning deliberately.
  //
  // The archive holds role -> column, and every use of it is checked against
  // the file's own header row. A file with no `alertType` therefore does not
  // get `category: alertType` applied to it, even though that mapping is
  // sitting in the archive and is perfectly valid for other files.
  //
  // This is the difference between a learned rule and a global truth. Applying
  // it anyway would put a column name into a report for a file that does not
  // contain it, and every downstream number keyed on that role would be
  // fabricated from a header the user can plainly see is absent.
  const { cwd, server, report, feedback } = await harness();
  await feedback("pega.csv", "alertType", "category");

  await writeFixture(cwd, "unrelated.csv", `some_name,other_name,third_thing
2026-10-01 09:00:00.000,a,1
2026-10-01 09:05:00.000,b,2`);

  const { status, body } = await report("unrelated.csv");
  assert.equal(status, 200, "the file itself is still perfectly reportable");
  const schema = body.schema as { roles?: Record<string, string> } | undefined;
  if (schema !== undefined) {
    assert.notEqual(schema.roles?.category, "alertType",
      "a correction must never be applied to a file that does not have the column");
  }
  // Either way, the report must not CLAIM the mapping was used.
  assert.ok(!(body.schema as { learnedRoles?: string[] } | undefined)?.learnedRoles?.includes("category"),
    "and it must not report the rule as learned for a file it could not apply it to");
  await server.close();
});

test("two corrections compose rather than overwrite", async () => {
  // The archive is rewritten wholesale, so a bug that drops the previous entry
  // is invisible until a user makes a second correction -- which is exactly
  // when they are trying to build up a mapping and find it resetting.
  const { server, feedback, readArchive } = await harness();
  await feedback("pega.csv", "alertType", "category");
  await feedback("pega.csv", "source_host", "source");
  await feedback("pega.csv", "elapsed_time", "duration");

  const roles = readArchive ? (await readArchive())[0]?.roles : undefined;
  assert.deepEqual(
    { ...roles },
    { category: "alertType", source: "source_host", duration: "elapsed_time" },
    "all three must survive the third write",
  );
  await server.close();
});
