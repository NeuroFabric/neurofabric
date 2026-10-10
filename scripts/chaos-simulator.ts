const INGEST_URL = 'https://neurofabric-backend.onrender.com/api/v1/workspace/ingest';
const EMBASSY_DECISIONS_URL = 'https://neurofabric-backend.onrender.com/api/v1/embassy/decisions';

async function ingestPayload(payload: any) {
  const start = Date.now();
  try {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return { status: res.status, latencyMs: Date.now() - start, source: payload.source };
  } catch (err: any) {
    return { status: 'ERR', latencyMs: Date.now() - start, error: err.message, source: payload.source };
  }
}

async function approveDecision(taskId: string) {
  const start = Date.now();
  try {
    const res = await fetch(EMBASSY_DECISIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId, decision: 'APPROVED', reviewer: 'operator' })
    });
    const data = await res.json();
    return { status: res.status, latencyMs: Date.now() - start, data };
  } catch (err: any) {
    return { status: 'ERR', latencyMs: Date.now() - start, error: err.message };
  }
}

async function runChaos() {
  console.log('Dispatched instant-burst chaos telemetry...');
  const payloads = [
    ...Array(5).fill(null).map(() => ({
      source: 'postgres-shard',
      severity: 'critical',
      message: 'Connection pool exhausted: max connections 500 reached',
      raw_log: 'FATAL: remaining connection slots are reserved for non-replication superuser'
    })),
    {
      source: 'auth-gateway',
      severity: 'warning',
      message: 'Token verification failed during authorization',
      raw_log: 'auth_err: token=AKIAIOSFODNN7EXAMPLE secret=ghp_ABC123456789012345678901234567890123'
    },
    { source: 'k8s-ingress', severity: 'info', message: 'HTTP 502 rate spike across edge proxies', raw_log: 'upstream connect error or disconnect/reset' },
    { source: 'payment-gateway-service', severity: 'critical', message: 'Deadlock on checkout transaction table', raw_log: 'Deadlock detected: waiting on Lock transaction_id=98124' },
    { source: 'redis-cluster', severity: 'warning', message: 'OOM command dropped: maxmemory policy reached', raw_log: 'Command evicted 142 keys to maintain threshold' }
  ];
  const results = await Promise.all(payloads.map(p => ingestPayload(p)));
  console.table(results);

  // Canary failure mode: trigger proposal, approve, then inject critical error
  if (process.argv.includes('--mode=canary-failure')) {
    console.log('\n=== Canary Failure Mode Simulation ===\n');

    // Step 1: Emit critical event to trigger proposal
    console.log('Step 1: Emitting critical event for payment-gateway-service...');
    const ingestResult = await ingestPayload({
      source: 'payment-gateway-service',
      severity: 'critical',
      message: 'Deadlock on checkout transaction table',
      raw_log: 'Deadlock detected: waiting on Lock transaction_id=98124'
    });
    console.log('Ingest result:', ingestResult);

    // Wait a moment for the system to process
    await new Promise(resolve => setTimeout(resolve, 500));

    // Step 2: Simulate operator approval
    console.log('Step 2: Approving the HITL proposal...');
    try {
      const approveResult = await approveDecision('hitl-task-payment-gateway-1');
      console.log('Approval result:', approveResult);
    } catch (err) {
      console.error('Approval failed:', err);
    }

    // Step 3: Immediately inject another critical error 3 seconds later
    console.log('Step 3: Injecting critical error after 3 seconds...');
    const timeoutId = setTimeout(async () => {
      console.log('Injecting critical error for payment-gateway-service...');
      const errorResult = await ingestPayload({
        source: 'payment-gateway-service',
        severity: 'critical',
        message: 'Canary timeout: response latency exceeded 2s',
        raw_log: 'Timeout waiting for health check response'
      });
      console.error('Error injected:', errorResult);

      // Step 4: Assert rollback occurred by checking the ledger
      setTimeout(async () => {
        try {
          const ledgerRes = await fetch('https://neurofabric-backend.onrender.com/api/v1/governance/ledger');
          const ledger = await ledgerRes.json();
          const rolledBackTask = ledger.find((t: any) => t.status === 'ROLLED_BACK');
          if (rolledBackTask) {
            console.log('\n✓ ASSERTION PASSED: System triggered automatic rollback');
            console.log('  Rolled back task:', rolledBackTask.token);
            console.log('  Status:', rolledBackTask.status);
          } else {
            console.log('\n✗ ASSERTION FAILED: No task rolled back detected');
            console.log('  Last 5 tasks:', ledger.slice(0, 5).map((t: any) => ({ token: t.token, status: t.status })));
          }
        } catch (err) {
          console.error('Failed to check ledger:', err);
        }
        process.exit(0);
      }, 1000);
    }, 3000);
  }
}

runChaos();