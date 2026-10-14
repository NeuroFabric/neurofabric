import fs from 'node:fs';
import path from 'node:path';

const sql = `CREATE TABLE IF NOT EXISTS approval_tasks (
  task_token TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'refused', 'expired', 'consumed')),
  subject_json TEXT NOT NULL,
  result_json TEXT,
  decided_at INTEGER,
  approved_by TEXT,
  reason TEXT,
  result_expires_at INTEGER,
  collected_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_approval_tasks_status ON approval_tasks(status);`;

const dir = path.join('platform', 'embassy', 'migrations');
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}
fs.writeFileSync(path.join(dir, '003_approval_tasks.sql'), sql);
console.log('Migration file written.');