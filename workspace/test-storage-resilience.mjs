import { createHash, randomUUID } from "node:crypto";
import { sovereignStorage } from "../platform/core/storage.ts";

const SERVICE = "order-processing-node";
const TOTAL_ENTRIES = 100;
const CRITICAL_ENTRIES = 3;
const DEDUP_WINDOW_MS = 60_000;

const runId = randomUUID();
const duplicateMessage = `synthetic duplicate telemetry run=${runId}`;
const duplicateHash = createHash("sha256")
  .update(`order-processing-node:${duplicateMessage}`)
  .digest("hex");

function entryHash(index, severity, message) {
  return severity === "CRITICAL"
    ? createHash("sha256").update(`${runId}:${index}:${message}`).digest("hex")
    : duplicateHash;
}

function makeEntry(index) {
  const isCritical = index < CRITICAL_ENTRIES;
  const severity = isCritical ? "CRITICAL" : "INFO";
  const message = isCritical
    ? `synthetic critical strike ${index + 1} run=${runId}`
    : duplicateMessage;
  return { index, severity, message, hash: entryHash(index, severity, message) };
}

async function fireEntry(entry) {
  const dedup = sovereignStorage.checkAndRecordDedup(
    entry.hash,
    SERVICE,
    DEDUP_WINDOW_MS,
  );

  const result = {
    ...entry,
    suppressed: dedup.suppressed,
    recorded: dedup.suppressed === 0,
    strike: null,
  };

  if (result.recorded) {
    sovereignStorage.recordTelemetry(SERVICE, entry.severity, entry.message, false);
  }

  if (entry.severity === "CRITICAL") {
    result.strike = sovereignStorage.recordCircuitStrike(SERVICE, 3);
  }

  return result;
}

async function main() {
  sovereignStorage.resetCircuit(SERVICE);

  const entries = Array.from({ length: TOTAL_ENTRIES }, (_, index) => makeEntry(index));
  const results = await Promise.all(entries.map((entry) => fireEntry(entry)));

  const duplicateSuppressions = results.filter((result) => result.suppressed > 0).length;
  const suppressedTotal = results.reduce((sum, result) => sum + result.suppressed, 0);
  const recordedLogs = results.filter((result) => result.recorded).length;
  const criticalStrikes = results.filter((result) => result.strike !== null).length;
  const trippedResult = results.find((result) => result.strike?.tripped === true);
  const circuit = sovereignStorage.getCircuitState(SERVICE);
  const recentLogs = sovereignStorage
    .getRecentLogs(100)
    .filter((log) => log.service === SERVICE);

  const checks = [
    {
      name: "100 rapid synthetic log entries fired",
      passed: results.length === TOTAL_ENTRIES,
      detail: `entries=${results.length}`,
    },
    {
      name: "deduplication suppressed duplicate alerts",
      passed: duplicateSuppressions > 0 && suppressedTotal > 0,
      detail: `duplicateSuppressions=${duplicateSuppressions} suppressedTotal=${suppressedTotal}`,
    },
    {
      name: "3 CRITICAL logs logged circuit strikes",
      passed: criticalStrikes === CRITICAL_ENTRIES && circuit?.strikes === CRITICAL_ENTRIES,
      detail: `criticalStrikes=${criticalStrikes} strikes=${circuit?.strikes ?? 0}`,
    },
    {
      name: "circuit breaker tripped === true",
      passed: circuit?.tripped === true && trippedResult !== undefined,
      detail: `tripped=${String(circuit?.tripped)} trippedAfterCritical=${trippedResult ? trippedResult.index + 1 : "never"}`,
    },
    {
      name: "deduplicated telemetry was recorded only once per unique alert",
      passed: recordedLogs === CRITICAL_ENTRIES + 1 && recentLogs.length >= recordedLogs,
      detail: `recordedLogs=${recordedLogs} recentServiceLogs=${recentLogs.length}`,
    },
  ];

  console.log("=== synthetic resilience stress test ===");
  console.log(`service=${SERVICE}`);
  console.log(`entries=${TOTAL_ENTRIES} critical=${CRITICAL_ENTRIES} run=${runId}`);
  for (const check of checks) {
    console.log(`${check.passed ? "[PASS]" : "[FAIL]"} ${check.name} (${check.detail})`);
  }

  const failed = checks.filter((check) => !check.passed).length;
  console.log(`summary: ${checks.length - failed}/${checks.length} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
