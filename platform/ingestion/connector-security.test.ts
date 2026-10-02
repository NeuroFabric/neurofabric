import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";

import { classifySql } from "../core/sql-guard.ts";
import { querySqlite } from "./db-connector.ts";
import { readPdf, assertInsideWorkspace } from "./pdf-connector.ts";

/**
 * THE CONNECTOR SWEEP. Three holes, found by hostile reading, pinned red first.
 *
 * Every finding here is the same SHAPE of mistake, which is why they survived
 * review: a boundary that exists on one front door and not on its neighbour. The
 * PDF connector was written last, with the workspace check in front of the file
 * open, and the DB connector -- written a session earlier, to a different brief --
 * never got one. A reader comparing the two sees the asymmetry immediately. A
 * reader who has only seen one of them sees nothing.
 *
 * That is the lesson worth keeping: the weakness was never a missing control,
 * it was that the controls were not required to be IDENTICAL across entry
 * points. The same argument the codebase already makes about the SQL guard --
 * "two call sites, one implementation" -- is the argument for every front door.
 */

/** A valid CSV that parses with zero problems, so a read of it would SUCCEED. */
const CLEAN_CSV = "alpha,beta\n1,2\n3,4\n";

async function outsideDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "nf-outside-"));
}

// === FINDING 1: `SELECT ... INTO` CREATES A TABLE AND PASSES THE GUARD =====

test("FINDING 1: SELECT ... INTO is a WRITE, and the read-only guard allows it", () => {
  // Postgres spells "copy the results of this query into a brand new table" as
  // `SELECT ... INTO name`. It creates and populates a table. It is a write.
  //
  // The guard is a WHITELIST of write verbs plus "must start with SELECT", and
  // `INTO` is in neither -- so a statement that creates a table passes. The
  // whitelist is only as good as the completeness of its verb list, and this is
  // the hole: a verb the author did not think of, rather than a bypass of the
  // parsing that already works.
  const verdict = classifySql("SELECT * INTO backdoor FROM users");
  assert.equal(verdict.allowed, false,
    "SELECT ... INTO creates a table; a guard that calls it read-only permits a write");
  assert.ok(verdict.reason.length > 0, "and the refusal must be explainable");
});

test("and the other spellings of the same trick are refused too", () => {
  for (const sql of [
    "SELECT * INTO TEMP t FROM users",
    "select a, b into newtable from t",
    "SELECT * FROM users INTO TABLE copy_of_users",
  ]) {
    assert.equal(classifySql(sql).allowed, false, `${sql} must be refused`);
  }
});

test("a genuine SELECT is still allowed, so finding 1 is a hole and not a wall", () => {
  assert.equal(classifySql("SELECT id, total FROM orders").allowed, true);
  assert.equal(classifySql("SELECT * INTO_THE_MOON FROM t").allowed, true,
    "a column merely NAMED like the keyword is data, not a write");
});

// === FINDING 2: THE DB CONNECTOR OPENS ANY FILE ON DISK =====================

test("FINDING 2: querySqlite opens a database from outside the workspace", async () => {
  // The PDF connector refuses this. The DB connector, given the same path, opens
  // it. The file name the user controls is a full filesystem path, and a
  // read-only query against a database the user did not intend to expose is
  // still a read of data they did not intend to expose.
  const outside = await outsideDir();
  const db = path.join(outside, "private.db");
  const { DatabaseSync } = (await import("node:sqlite")) as {
    DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void };
  };
  const handle = new DatabaseSync(db);
  handle.exec("CREATE TABLE t (a); INSERT INTO t VALUES (1);");
  handle.close();

  const workspace = await outsideDir();
  // No `root` option exists yet, so this cannot be expressed -- which is exactly
  // the finding: the connector has no way to be governed, and therefore is not.
  await assert.rejects(
    () => querySqlite({ file: db, query: "SELECT a FROM t", root: workspace } as never),
    /refus|outside|root|boundary|escape/i,
    "a database outside the workspace must be refused, exactly as a PDF would be",
  );
});

test("and a legitimate database inside the root still reads", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "nf-dbinside-"));
  const db = path.join(workspace, "orders.db");
  const { DatabaseSync } = (await import("node:sqlite")) as {
    DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void };
  };
  const handle = new DatabaseSync(db);
  handle.exec("CREATE TABLE orders (id INTEGER, total REAL); INSERT INTO orders VALUES (1, 9.5);");
  handle.close();
  const result = querySqlite({ file: path.join(workspace, "orders.db"), query: "SELECT id, total FROM orders", root: workspace });
  assert.equal(result.rowCount, 1, "the fix must not be a wall");
});

// === FINDING 3 (CONFIRMED CLEAN, PINNED SO IT STAYS THAT WAY) ==============

test("the PDF connector is the shape the DB connector must be brought to", async () => {
  const outside = await outsideDir();
  await writeFile(path.join(outside, "notes.pdf"), "%PDF-1.4\n");
  const workspace = await outsideDir();
  await assert.rejects(() => readPdf({ path: path.join(outside, "notes.pdf"), root: workspace }), /refus|outside|root|boundary|escape/i);
  assert.throws(() => assertInsideWorkspace({ path: path.join(outside, "notes.pdf"), root: workspace }));
  // The guard runs before the file is opened: a path that does not exist is
  // still refused, which is what proves there is no open-then-check window.
  assert.throws(() => assertInsideWorkspace({ path: path.join(outside, "absent.pdf"), root: workspace }));
});
