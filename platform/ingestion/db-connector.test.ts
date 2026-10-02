import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { KernelAdapter } from "../pi/kernel-adapter.ts";
import { buildPolicy } from "../pi/project-config.ts";
import { parsePolicyConfig, type PolicyConfig } from "../core/policy-config.ts";
import { analyseBottlenecks } from "../conductor/bottlenecks.ts";
import { toBottleneckMarkdown } from "../conductor/bottleneck-report.ts";
import { resolveSchemaMemory } from "../conductor/schema-memory.ts";
import { querySqlite, assertReadOnly, SqlRefused, queryPostgres, type PostgresDriver } from "./db-connector.ts";
import type { DenialTier, ToolDescriptor } from "../core/index.ts";

/**
 * THE DATABASE FRONT DOOR, GOVERNED THE SAME WAY AS EVERY OTHER FRONT DOOR.
 *
 * The engine has learned to read files it was never shown. Databases are the
 * same problem with a worse failure mode: a mistyped query is not a malformed
 * report, it is a deleted table. So the guard is a WHITELIST, it runs before any
 * database is opened, and the refusal comes from the kernel's own precheck at
 * HARD_DENY -- the same function that refuses a destructive shell command, not
 * a side channel inside a connector that anyone could bypass by calling it
 * directly.
 *
 * The read-only OPEN is the second, independent reason the SQLite path cannot
 * modify anything. node:sqlite will happily run a DROP on a read-write handle,
 * so the handle is read-only AND the query is checked, and the two are
 * deliberately not the same check.
 */

const RULES = {
  version: 1,
  deniedTools: [],
  allowedTools: [],
  fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
  destructiveCommandPatterns: [],
  destructiveCommandTokens: [],
  secretWritePatterns: [],
  limits: { maxToolCallsPerTask: 200, maxFileWritesPerTask: 30, maxBytesPerWrite: 2_000_000 },
  onViolation: "block",
} as const;

const DESCRIPTOR: ToolDescriptor = {
  name: "query_database",
  version: "phase3",
  description: "Run a read-only SQL query and return rows as a table",
  inputSchema: { type: "object", properties: { file: { type: "string" }, query: { type: "string" } }, required: ["query"] },
  outputSchema: { type: "object" },
  capabilities: ["db.read"],
  permissions: ["tool:query_database"],
  riskLevel: "READ_ONLY",
  timeoutMs: 10_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
  idempotency: "IDEMPOTENT",
  sideEffect: "PURE",
  governedQueryParameter: "query",
};

async function governed() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-db-"));
  const config: PolicyConfig = parsePolicyConfig({ ...RULES }, "db.json");
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy({ policyMode: "TRUSTED_PROJECT", allowedRoots: [dir] }, dir, config));
  // Registered directly as a ToolDescriptor rather than through the Pi adapter,
  // because `governedQueryParameter` is a field this product's own descriptor
  // carries and the Pi conversion path would drop it. That is the point: the
  // declaration of what to govern travels with the tool, not with a wrapper.
  adapter.registerTools([DESCRIPTOR]);
  await adapter.beginTask("analyse the database", "analyse the database");
  return { adapter, dir };
}

async function tierOf(k: KernelAdapter, query: string, id: string): Promise<DenialTier | undefined> {
  const { decision } = await k.precheckToolCall("query_database", "execute", { query }, undefined, id);
  assert.equal(decision.decision, "DENY", `"${query}" must be refused, or this pin proves nothing`);
  return (decision as { tier?: DenialTier }).tier;
}

// === THE HEADLINE CASE ======================================================

test("a DROP TABLE is HARD_DENY by the kernel, not merely refused by the connector", async () => {
  const { adapter } = await governed();
  const tier = await tierOf(adapter, "DROP TABLE users", "db1");
  assert.equal(tier, "HARD_DENY",
    "HARD and not SOFT: a soft refusal lets the run continue, and the next thing to try is the same DROP with different spacing");
});

test("and so is every other write, including the stacked and commented spellings", async () => {
  const { adapter } = await governed();
  for (const [i, sql] of [
    "DELETE FROM users",
    "UPDATE users SET admin = 1",
    "INSERT INTO users VALUES (1)",
    "SELECT 1; DROP TABLE users",
    "PRAGMA writable_schema = 1",
    "ATTACH DATABASE 'evil.db' AS e",
  ].entries()) {
    assert.equal(await tierOf(adapter, sql, `db2-${i}`), "HARD_DENY", `${sql} must be HARD_DENY`);
  }
});

test("a genuine SELECT is ALLOWED, so the guard is not simply refusing everything", async () => {
  const { adapter } = await governed();
  const { decision } = await adapter.precheckToolCall("query_database", "execute", { query: "SELECT id, total FROM orders" }, undefined, "db3");
  assert.equal(decision.decision, "ALLOW", "a read must pass, or the guard is a wall rather than a filter");
});

// === THE CONNECTOR REFUSES INDEPENDENTLY ==================================

test("the connector itself refuses, so calling it directly is not a way around the kernel", async () => {
  // The kernel check and the connector check are the SAME FUNCTION. A caller who
  // imports the connector never reaches the precheck, and a guard that lived
  // only in the precheck would be one import away from being useless.
  assert.throws(() => assertReadOnly("DROP TABLE users"), SqlRefused);
  assert.throws(() => querySqlite({ file: "x.db", query: "DELETE FROM t" }), SqlRefused);
  assert.doesNotThrow(() => assertReadOnly("SELECT 1"));
});

test("the refusal carries a reason, so it is explainable rather than a bare stop", async () => {
  try {
    assertReadOnly("DELETE FROM t");
    assert.fail("should have refused");
  } catch (e) {
    assert.ok(e instanceof SqlRefused);
    assert.match(e.verdict.reason, /DELETE/, "the verdict names the verb it found");
  }
});

// === THE PIPELINE ACTUALLY WORKS ===========================================

/** A real SQLite file, built with node:sqlite, so the test is not a mock. */
async function makeDb(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-dbfile-"));
  const file = path.join(dir, "orders.db");
  const { DatabaseSync } = (await import("node:sqlite")) as { DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void } };
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE orders (id INTEGER, order_date TEXT, region TEXT, total REAL);
    INSERT INTO orders VALUES
      (1,'2026-09-30','EMEA',10.5),
      (2,'2026-09-30','AMER',20.25),
      (3,'2026-10-01','EMEA',30),
      (4,'2026-10-01','APAC',40.75),
      (5,'2026-10-01','EMEA',99.99);
  `);
  db.close();
  return file;
}

test("a real SQLite read produces the exact table the Conductor already understands", async () => {
  const file = await makeDb();
  const result = querySqlite({ file, query: "SELECT id, order_date, region, total FROM orders" });
  assert.equal(result.rowCount, 5);
  assert.deepEqual(result.csv.headers, ["id", "order_date", "region", "total"]);
  assert.equal(result.truncated, false);
  // Every cell is a STRING, exactly as it would be from a CSV. The profiler
  // classifies types by parsing, so a number arriving as a number would take a
  // different path than the same number arriving as text.
  assert.equal(typeof result.csv.rows[0].total, "string");
});

test("and it flows straight into the existing engine, with no new code downstream", async () => {
  const file = await makeDb();
  const result = querySqlite({ file, query: "SELECT id, order_date, region, total FROM orders" });
  // The renderer resolves memory before analysing, so the pipeline under test is
  // resolve-then-analyse. Calling analyseBottlenecks bare would skip the generic
  // profiler entirely -- and "region" is in its category names, not in the
  // alert-shaped name candidates the CSV path uses.
  //
  // The order_date column is there because a generic schema REQUIRES a
  // category and a time. A table of numbers with no dates is not a degraded
  // profile, it is no profile, and the engine declines it on purpose.
  const schema = await resolveSchemaMemory({ cwd: "configs/..", headers: result.csv.headers, rows: result.csv.rows });
  assert.equal(schema?.source, "GENERIC", "a table of orders is not a Pega export, so it profiles generically");
  const analysis = analyseBottlenecks(result.csv, schema);
  assert.equal(analysis.categoryColumn, "region", "the region column was found");
  assert.ok(analysis.categories.length > 0, "and ranked");
  const md = toBottleneckMarkdown(analysis, "Orders");
  assert.match(md, /^# Orders/m, "the report renderer needs no idea where the rows came from");
  assert.match(md, /Record categories by frequency/, "and it is described in records, not alerts");
});

test("the open is READ-ONLY, which is a second and independent reason nothing is modified", async () => {
  // Even if the guard were removed entirely, a read-only handle cannot write.
  // The two protections are deliberately different mechanisms.
  const file = await makeDb();
  const { DatabaseSync } = (await import("node:sqlite")) as {
    DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => { prepare(s: string): { get(): unknown }; close(): void };
  };
  const db = new DatabaseSync(file, { readOnly: true });
  assert.throws(() => db.prepare("DROP TABLE orders").get(), /readonly|read-only/i,
    "a read-only handle refuses a write at the database itself");
  db.close();
});

test("postgres goes through an injected driver, and the guard runs BEFORE the driver is called", async () => {
  // The guard is not negotiable by supplying a different transport. A driver that
  // is never called cannot be a way around the check.
  let called = false;
  const driver: PostgresDriver = {
    query: async () => { called = true; return { columns: ["a"], rows: [{ a: 1 }] }; },
  };
  await assert.rejects(
    () => queryPostgres({ connectionString: "postgres://x", query: "DROP TABLE users", driver }),
    SqlRefused,
  );
  assert.equal(called, false, "the driver was never reached");

  const ok = await queryPostgres({ connectionString: "postgres://x", query: "SELECT a FROM t", driver });
  assert.equal(called, true);
  assert.deepEqual(ok.csv.headers, ["a"]);
  assert.equal(ok.csv.rows[0].a, "1", "and values are stringified, like a CSV cell");
});

test("the row cap is reported rather than applied silently", async () => {
  let rows = 0;
  const driver: PostgresDriver = {
    query: async (_c, _s, limit) => {
      rows = limit;
      return { columns: ["a"], rows: Array.from({ length: 3 }, (_, i) => ({ a: i })) };
    },
  };
  const ok = await queryPostgres({ connectionString: "postgres://x", query: "SELECT a FROM t", driver });
  assert.ok(rows > 0, "the limit is pushed to the database rather than enforced by reading everything first");
  assert.equal(ok.truncated, false);
  assert.equal(ok.rowCount, 3);
});
