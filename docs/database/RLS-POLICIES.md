# Row-Level Security (RLS) Policies (RLS-POLICIES.md)

## 1. Mandatory Per-User & Per-Tenant Isolation
Row-Level Security is enabled across all 7 tables (users, sessions, telemetry_logs, patch_proposals, circuit_breakers, merkle_ledger, access_requests). Every database query and mutation requires a verified RLSContext (currentUserId and currentTenantId).

## 2. Active Policy Rules
- SELECT Policy (Read): owner_user_id = current_user_id() AND tenant_id = current_tenant_id()
- INSERT Policy (Write): owner_user_id = current_user_id() AND tenant_id = current_tenant_id()
- UPDATE Policy (Mutate): owner_user_id = current_user_id() AND tenant_id = current_tenant_id() (Denied on append-only telemetry_logs and merkle_ledger)
- DELETE Policy: Denied on audit tables; restricted to row owner on ephemeral sessions.
