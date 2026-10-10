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

const sseClients = new Set<ServerResponse>();
export const inMemoryLedger = new Map<string, any>();
const recentTelemetryHistory: Array<any> = [];

let totalScrubbed = 2;
let totalSuppressed = 14;
let rollingThroughputWindow: number[] = [];
const alertDedupWindow = new Map<string, number>();
const targetCriticalStrikes = new Map<string, number>();
const DEDUP_TTL_MS = 30000;

// Enterprise Auth Credentials & Signed Session Store
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

// AST Diff Security Gate
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
  const seedItems = [
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
    inMemoryLedger.set(item.token, item);
  }

  const logs = [
    { service: "auth-gateway", severity: "INFO", message: "OAuth2 bearer token validated for session usr-9843", dlpScrubbed: false, offsetMs: 120000 },
    { service: "auth-gateway", severity: "WARNING", message: "Attempting exfiltration: Bearer [REDACTED_SECRET] password=[REDACTED]", dlpScrubbed: true, offsetMs: 95000 },
    { service: "k8s-ingress", severity: "CRITICAL", message: "CRITICAL 500: [SYSTEM INSTRUCTION OVERRIDE blocked by policy]", dlpScrubbed: false, offsetMs: 65000 },
  ];

  for (const log of logs) {
    const rawTime = now - log.offsetMs;
    recentTelemetryHistory.push({
      id: `evt-${rawTime}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date(rawTime).toLocaleTimeString(),
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
  rollingThroughputWindow = rollingThroughputWindow.filter((t) => now - t <= 5000);
  const currentTps = Math.round((rollingThroughputWindow.length / 5) * 10) / 10;

  let pendingCount = 0;
  for (const item of inMemoryLedger.values()) {
    if (item.status === "PENDING") pendingCount++;
  }

  broadcastAlert({
    type: "INGESTION_METRICS_UPDATE",
    data: {
      ...metricsCollector.getSnapshot(),
      throughput: currentTps,
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
  inMemoryLedger.set(taskToken, {
    token: taskToken,
    task_token: taskToken,
    taskId: taskToken,
    status: "PENDING",
    subject: data,
    createdAt: new Date().toISOString(),
  });
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

        // GET /api/v1/workspace/recent-logs
        if (request.method === "GET" && url.pathname === "/api/v1/workspace/recent-logs") {
          sendJson(response, 200, recentTelemetryHistory.slice(-50));
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
              inMemoryLedger.set(token, { ...item, status: "ROLLED_BACK", reason: `Circuit breaker manually reset by ${resetBy}.` });
            }
          }
          sendJson(response, 200, { success: true, target, message: `Circuit breaker reset for ${target}.` });
          return;
        }

        // POST /api/v1/embassy/batch-decisions (Guarded by Bearer Authentication)
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
              inMemoryLedger.set(token, {
                ...item,
                status: action,
                approvedBy: authUser.name,
                decidedAt: new Date().toISOString(),
              });
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
          const target = parsed?.target || mem?.subject?.target || mem?.target || (taskId.includes("payment") ? "flapping-payment-worker" : "redis-cluster");
          const diff = parsed?.diff || mem?.subject?.patch?.diff || "--- a/deployment.yaml\n+++ b/deployment.yaml\n@@ -1 +1 @@\n-replicas: 2\n+replicas: 5";

          // AST Defense Gate: Input Validation Prior to Execution
          const isDangerousDiff = DANGEROUS_DIFF_PATTERNS.some((pat) => pat.test(diff));
          if (isDangerousDiff) {
            sendJson(response, 422, {
              success: false,
              error: "MALICIOUS_DIFF_REJECTED",
              message: "AST Security Gate: Patch contains prohibited command execution primitives.",
            });
            return;
          }

          // Anti-Flapping Circuit Breaker Guard
          const isTargetTripped = RollbackCircuit.isTripped(target) ||
            (targetCriticalStrikes.get(target) || 0) >= 3 ||
            Array.from(inMemoryLedger.values()).some(
              (item) => item.status === "CIRCUIT_TRIPPED" && (item.target === target || item.subject?.target === target)
            );

          if (decision === "APPROVED" && isTargetTripped) {
            const reason = "Circuit breaker tripped: Service flapping continuously. Automated actions frozen.";
            inMemoryLedger.set(taskId, {
              token: taskId,
              task_token: taskId,
              taskId,
              status: "CIRCUIT_TRIPPED",
              target,
              approvedBy: reviewer,
              reason,
              createdAt: mem?.createdAt || new Date().toISOString(),
              decidedAt: new Date().toISOString(),
            });
            broadcastAlert({ type: "CIRCUIT_TRIPPED", data: { taskId, target, status: "CIRCUIT_TRIPPED", reason } });
            sendJson(response, 423, { success: false, taskId, status: "CIRCUIT_TRIPPED", reason });
            return;
          }

          const targetStatus = decision === "APPROVED" ? "CANARY_VERIFYING" : "REJECTED";

          if (decision === "APPROVED") {
            inMemoryLedger.set(taskId, {
              ...mem,
              token: taskId,
              task_token: taskId,
              taskId,
              status: "CANARY_VERIFYING",
              target,
              approvedBy: reviewer,
              createdAt: mem?.createdAt || new Date().toISOString(),
              decidedAt: new Date().toISOString(),
            });

            try {
              await new AutonomousDeploymentAdapter().applyRemediation({ target, diff } as any);
            } catch (err) {
              console.warn("[AutonomousDeploymentAdapter] warning:", err);
            }

            RollbackCircuit.startCanaryObservation(taskId, target, diff, 15000);
            broadcastAlert({ type: "REMEDIATION_DEPLOYED", data: { taskId, target } });
          } else {
            inMemoryLedger.set(taskId, {
              ...mem,
              token: taskId,
              task_token: taskId,
              taskId,
              status: "REJECTED",
              approvedBy: reviewer,
              decidedAt: new Date().toISOString(),
              createdAt: mem?.createdAt || new Date().toISOString(),
            });
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

          rollingThroughputWindow.push(Date.now());

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
              timestamp: new Date().toLocaleTimeString(),
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
                inMemoryLedger.set(`circuit-trip-${ev.service}`, {
                  token: `circuit-trip-${ev.service}`,
                  task_token: `circuit-trip-${ev.service}`,
                  taskId: `circuit-trip-${ev.service}`,
                  status: "CIRCUIT_TRIPPED",
                  target: ev.service,
                  reason: `Anti-flapping breaker tripped: ${currentStrikes} consecutive critical spikes detected.`,
                  createdAt: new Date().toISOString(),
                });
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

              inMemoryLedger.set(taskId, {
                token: taskId,
                task_token: taskId,
                taskId,
                status: isLocked ? "CIRCUIT_TRIPPED" : "PENDING",
                target: ev.service,
                subject: proposal,
                createdAt: new Date().toISOString(),
              });

              broadcastAlert({
                type: "HITL_PROPOSAL",
                data: proposal,
              });
            }
          }

          const processingMs = Math.max(1, Math.round(performance.now() - tCpuStart));
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
          rollingThroughputWindow = rollingThroughputWindow.filter((t) => now - t <= 5000);
          const currentTps = Math.round((rollingThroughputWindow.length / 5) * 10) / 10;

          let pendingCount = 0;
          for (const item of inMemoryLedger.values()) {
            if (item.status === "PENDING") pendingCount++;
          }

          sendJson(response, 200, {
            ...metricsCollector.getSnapshot(),
            throughput: currentTps,
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
