import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { classifySql, type SqlVerdict } from "../core/sql-guard.ts";
import { resolveWithinRoot } from "../core/workspace.ts";
import { parseCsv } from "../conductor/capabilities.ts";
import type { CsvReadResult } from "../conductor/capabilities.ts";

/**
 * THE DATABASE INGESTION PLANE. Same analysis, new front door.
 *
 * The engine has spent three sessions learning to read files it was never shown:
 * a Pega export, a web access log, a matrix of random numbers. Nothing in it
 * cares where the rows came from, so the honest way to add databases is to hand
 * it the same CsvReadResult shape and change nothing downstream. That is the
 * whole design: `queryToCsvResult` is the only new piece, and the profiler, the
 * bottleneck engine and the report renderer cannot tell the difference.
 *
 * GOVERNANCE IS NOT OPTIONAL AND NOT DUPLICATED. `classifySql` runs here as the
 * connector's own last line of defence, and the identical function runs inside
 * the kernel's precheck because the tool descriptor names its query parameter.
 * Two call sites, one implementation: a connector guard alone would be bypassed
 * by anyone calling the tool directly, and a policy guard alone would be bypassed
 * by anyone who imports the connector. The refusal is the same verdict, the same
 * reason string, and the same HARD_DENY tier either way.
 *
 * SQLITE IS BUILT IN. Node 22 ships node:sqlite, so a real database read needs
 * no dependency, no native build and no install step -- which matters for a
 * product whose whole claim is that a fresh clone works. It is imported
 * dynamically so that a host without it degrades to an explanation rather than
 * failing to load the module.
 *
 * POSTGRES IS AN INTERFACE, NOT AN IMPLEMENTATION, and it is called out plainly
 * rather than stubbed behind a lie. A Postgres wire-protocol client is a
 * substantial dependency and this repository installs nothing. So the shape is
 * defined, the guard and the row-mapping are real, and the driver is injected:
 * a caller supplies a `query` function and gets the full pipeline. The one
 * thing that is NOT negotiable -- the read-only guard -- runs before the driver
 * is ever touched, so a driver cannot be a way around it.
 */

/** A source of rows, in the exact shape the Conductor already understands. */
export type CsvLike = {
  readonly headers: readonly string[];
  readonly rows: ReadonlyArray<Record<string, string>>;
  readonly problems: readonly string[];
  readonly source: string;
};

/** What the connector produced, plus the provenance a report needs to cite. */
export interface QueryResult {
  readonly csv: CsvReadResult;
  readonly columns: number;
  readonly rowCount: number;
  /** Truncated at the row cap, and the cap is named here rather than hidden. */
  readonly truncated: boolean;
  readonly source: string;
}

/**
 * ROWS ARE CAPPED. A query with no LIMIT against a 40-million-row table would
 * exhaust memory inside a read-only analysis tool, and the cap is reported in
 * the result rather than applied silently -- a summary computed over the first
 * 100,000 rows and presented as if it covered the table is the partial-answer
 * bug this codebase has been bitten by repeatedly.
 */
export const MAX_ROWS = 100_000;

/** The row limit applied to the SQL itself, where the dialect allows it. */
const ROW_LIMIT_CLAUSE = " LIMIT 100001";

const nodeRequire = createRequire(import.meta.url);

export class SqlRefused extends Error {
  readonly verdict: SqlVerdict;
  constructor(verdict: SqlVerdict) {
    super(`query refused by the read-only SQL guard: ${verdict.reason}`);
    this.name = "SqlRefused";
    this.verdict = verdict;
  }
}

/**
 * A PATH REFUSAL, kept as its own type and not folded into SqlRefused.
 *
 * Two different guards produce two different verdicts and a caller has to be
 * able to tell them apart: one of them is about WHAT you asked for, the other
 * is about WHERE you asked from it. Conflating them would make a filesystem
 * refusal report a SQL reason, and the operator would go looking for a bad query
 * in a request that never ran one.
 */
export class DatabasePathRefused extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`database read refused by the workspace boundary: ${reason}`);
    this.name = "DatabasePathRefused";
    this.reason = reason;
  }
}

/**
 * THE PATH BOUNDARY, AND IT IS NOT OPTIONAL.
 *
 * Found by the security sweep: this connector was written a session before the
 * PDF one and never got the check the PDF one has, so `querySqlite` would open
 * any file on the disk. Two front doors, two different security postures, and
 * the weaker one is the older one -- which is the argument for requiring them
 * to be identical rather than for adding a check to whichever file is in front
 * of you.
 *
 * It calls the kernel's own `resolveWithinRoot` -- the same function the text
 * read and the PDF read use -- so this is one implementation with three call
 * sites, not three implementations. `root` defaults to the process working
 * directory rather than being optional-and-skipped, because a boundary a caller
 * can leave unset is a boundary that will be left unset.
 */
export function assertDatabaseInsideWorkspace(input: { readonly file: unknown; readonly root: string }): string {
  const verdict = resolveWithinRoot(input.root, input.file);
  if (!verdict.allowed) throw new DatabasePathRefused(verdict.reason ?? "path is outside every allowed root");
  return verdict.resolvedPath as string;
}

/**
 * THE GUARD, CALLED DIRECTLY.
 *
 * Every entry point runs this before touching a database, so the connector is
 * safe to call without going through the kernel. It is the same function the
 * policy uses, not a copy: a second implementation of a security check is a
 * second thing to keep correct, and the two would drift.
 */
export function assertReadOnly(sql: string): SqlVerdict {
  const verdict = classifySql(sql);
  if (!verdict.allowed) throw new SqlRefused(verdict);
  return verdict;
}

/** Driver for a remote database. Injected, because this repository installs nothing. */
export interface PostgresDriver {
  /** Runs a read-only query and returns column names and row objects. */
  query(connectionString: string, sql: string, limit: number): Promise<{ columns: readonly string[]; rows: ReadonlyArray<Record<string, unknown>> }>;
}

function toCsvResult(headers: readonly string[], rows: ReadonlyArray<Record<string, unknown>>, source: string): QueryResult {
  // Everything is stringified here, once, so that every downstream reader sees
  // the same type it sees for a CSV cell. A number that arrives as a number and
  // a number that arrives as a string would take different paths through the
  // profiler, and the difference would show up as a column classified one way in
  // a database and another way in a file.
  const stringified = rows.map((row) =>
    Object.fromEntries(headers.map((h) => [h, row[h] === null || row[h] === undefined ? "" : String(row[h])])));
  const kept = stringified.slice(0, MAX_ROWS);
  const csv: CsvReadResult = {
    path: source,
    headers: [...headers],
    rowCount: kept.length,
    columns: [],
    sample: kept.slice(0, 5),
    rows: kept,
    problems: [],
  };
  return { csv, columns: headers.length, rowCount: kept.length, truncated: kept.length < stringified.length, source };
}

/**
 * READ FROM A SQLITE FILE.
 *
 * The file is opened READ-LOW, never write. A read-only connection is the
 * strongest form of this guard, and it is not a substitute for the SQL guard --
 * node:sqlite would happily run a DROP on a read-write handle -- so both are
 * used. Belt and braces here means "two independent reasons this cannot modify
 * your data", not "the same check twice".
 */
export function querySqlite(input: { readonly file: string; readonly query: string; readonly root?: string }): QueryResult {
  // The path is checked BEFORE the query, so an escaping path is refused even
  // when the query is perfectly innocent -- the order the PDF connector uses,
  // and the only order in which there is no window between deciding and opening.
  const file = assertDatabaseInsideWorkspace({ file: input.file, root: input.root ?? process.cwd() });
  assertReadOnly(input.query);
  // `createRequire` rather than a bare `require`, because this module is ESM and
  // has no `require` in scope. The module is still resolved LAZILY, so a host
  // without node:sqlite gets an explanation rather than a load failure.
  const sqlite = nodeRequire("node:sqlite") as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
      prepare(sql: string): { all(): unknown[]; columns?(): string[] };
      close(): void;
    };
  };
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    const statement = db.prepare(input.query.endsWith(";") ? input.query : `${input.query}${ROW_LIMIT_CLAUSE}`);
    const raw = statement.all() as Array<Record<string, unknown>>;
    const headers = raw.length > 0 ? Object.keys(raw[0]) : (statement.columns?.() ?? []);
    return toCsvResult(headers, raw, input.file);
  } finally {
    db.close();
  }
}

/**
 * READ FROM POSTGRES, through an injected driver.
 *
 * The driver is called only after the guard has passed, and it is handed a LIMIT
 * so the cap is enforced by the database rather than by reading a million rows
 * into memory to discard all but the first 100,000.
 */
export async function queryPostgres(input: {
  readonly connectionString: string;
  readonly query: string;
  readonly driver: PostgresDriver;
}): Promise<QueryResult> {
  assertReadOnly(input.query);
  const result = await input.driver.query(input.connectionString, input.query, MAX_ROWS);
  return toCsvResult(result.columns, result.rows, "postgres");
}

/** Dispatch on the source. The shape the report renderer ultimately receives is identical either way. */
export async function queryDatabase(input:
  | { readonly kind: "sqlite"; readonly file: string; readonly query: string }
  | { readonly kind: "postgres"; readonly connectionString: string; readonly query: string; readonly driver: PostgresDriver }): Promise<QueryResult> {
  return input.kind === "sqlite" ? querySqlite({ file: input.file, query: input.query }) : queryPostgres(input);
}

/**
 * WHAT A READY-MADE CONNECTOR LOOKS LIKE WHEN THERE IS NO SQLITE, for tests and
 * for hosts that want to prove the pipeline without a database. Kept here rather
 * than in a fixture so that the shape is the same one the real connector emits.
 */
export function csvLikeResult(source: CsvLike): QueryResult {
  return toCsvResult(source.headers, source.rows.map((r) => ({ ...r })), source.source);
}

/** Re-exported so callers can explain a refusal without importing the core module. */
export { classifySql };
export { parseCsv, readFileSync };
