import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { loadSchemaMemory, recallMapping, rememberMapping, type SchemaMemory } from "./schema-memory.ts";
import { makeTempWorkspace, pathExists } from "../test-support/temp-workspace.ts";

/**
 * SCHEMA MEMORY — so a schema that was worked out once is not worked out again.
 *
 * A memory keyed on the exact column set would miss the moment an export gains a
 * column, which is exactly when the Conductor most needs to recognise the file
 * as the one it already understands. So an entry matches when every column of
 * its signature is PRESENT, not when the sets are equal.
 *
 * Two properties this file exists to hold:
 *
 *   1. A remembered mapping is a CANDIDATE, never an authority. It is consulted
 *      before profiling, but it cannot silently override what the file actually
 *      contains -- if the remembered category column is absent, the memory is
 *      stale and says so rather than producing an empty ranking.
 *   2. Owner RULINGS are memory too. R10 and R11 were established by a person,
 *      not inferred from a column name, and re-deriving them from a header on
 *      every run would quietly discard the ruling the first time it was needed.
 */

const PEGA_HEADERS = [
  "_time", "source_host", "nodeId", "userid", "thread_name", "logger_name",
  "alertType", "alert_code", "elapsed_time", "threshold", "pega_time", "service_uri",
];

function memoryWithPega(): SchemaMemory {
  return {
    version: 1,
    rulings: { durationUnit: "ms", timeZone: "UTC" },
    entries: [{
      signature: PEGA_HEADERS,
      marker: ["alertType", "pega_time", "alert_code"],
      roles: { category: "alert_code", duration: "elapsed_time", time: "_time" },
      learnedFrom: "data/splunk_pega_alerts.csv",
      confirmedByOwner: false,
    }],
  };
}

test("M1 a remembered schema is recalled from its marker columns", () => {
  const found = recallMapping(memoryWithPega(), PEGA_HEADERS);
  assert.ok(found, "the remembered schema must be found");
  assert.equal(found.roles.category, "alert_code");
  assert.equal(found.roles.duration, "elapsed_time");
});

test("M2 a schema with EXTRA columns is still recognised", () => {
  // The common real case: one new field appears and the tool must not forget
  // everything it knew.
  const found = recallMapping(memoryWithPega(), [...PEGA_HEADERS, "new_field"]);
  assert.ok(found, "an added column must not invalidate a remembered schema");
});

test("M3 an unrelated schema is NOT recalled", () => {
  const found = recallMapping(memoryWithPega(), ["date", "amount", "merchant", "note"]);
  assert.equal(found, null, "a different file must not inherit another file's mapping");
});

test("M4 a STALE memory is rejected, not obeyed", () => {
  // The remembered category column is gone. Obeying the memory would rank by a
  // column that does not exist and print an empty table that looks like a result.
  const memory = memoryWithPega();
  const found = recallMapping(memory, PEGA_HEADERS.filter((h) => h !== "alert_code"));
  assert.equal(found, null, "a memory naming an absent column is stale and must not be applied");
});

test("M5 owner rulings survive with the memory", () => {
  const memory = memoryWithPega();
  assert.equal(memory.rulings.durationUnit, "ms");
  assert.equal(memory.rulings.timeZone, "UTC");
});

test("M6 a missing memory file is an empty memory, not an error", async () => {
  const cwd = await makeTempWorkspace("nf-mem-");
  const file = path.join(cwd, ".session-archive", "schema-memory.json");
  const memory = await loadSchemaMemory(file);
  assert.equal(memory.entries.length, 0);
  assert.equal(recallMapping(memory, PEGA_HEADERS), null);
});

test("M7 a written mapping is recalled on the next run", async () => {
  const cwd = await makeTempWorkspace("nf-mem2-");
  const file = path.join(cwd, ".session-archive", "schema-memory.json");
  await rememberMapping(file, {
    signature: PEGA_HEADERS,
    marker: ["alertType", "alert_code"],
    roles: { category: "alert_code", duration: "elapsed_time", time: "_time" },
    learnedFrom: "data/example.csv",
  });
  assert.equal(await pathExists(file), true, "the memory file must be created, parents and all");
  const reloaded = await loadSchemaMemory(file);
  const found = recallMapping(reloaded, PEGA_HEADERS);
  assert.ok(found);
  assert.equal(found.roles.category, "alert_code");
});

test("M8 remembering the same schema twice does not duplicate it", async () => {
  const cwd = await makeTempWorkspace("nf-mem3-");
  const file = path.join(cwd, ".session-archive", "schema-memory.json");
  const entry = {
    signature: PEGA_HEADERS, marker: ["alert_code"],
    roles: { category: "alert_code" }, learnedFrom: "a.csv",
  };
  await rememberMapping(file, entry);
  await rememberMapping(file, entry);
  const memory = await loadSchemaMemory(file);
  assert.equal(memory.entries.length, 1, "a repeated schema must update, not accumulate");
});

test("M9 a CORRUPT memory file is reported, not silently ignored", async () => {
  const cwd = await makeTempWorkspace("nf-mem4-");
  const file = path.join(cwd, ".session-archive", "schema-memory.json");
  await rememberMapping(file, {
    signature: PEGA_HEADERS, marker: ["alert_code"], roles: { category: "alert_code" }, learnedFrom: "a.csv",
  });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, "{ this is not json", "utf8");
  const memory = await loadSchemaMemory(file);
  assert.equal(memory.corrupt, true, "silently treating unreadable memory as empty loses the rulings");
  assert.equal(memory.entries.length, 0);
});