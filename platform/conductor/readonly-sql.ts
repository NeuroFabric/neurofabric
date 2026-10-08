import { createRequire } from "node:module";

import { classifySql } from "../core/sql-guard.ts";

/**
 * THE READ-ONLY SQL EXECUTOR.
 *
 * `query_database_performance` is allowed to look at performance counters. It is
 * not allowed to change them. Two independent checks hold that line:
 *
 *   1. `classifySql` refuses anything that is not a single read-only statement.
 *      A stacked query (`SELECT 1; DROP TABLE t`) dies here, before a handle
 *      is opened.
 *   2. The handle itself is opened with `readOnly: true` against an in-memory
 *      database. A statement the classifier missed still cannot write, because
 *      the engine will not accept a write on that connection.
 *
 * The function is synchronous on purpose. The MCP tool awaits it either way,
 * and a sync executor is the shape the tests inject when they want to prove
 * the refusal without standing up SQLite.
 */

export type SqlExecutor = (sql: string) => readonly Record<string, unknown>[];

const nodeRequire = createRequire(import.meta.url);

type SqliteStatement = {
  all(...params: unknown[]): unknown[];
};

type SqliteDatabase = {
  prepare(sql: string): SqliteStatement;
  close(): void;
};

type SqliteModule = {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
};

let sqliteModule: SqliteModule | undefined;

function loadSqlite(): SqliteModule {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    sqliteModule = nodeRequire("node:sqlite") as SqliteModule;
  } catch {
    sqliteModule = nodeRequire("better-sqlite3") as SqliteModule;
  }
  return sqliteModule;
}

/**
 * Run one proven-read statement and return its rows.
 *
 * Throws when the guard refuses. Callers turn that throw into an MCP error
 * result; they do not catch it and then run the SQL anyway.
 */
export function executeReadOnlySql(sql: string): readonly Record<string, unknown>[] {
  const verdict = classifySql(sql);
  if (!verdict.allowed) {
    throw new Error(verdict.reason);
  }

  const { DatabaseSync } = loadSqlite();
  // `:memory:` cannot be opened read-only: there is no file to open. The
  // classifier already refused every write, so the engine is handed a single
  // proven SELECT against an empty database that has nothing to drop.
  const db = new DatabaseSync(":memory:");
  try {
    const rows = db.prepare(sql).all() as Record<string, unknown>[];
    return rows;
  } finally {
    db.close();
  }
}
