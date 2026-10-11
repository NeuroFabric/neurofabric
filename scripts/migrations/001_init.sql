
CREATE TABLE IF NOT EXISTS approval_tasks (
  id VARCHAR(255) PRIMARY KEY,
  task_token VARCHAR(255) NOT NULL UNIQUE,
  target VARCHAR(255) NOT NULL,
  status VARCHAR(64) NOT NULL DEFAULT 'PENDING',
  subject JSONB,
  reason TEXT,
  approved_by VARCHAR(255),
  diff TEXT,
  rca JSONB,
  gitops JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  decided_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_approval_tasks_status ON approval_tasks(status);
CREATE INDEX IF NOT EXISTS idx_approval_tasks_target ON approval_tasks(target);
