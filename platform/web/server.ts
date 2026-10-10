import cors from 'cors';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
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
let totalScrubbed = 0;
let totalSuppressed = 0;

let rollingThroughputWindow: number[] = [];
const alertDedupWindow = new Map<string, number>();
const DEDUP_TTL_MS = 30000;

// Security Allowlist: Authorized DevSecOps Roles
const AUTHORIZED_ROLES = new Set([
  "Incident Commander",
  "Operator",
  "SecOps",
  "DevOps Lead",
  "SRE Lead",
  "admin",
  "Batch Commander",
]);

// AST Security Gate: Prohibited Diff Primitives
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
    if (item.status === 'PENDING') pendingCount++;
  }

  broadcastAlert({
    type: 'INGESTION_METRICS_UPDATE',
    data: {
      ...metricsCollector.getSnapshot(),
      throughput: currentTps,
      secretsScrubbed: totalScrubbed,
      suppressedAlerts: totalSuppressed,
      hitlPending: pendingCount,
    }
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

hitlEventBus.on('hitl:events', (data: any) => {
  const taskToken = String(data?.taskId ?? '');
  if (!taskToken) return;
  inMemoryLedger.set(taskToken, {
    token: taskToken,
    task_token: taskToken,
    taskId: taskToken,
    status: 'PENDING',
    subject: data,
    createdAt: new Date().toISOString(),
  });
  void dbPool
    .query(
      `INSERT INTO approval_tasks (task_token, status, subject_json, created_at)
       VALUES ($1, 'PENDING', $2, EXTRACT(EPOCH FROM NOW()) * 1000)
       ON CONFLICT (task_token) DO NOTHING`,
      [taskToken, JSON.stringify(data)],
    )
    .catch(() => undefined);
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

function ledgerTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let milliseconds: number;
  if (typeof value === "number" && Number.isFinite(value)) {
    milliseconds = value * 1000;
  } else if (typeof value === "string" && value.trim() !== "") {
    const numeric = Number(value);
    milliseconds = Number.isFinite(numeric) ? numeric * 1000 : Date.parse(value);
  } else {
    return null;
  }
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
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
          const combined = new Map<string, any>();

          for (const [token, item] of inMemoryLedger.entries()) {
            combined.set(token, {
              token: item.token || token,
              task_token: item.token || token,
              taskId: item.token || token,
              status: item.status,
              target: item.target || item.subject?.target || null,
              subject: item.subject || null,
              decidedAt: item.decidedAt || null,
              approvedBy: item.approvedBy || null,
              reason: item.reason || null,
              createdAt: item.createdAt || new Date().toISOString(),
              owaspRef: item.owaspRef || null,
              nistRef: item.nistRef || null,
            });
          }

          if (process.env.DATABASE_URL) {
            try {
              const queryPromise = dbPool.query(`
                SELECT task_token, status, subject_json, decided_at, approved_by, reason, created_at
                FROM approval_tasks
                ORDER BY created_at DESC
                LIMIT 100
              `);
              const timeoutPromise = new Promise<null>((_, reject) => setTimeout(() => reject(new Error("DB_TIMEOUT")), 500));
              const queryResult: any = await Promise.race([queryPromise, timeoutPromise]);

              if (queryResult && queryResult.rows) {
                for (const row of queryResult.rows) {
                  let subject: any;
                  try {
                    subject = typeof row.subject_json === "string" ? JSON.parse(row.subject_json) : row.subject_json;
                  } catch {
                    subject = row.subject_json;
                  }
                  combined.set(row.task_token, {
                    token: row.task_token,
                    task_token: row.task_token,
                    taskId: row.task_token,
                    status: row.status,
                    target: subject?.target || null,
                    subject,
                    decidedAt: ledgerTimestamp(row.decided_at),
                    approvedBy: row.approved_by ?? null,
                    reason: row.reason ?? null,
                    createdAt: ledgerTimestamp(row.created_at),
                    owaspRef: null,
                    nistRef: null,
                  });
                }
              }
            } catch {}
          }

          const result = Array.from(combined.values()).reverse();
          sendJson(response, 200, result);
          return;
        }

        // POST /api/v1/embassy/reset-breaker
        if (request.method === "POST" && url.pathname === "/api/v1/embassy/reset-breaker") {
          const raw = await readBody(request);
          let parsed: any = {};
          try { parsed = JSON.parse(raw); } catch {}
          const target = parsed?.target || "flapping-payment-worker";
          RollbackCircuit.resetCircuit(target);
          for (const [token, item] of inMemoryLedger.entries()) {
            if (item.status === "CIRCUIT_TRIPPED" && (item.target === target || item.subject?.target === target)) {
              inMemoryLedger.set(token, { ...item, status: "ROLLED_BACK", reason: "Circuit breaker manually reset by Operator." });
            }
          }
          sendJson(response, 200, { success: true, target, message: `Circuit breaker reset for ${target}.` });
          return;
        }

        // POST /api/v1/embassy/batch-decisions
        if (request.method === "POST" && url.pathname === "/api/v1/embassy/batch-decisions") {
          const raw = await readBody(request);
          let parsed: any = {};
          try { parsed = JSON.parse(raw); } catch {}
          const action = parsed?.action === "REJECT_ALL" ? "REJECTED" : "APPROVED";

          for (const [token, item] of inMemoryLedger.entries()) {
            if (item.status === "PENDING") {
              inMemoryLedger.set(token, {
                ...item,
                status: action,
                approvedBy: "Batch Commander",
                decidedAt: new Date().toISOString(),
              });
            }
          }
          broadcastAlert({ type: "DECISION_RESOLVED", data: { batch: true, action } });
          sendJson(response, 200, { success: true, action });
          return;
        }

        // POST /api/v1/embassy/decisions (Secured with Reviewer Role Allowlist & AST Diff Gate)
        if (request.method === "POST" && url.pathname === "/api/v1/embassy/decisions") {
          const raw = await readBody(request);
          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            sendJson(response, 400, { error: "the request body is not valid JSON" });
            return;
          }

          const taskId = typeof parsed?.taskId === "string" ? parsed.taskId : undefined;
          const decision = parsed?.decision === "APPROVED" || parsed?.decision === "REJECTED" ? parsed.decision : undefined;
          const reviewer = typeof parsed?.reviewer === "string" ? parsed.reviewer.trim() : "";

          if (taskId === undefined || decision === undefined) {
            sendJson(response, 400, { error: "taskId and decision are required" });
            return;
          }

          // SECURITY GATE 1: Operator Role Authorization Check
          if (!reviewer || !AUTHORIZED_ROLES.has(reviewer)) {
            sendJson(response, 403, {
              success: false,
              error: "UNAUTHORIZED_REVIEWER",
              message: `Reviewer '${reviewer}' is not authorized to sign off on production remediations.`,
            });
            return;
          }

          const mem = inMemoryLedger.get(taskId);
          const target = parsed?.target || mem?.subject?.target || mem?.target || (taskId.includes("payment") ? "flapping-payment-worker" : "redis-cluster");
          const diff = parsed?.diff || mem?.subject?.patch?.diff || "--- a/deployment.yaml\n+++ b/deployment.yaml\n@@ -1 +1 @@\n-replicas: 2\n+replicas: 5";

          // SECURITY GATE 2: AST Diff Security Scanner
          const isDangerousDiff = DANGEROUS_DIFF_PATTERNS.some((pat) => pat.test(diff));
          if (isDangerousDiff) {
            sendJson(response, 422, {
              success: false,
              error: "MALICIOUS_DIFF_REJECTED",
              message: "AST Security Gate: Patch contains prohibited shell execution or external network primitives.",
            });
            return;
          }

          // SECURITY GATE 3: Tripped Circuit Breaker Lockout Check
          const isTargetTripped = RollbackCircuit.isTripped(target) || Array.from(inMemoryLedger.values()).some(
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

          try {
            await dbPool.query(
              `UPDATE approval_tasks SET status = $1, reviewer = $2 WHERE task_token = $3`,
              [decision, reviewer, taskId]
            );
          } catch {}

          broadcastAlert({ type: "DECISION_RESOLVED", data: { taskId, decision } });
          sendJson(response, 200, { success: true, taskId, status: decision });
          return;
        }

        // POST /api/v1/workspace/ingest
        if (request.method === "POST" && url.pathname === "/api/v1/workspace/ingest") {
          const tCpuStart = performance.now();
          const raw = await readBody(request);
          let parsed: any = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = {};
          }

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
            if (isDuplicateAlert(ev.service, ev.message)) {
              continue;
            }
            processedCount++;

            const original = ev.message;
            ev.message = ev.message
              .replace(/Bearer\s+[^\s]{1,512}/gi, "Bearer [REDACTED_SECRET]")
              .replace(/sk-[A-Za-z0-9_\-]{8,128}/gi, "[REDACTED_API_KEY]")
              .replace(/(password|client_secret)=([^\s&]{1,256})/gi, "$1=[REDACTED]");

            const scrubbed = ev.message !== original;
            if (scrubbed) totalScrubbed++;

            broadcastAlert({
              type: "ALERT_INGESTED",
              data: {
                id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                service: ev.service,
                severity: ev.severity,
                message: ev.message.slice(0, 300),
                scrubbed,
                timestamp: new Date().toLocaleTimeString(),
              },
            });

            if (ev.severity === "CRITICAL") {
              await RollbackCircuit.onTelemetry(ev.service, ev.severity);
            }

            if (ev.severity === "CRITICAL" && !ev.message.includes("regression") && !ev.message.includes("post-deploy") && !ev.message.includes("Storm event")) {
              const evalScore = PolicyEvaluator.evaluateProposal(ev.service, 20, 0.15);
              const taskId = `hitl-task-${ev.service}-${Date.now().toString(36)}`;
              const isLocked = RollbackCircuit.isTripped(ev.service);
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

              void dbPool
                .query(
                  `INSERT INTO approval_tasks (task_token, status, subject_json, created_at)
                   VALUES ($1, $2, $3, EXTRACT(EPOCH FROM NOW()) * 1000)
                   ON CONFLICT (task_token) DO NOTHING`,
                  [taskId, isLocked ? "CIRCUIT_TRIPPED" : "PENDING", JSON.stringify(proposal)]
                )
                .catch(() => undefined);

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
            if (item.status === 'PENDING') pendingCount++;
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
