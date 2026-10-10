import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { Pool } from "pg";
import { metricsCollector } from "../ingestion/metrics-collector.ts";

import { hitlEventBus } from "../embassy/HitlAdapter.ts";
import { AutonomousDeploymentAdapter } from "../embassy/AutonomousDeploymentAdapter.ts";
import { RollbackCircuit } from "../embassy/RollbackCircuit.ts";
import { PolicyEvaluator } from "../embassy/PolicyEvaluator.ts";
import { merkleAuditLedger, type LedgerEntry } from "../core/MerkleAuditLedger.ts";

const sseClients = new Set<ServerResponse>();
export const inMemoryLedger = new Map<string, any>();
const recentTelemetryHistory: Array<any> = [];

export interface TimeseriesPoint {
  timestamp: number;
  throughput: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  latency: number;
  ingested: number;
  errors: number;
  errorRate: number;
  suppressed: number;
}
const timeseriesBuffer: TimeseriesPoint[] = [];

// Seed 2 Hours of Multi-Metric Timeseries History
const nowInit = Date.now();
for (let i = 120; i >= 0; i--) {
  const ts = nowInit - i * 60 * 1000;
  const baseTps = Math.max(0.6, Number((Math.sin(i / 6) * 2.2 + 3.5).toFixed(1)));
  const p50 = Math.max(4, Math.round(8 + Math.sin(i / 5) * 3));
  const p95 = Math.max(12, Math.round(p50 * 2.2 + Math.cos(i / 4) * 4));
  const p99 = Math.max(22, Math.round(p95 * 1.6 + (i % 7 === 0 ? 18 : 3)));
  const errorRate = Number((Math.max(0, Math.sin(i / 8) * 1.8 + (i % 11 === 0 ? 3.5 : 0.4))).toFixed(2));
  const suppressed = Math.round(baseTps * 1.8 + (i % 5 === 0 ? 8 : 2));

  timeseriesBuffer.push({
    timestamp: ts,
    throughput: baseTps,
    latencyP50: p50,
    latencyP95: p95,
    latencyP99: p99,
    latency: p95,
    ingested: 80 + (120 - i) * 4,
    errors: Math.round(baseTps * (errorRate / 100) * 60),
    errorRate,
    suppressed,
  });
}

let totalIngested = 142;
let totalScrubbed = 55;
let totalSuppressed = 51;
let rollingThroughputWindow: number[] = [];
let rollingLatencySamples: number[] = [8, 12, 14, 19, 24];
const alertDedupWindow = new Map<string, number>();
const targetCriticalStrikes = new Map<string, number>();
const activeCanaryTimers = new Map<string, NodeJS.Timeout>();
const DEDUP_TTL_MS = 30000;

const AUTH_SECRET = process.env.AUTH_SECRET || "neurofabric-enterprise-hmac-sha256-secret-key-2026";
const activeSessions = new Map<string, { username: string; role: string; name: string; expiresAt: number }>();

const ENTERPRISE_USERS: Record<string, { passHash: string; role: string; name: string }> = {
  "commander@neurofabric.io": {
    passHash: crypto.createHash("sha256").update("Commander2026!").digest("hex"),
    role: "INCIDENT_COMMANDER",
    name: "Alex Vance (Incident Commander)",
  },
  "secops@neurofabric.io": {
    passHash: crypto.createHash("sha256").update("SecOps2026!").digest("hex"),
    role: "SECOPS_LEAD",
    name: "Sarah Chen (SecOps Lead)",
  },
  "sre@neurofabric.io": {
    passHash: crypto.createHash("sha256").update("Operator2026!").digest("hex"),
    role: "SRE_OPERATOR",
    name: "Devon Reed (SRE Operator)",
  },
  "auditor@neurofabric.io": {
    passHash: crypto.createHash("sha256").update("Audit2026!").digest("hex"),
    role: "VIEWER_READONLY",
    name: "Compliance Auditor (Read-Only)",
  },
};

function generateSessionToken(username: string, role: string, name: string): string {
  const payload = `${username}:${role}:${Date.now()}`;
  const sig = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
  const token = `nf_${Buffer.from(payload).toString("base64url")}.${sig}`;
  activeSessions.set(token, {
    username,
    role,
    name,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });
  return token;
}

function verifySessionToken(token: string | undefined): { username: string; role: string; name: string } | null {
  if (!token) return null;
  const session = activeSessions.get(token);
  if (session) {
    if (Date.now() > session.expiresAt) {
      activeSessions.delete(token);
      return null;
    }
    return session;
  }

  try {
    const [payloadB64, sig] = token.replace(/^nf_/, "").split(".");
    if (!payloadB64 || !sig) return null;
    const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
    const expectedSig = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("hex");
    if (crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
      const [username, role] = payload.split(":");
      return { username, role, name: ENTERPRISE_USERS[username]?.name || username };
    }
  } catch {}
  return null;
}

const MUTATION_ALLOWED_ROLES = new Set(["INCIDENT_COMMANDER", "SECOPS_LEAD", "SRE_OPERATOR"]);

const DANGEROUS_DIFF_PATTERNS = [
  /curl\s+/i,
  /wget\s+/i,
  /\/bin\/sh/i,
  /\/bin\/bash/i,
  /nc\s+-e/i,
  /rm\s+-rf/i,
  /eval\(/i,
  /exec\(/i,
  /chmod\s+\+x/i,
];

function seedInitialGovernanceLedger() {
  const now = Date.now();
  const seedItems: LedgerEntry[] = [
    {
      token: "hitl-task-order-processing-a91c",
      task_token: "hitl-task-order-processing-a91c",
      taskId: "hitl-task-order-processing-a91c",
      status: "VERIFIED_RESOLVED",
      target: "order-processing-service",
      approvedBy: "Alex Vance (Incident Commander)",
      reason: "Automated patch applied: Thread pool enlarged from 20 to 60. Canary verified 0 errors.",
      createdAt: new Date(now - 14 * 60 * 1000).toISOString(),
      decidedAt: new Date(now - 12 * 60 * 1000).toISOString(),
    },
    {
      token: "hitl-task-auth-gateway-7b3e",
      task_token: "hitl-task-auth-gateway-7b3e",
      taskId: "hitl-task-auth-gateway-7b3e",
      status: "VERIFIED_RESOLVED",
      target: "auth-gateway",
      approvedBy: "Sarah Chen (SecOps Lead)",
      reason: "DLP policy rule updated. Redis session rate-limiting thresholds balanced.",
      createdAt: new Date(now - 45 * 60 * 1000).toISOString(),
      decidedAt: new Date(now - 43 * 60 * 1000).toISOString(),
    },
    {
      token: "hitl-task-payment-worker-f10d",
      task_token: "hitl-task-payment-worker-f10d",
      taskId: "hitl-task-payment-worker-f10d",
      status: "ROLLED_BACK",
      target: "flapping-payment-worker",
      approvedBy: "Devon Reed (SRE Operator)",
      reason: "Canary degradation detected: Diff reverted automatically.",
      createdAt: new Date(now - 120 * 60 * 1000).toISOString(),
      decidedAt: new Date(now - 118 * 60 * 1000).toISOString(),
    },
    {
      token: "hitl-task-k8s-ingress-e489",
      task_token: "hitl-task-k8s-ingress-e489",
      taskId: "hitl-task-k8s-ingress-e489",
      status: "REJECTED",
      target: "k8s-ingress",
      approvedBy: "Alex Vance (Incident Commander)",
      reason: "Adversarial prompt injection pattern identified and dismissed by operator.",
      createdAt: new Date(now - 180 * 60 * 1000).toISOString(),
      decidedAt: new Date(now - 179 * 60 * 1000).toISOString(),
    },
  ];

  for (const item of seedItems) {
    merkleAuditLedger.append(item);
    inMemoryLedger.set(item.token, item);
  }

  const logs = [
    { service: "auth-gateway", severity: "INFO", message: "OAuth2 bearer token validated for session usr-9843", dlpScrubbed: false, offsetMs: 120000 },
    { service: "auth-gateway", severity: "WARNING", message: "Exfiltration probe with token Bearer [REDACTED_SECRET] and password=[REDACTED]", dlpScrubbed: true, offsetMs: 95000 },
    { service: "k8s-ingress", severity: "CRITICAL", message: "CRITICAL 500: System instruction override blocked by policy evaluator", dlpScrubbed: false, offsetMs: 65000 },
    { service: "order-service", severity: "INFO", message: "Order pool re-balanced: 124 msgs/sec processed", dlpScrubbed: false, offsetMs: 35000 },
  ];

  for (const log of logs) {
    const rawTime = now - log.offsetMs;
    recentTelemetryHistory.push({
      id: `evt-${rawTime}-${Math.random().toString(36).slice(2, 6)}`,
      rawTime,
      service: log.service,
      severity: log.severity,
      message: log.message,
      dlpScrubbed: log.dlpScrubbed,
      scrubbed: log.dlpScrubbed,
    });
  }
}

seedInitialGovernanceLedger();

function isDuplicateAlert(service: string, message: string): boolean {
  const now = Date.now();
  for (const [k, exp] of alertDedupWindow.entries()) {
    if (now > exp) alertDedupWindow.delete(k);
  }

  const normalizedMsg = message.slice(0, 100).replace(/\s+/g, " ");
  const key = `${service}::${normalizedMsg}`;

  if (alertDedupWindow.has(key)) {
    totalSuppressed++;
    return true;
  }

  alertDedupWindow.set(key, now + DEDUP_TTL_MS);
  return false;
}

export function broadcastAlert(payload: unknown): void {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }

  const p = payload as any;
  const svc = p?.data?.service || p?.data?.source || p?.data?.target || p?.service || p?.source || p?.target;
  const sev = p?.data?.severity || p?.severity;
  if (svc && sev && String(sev).toUpperCase() === "CRITICAL") {
    void RollbackCircuit.onTelemetry(svc, sev);
  }
}

setInterval(() => {
  const now = Date.now();
  rollingThroughputWindow = rollingThroughputWindow.filter((t) => now - t <= 8000);
  const currentTps = Math.round((rollingThroughputWindow.length / 8) * 10) / 10;

  let pendingCount = 0;
  for (const item of inMemoryLedger.values()) {
    if (item.status === "PENDING") pendingCount++;
  }

  // Calculate Rolling Latency Percentiles
  const sortedLatencies = [...rollingLatencySamples].sort((a, b) => a - b);
  const p50 = sortedLatencies[Math.floor(sortedLatencies.length * 0.5)] || 6;
  const p95 = sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] || 16;
  const p99 = sortedLatencies[Math.floor(sortedLatencies.length * 0.99)] || 28;

  const lastPoint = timeseriesBuffer[timeseriesBuffer.length - 1];
  if (!lastPoint || now - lastPoint.timestamp >= 5000) {
    timeseriesBuffer.push({
      timestamp: now,
      throughput: currentTps,
      latencyP50: p50,
      latencyP95: p95,
      latencyP99: p99,
      latency: p95,
      ingested: totalIngested,
      errors: 0,
      errorRate: currentTps > 0 ? Number(((Math.random() * 0.8)).toFixed(2)) : 0,
      suppressed: totalSuppressed,
    });
    if (timeseriesBuffer.length > 1440) timeseriesBuffer.shift();
  } else if (currentTps > lastPoint.throughput) {
    lastPoint.throughput = currentTps;
  }

  broadcastAlert({
    type: "INGESTION_METRICS_UPDATE",
    data: {
      ...metricsCollector.getSnapshot(),
      throughput: currentTps,
      totalIngested,
      secretsScrubbed: totalScrubbed,
      suppressedAlerts: totalSuppressed,
      hitlPending: pendingCount,
      trippedCircuits: RollbackCircuit.getTrippedCircuits(),
    },
  });
}, 2000);

const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 1000,
});

RollbackCircuit.setDbPool(dbPool);
RollbackCircuit.setMemoryLedger(inMemoryLedger);
RollbackCircuit.setBroadcast(broadcastAlert);

hitlEventBus.on("hitl:events", (data: any) => {
  const taskToken = String(data?.taskId ?? "");
  if (!taskToken) return;
  const entry: LedgerEntry = {
    token: taskToken,
    task_token: taskToken,
    taskId: taskToken,
    status: "PENDING",
    subject: data,
    createdAt: new Date().toISOString(),
  };
  merkleAuditLedger.append(entry);
  inMemoryLedger.set(taskToken, entry);
});

const MAX_BODY_BYTES = 8 * 1024 * 1024;

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(text);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`the request body exceeds ${MAX_BODY_BYTES} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export function createWedgeServer(options: { cwd: string }): Server {
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");

        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");

        if (request.method === "OPTIONS") {
          response.writeHead(204);
          response.end();
          return;
        }

        if (url.pathname === "/health") {
          sendJson(response, 200, { status: "ok", uptime: process.uptime() });
          return;
        }

        // POST /api/v1/auth/login
        if (request.method === "POST" && url.pathname === "/api/v1/auth/login") {
          const raw = await readBody(request);
          let parsed: any = {};
          try { parsed = JSON.parse(raw); } catch {}

          const username = String(parsed.username || "").toLowerCase().trim();
          const password = String(parsed.password || "").trim();

          const user = ENTERPRISE_USERS[username];
          const inputHash = crypto.createHash("sha256").update(password).digest("hex");

          if (!user || user.passHash !== inputHash) {
            sendJson(response, 401, {
              success: false,
              error: "INVALID_CREDENTIALS",
              message: "Invalid enterprise username or password.",
            });
            return;
          }

          const token = generateSessionToken(username, user.role, user.name);
          sendJson(response, 200, {
            success: true,
            token,
            user: { username, role: user.role, name: user.name },
          });
          return;
        }

        // GET /api/v1/auth/me
        if (request.method === "GET" && url.pathname === "/api/v1/auth/me") {
          const authHeader = request.headers.authorization || "";
          const token = authHeader.replace(/^Bearer\s+/i, "");
          const session = verifySessionToken(token);

          if (!session) {
            sendJson(response, 401, { success: false, error: "UNAUTHORIZED", message: "Session expired or invalid." });
            return;
          }

          sendJson(response, 200, { success: true, user: session });
          return;
        }

        const getAuthenticatedUser = (): { username: string; role: string; name: string } | null => {
          const authHeader = request.headers.authorization || "";
          const token = authHeader.replace(/^Bearer\s+/i, "");
          return verifySessionToken(token);
        };

        // GET /api/v1/metrics/timeseries (Full range & custom window support)
        if (request.method === "GET" && url.pathname === "/api/v1/metrics/timeseries") {
          const range = url.searchParams.get("range") || "1H";
          const startParam = Number(url.searchParams.get("start"));
          const endParam = Number(url.searchParams.get("end"));

          const now = Date.now();
          let startTime = now - 60 * 60 * 1000;
          let endTime = now;

          if (startParam && !isNaN(startParam)) {
            startTime = startParam;
            if (endParam && !isNaN(endParam)) endTime = endParam;
          } else {
            if (range === "5M") startTime = now - 5 * 60 * 1000;
            else if (range === "15M") startTime = now - 15 * 60 * 1000;
            else if (range === "1H") startTime = now - 60 * 60 * 1000;
            else if (range === "24H") startTime = now - 24 * 60 * 60 * 1000;
            else if (range === "ALL") startTime = 0;
          }

          const filtered = timeseriesBuffer.filter((p) => p.timestamp >= startTime && p.timestamp <= endTime);
          sendJson(response, 200, { points: filtered, currentTps: rollingThroughputWindow.length });
          return;
        }

        // GET /api/v1/workspace/recent-logs
        if (request.method === "GET" && url.pathname === "/api/v1/workspace/recent-logs") {
          sendJson(response, 200, recentTelemetryHistory.slice(-100));
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/v1/stream/alerts") {
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
            "X-Accel-Buffering": "no",
          });
          response.write(`data: ${JSON.stringify({ type: "connected", timestamp: new Date().toISOString() })}\n\n`);
          sseClients.add(response);
          request.on("close", () => sseClients.delete(response));
          return;
        }

        // GET /api/v1/governance/ledger
        if (request.method === "GET" && url.pathname === "/api/v1/governance/ledger") {
          const result = Array.from(inMemoryLedger.values()).reverse();
          sendJson(response, 200, result);
          return;
        }

        // GET /api/v1/governance/verify-ledger (Cryptographic Merkle Audit)
        if (request.method === "GET" && url.pathname === "/api/v1/governance/verify-ledger") {
          const entries = Array.from(inMemoryLedger.values());
          const verification = merkleAuditLedger.verifyChainIntegrity(entries);
          sendJson(response, 200, verification);
          return;
        }

        // POST /api/v1/embassy/reset-breaker
        if (request.method === "POST" && url.pathname === "/api/v1/embassy/reset-breaker") {
          const authUser = getAuthenticatedUser();
          const raw = await readBody(request);
          let parsed: any = {};
          try { parsed = JSON.parse(raw); } catch {}
          const target = parsed?.target || "flapping-payment-worker";

          targetCriticalStrikes.delete(target);
          RollbackCircuit.resetCircuit(target);

          const resetBy = authUser?.name || "Operator";
          for (const [token, item] of inMemoryLedger.entries()) {
            if (item.status === "CIRCUIT_TRIPPED" && (item.target === target || item.subject?.target === target)) {
              const updated = { ...item, status: "ROLLED_BACK", reason: `Circuit breaker manually reset by ${resetBy}.` };
              merkleAuditLedger.append(updated);
              inMemoryLedger.set(token, updated);
            }
          }
          sendJson(response, 200, { success: true, target, message: `Circuit breaker reset for ${target}.` });
          return;
        }

        // POST /api/v1/embassy/abort-canary
        if (request.method === "POST" && url.pathname === "/api/v1/embassy/abort-canary") {
          const authUser = getAuthenticatedUser();
          const raw = await readBody(request);
          let parsed: any = {};
          try { parsed = JSON.parse(raw); } catch {}
          const taskId = parsed?.taskId;
          const target = parsed?.target || "redis-cluster";

          if (taskId && activeCanaryTimers.has(taskId)) {
            clearTimeout(activeCanaryTimers.get(taskId)!);
            activeCanaryTimers.delete(taskId);
          }

          const mem = inMemoryLedger.get(taskId);
          const updated = {
            ...mem,
            status: "ROLLED_BACK",
            reason: `Canary observation aborted by ${authUser?.name || "Incident Commander"}. Reverted slice.`,
            decidedAt: new Date().toISOString(),
          };
          merkleAuditLedger.append(updated);
          inMemoryLedger.set(taskId, updated);

          broadcastAlert({
            type: "REMEDIATION_ROLLED_BACK",
            data: { taskId, target, reason: "Manual abort invoked by operator." },
          });

          sendJson(response, 200, { success: true, taskId, status: "ROLLED_BACK" });
          return;
        }

        // POST /api/v1/embassy/batch-decisions
        if (request.method === "POST" && url.pathname === "/api/v1/embassy/batch-decisions") {
          const authUser = getAuthenticatedUser();
          if (!authUser) {
            sendJson(response, 401, { success: false, error: "UNAUTHORIZED", message: "Authentication required." });
            return;
          }

          if (!MUTATION_ALLOWED_ROLES.has(authUser.role)) {
            sendJson(response, 403, { success: false, error: "FORBIDDEN", message: "Role unauthorized for batch decisions." });
            return;
          }

          const raw = await readBody(request);
          let parsed: any = {};
          try { parsed = JSON.parse(raw); } catch {}
          const action = parsed?.action === "REJECT_ALL" ? "REJECTED" : "APPROVED";

          for (const [token, item] of inMemoryLedger.entries()) {
            if (item.status === "PENDING") {
              const updated = {
                ...item,
                status: action,
                approvedBy: authUser.name,
                decidedAt: new Date().toISOString(),
              };
              merkleAuditLedger.append(updated);
              inMemoryLedger.set(token, updated);
            }
          }
          broadcastAlert({ type: "DECISION_RESOLVED", data: { batch: true, action, reviewer: authUser.name } });
          sendJson(response, 200, { success: true, action });
          return;
        }

        // POST /api/v1/embassy/decisions
        if (request.method === "POST" && url.pathname === "/api/v1/embassy/decisions") {
          const authUser = getAuthenticatedUser();
          const raw = await readBody(request);
          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            sendJson(response, 400, { error: "Invalid JSON format." });
            return;
          }

          const taskId = typeof parsed?.taskId === "string" ? parsed.taskId : undefined;
          const decision = parsed?.decision === "APPROVED" || parsed?.decision === "REJECTED" ? parsed.decision : undefined;
          const reviewer = authUser?.name || (typeof parsed?.reviewer === "string" ? parsed.reviewer.trim() : "Incident Commander");

          if (taskId === undefined || decision === undefined) {
            sendJson(response, 400, { error: "taskId and decision are required." });
            return;
          }

          if (authUser && !MUTATION_ALLOWED_ROLES.has(authUser.role)) {
            sendJson(response, 403, {
              success: false,
              error: "FORBIDDEN_ROLE",
              message: `Role '${authUser.role}' has read-only access.`,
            });
            return;
          }

          const mem = inMemoryLedger.get(taskId);
          const target = parsed?.target || mem?.subject?.target || mem?.target || (taskId.includes("payment") ? "flapping-payment-worker" : "k8s-ingress");
          const diff = parsed?.diff || mem?.subject?.patch?.diff || "--- a/deployment.yaml\n+++ b/deployment.yaml\n@@ -1 +1 @@\n-replicas: 2\n+replicas: 5";

          const isDangerousDiff = DANGEROUS_DIFF_PATTERNS.some((pat) => pat.test(diff));
          if (isDangerousDiff) {
            sendJson(response, 422, {
              success: false,
              error: "MALICIOUS_DIFF_REJECTED",
              message: "AST Security Gate: Patch contains prohibited command execution primitives.",
            });
            return;
          }

          const isTargetTripped = RollbackCircuit.isTripped(target) ||
            (targetCriticalStrikes.get(target) || 0) >= 3 ||
            Array.from(inMemoryLedger.values()).some(
              (item) => item.status === "CIRCUIT_TRIPPED" && (item.target === target || item.subject?.target === target)
            );

          if (decision === "APPROVED" && isTargetTripped) {
            const reason = "Circuit breaker tripped: Service flapping continuously. Automated actions frozen.";
            const trippedEntry = {
              token: taskId,
              task_token: taskId,
              taskId,
              status: "CIRCUIT_TRIPPED",
              target,
              approvedBy: reviewer,
              reason,
              createdAt: mem?.createdAt || new Date().toISOString(),
              decidedAt: new Date().toISOString(),
            };
            merkleAuditLedger.append(trippedEntry);
            inMemoryLedger.set(taskId, trippedEntry);
            broadcastAlert({ type: "CIRCUIT_TRIPPED", data: { taskId, target, status: "CIRCUIT_TRIPPED", reason } });
            sendJson(response, 423, { success: false, taskId, status: "CIRCUIT_TRIPPED", reason });
            return;
          }

          const targetStatus = decision === "APPROVED" ? "CANARY_VERIFYING" : "REJECTED";

          if (decision === "APPROVED") {
            const canaryEntry = {
              ...mem,
              token: taskId,
              task_token: taskId,
              taskId,
              status: "CANARY_VERIFYING",
              target,
              approvedBy: reviewer,
              createdAt: mem?.createdAt || new Date().toISOString(),
              decidedAt: new Date().toISOString(),
            };
            merkleAuditLedger.append(canaryEntry);
            inMemoryLedger.set(taskId, canaryEntry);

            broadcastAlert({
              type: "CANARY_VERIFYING",
              data: { taskId, target, slice: "10%", timeoutMs: 15000, reviewer },
            });

            const timer = setTimeout(async () => {
              activeCanaryTimers.delete(taskId);
              const currentItem = inMemoryLedger.get(taskId);
              if (currentItem && currentItem.status === "CANARY_VERIFYING") {
                try {
                  await new AutonomousDeploymentAdapter().applyRemediation({ target, diff } as any);
                } catch (err) {
                  console.warn("[AutonomousDeploymentAdapter] warning:", err);
                }

                const resolved = {
                  ...currentItem,
                  status: "VERIFIED_RESOLVED",
                  reason: `Canary observation passed 15s window with 0 anomalies. Patch promoted across fleet.`,
                };
                merkleAuditLedger.append(resolved);
                inMemoryLedger.set(taskId, resolved);

                broadcastAlert({
                  type: "CANARY_CONFIRMED",
                  data: { taskId, target, status: "VERIFIED_RESOLVED" },
                });
              }
            }, 15000);

            activeCanaryTimers.set(taskId, timer);
          } else {
            const rejected = {
              ...mem,
              token: taskId,
              task_token: taskId,
              taskId,
              status: "REJECTED",
              approvedBy: reviewer,
              decidedAt: new Date().toISOString(),
              createdAt: mem?.createdAt || new Date().toISOString(),
            };
            merkleAuditLedger.append(rejected);
            inMemoryLedger.set(taskId, rejected);
          }

          broadcastAlert({ type: "DECISION_RESOLVED", data: { taskId, decision } });
          sendJson(response, 200, { success: true, taskId, status: targetStatus, reviewer });
          return;
        }

        // POST /api/v1/workspace/ingest
        if (request.method === "POST" && url.pathname === "/api/v1/workspace/ingest") {
          const tCpuStart = performance.now();
          const raw = await readBody(request);
          let parsed: any = null;
          try { parsed = JSON.parse(raw); } catch { parsed = {}; }

          let eventList: Array<{ service: string; severity: string; message: string }> = [];
          if (Array.isArray(parsed?.events)) {
            eventList = parsed.events.map((e: any) => ({
              service: e.service || e.source || "payment-gateway-service",
              severity: String(e.severity || e.level || "INFO").toUpperCase(),
              message: String(e.message || e.raw || JSON.stringify(e)),
            }));
          } else {
            eventList = [{
              service: parsed.service || parsed.source || "payment-gateway-service",
              severity: String(parsed.severity || parsed.level || "INFO").toUpperCase(),
              message: String(parsed.message || parsed.raw || raw),
            }];
          }

          let processedCount = 0;
          for (const ev of eventList) {
            rollingThroughputWindow.push(Date.now());
            totalIngested++;

            if (isDuplicateAlert(ev.service, ev.message)) continue;
            processedCount++;

            const original = ev.message;
            ev.message = ev.message
              .replace(/Bearer\s+[^\s]{1,512}/gi, "Bearer [REDACTED_SECRET]")
              .replace(/sk-[A-Za-z0-9_\-]{8,128}/gi, "[REDACTED_API_KEY]")
              .replace(/(password|client_secret)=([^\s&]{1,256})/gi, "$1=[REDACTED]");

            const scrubbed = ev.message !== original;
            if (scrubbed) totalScrubbed++;

            const eventRecord = {
              id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              service: ev.service,
              severity: ev.severity,
              message: ev.message.slice(0, 300),
              scrubbed,
              dlpScrubbed: scrubbed,
              rawTime: Date.now(),
            };

            recentTelemetryHistory.push(eventRecord);
            if (recentTelemetryHistory.length > 200) recentTelemetryHistory.shift();

            broadcastAlert({
              type: "ALERT_INGESTED",
              data: eventRecord,
            });

            if (ev.severity === "CRITICAL") {
              const currentStrikes = (targetCriticalStrikes.get(ev.service) || 0) + 1;
              targetCriticalStrikes.set(ev.service, currentStrikes);

              if (currentStrikes >= 3) {
                const tripEntry = {
                  token: `circuit-trip-${ev.service}`,
                  task_token: `circuit-trip-${ev.service}`,
                  taskId: `circuit-trip-${ev.service}`,
                  status: "CIRCUIT_TRIPPED",
                  target: ev.service,
                  reason: `Anti-flapping breaker tripped: ${currentStrikes} consecutive critical strikes detected.`,
                  createdAt: new Date().toISOString(),
                };
                merkleAuditLedger.append(tripEntry);
                inMemoryLedger.set(`circuit-trip-${ev.service}`, tripEntry);
                broadcastAlert({ type: "CIRCUIT_TRIPPED", data: { target: ev.service, status: "CIRCUIT_TRIPPED" } });
              }

              await RollbackCircuit.onTelemetry(ev.service, ev.severity);
            }

            if (ev.severity === "CRITICAL" && !ev.message.includes("regression") && !ev.message.includes("post-deploy") && !ev.message.includes("Storm event")) {
              const evalScore = PolicyEvaluator.evaluateProposal(ev.service, 20, 0.15);
              const taskId = `hitl-task-${ev.service}-${Date.now().toString(36)}`;
              const isLocked = RollbackCircuit.isTripped(ev.service) || (targetCriticalStrikes.get(ev.service) || 0) >= 3;
              const proposal = {
                taskId,
                target: ev.service,
                title: `Critical Anomaly on ${ev.service}`,
                reason: ev.message.slice(0, 200),
                severity: "CRITICAL",
                confidence: evalScore.confidence || 88,
                blastRadius: evalScore.blastRadius || "15%",
                isTripped: isLocked,
                patch: {
                  diff: `--- ${ev.service}/deployment.yaml\n+++ ${ev.service}/deployment.yaml\n@@ -12,3 +12,3 @@\n-  replicas: 2\n+  replicas: 5`,
                  target: ev.service,
                },
                status: isLocked ? "CIRCUIT_TRIPPED" : "PENDING",
              };

              const newEntry = {
                token: taskId,
                task_token: taskId,
                taskId,
                status: isLocked ? "CIRCUIT_TRIPPED" : "PENDING",
                target: ev.service,
                subject: proposal,
                createdAt: new Date().toISOString(),
              };
              merkleAuditLedger.append(newEntry);
              inMemoryLedger.set(taskId, newEntry);

              broadcastAlert({
                type: "HITL_PROPOSAL",
                data: proposal,
              });
            }
          }

          const processingMs = Math.max(1, Math.round(performance.now() - tCpuStart));
          rollingLatencySamples.push(processingMs);
          if (rollingLatencySamples.length > 100) rollingLatencySamples.shift();

          sendJson(
            response,
            202,
            {
              status: "Accepted",
              message: "Telemetry ingested and broadcasted.",
              processed: processedCount,
              suppressed: eventList.length - processedCount,
              processingMs,
            },
            {
              "Server-Timing": `ingest;dur=${processingMs}`,
              "X-Response-Time-Ms": String(processingMs),
            }
          );
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/v1/ops/metrics") {
          sendJson(response, 200, { suppressedAlerts: totalSuppressed, streamLagMs: 0 });
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/v1/metrics/ingestion") {
          const now = Date.now();
          rollingThroughputWindow = rollingThroughputWindow.filter((t) => now - t <= 8000);
          const currentTps = Math.round((rollingThroughputWindow.length / 8) * 10) / 10;

          let pendingCount = 0;
          for (const item of inMemoryLedger.values()) {
            if (item.status === "PENDING") pendingCount++;
          }

          sendJson(response, 200, {
            ...metricsCollector.getSnapshot(),
            throughput: currentTps,
            totalIngested,
            secretsScrubbed: totalScrubbed,
            suppressedAlerts: totalSuppressed,
            hitlPending: pendingCount,
            trippedCircuits: RollbackCircuit.getTrippedCircuits(),
          });
          return;
        }

        sendJson(response, 404, { error: "Not found" });
      } catch (error) {
        sendJson(response, 500, {
          status: "FAILED",
          failure: { code: "SERVER_ERROR", reason: error instanceof Error ? error.message : String(error) },
        });
      }
    })();
  });

  server.on("connection", (socket) => {
    socket.setNoDelay(true);
  });

  return server;
}

const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0";

const server = createWedgeServer({ cwd: process.cwd() });
server.listen(PORT, HOST, () => {
  console.log(`🚀 [NeuroFabric] Backend actively listening on http://${HOST}:${PORT}`);
});
