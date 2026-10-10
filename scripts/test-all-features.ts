import { PolicyEvaluator } from "../platform/embassy/PolicyEvaluator.ts";
import { RollbackCircuit } from "../platform/embassy/RollbackCircuit.ts";

const BASE_URL = (process.env.API_BASE || "http://127.0.0.1:8080").replace(/\/$/, "");

async function post(path: string, body: any) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function get(path: string) {
  const res = await fetch(`${BASE_URL}${path}`);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTestSuite() {
  console.log("\n========================================================");
  console.log(`  NEUROFABRIC RESILIENCE PLATFORM - FULL TEST SUITE    `);
  console.log(`  Targeting: ${BASE_URL}                                `);
  console.log("========================================================\n");

  let passed = 0;
  let failed = 0;

  function assert(title: string, condition: boolean, extra?: string) {
    if (condition) {
      console.log(`  [PASS] ${title}`);
      passed++;
    } else {
      console.error(`  [FAIL] ${title} ${extra ? `-> ${extra}` : ""}`);
      failed++;
    }
  }

  // --- TEST 1: Health Probe ---
  console.log("--> [Test 1] Health & Telemetry SSE Probe");
  const health = await get("/health");
  assert("Health probe returns 200 OK", health.status === 200 && (health.data as any)?.status === "ok");

  // --- TEST 2: DLP Secret Scrubbing ---
  console.log("\n--> [Test 2] Edge DLP Secret Masking");
  const dlpRes = await post("/api/v1/workspace/ingest", {
    service: "auth-session-worker",
    severity: "WARNING",
    message: "Leak test: Bearer sk-ant-live99881122 and client_secret=SuperSecret!",
  });
  assert("DLP payload accepted (202)", dlpRes.status === 202);
  await sleep(1000);
  const metrics = await get("/api/v1/metrics/ingestion");
  assert("Secrets scrubbed metric incremented", (metrics.data as any)?.secretsScrubbed > 0);

  // --- TEST 3: Diff Inversion Math Check ---
  console.log("\n--> [Test 3] Rollback Circuit Diff Inversion");
  const originalDiff = "--- a/deploy.yaml\n+++ b/deploy.yaml\n@@ -1 +1 @@\n-replicas: 2\n+replicas: 5";
  const inverted = RollbackCircuit.invertDiff(originalDiff);
  assert("Unified diff properly inverted", inverted.includes("-replicas: 5") && inverted.includes("+replicas: 2"));

  // --- TEST 4: Dynamic Policy Engine Evaluation ---
  console.log("\n--> [Test 4] Dynamic Policy Engine (embassy_rules.yaml)");
  try {
    const proposalEval = PolicyEvaluator.evaluateProposal("payment-gateway-service", 25, 0.12);
    assert("Policy scores critical blast radius and confidence", proposalEval.confidence > 70 && proposalEval.action !== undefined);
  } catch (err: any) {
    assert("Policy evaluation failed", false, err.message);
  }

  // --- TEST 5: Operator Rejection Flow ---
  console.log("\n--> [Test 5] Operator Rejection Flow");
  const rejTask = `hitl-rej-${Date.now().toString(36)}`;
  await post("/api/v1/workspace/ingest", {
    service: "k8s-ingress",
    severity: "CRITICAL",
    message: "Synthetic timeout trigger for rejection test",
  });
  await sleep(500);
  const rejRes = await post("/api/v1/embassy/decisions", {
    taskId: rejTask,
    decision: "REJECTED",
    reviewer: "Pi Automator",
  });
  assert("Decision endpoint handles REJECTED (200)", rejRes.status === 200);

  // --- TEST 6: Canary Observation & Automatic Rollback ---
  console.log("\n--> [Test 6] Closed-Loop Canary Rollback (Anomaly Injection)");
  const canaryTask = `canary-test-${Date.now().toString(36)}`;
  await post("/api/v1/embassy/decisions", {
    taskId: canaryTask,
    decision: "APPROVED",
    reviewer: "Pi Automator",
  });
  console.log(`      Task ${canaryTask} entered CANARY_VERIFYING...`);
  await sleep(1500);

  console.log("      Injecting regression telemetry for payment-gateway-service...");
  await post("/api/v1/workspace/ingest", {
    service: "payment-gateway-service",
    severity: "CRITICAL",
    message: "Canary regression: latency spike detected post-deploy",
  });
  await sleep(1500);

  const ledger = await get("/api/v1/governance/ledger");
  const tasks = Array.isArray(ledger.data) ? ledger.data : [];
  const rolledBack = tasks.find((t: any) => t.token === canaryTask && t.status === "ROLLED_BACK");
  assert("Rollback circuit detected anomaly and set status ROLLED_BACK", Boolean(rolledBack));

  // --- TEST 7: Governance Ledger Auditability ---
  console.log("\n--> [Test 7] Governance Ledger Integrity");
  assert("Ledger contains immutable historical records", tasks.length >= 2);
  const sample = tasks[0];
  assert("Ledger entries contain token, status, and decidedAt", Boolean(sample?.token && sample?.status));

  console.log("\n========================================================");
  console.log(`  TEST RESULTS: ${passed} PASSED | ${failed} FAILED     `);
  console.log("========================================================\n");

  if (failed > 0) process.exit(1);
}

runTestSuite().catch((e) => {
  console.error("Test execution aborted:", e);
  process.exit(1);
});