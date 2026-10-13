import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

export interface TelemetryLog {
  id?: number;
  service: string;
  severity: string;
  message: string;
  dlpScrubbed: boolean;
  createdAt: number;
}

export interface CircuitState {
  service: string;
  strikes: number;
  tripped: boolean;
  lastStrike: number;
}

export interface HitlTask {
  taskId: string;
  target?: string;
  diff?: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANARY_VERIFYING";
  reviewer?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CapabilityRecord {
  token: string;
  username: string;
  role: "COMMANDER" | "AUDITOR" | "OPERATOR";
  createdAt: number;
  expiresAt: number;
}

export class SovereignStorage {
  private db: DatabaseSync;
  private static instance: SovereignStorage | null = null;

  private constructor(dbPath?: string) {
    const targetDir = path.resolve(process.cwd(), "workspace");
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const file = dbPath || path.join(targetDir, ".neurofabric.db");
    this.db = (fs.mkdirSync(path.dirname(file), { recursive: true }), new DatabaseSync(file));
    this.initPragmas();
    this.migrate();
  }

  public static getInstance(dbPath?: string): SovereignStorage {
    if (!SovereignStorage.instance) {
      SovereignStorage.instance = new SovereignStorage(dbPath);
    }
    return SovereignStorage.instance;
  }

  private initPragmas(): void {
    // Enable WAL for concurrent multi-process readers + busy_timeout for lock resilience
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        leaf_hash TEXT NOT NULL,
        entry_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS circuit_breakers (
        service TEXT PRIMARY KEY,
        strikes INTEGER NOT NULL DEFAULT 0,
        tripped INTEGER NOT NULL DEFAULT 0,
        last_strike INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS hitl_tasks (
        task_id TEXT PRIMARY KEY,
        target TEXT,
        diff TEXT,
        status TEXT NOT NULL,
        reviewer TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS telemetry_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        dlp_scrubbed INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dedup_cache (
        hash TEXT PRIMARY KEY,
        service TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        seen_count INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS capabilities (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  // --- Audit Ledger Operations ---
  public appendAudit(entryType: string, payload: unknown, leafHash: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO audit_ledger (leaf_hash, entry_type, payload, timestamp)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(leafHash, entryType, JSON.stringify(payload), new Date().toISOString());
  }

  public getAuditEntries(limit: number = 100): Array<{ id: number; leafHash: string; entryType: string; payload: any; timestamp: string }> {
    const stmt = this.db.prepare(`SELECT id, leaf_hash as leafHash, entry_type as entryType, payload, timestamp FROM audit_ledger ORDER BY id DESC LIMIT ?`);
    const rows = stmt.all(limit) as any[];
    return rows.map(r => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  // --- Circuit Breaker Operations ---
  public recordCircuitStrike(service: string, threshold: number = 3): CircuitState {
    const now = Date.now();
    const existing = this.getCircuitState(service);
    const strikes = (existing?.strikes || 0) + 1;
    const tripped = strikes >= threshold ? 1 : 0;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO circuit_breakers (service, strikes, tripped, last_strike)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(service, strikes, tripped, now);
    return { service, strikes, tripped: Boolean(tripped), lastStrike: now };
  }

  public resetCircuit(service: string): void {
    const stmt = this.db.prepare(`
      UPDATE circuit_breakers SET strikes = 0, tripped = 0 WHERE service = ?
    `);
    stmt.run(service);
  }

  public getCircuitState(service: string): CircuitState | null {
    const stmt = this.db.prepare(`SELECT service, strikes, tripped, last_strike as lastStrike FROM circuit_breakers WHERE service = ?`);
    const row = stmt.get(service) as any;
    if (!row) return null;
    return { service: row.service, strikes: row.strikes, tripped: Boolean(row.tripped), lastStrike: row.lastStrike };
  }

  // --- Deduplication & Telemetry Operations ---
  public checkAndRecordDedup(hash: string, service: string, windowMs: number = 60000): { suppressed: number } {
    const now = Date.now();
    const existing = this.db.prepare(`SELECT * FROM dedup_cache WHERE hash = ?`).get(hash) as any;

    if (existing && (now - existing.first_seen) < windowMs) {
      this.db.prepare(`UPDATE dedup_cache SET seen_count = seen_count + 1, last_seen = ? WHERE hash = ?`).run(now, hash);
      return { suppressed: existing.seen_count };
    }

    this.db.prepare(`INSERT OR REPLACE INTO dedup_cache (hash, service, first_seen, last_seen, seen_count) VALUES (?, ?, ?, ?, 1)`).run(hash, service, now, now);
    return { suppressed: 0 };
  }

  public recordTelemetry(service: string, severity: string, message: string, dlpScrubbed: boolean): void {
    const stmt = this.db.prepare(`
      INSERT INTO telemetry_logs (service, severity, message, dlp_scrubbed, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(service, severity, message, dlpScrubbed ? 1 : 0, Date.now());
  }

  public getRecentLogs(limit: number = 50): TelemetryLog[] {
    const stmt = this.db.prepare(`
      SELECT service, severity, message, dlp_scrubbed as dlpScrubbed, created_at as createdAt
      FROM telemetry_logs ORDER BY id DESC LIMIT ?
    `);
    const rows = stmt.all(limit) as any[];
    return rows.map(r => ({ ...r, dlpScrubbed: Boolean(r.dlpScrubbed) }));
  }

  // --- Capability Token Operations ---
  public storeCapability(token: string, username: string, role: "COMMANDER" | "AUDITOR" | "OPERATOR", ttlMs: number = 86400000): CapabilityRecord {
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO capabilities (token, username, role, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(token, username, role, now, expiresAt);
    return { token, username, role, createdAt: now, expiresAt };
  }

  public verifyCapability(token: string): CapabilityRecord | null {
    const stmt = this.db.prepare(`SELECT token, username, role, created_at as createdAt, expires_at as expiresAt FROM capabilities WHERE token = ?`);
    const row = stmt.get(token) as any;
    if (!row) return null;
    if (Date.now() > row.expiresAt) return null;
    return row as CapabilityRecord;
  }
}

export const sovereignStorage = SovereignStorage.getInstance();
