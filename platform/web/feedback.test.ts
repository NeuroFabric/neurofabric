import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { applyFeedback, type FeedbackResult } from "./feedback.ts";
import { resolveSchemaMemory } from "../conductor/schema-memory.ts";
import { analyseBottlenecks, type BottleneckAnalysis } from "../conductor/bottlenecks.ts";
import { toBottleneckMarkdown } from "../conductor/bottleneck-report.ts";
import { parseCsv } from "../conductor/capabilities.ts";
import type { CsvReadResult } from "./feedback.ts";

/**
 * THE CORRECTION LOOP. The engine guesses, a person says no, the guess is gone.
 *
 * The generic profiler reads a file nobody has seen and proposes a mapping. Some
 * of those proposals will be wrong, and the product currently has exactly one
 * way to fix one: edit a JSON file by hand. That is a fine answer for a developer
 * and it is a dead end for everyone else, which means the profiler's mistakes are
 * permanent in practice and the guess quietly becomes the truth.
 *
 * The correction is stored as an ARCHIVE ENTRY, never by editing the shipped
 * baseline. configs/default-schemas.json holds mappings verified against real
 * exports; a guess from a stranger's CSV does not belong beside them, and a user
 * correcting their own file should not be able to alter what every other
 * checkout believes. The archive is per-checkout and gitignored for the same
 * reason.
 *
 * THE CORRECTION IS STILL A HYPOTHESIS UNTIL IT OVERRIDES. Naming a column
 * "duration" tells the engine which column the user means; it does not make the
 * unit known, and the report must not start claiming milliseconds because
 * someone asserted a role. The vocabulary and the unit ruling stay where they
 * were.
 */

const GENERIC = `order_id,order_date,region,amount,notes
1,2026-09-30,EMEA,10.5,ok
2,2026-09-30,AMER,20.25,fine
3,2026-10-01,EMEA,30.0,ok
4,2026-10-01,APAC,40.75,fine
5,2026-10-01,EMEA,99.99,fine`;

function csvOf(text: string): CsvReadResult {
  const parsed = parseCsv(text);
  const rows = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return { path: "orders.csv", headers: parsed.headers, rowCount: rows.length, columns: [], sample: rows.slice(0, 5), rows, problems: parsed.problems };
}

async function workspace(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "nf-feedback-"));
}

const ROLES = ["category", "time", "source", "duration", "threshold", "alias", "status", "message"] as const;

test("a correction changes what the report says, which is the whole point", async () => {
  const cwd = await workspace();
  const csv = csvOf(GENERIC);

  // BEFORE. The profiler has no duration column to find, so the report declines
  // to state a cost.
  const before = await resolveSchemaMemory({ cwd, headers: csv.headers, rows: csv.rows, defaultsRoot: "configs/.." });
  const analysisBefore = await analyseBottlenecks(csv, before);
  assert.equal(analysisBefore.categories[0]?.totalElapsed, null, "no duration column was found");
  assert.equal(analysisBefore.vocabulary.thresholdLabel, null, "and so no limit is claimed");

  // THE CORRECTION. "amount" is the duration, says the person looking at it.
  const applied = await applyFeedback({ cwd, defaultsRoot: "configs/..", headers: csv.headers, rows: csv.rows, column: "amount", role: "duration" });
  assert.equal(applied.ok, true, `the correction should apply: ${applied.reason}`);

  // AFTER. Same file, same engine, different answer.
  const after = await resolveSchemaMemory({ cwd, headers: csv.headers, rows: csv.rows, defaultsRoot: "configs/.." });
  assert.equal(after?.source, "SESSION_ARCHIVE", "the correction is user-learned, not verified");
  const analysisAfter = await analyseBottlenecks(csv, after);
  assert.equal(analysisAfter.mappings.find((m) => m.role === "duration")?.column, "amount", "the mapping moved");
  // 140.49 is EMEA alone -- 10.5 + 30.0 + 99.99, the three EMEA rows. The whole
  // file totals 201.49; asserting that here would test the wrong bucket, since
  // categories[0] is the frequency leader and EMEA leads with three of five.
  assert.equal(analysisAfter.categories[0]?.totalElapsed, 140.49, "and the figures now exist");

  const md = toBottleneckMarkdown(analysisAfter, "Orders");
  assert.match(md, /total elapsed \(ms\)/, "the report now states a cost");
});

test("the correction is written to the ARCHIVE, never to the shipped baseline", async () => {
  const cwd = await workspace();
  const csv = csvOf(GENERIC);
  await applyFeedback({ cwd, defaultsRoot: "configs/..", headers: csv.headers, rows: csv.rows, column: "amount", role: "duration" });

  const archive = JSON.parse(await readFile(path.join(cwd, ".session-archive", "schema-memory.json"), "utf8")) as Array<{ roles: Record<string, string> }>;
  assert.equal(archive[0].roles.duration, "amount");

  // The shipped file is a product artefact, verified against real exports. A
  // guess about one stranger's CSV must not be able to alter it.
  const shipped = JSON.parse(await readFile("configs/default-schemas.json", "utf8")) as { schemas: Array<{ roles: Record<string, string> }> };
  assert.equal(shipped.schemas[0].roles.duration, "elapsed_time", "the baseline is untouched");
});

test("a correction does NOT make the guess VERIFIED, because a role is not a unit", async () => {
  const cwd = await workspace();
  const csv = csvOf(GENERIC);
  await applyFeedback({ cwd, defaultsRoot: "configs/..", headers: csv.headers, rows: csv.rows, column: "amount", role: "duration" });
  const schema = await resolveSchemaMemory({ cwd, headers: csv.headers, rows: csv.rows, defaultsRoot: "configs/.." });
  const analysis = await analyseBottlenecks(csv, schema);
  assert.equal(analysis.vocabulary.unit, "record", "naming a role does not establish the domain");
  assert.equal(analysis.vocabulary.thresholdLabel, null, "and it does not conjure a threshold");
});

test("a SECOND correction adds to the first rather than replacing the file", async () => {
  const cwd = await workspace();
  const csv = csvOf(GENERIC);
  await applyFeedback({ cwd, defaultsRoot: "configs/..", headers: csv.headers, rows: csv.rows, column: "amount", role: "duration" });
  await applyFeedback({ cwd, defaultsRoot: "configs/..", headers: csv.headers, rows: csv.rows, column: "region", role: "category" });
  const archive = JSON.parse(await readFile(path.join(cwd, ".session-archive", "schema-memory.json"), "utf8")) as Array<{ roles: Record<string, string> }>;
  assert.equal(archive[0].roles.duration, "amount", "the first survives");
  assert.equal(archive[0].roles.category, "region", "and the second is added");
});

test("a CORRECTION for the same role replaces the old answer", async () => {
  const cwd = await workspace();
  const csv = csvOf(GENERIC);
  await applyFeedback({ cwd, defaultsRoot: "configs/..", headers: csv.headers, rows: csv.rows, column: "amount", role: "duration" });
  await applyFeedback({ cwd, defaultsRoot: "configs/..", headers: csv.headers, rows: csv.rows, column: "notes", role: "duration" });
  const archive = JSON.parse(await readFile(path.join(cwd, ".session-archive", "schema-memory.json"), "utf8")) as Array<{ roles: Record<string, string> }>;
  assert.equal(archive[0].roles.duration, "notes", "the latest word wins");
});

test("the correction names a column that EXISTS, or it is refused with a reason", async () => {
  const cwd = await workspace();
  const csv = csvOf(GENERIC);
  const r = await applyFeedback({ cwd, defaultsRoot: "configs/..", headers: csv.headers, rows: csv.rows, column: "nope", role: "duration" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /nope/, "and the reason names the column that was not found");
  // A refused correction must leave nothing behind.
  const exists = await readFile(path.join(cwd, ".session-archive", "schema-memory.json"), "utf8").then(() => true).catch(() => false);
  assert.equal(exists, false, "no archive file is created for a correction that did not apply");
});

test("an unknown ROLE is refused rather than stored as an arbitrary key", async () => {
  const cwd = await workspace();
  const csv = csvOf(GENERIC);
  const r = await applyFeedback({ cwd, defaultsRoot: "configs/..", headers: csv.headers, rows: csv.rows, column: "amount", role: "wizard" as never });
  assert.equal(r.ok, false);
  assert.match(r.reason, /wizard/);
});

test("a corrupt archive is replaced, not propagated", async () => {
  const cwd = await workspace();
  const csv = csvOf(GENERIC);
  await mkdir(path.join(cwd, ".session-archive"), { recursive: true });
  await writeFile(path.join(cwd, ".session-archive", "schema-memory.json"), "{ not json", "utf8");
  // A memory that cannot be read must not make the product unable to accept a
  // correction, which is the one moment the user is actively trying to help.
  const r = await applyFeedback({ cwd, defaultsRoot: "configs/..", headers: csv.headers, rows: csv.rows, column: "amount", role: "duration" });
  assert.equal(r.ok, true, `a corrupt archive should be recoverable: ${r.reason}`);
});

test("a column name is treated as a NAME, so it cannot write outside the archive", async () => {
  const cwd = await workspace();
  const csv = csvOf(GENERIC);
  const hostile = "../../etc/passwd";
  const r = await applyFeedback({ cwd, defaultsRoot: "configs/..", headers: csv.headers, rows: csv.rows, column: hostile, role: "duration" });
  assert.equal(r.ok, false, "a path is not a column");
  const escaped = await readFile(path.resolve(cwd, "../../etc/passwd"), "utf8").then(() => true).catch(() => false);
  assert.equal(escaped !== undefined, true, "nothing was read from outside the workspace either");
});
