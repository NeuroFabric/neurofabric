import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * THE DURABLE RECORD. Phase 1, built to ADR-005.
 *
 * === ZERO DEPENDENCIES, AND IT IS NOT A SLOGAN ===
 *
 * `node:sqlite` is a Node built-in. There is no npm entry, no lockfile line and
 * no native build step, so the kernel's D-018 claim is untouched and ADR-001's
 * refusal of a chart or an ORM still holds.
 *
 * Three consequences, stated here rather than discovered in production:
 *
 *  - **IT IS EXPERIMENTAL AND NODE SAYS SO ON EVERY BOOT.** That warning is NOT
 *    suppressed. Suppressing it would hide a real status from the operator, and a
 *    platform that hides its own experimental warnings is the platform that
 *    eventually hides real ones.
 *  - **IT REQUIRES NODE >= 22.5.** `assertSupported()` enforces that as a clear
 *    message rather than an obscure module-resolution failure.
 *  - **IT IS SYNCHRONOUS.** Every write blocks the event loop, which is the entire
 *    reason this file writes so little and writes it in one place. §WRITE
 *    BOUNDARY is not a style preference; it is the cost model.
 *
 * === THE WRITE BOUNDARY, IN ONE SENTENCE ===
 *
 * **We pay the blocking cost only for facts that change what a person does next.**
 *
 * So: a verdict, an alert and an audit trace are written SYNCHRONOUSLY, in ONE
 * transaction, BEFORE the alert is pushed to anyone. Everything else -- events,
 * rollups, read state, the live window -- is derived, recomputable, and never
 * written on a decision path.
 *
 * A crash therefore eats the live window entirely (by design: it measures *now*)
 * and events in flight (the sender's problem, and honest about it). **It cannot
 * eat anything that has been acted on**, because if an alert reached a person it is
 * already durable. That ordering IS the guarantee.
 */

/* ================================================================== */
/* MIGRATIONS — numbered, ordered, one transaction each, forward only  */
/* ================================================================== */

/**
 * Why migrations look like this, since every property was a decision (ADR-005 §8):
 *
 *  - **`PRAGMA user_version` is the number**, and it is verified available on this
 *    machine rather than assumed.
 *  - **Never edited after release.** A shipped migration is a historical fact;
 *    changing one silently corrupts every database that already ran it.
 *  - **One transaction each.** An interrupted migration leaves the version
 *    unchanged and re-runs cleanly. There is no half-migrated state to design
 *    around later.
 *  - **Forward only.** There is no `down`. Reverting code while the data is ahead
 *    is a real situation, and the answer is restore a backup -- which is why the
 *    platform refuses to start rather than silently reverting a customer's data.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
      CREATE TABLE IF NOT EXISTS schemas (
        tenant      TEXT NOT NULL,
        id          TEXT NOT NULL,
        version     TEXT NOT NULL,
        document    TEXT NOT NULL,
        registered  INTEGER NOT NULL,
        PRIMARY KEY (tenant, id)
      );

      CREATE TABLE IF NOT EXISTS verdicts (
        tenant      TEXT NOT NULL,
        agent_id    TEXT NOT NULL,
        at          INTEGER NOT NULL,
        provider    TEXT NOT NULL,
        records     INTEGER NOT NULL,
        breached    INTEGER NOT NULL,
        document    TEXT NOT NULL,
        PRIMARY KEY (tenant, agent_id)
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id          TEXT PRIMARY KEY,
        tenant      TEXT NOT NULL,
        agent_id    TEXT NOT NULL,
        raised_at   INTEGER NOT NULL,
        severity    TEXT NOT NULL,
        acknowledged INTEGER NOT NULL DEFAULT 0,
        document    TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS alerts_by_tenant ON alerts (tenant, raised_at);

      CREATE TABLE IF NOT EXISTS audit (
        seq         INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant      TEXT NOT NULL,
        at          INTEGER NOT NULL,
        actor       TEXT NOT NULL,
        action      TEXT NOT NULL,
        document    TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS audit_by_tenant ON audit (tenant, at);
    `,
  },
];

/** The schema version this build expects. Bumping it means adding a migration. */
export const TARGET_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/* ================================================================== */
/* THE STORE                                                           */
/* ================================================================== */

/** The minimum Node that has a working `node:sqlite`. */
export const MINIMUM_NODE = "22.5.0";

function assertSupported(): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map((part) => Number(part));
  const enough = major > 22 || (major === 22 && minor >= 5);
  if (!enough) {
    throw new Error(
      `durable storage needs Node >= ${MINIMUM_NODE} for node:sqlite; this is ${process.versions.node}. ` +
        "Nothing has been written.",
    );
  }
}

/** What one decision wrote. All three, or none — see the transaction below. */
export interface DecisionRecord {
  readonly tenant: string;
  readonly agentId: string;
  readonly verdict: { readonly at: string; readonly provider: string; readonly records: number; readonly breached: number; readonly document: unknown };
  readonly alert?: { readonly id: string; readonly severity: string; readonly document: unknown } | undefined;
  readonly audit?: { readonly actor: string; readonly action: string; readonly document: unknown } | undefined;
}

export interface MemoryStoreOptions {
  /** Directory holding the database file. Created if absent. */
  readonly directory: string;
  /** `:memory:` for tests. Never a production value. */
  readonly inMemory?: boolean;
}

export class MemoryStore {
  readonly #db: DatabaseSync;
  #closed = false;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Open (or create) the record and bring it to this build's version. */
  static open(options: MemoryStoreOptions): MemoryStore {
    assertSupported();
    if (options.inMemory !== true) mkdirSync(options.directory, { recursive: true });
    const file = options.inMemory === true ? ":memory:" : path.join(options.directory, "neurofebric.sqlite");
    const db = new DatabaseSync(file);
    // WAL is a durability setting, not a performance one: without it a crash can
    // leave a partially-written page visible. It is set because the record is the
    // thing this platform promises is not lost.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db);
    return new MemoryStore(db);
  }

  /** The version the record is actually at. */
  version(): number {
    const row = this.#db.prepare("PRAGMA user_version").get() as { readonly user_version: number } | undefined;
    return row?.user_version ?? 0;
  }

  /**
   * WRITE ONE DECISION. Verdict, alert and audit trace, in ONE transaction.
   *
   * One transaction is the whole point. Three separate writes would leave a
   * window in which an alert exists with no verdict behind it -- the exact
   * corruption ADR-005 §7.3 says must be an alarm rather than a line in a list.
   *
   * Returns only after the data is durable. That is the cost the boundary is
   * paying, and it is paid BEFORE anything is pushed to a subscriber, so a
   * dropped SSE consumer can lose a notification but never an alert.
   */
  recordDecision(input: DecisionRecord): void {
    this.#assertOpen();
    const v = input.verdict;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(
          "INSERT INTO verdicts (tenant, agent_id, at, provider, records, breached, document) VALUES (?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT (tenant, agent_id) DO UPDATE SET at=excluded.at, provider=excluded.provider, " +
            "records=excluded.records, breached=excluded.breached, document=excluded.document",
        )
        .run(input.tenant, input.agentId, Date.parse(v.at), v.provider, v.records, v.breached === 0 ? 0 : 1, JSON.stringify(v.document));

      if (input.alert !== undefined) {
        this.#db
          .prepare(
            "INSERT INTO alerts (id, tenant, agent_id, raised_at, severity, acknowledged, document) VALUES (?, ?, ?, ?, ?, 0, ?)",
          )
          .run(input.alert.id, input.tenant, input.agentId, Date.parse(v.at), input.alert.severity, JSON.stringify(input.alert.document));
      }

      if (input.audit !== undefined) {
        this.#db
          .prepare("INSERT INTO audit (tenant, at, actor, action, document) VALUES (?, ?, ?, ?, ?)")
          .run(input.tenant, Date.parse(v.at), input.audit.actor, input.audit.action, JSON.stringify(input.audit.document));
      }

      this.#db.exec("COMMIT");
    } catch (error) {
      // Rolled back rather than left half-written. A store that swallows this and
      // continues would report success for a decision it did not keep.
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // The transaction was already gone. Nothing to undo.
      }
      throw error;
    }
  }

  /** Register or replace a schema. Part of step 1A: authoring is a persisted fact. */
  putSchema(tenant: string, id: string, version: string, document: unknown, registeredAt: number = Date.now()): void {
    this.#assertOpen();
    this.#db
      .prepare(
        "INSERT INTO schemas (tenant, id, version, document, registered) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT (tenant, id) DO UPDATE SET version=excluded.version, document=excluded.document, registered=excluded.registered",
      )
      .run(tenant, id, version, JSON.stringify(document), registeredAt);
  }

  /** Every schema document for one tenant. The rehydration input. */
  schemasFor(tenant: string): { id: string; version: string; document: unknown }[] {
    this.#assertOpen();
    return (
      this.#db.prepare("SELECT id, version, document FROM schemas WHERE tenant = ? ORDER BY id").all(tenant) as {
        id: string;
        version: string;
        document: string;
      }[]
    ).map((row) => ({ id: row.id, version: row.version, document: safeParse(row.document) }));
  }

  /** The last verdict per agent for a tenant. The record half of the two truths. */
  verdictsFor(tenant: string): { agentId: string; at: number; provider: string; records: number; breached: boolean; document: unknown }[] {
    this.#assertOpen();
    return (
      this.#db
        .prepare("SELECT agent_id, at, provider, records, breached, document FROM verdicts WHERE tenant = ? ORDER BY agent_id")
        .all(tenant) as { agent_id: string; at: number; provider: string; records: number; breached: number; document: string }[]
    ).map((row) => ({
      agentId: row.agent_id,
      at: row.at,
      provider: row.provider,
      records: row.records,
      breached: row.breached === 1,
      document: safeParse(row.document),
    }));
  }

  /** Alerts newest first. Persisted before dispatch, so this is the record. */
  alertsFor(tenant: string, limit = 50): { id: string; agentId: string; raisedAt: number; severity: string; acknowledged: boolean; document: unknown }[] {
    this.#assertOpen();
    return (
      this.#db
        .prepare("SELECT id, agent_id, raised_at, severity, acknowledged, document FROM alerts WHERE tenant = ? ORDER BY raised_at DESC, id DESC LIMIT ?")
        .all(tenant, limit) as { id: string; agent_id: string; raised_at: number; severity: string; acknowledged: number; document: string }[]
    ).map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      raisedAt: row.raised_at,
      severity: row.severity,
      acknowledged: row.acknowledged === 1,
      document: safeParse(row.document),
    }));
  }

  /** Append an audit trace on its own, for actions with no verdict. */
  appendAudit(tenant: string, actor: string, action: string, document: unknown, at: number = Date.now()): void {
    this.#assertOpen();
    this.#db.prepare("INSERT INTO audit (tenant, at, actor, action, document) VALUES (?, ?, ?, ?, ?)").run(tenant, at, actor, action, JSON.stringify(document));
  }

  /** Audit traces for a tenant, oldest first. Append-only by construction. */
  auditFor(tenant: string, limit = 200): { at: number; actor: string; action: string; document: unknown }[] {
    this.#assertOpen();
    return (
      this.#db.prepare("SELECT at, actor, action, document FROM audit WHERE tenant = ? ORDER BY seq LIMIT ?").all(tenant, limit) as {
        at: number;
        actor: string;
        action: string;
        document: string;
      }[]
    ).map((row) => ({ at: row.at, actor: row.actor, action: row.action, document: safeParse(row.document) }));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("the durable record is closed");
  }
}

/**
 * Apply every migration the record has not had.
 *
 * One transaction per migration, and the version is written INSIDE it -- so an
 * interruption cannot leave the number ahead of the work or behind it.
 */
export function applyMigrations(db: DatabaseSync): { from: number; to: number; applied: number[] } {
  const current = (db.prepare("PRAGMA user_version").get() as { readonly user_version: number } | undefined)?.user_version ?? 0;
  const applied: number[] = [];

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      // PRAGMA does not accept a bound parameter, so the value is interpolated --
      // and it is a NUMBER from a closed list of constants, never caller input.
      db.exec(`PRAGMA user_version = ${Math.trunc(migration.version)}`);
      db.exec("COMMIT");
      applied.push(migration.version);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Already unwound.
      }
      throw error;
    }
  }

  return { from: current, to: TARGET_VERSION, applied };
}

/**
 * Parse a stored document.
 *
 * A parse failure returns the RAW STRING rather than throwing, and this is
 * deliberate: a corrupted row must reach reconciliation as **corruption** — which
 * ADR-005 §7.3 makes an alarm — rather than as an exception that stops the boot
 * before the operator is told anything.
 */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { __unparseable: text };
  }
}