-- k8s/init-schema.sql
-- Enterprise Schema Definition for NeuroFebric Governance Ledger

CREATE TABLE IF NOT EXISTS approval_tasks (
    task_token VARCHAR(255) PRIMARY KEY,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    
    -- JSONB allows for high-performance indexing and querying of nested telemetry
    subject_json JSONB NOT NULL,
    result_json JSONB,
    
    -- Audit & Traceability
    approved_by VARCHAR(255),
    reason TEXT,
    owasp_ref VARCHAR(255),
    nist_ref VARCHAR(255),
    
    -- Epoch Timestamps (BIGINT to match the existing Node.js epoch logic)
    created_at BIGINT NOT NULL,
    decided_at BIGINT,
    collected_at BIGINT,
    result_expires_at BIGINT
);

-- High-performance indices for the Incident Commander dashboard filters
CREATE INDEX idx_approval_status ON approval_tasks(status);
CREATE INDEX idx_approval_created ON approval_tasks(created_at DESC);
CREATE INDEX idx_approval_owasp ON approval_tasks(owasp_ref);
CREATE INDEX idx_approval_nist ON approval_tasks(nist_ref);