import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { Pool } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = resolve(__dirname, "migrations");

async function runMigrations() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.log("  [INFO] No DATABASE_URL configured. Skipping Postgres migrations (in-memory mode active).");
    process.exit(0);
  }

  if (!existsSync(MIGRATIONS_DIR)) {
    console.log(`  [INFO] Migrations directory not found at '${MIGRATIONS_DIR}'. Skipping.`);
    process.exit(0);
  }

  const pool = new Pool({
    connectionString: dbUrl,
    connectionTimeoutMillis: 3000,
  });

  try {
    const client = await pool.connect();
    try {
      console.log("  [INFO] Connected to PostgreSQL. Applying schema migrations...");

      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name VARCHAR(255) PRIMARY KEY,
          applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();

      for (const file of files) {
        const filePath = resolve(MIGRATIONS_DIR, file);
        const existing = await client.query(
          "SELECT name FROM schema_migrations WHERE name = $1",
          [file]
        );

        if (existing.rows.length > 0) {
          console.log(`  [SKIP] Migration '${file}' already recorded.`);
          continue;
        }

        console.log(`  [APPLY] Running ${file}...`);
        const sql = readFileSync(filePath, "utf8");
        const statements = sql
          .split(";")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        for (const statement of statements) {
          try {
            await client.query(statement);
          } catch (err: any) {
            if (err?.code === "42P07") {
              // duplicate object / index already exists
              continue;
            }
            throw err;
          }
        }

        await client.query(
          "INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING",
          [file]
        );
        console.log(`  [PASS] Successfully applied ${file}.`);
      }
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.warn(`  [WARN] Database connection not available: ${err?.message || err}. Continuing with in-memory store.`);
  } finally {
    await pool.end();
  }
}

runMigrations().catch((err) => {
  console.warn("  [WARN] Migration runner encountered an error:", err?.message || err);
  process.exit(0);
});
