# NeuroFabric Sovereign Data Model (DATA-MODEL.md)

## 1. Entity-Relationship Overview
NeuroFabric enforces a strict multi-tenant, per-user Row-Level Security (RLS) relational model backed by SQLite Write-Ahead Logging (WAL). Every operational row is bound to both owner_user_id and tenant_id.

- users (1) ---> (N) sessions (bound by owner_user_id)
- users (1) ---> (N) telemetry_logs (bound by owner_user_id and tenant_id)
- users (1) ---> (N) patch_proposals (bound by owner_user_id and tenant_id)
- users (1) ---> (N) circuit_breakers (bound by owner_user_id and tenant_id)
- users (1) ---> (N) merkle_ledger (bound by owner_user_id and tenant_id)
- users (1) ---> (N) access_requests (bound by owner_user_id and tenant_id)

## 2. Core Data Minimization Principles (DPDP Act 2023 & GDPR Art. 5)
1. Zero Raw PII Persistence: All telemetry payloads pass through scrubIndianAndGlobalPII() before WAL insertion.
2. Zero Plaintext Passwords or Tokens: Passwords use PBKDF2-HMAC-SHA256 (100,000 iterations) with per-user salts; session tokens store only their SHA-256 digest.
3. Per-User Row Ownership: Every user-generated record carries owner_user_id so operators can only read or mutate their own rows.
