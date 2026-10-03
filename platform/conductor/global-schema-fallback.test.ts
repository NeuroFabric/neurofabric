import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveSchemaMemory } from "./schema-memory.ts";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { parseCsv } from "./capabilities.ts";
import { makeTempWorkspace } from "../test-support/temp-workspace.ts";
import type { CsvReadResult } from "./capabilities.ts";

/**
 * A FRESH CLONE MUST WORK, AND THE OWNER'S CORRECTIONS MUST SURVIVE IT.
 *
 * A fresh git clone has no .session-archive at all. If the product only worked
 * for a checkout that happened to have been taught something, the demo would
 * fail on exactly the machine with the least history on it. The baseline is
 * configs/default-schemas.json, tracked in git, shipped with the product, and
 * established against real exports in Stage 2.
 *
 * THE ARCHIVE IS READ UNDER TWO NAMES, and that is a deliberate compatibility
 * decision rather than an oversight. The canonical name is now
 * schema-memory.json, which says what the file is instead of saying where it
 * lives. But earlier sessions wrote corrections to schemas.json, and a
 * hard rename would silently orphan a file a user may have spent an afternoon
 * building -- their corrections would be ignored with no warning, which is
 * precisely the failure this module's own documentation calls worse than
 * crashing. So the old name still works, the new one wins if both exist, and the
 * precedence is pinned so it cannot become accidental.
 *
 * Precedence is the part worth being pedantic about. Both stores are merged
 * ROLE BY ROLE, so a checkout that corrected one role keeps that correction and
 * still inherits the verified mapping for the other five. Picking one whole store
 * would mean either discarding the user's learning or discarding what we verified.
 */

function csvOf(text: string, file = "in.csv"): CsvReadResult {
  const parsed = parseCsv(text);
  const keyed = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return { path: file, headers: parsed.headers, rowCount: keyed.length, columns: [], sample: keyed.slice(0, 5), rows: keyed, problems: parsed.problems };
}

const PEGA = `_time,source_host,alertType,alert_code,logger_name,elapsed_time,threshold
2026-09-30 12:00:00.000,host-web,performance,PEGA0001,com.pega.HttpAPI,1200,1000
2026-09-30 12:01:00.000,host-bg,performance,PEGA0002,com.pega.Declarative,800,1000
2026-09-30 12:02:00.000,host-web,performance,PEGA0001,com.pega.HttpAPI,1300,1000
2026-09-30 12:03:00.000,host-api,performance,PEGA0011,com.pega.Queue,300,1000`;

/** The product's own configs, which is what a fresh clone has. */
const SHIPPED = "configs/..";

async function writeArchive(cwd: string, name: string, roles: Record<string, string>, id = "my-own-pega"): Promise<void> {
  await mkdir(path.join(cwd, ".session-archive"), { recursive: true });
  await writeFile(path.join(cwd, ".session-archive", name), JSON.stringify([{ id, roles }]), "utf8");
}

test("A FRESH CLONE, WITH NO .session-archive AT ALL, FALLS BACK TO THE SHIPPED SCHEMA", async () => {
  // The demo case. Not an empty archive -- no archive, no directory, nothing.
  const cwd = await makeTempWorkspace("nf-fresh-");
  const csv = csvOf(PEGA);
  const schema = await resolveSchemaMemory({ cwd, headers: csv.headers, rows: csv.rows, defaultsRoot: SHIPPED });

  assert.equal(schema?.source, "DEFAULT", "the shipped baseline answered");
  assert.equal(schema?.id, "pega-alert-export");
  assert.deepEqual(schema?.learnedRoles, [], "and nothing was learned locally, honestly reported");
  assert.deepEqual(schema?.unresolved, [], "no required role is left hanging");

  // The three mappings the demo depends on, by name.
  assert.equal(schema?.roles.category, "alert_code", "alert_code is the category");
  assert.equal(schema?.roles.duration, "elapsed_time", "elapsed_time is the duration");
  assert.equal(schema?.roles.alias, "logger_name", "logger_name is the alias");

  // And they must reach the ANALYSIS as established, not as guesses. A shipped
  // schema that is read but not applied is a config file that means nothing.
  const analysis = await analyseBottlenecks(csv, schema);
  for (const role of ["category", "duration", "alias", "time", "source", "threshold"]) {
    assert.equal(analysis.mappings.find((m) => m.role === role)?.hypothesis, false, `${role} must be established from the shipped schema`);
  }
  assert.equal(analysis.vocabulary.unit, "alert", "a verified mapping earns the domain vocabulary");
  assert.equal(analysis.categories[0]?.label.includes("("), true, "and R13 aliasing works on a fresh clone");
});

test("corrections saved as schema-memory.json override the baseline", async () => {
  // The canonical name for the archive.
  const cwd = await makeTempWorkspace("nf-mem-");
  await writeArchive(cwd, "schema-memory.json", { category: "alertType" });
  const csv = csvOf(PEGA);
  const schema = await resolveSchemaMemory({ cwd, headers: csv.headers, rows: csv.rows, defaultsRoot: SHIPPED });
  assert.equal(schema?.source, "SESSION_ARCHIVE", "the user store answered");
  assert.equal(schema?.roles.category, "alertType", "and the correction was applied");
  assert.deepEqual(schema?.learnedRoles, ["category"]);
});

test("a correction is merged ROLE BY ROLE, not by picking a whole store", async () => {
  // The behaviour that makes the archive worth having. A user who corrected ONE
  // role keeps that correction AND still inherits the verified mapping for the
  // other five; picking a store wholesale would mean either discarding their
  // learning or discarding everything we verified.
  const cwd = await makeTempWorkspace("nf-merge-");
  await writeArchive(cwd, "schema-memory.json", { category: "alertType" });
  const csv = csvOf(PEGA);
  const schema = await resolveSchemaMemory({ cwd, headers: csv.headers, rows: csv.rows, defaultsRoot: SHIPPED });
  assert.equal(schema?.roles.category, "alertType", "the learned role");
  assert.equal(schema?.roles.duration, "elapsed_time", "inherited from the shipped baseline");
  assert.equal(schema?.roles.alias, "logger_name", "inherited too");
});

test("the LEGACY archive name is GONE, deliberately", async () => {
  // A previous session kept reading .session-archive/schemas.json for
  // compatibility, on the argument that a hard rename orphans a file a user may
  // have built by hand. The interactive correction loop changes that calculus:
  // every write into the archive now goes through one endpoint and one filename,
  // so a second readable name can only produce a checkout with two memories and
  // no way to tell which one is being consulted.
  //
  // The old behaviour was kept for one release. This pins its removal rather
  // than merely allowing it, because the failure mode of re-adding it is silent
  // -- a stale file that quietly outranks or is quietly outranked, with nothing
  // in the report to say so.
  const cwd = await makeTempWorkspace("nf-legacy-gone-");
  await mkdir(path.join(cwd, ".session-archive"), { recursive: true });
  await writeFile(path.join(cwd, ".session-archive", "schemas.json"), JSON.stringify([
    { id: "old-pega", roles: { category: "alertType" } },
  ]), "utf8");
  const resolved = await resolveSchemaMemory({ cwd, headers: csvOf(PEGA).headers, defaultsRoot: `${cwd}/no-configs` });
  // Not a learned schema: the file is not read at all.
  assert.notEqual(resolved?.source, "SESSION_ARCHIVE", "the legacy file is no longer consulted");
});

test("an EMPTY archive falls through to the baseline rather than shadowing it", async () => {
  // An empty user store must not be able to blank out what we verified. This is
  // the difference between "the user has taught us nothing" and "there is no
  // memory", and only the second may fall back.
  const cwd = await makeTempWorkspace("nf-empty-");
  await mkdir(path.join(cwd, ".session-archive"), { recursive: true });
  await writeFile(path.join(cwd, ".session-archive", "schema-memory.json"), "[]", "utf8");
  const csv = csvOf(PEGA);
  const schema = await resolveSchemaMemory({ cwd, headers: csv.headers, rows: csv.rows, defaultsRoot: SHIPPED });
  assert.equal(schema?.source, "DEFAULT");
  assert.equal(schema?.roles.duration, "elapsed_time", "the baseline is intact");
});

test("the baseline is a REPOSITORY FILE, not a workspace file", async () => {
  // A fresh clone gets configs/default-schemas.json from git. If the resolver
  // looked for it beside the workspace instead, the demo would depend on where
  // the process happened to be started from.
  const cwd = await makeTempWorkspace("nf-loc-");
  const csv = csvOf(PEGA);
  const fromRepo = await resolveSchemaMemory({ cwd, headers: csv.headers, rows: csv.rows, defaultsRoot: SHIPPED });
  const fromNowhere = await resolveSchemaMemory({ cwd, headers: csv.headers, rows: csv.rows, defaultsRoot: `${cwd}/no-configs-here` });
  assert.equal(fromRepo?.source, "DEFAULT");
  assert.equal(fromNowhere?.source, "GENERIC", "and with no baseline at all it degrades to inference, not to a crash");
  assert.notEqual(fromNowhere?.source, "DEFAULT", "it must never fabricate a verified schema");
});
