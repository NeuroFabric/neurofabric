# NeuroFabric Database Schema Specification (SCHEMA.md)

## Engine Configuration
- Engine: SQLite 3 with PRAGMA journal_mode = WAL;
- Foreign Keys: PRAGMA foreign_keys = ON;
- Synchronous Mode: PRAGMA synchronous = NORMAL;

## DDL Table Definitions
1. users: id (PK), owner_user_id, email (UNIQUE), name, role, clearance, tenant_id, password_pbkdf2, mfa_enforced, status, permissions_json, created_at
2. sessions: id (PK), owner_user_id (FK -> users.id), tenant_id, token_sha256 (UNIQUE), ip_address, expires_at_epoch, created_at
3. telemetry_logs: id (PK), owner_user_id (FK -> users.id), tenant_id, epoch_ms, timestamp, severity, service, message, dlp_scrubbed, suppressed_count
4. patch_proposals: task_id (PK), owner_user_id (FK -> users.id), tenant_id, pr_number, repository, target_branch, commit_sha, title, target_file, service, severity, confidence, ast_status, status, canary_percentage, rca_summary, diff_json, created_at
5. circuit_breakers: service_name (PK), owner_user_id (FK -> users.id), tenant_id, strikes, max_strikes, status, cooldown_sec, latency_ms, error_rate, updated_at
6. merkle_ledger: leaf_index (PK AUTOINCREMENT), owner_user_id (FK -> users.id), tenant_id, action, target, operator_label, timestamp, prev_hash, leaf_hash (UNIQUE)
7. access_requests: id (PK), owner_user_id, email, name, requested_clearance, tenant_id, reason, status, requested_at
