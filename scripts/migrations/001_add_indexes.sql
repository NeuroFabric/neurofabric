-- ============================================================================
-- 001_add_indexes.sql — NeuroFabric PostgreSQL Migration
-- ============================================================================
-- Add B-tree and GIN indexes for the approval_tasks table to optimize
-- governance ledger queries, duplicate detection, and canary observation.
-- Run: psql $DATABASE_URL -f scripts/migrations/001_add_indexes.sql
-- ============================================================================

-- CONCURRENT B-tree index on task_token (primary lookup key)
-- This accelerates task token lookups, governance result collection, and
-- status-based queries. IF NOT EXISTS ensures idempotent re-runs.
CREATE INDEX IF NOT EXISTS idx_approval_tasks_task_token
  ON approval_tasks (task_token ASC)
  WHERE task_token IS NOT NULL;

-- CONCURRENT B-tree index on status + created_at DESC
-- Optimizes canary observation windows and status-based polling:
--   SELECT * FROM approval_tasks WHERE status = 'PENDING' ORDER BY created_at DESC
--   SELECT * FROM approval_tasks WHERE status IN ('CANARY_VERIFYING','ROLLED_BACK','VERIFIED_RESOLVED') ORDER BY created_at DESC
CREATE INDEX IF NOT EXISTS idx_approval_tasks_status_created
  ON approval_tasks (status ASC, created_at DESC)
  WHERE status IS NOT NULL;

-- Partial index: only PENDING tasks — smallest working set for resumption
CREATE INDEX IF NOT EXISTS idx_approval_tasks_pending
  ON approval_tasks (task_token ASC, created_at DESC)
  WHERE status = 'PENDING';

-- GIN index on subject_json for rapid key/value lookups within the
-- stored proposal metadata (e.g. finding all tasks that mention a given
-- service or source in their embedded diff/patch metadata).
CREATE INDEX IF NOT EXISTS idx_approval_tasks_subject_json_gin
  ON approval_tasks USING GIN (subject_json);

-- Comment summary
COMMENT ON INDEX idx_approval_tasks_task_token IS 'Primary task token lookup index';
COMMENT ON INDEX idx_approval_tasks_status_created IS 'Status + creation-order index for canary/polling';
COMMENT ON INDEX idx_approval_tasks_pending IS 'Partial index for PENDING task resumption';
COMMENT ON INDEX idx_approval_tasks_subject_json_gin IS 'GIN index for subject JSON metadata queries';