import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempWorkspace, writeFixture } from "../test-support/temp-workspace.ts";
import { resolveSchemaMemory } from "./schema-memory.ts";

/**
 * TASK 1 — SCHEMA MEMORY. Red first.
 *
 * The ruling: USER-LEARNED schemas are per-checkout and stay in
 * `.session-archive` (never committed). CORE VERIFIED schemas ship with the
 * product in `configs/default-schemas.json`, tracked in git, because the Pega
 * mapping was established against a real export and a customer who drops a
 * second Pega export must not have to re-earn it.
 *
 * So there are two stores and an order between them, and these tests pin the
 * order as well as the fallback. A "fallback" that wins when both are present
 * would silently discard what this checkout has learned, which is the one thing
 * per-checkout memory exists to keep.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const PEGA_HEADERS = [
  "_time", "source_host", "nodeId", "userid", "thread_name", "logger_name",
  "alertType", "alert_code", "elapsed_time", "threshold", "pega_time", "service_uri",
];

/** The shipped core schema must exist in git-tracked configs/, not in the archive. */
test("the core Pega schema ships with the product, in git-tracked configs/", async () => {
  const shipped = path.join(REPO_ROOT, "configs", "default-schemas.json");
  const text = await readFile(shipped, "utf8");
  const parsed = JSON.parse(text) as { schemas: { id: string; roles: Record<string, string> }[] };
  const pega = parsed.schemas.find((s) => s.id === "pega-alert-export");
  assert.ok(pega, "the verified Pega mapping must be in the shipped defaults");
  // The mapping !48 established against the real export.
  assert.equal(pega.roles.category, "alert_code", "category is alert_code, NOT alertType");
  assert.equal(pega.roles.duration, "elapsed_time");
  assert.equal(pega.roles.threshold, "threshold");
  assert.equal(pega.roles.source, "source_host");
  // alertType is the trap from R9 and must be recorded as rejected, not just absent.
  assert.ok(
    JSON.stringify(pega).includes("alertType"),
    "the rejected alertType column must be recorded, so the reason travels with the mapping",
  );
});

test("an empty .session-archive falls back to the shipped core schema", async () => {
  const cwd = await makeTempWorkspace("nf-schema-fallback-");
  // Present but EMPTY is the case the task names, and it is not the same as
  // absent: an empty archive is what a fresh checkout of a configured project
  // looks like after someone deletes their learned overrides.
  await mkdir(path.join(cwd, ".session-archive"), { recursive: true });
  await writeFile(path.join(cwd, ".session-archive", "schemas.json"), "[]", "utf8");

  // `defaultsRoot` points at the repo: the temp workspace has no configs/ of its
  // own, and without this the assertion below would hold whether or not the
  // fallback works.
  const resolved = await resolveSchemaMemory({ cwd, headers: PEGA_HEADERS, defaultsRoot: REPO_ROOT });
  assert.equal(resolved?.roles.category, "alert_code");
  assert.equal(resolved?.source, "DEFAULT", "an empty archive must fall back to the shipped default");
});

test("a user-learned schema in .session-archive WINS over the shipped default", async () => {
  const cwd = await makeTempWorkspace("nf-schema-learned-");
  await mkdir(path.join(cwd, ".session-archive"), { recursive: true });
  // This checkout learned that alertType is the discriminating column. It is
  // right HERE and wrong in general, which is exactly why it is per-checkout.
  await writeFile(path.join(cwd, ".session-archive", "schema-memory.json"), JSON.stringify([
    { id: "pega-alert-export", roles: { category: "alertType" } },
  ]), "utf8");

  const resolved = await resolveSchemaMemory({ cwd, headers: PEGA_HEADERS, defaultsRoot: REPO_ROOT });
  assert.equal(resolved?.roles.category, "alertType", "per-checkout learning must not be discarded");
  assert.equal(resolved?.source, "SESSION_ARCHIVE");
});

test("a remembered schema is only used when the file still has its columns", async () => {
  const cwd = await makeTempWorkspace("nf-schema-stale-");
  await mkdir(path.join(cwd, ".session-archive"), { recursive: true });
  await writeFile(path.join(cwd, ".session-archive", "schemas.json"), JSON.stringify([
    { id: "pega-alert-export", roles: { category: "alert_code", duration: "elapsed_ms" } },
  ]), "utf8");

  // A different export: no alert_code, no elapsed_ms. Applying the memory
  // anyway would rank on undefined columns and report a confident empty answer.
  // `defaultsRoot` is set so that undefined here means "nothing matched", not
  // "there was nothing to match against" -- those two look identical otherwise.
  const resolved = await resolveSchemaMemory({
    cwd, headers: ["_time", "service", "millis", "alertType"], defaultsRoot: REPO_ROOT,
  });
  assert.equal(resolved, undefined, "a schema whose columns are absent must not be applied");
  // The control: the same cwd and the same resolver DO resolve when the columns
  // are present, so the negative above is caused by the header set and not by a
  // resolver that matches nothing. (Source is SESSION_ARCHIVE here, because this
  // cwd does have an archive -- the control is about capability, not provenance.)
  const control = await resolveSchemaMemory({ cwd, headers: PEGA_HEADERS, defaultsRoot: REPO_ROOT });
  assert.ok(control !== undefined, "the same resolver resolves when the columns are there");
  assert.equal(control?.roles.category, "alert_code");
  // The default still supplies the roles the stale archive could not.
  assert.equal(control?.roles.duration, "elapsed_time", "shipped defaults fill gaps the archive left");
});

test("an unparseable .session-archive degrades to the shipped default, it does not throw", async () => {
  const cwd = await makeTempWorkspace("nf-schema-corrupt-");
  await mkdir(path.join(cwd, ".session-archive"), { recursive: true });
  await writeFixture(cwd, "x.txt", "");
  await writeFile(path.join(cwd, ".session-archive", "schemas.json"), "{ not json", "utf8");

  const resolved = await resolveSchemaMemory({ cwd, headers: PEGA_HEADERS, defaultsRoot: REPO_ROOT });
  assert.equal(resolved?.source, "DEFAULT", "a corrupt archive must not take the product down");
});
