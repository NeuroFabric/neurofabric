CREATE TABLE IF NOT EXISTS approval_tasks (
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
CREATE INDEX IF NOT EXISTS idx_approval_tasks_status ON approval_tasks(status);