const BASE = "http://127.0.0.1:8080";
const SERVICE = "auth-service";
const INGESTION_KEY = "nf-edge-telemetry-token-2026";
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

async function request(method, path, body, headers = {}) {
  const init = {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const response = await fetch(`${BASE}${path}`, init);
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

async function main() {
  const checks = [];

  function check(name, passed, detail) {
    checks.push({ name, passed, detail });
    console.log(`${passed ? "[PASS]" : "[FAIL]"} ${name} (${detail})`);
  }

  function trace(step, message) {
    console.log(`[${step}] ${message}`);
  }

  trace("1/6", "resetting baseline circuit breaker for auth-service");
  const baselineReset = await request("POST", "/api/v1/embassy/reset-breaker", {
    target: SERVICE,
  });
  check(
    "baseline circuit breaker reset",
    baselineReset.status === 200 && baselineReset.data?.success === true,
    `HTTP ${baselineReset.status} success=${String(baselineReset.data?.success)}`,
  );

  trace("2/6", "sending 3 sequential CRITICAL auth-service logs with dirty secrets");
  const rawSecrets = [];
  const ingestionResults = [];

  for (let index = 1; index <= 3; index += 1) {
    const dirtyPassword = `password-2am-${RUN_ID}-${index}`;
    const dirtyToken = `sk-ant-live-${RUN_ID}-${index}`;
    const message =
      `auth-service 2AM cascading failure run=${RUN_ID} seq=${index}: `
      + `password=${dirtyPassword} token=Bearer ${dirtyToken}`;

    rawSecrets.push(dirtyPassword, dirtyToken);

    const result = await request(
      "POST",
      "/api/v1/workspace/ingest",
      {
        service: SERVICE,
        severity: "CRITICAL",
        message,
      },
      { "x-ingest-key": INGESTION_KEY },
    );
    ingestionResults.push(result);
    trace(
      `ingest ${index}/3`,
      `HTTP ${result.status} suppressed=${result.data?.suppressed ?? 0}`,
    );
  }

  check(
    "3 sequential CRITICAL logs accepted by edge ingestion",
    ingestionResults.every((result) => result.status === 202),
    `statuses=${ingestionResults.map((result) => result.status).join(",")}`,
  );

  trace("3/6", "verifying DLP scrubbing in recent workspace logs");
  const logsResponse = await request("GET", "/api/v1/workspace/recent-logs");
  const incidentLogs = (Array.isArray(logsResponse.data) ? logsResponse.data : [])
    .filter((log) =>
      log.service === SERVICE
      && log.severity === "CRITICAL"
      && String(log.message).includes(RUN_ID),
    )
    .slice(-3);
  const dlpPassed = incidentLogs.length === 3
    && incidentLogs.every((log) =>
      log.dlpScrubbed === true
      && log.message.includes("[REDACTED_SECRET]")
      && rawSecrets.every((secret) => !log.message.includes(secret)));

  check(
    "DLP scrubbed dirty passwords and tokens",
    dlpPassed,
    `incidentLogs=${incidentLogs.length} scrubbed=${incidentLogs.filter((log) => log.dlpScrubbed).length}`,
  );

  trace("4/6", "confirming the third CRITICAL log tripped the circuit breaker");
  const blockedDecision = await request("POST", "/api/v1/embassy/decisions", {
    taskId: `task-2am-blocked-${RUN_ID}`,
    target: SERVICE,
    decision: "APPROVED",
    reviewer: "Incident Commander",
  });
  const breakerTripped = blockedDecision.status === 423
    && blockedDecision.data?.status === "CIRCUIT_TRIPPED";
  check(
    "third CRITICAL log trips circuit breaker for auth-service",
    breakerTripped,
    `HTTP ${blockedDecision.status} status=${blockedDecision.data?.status}`,
  );

  trace("5/6", "resetting the tripped circuit breaker");
  const reset = await request("POST", "/api/v1/embassy/reset-breaker", {
    target: SERVICE,
  });
  check(
    "circuit breaker reset succeeded",
    reset.status === 200 && reset.data?.success === true,
    `HTTP ${reset.status} success=${String(reset.data?.success)}`,
  );

  trace("6/6", "re-submitting a clean remediation decision");
  const cleanDiff =
    "--- a/auth-service.yaml\n+++ b/auth-service.yaml\n@@ -1 +1 @@\n-replicas: 2\n+replicas: 3";
  const cleanDecision = await request("POST", "/api/v1/embassy/decisions", {
    taskId: `task-2am-clean-${RUN_ID}`,
    target: SERVICE,
    decision: "APPROVED",
    diff: cleanDiff,
    reviewer: "Incident Commander",
  });
  const gitopsBranch = cleanDecision.data?.gitops?.branch;
  const cleanDecisionPassed = cleanDecision.status === 200
    && cleanDecision.data?.status === "APPROVED"
    && typeof gitopsBranch === "string"
    && gitopsBranch.startsWith("neurofabric/remediation-");

  check(
    "clean remediation decision approved with GitOps PR branch",
    cleanDecisionPassed,
    `HTTP ${cleanDecision.status} status=${cleanDecision.data?.status} branch=${gitopsBranch}`,
  );

  const failed = checks.filter((entry) => !entry.passed).length;
  console.log(`summary: ${checks.length - failed}/${checks.length} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

try {
  await main();
} catch (error) {
  console.error("2AM incident simulation failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
