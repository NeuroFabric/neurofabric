# NeuroFabric Database Migrations Ledger (MIGRATIONS.md)

## Migration Execution Policy
- Every migration runs inside an atomic BEGIN IMMEDIATE TRANSACTION ... COMMIT block.
- SHA-256 checksums of each migration script are recorded in schema_migrations.
- Failed migrations automatically trigger ROLLBACK and fail closed.

## Ordered Migration History
- 001_init_wal_core.sql: Initialize SQLite WAL, users, sessions, and schema_migrations tables (APPLIED)
- 002_telemetry_and_dlp.sql: Create telemetry_logs with dlp_scrubbed constraints and epoch indices (APPLIED)
- 003_gitops_and_circuits.sql: Create patch_proposals (AST check constraint) and circuit_breakers (APPLIED)
- 004_merkle_audit_chain.sql: Create append-only merkle_ledger with immutability triggers (APPLIED)
- 005_enable_strict_rls.sql: Add owner_user_id foreign keys and Row-Level Security (RLS) enforcement across all 7 tables (APPLIED)
