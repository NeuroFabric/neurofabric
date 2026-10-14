import { performance } from "node:perf_hooks";
import { eventBridge } from "../platform/core/event-bridge.ts";

const TOPIC = "test.mcp_action";
const EXPECTED_PAYLOAD = {
  agent: "Pi",
  action: "CREDENTIAL_REFUSED",
  reason: "high-severity",
};

function payloadMatches(actual, expected) {
  if (typeof actual !== "object" || actual === null) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.length !== expectedKeys.length) return false;
  if (actualKeys.join(",") !== expectedKeys.join(",")) return false;
  return actual.agent === expected.agent
    && actual.action === expected.action
    && actual.reason === expected.reason;
}

async function main() {
  const publishStart = performance.now();

  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("timed out waiting for event delivery"));
    }, 5_000);

    const unsubscribe = eventBridge.subscribe((event) => {
      if (event.topic !== TOPIC) return;

      const latencyMs = performance.now() - publishStart;
      clearTimeout(timeout);
      unsubscribe();

      resolve({
        received: true,
        latencyMs,
        payloadMatched: payloadMatches(event.payload, EXPECTED_PAYLOAD),
        event,
      });
    });

    eventBridge.publish(TOPIC, EXPECTED_PAYLOAD);
  });

  const latencyOk = result.latencyMs < 200;
  const checks = [
    {
      name: "event propagated through SQLite to subscriber",
      passed: result.received === true,
      detail: `topic=${TOPIC}`,
    },
    {
      name: "payload matches published event",
      passed: result.payloadMatched === true,
      detail: JSON.stringify(result.event?.payload),
    },
    {
      name: "latency is under 200ms",
      passed: latencyOk,
      detail: `latency=${result.latencyMs.toFixed(3)}ms`,
    },
  ];

  console.log("=== real-time EventBridge propagation test ===");
  console.log(`topic=${TOPIC}`);
  console.log(`expectedPayload=${JSON.stringify(EXPECTED_PAYLOAD)}`);
  for (const check of checks) {
    console.log(`${check.passed ? "[PASS]" : "[FAIL]"} ${check.name} (${check.detail})`);
  }

  const failed = checks.filter((check) => !check.passed).length;
  console.log(`summary: ${checks.length - failed}/${checks.length} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

await main();
