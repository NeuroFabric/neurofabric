import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { Pool } from "pg";

function loadEnvSafe(filepath: string) {
  if (typeof (process as any).loadEnvFile === "function") {
    try {
      (process as any).loadEnvFile(filepath);
      return;
    } catch {}
  }
  try {
    if (existsSync(filepath)) {
      const content = readFileSync(filepath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch {}
}

const parentEnv = resolve(process.cwd(), "../.env");
const localEnv = resolve(process.cwd(), ".env");
if (existsSync(parentEnv)) {
  loadEnvSafe(parentEnv);
} else if (existsSync(localEnv)) {
  loadEnvSafe(localEnv);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const candidateDirs = [
  resolve(__dirname, "migrations"),
  resolve(process.cwd(), "scripts/migrations"),
  resolve(process.cwd(), "platform/migrations"),
  resolve(process.cwd(), "migrations"),
];
const MIGRATIONS_DIR = candidateDirs.find((d) => existsSync(d)) || resolve(__dirname, "migrations");

async function runMigrations() {
  const dbUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

  if (!dbUrl) {
    console.log("  [INFO] No DATABASE_URL configured. Skipping Postgres migrations (in-memory mode active).");
    process.exit(0);
  }

  const pool = new Pool({
    connectionString: dbUrl,
    connectionTimeoutMillis: 15000,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const client = await pool.connect();
    try {
      console.log("  [INFO] Connected to Neon PostgreSQL. Applying schema migrations...");

      // 1. Schema migration tracker
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version VARCHAR(255) PRIMARY KEY,
          applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 2. Baseline table schema with both subject column aliases
      await client.query(`
        CREATE TABLE IF NOT EXISTS approval_tasks (
          id VARCHAR(255) PRIMARY KEY,
          task_token VARCHAR(255) NOT NULL UNIQUE,
          target VARCHAR(255) NOT NULL,
          status VARCHAR(64) NOT NULL DEFAULT 'PENDING',
          subject JSONB,
          subject_json JSONB,
          reason TEXT,
          approved_by VARCHAR(255),
          diff TEXT,
          rca JSONB,
          gitops JSONB,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          decided_at TIMESTAMP WITH TIME ZONE
        );
        ALTER TABLE approval_tasks ADD COLUMN IF NOT EXISTS subject JSONB;
        ALTER TABLE approval_tasks ADD COLUMN IF NOT EXISTS subject_json JSONB;
        CREATE INDEX IF NOT EXISTS idx_approval_tasks_status ON approval_tasks(status);
        CREATE INDEX IF NOT EXISTS idx_approval_tasks_target ON approval_tasks(target);
      `);

      // 3. Apply SQL migrations sequentially, stripping any BOM
      if (existsSync(MIGRATIONS_DIR)) {
        const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
        for (const file of files) {
          const { rows } = await client.query(
            "SELECT version FROM schema_migrations WHERE version = $1",
            [file]
          );
          if (rows.length === 0) {
            const rawContent = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
            // Strip BOM header (\uFEFF) and trim whitespace
            const cleanSql = rawContent.replace(/^\uFEFF/, "").trim();

            if (!cleanSql) {
              await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
              continue;
            }

            try {
              await client.query("BEGIN");
              await client.query(cleanSql);
              await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
              await client.query("COMMIT");
              console.log(`  [PASS] Applied migration: ${file}`);
            } catch (fileErr: any) {
              await client.query("ROLLBACK");
              console.warn(`  [WARN] Migration ${file} failed: ${fileErr?.message || fileErr}`);
              throw fileErr;
            }
          }
        }
      }

      console.log("  [PASS] Migrations synchronized successfully.");
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.warn(`  [WARN] Migration failed: ${err?.message || err}. Continuing with in-memory store.`);
  } finally {
    await pool.end();
  }
}

runMigrations().catch((err) => {
  console.warn("  [WARN] Migration runner encountered an error:", err?.message || err);
  process.exit(0);
});
