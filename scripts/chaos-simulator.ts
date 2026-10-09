const INGEST_URL = 'http://127.0.0.1:8080/api/v1/workspace/ingest';

async function send(payload: any) {
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
  const results = await Promise.all(payloads.map(p => send(p)));
  console.table(results);
}

runChaos();
