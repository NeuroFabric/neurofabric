import { sovereignStorage } from "./storage.ts";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

export interface PlatformEvent {
  id?: number;
  topic: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export class EventBridge {
  private static instance: EventBridge | null = null;
  private db: DatabaseSync;
  private lastSeenId: number = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private subscribers: Set<(event: PlatformEvent) => void> = new Set();

  private constructor() {
    const targetDir = path.resolve(process.cwd(), "workspace");
    const file = path.join(targetDir, ".neurofabric.db");
    this.db = new DatabaseSync(file);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS platform_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_platform_events_id ON platform_events(id);
    `);

    // Initialize lastSeenId to the highest current event
    const row = this.db.prepare("SELECT MAX(id) as maxId FROM platform_events").get() as any;
    this.lastSeenId = row?.maxId || 0;
  }

  public static getInstance(): EventBridge {
    if (!EventBridge.instance) {
      EventBridge.instance = new EventBridge();
    }
    return EventBridge.instance;
  }

  /**
   * Publish an event from ANY process into the shared SQLite event journal
   */
  public publish(topic: string, payload: Record<string, unknown>): number {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO platform_events (topic, payload, created_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(topic, JSON.stringify(payload), now);

    const row = this.db.prepare("SELECT last_insert_rowid() as id").get() as any;
    return row?.id || 0;
  }

  /**
   * Subscribe to new cross-process events via lightweight polling
   */
  public subscribe(handler: (event: PlatformEvent) => void): () => void {
    this.subscribers.add(handler);

    if (!this.pollTimer) {
      this.startPolling();
    }

    return () => {
      this.subscribers.delete(handler);
      if (this.subscribers.size === 0 && this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    };
  }

  private startPolling(intervalMs: number = 75): void {
    this.pollTimer = setInterval(() => {
      try {
        const stmt = this.db.prepare(`
          SELECT id, topic, payload, created_at as createdAt
          FROM platform_events
          WHERE id > ?
          ORDER BY id ASC
          LIMIT 50
        `);
        const rows = stmt.all(this.lastSeenId) as any[];

        for (const row of rows) {
          this.lastSeenId = row.id;
          const evt: PlatformEvent = {
            id: row.id,
            topic: row.topic,
            payload: JSON.parse(row.payload),
            createdAt: row.createdAt,
          };
          for (const sub of this.subscribers) {
            try { sub(evt); } catch {}
          }
        }
      } catch {}
    }, intervalMs);
  }
}

export const eventBridge = EventBridge.getInstance();
