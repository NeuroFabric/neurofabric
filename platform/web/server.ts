import cors from 'cors';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { mkdirSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { register, alertsSuppressed } from "../observability/metrics.ts";
import { handleIngest } from "./routes/ingest-route.ts";
import { metricsCollector } from "../ingestion/metrics-collector.ts";

import { hitlEventBus } from "../embassy/HitlAdapter.ts";
import { AutonomousDeploymentAdapter } from "../embassy/AutonomousDeploymentAdapter.ts";
import { setDbPool, startCanaryObservation } from "../embassy/RollbackCircuit.ts";

const sseClients = new Set<ServerResponse>();

export function broadcastAlert(payload: unknown): void {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Start periodic metrics broadcast
setInterval(() => {
  broadcastAlert({
    type: 'INGESTION_METRICS_UPDATE',
    data: metricsCollector.getSnapshot()
  });
}, 2500);

const dbPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Persist every HITL proposal into the governance ledger (approval_tasks).
// Best-effort: a missing/unreachable DB logs a warning but never breaks the pipeline.
hitlEventBus.on('hitl:events', (data: any) => {
  const taskToken = String(data?.taskId ?? '');
  if (!taskToken) return;
  void dbPool
    .query(
      `INSERT INTO approval_tasks (task_token, status, subject_json, created_at)
       VALUES ($1, 'PENDING', $2, EXTRACT(EPOCH FROM NOW()) * 1000)
       ON CONFLICT (task_token) DO NOTHING`,
      [taskToken, JSON.stringify(data)],
    )
    .catch((err) => console.warn('[ledger] HITL proposal persist failed:', err instanceof Error ? err.message : err));
});

export class CircuitBreakerError extends Error {
  constructor(message = 'Task execution halted: maximum iteration threshold exceeded.') {
    super(message);
    this.name = 'CircuitBreakerError';
  }
}

const MAX_ITERATIONS = 3;
const taskIterationMap = new Map<string, number>();

import * as RedisNamespace from "ioredis";
const RedisClient = (RedisNamespace as unknown as { default: new (url: string, opts?: Record<string, unknown>) => any }).default;
const redis = new RedisClient(process.env.REDIS_URL || 'redis://localhost:6379', {
  lazyConnect: true,
});

import { Conductor, type ConductorResult } from "../conductor/conductor.ts";
import { applyFeedback } from "./feedback.ts";
import { titleFor, type Purpose } from "../conductor/semantics.ts";
import { csvRead } from "../conductor/capabilities.ts";
import { analyseBottlenecks, type BottleneckAnalysis } from "../conductor/bottlenecks.ts";
import { createPortalRoutes, InMemoryPortalStore, type PortalRouter } from "../api/portal-routes.ts";
import { createEvaluationScheduler } from "../omniroute/evaluation-scheduler.ts";
import { createMemoryRoutes, MEMORY_ALERTS_PATH, type MemoryRouter } from "../memory/memory-routes.ts";
import { validateSchema, type AgentSchema } from "../swarm/dynamic-registry.ts";
import { buildAlertPayload } from "../egress/webhook-dispatcher.ts";
import { createAlertHub, frame, type AlertHub } from "../memory/alert-hub.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { SwarmAlert } from "../omniroute/omniroute-gateway.ts";
import { environmentVault, type VaultProvider } from "../omniroute/edge-security.ts";
import { OmniRouteGateway } from "../omniroute/omniroute-gateway.ts";
import { DynamicAgentRegistry } from "../swarm/dynamic-registry.ts";
import { resolveWithinRoot } from "../core/workspace.ts";
import { appendTurn, assertSessionId, newSessionId, readSession } from "../conductor/session-store.ts";
import type { CsvReadResult } from "../conductor/capabilities.ts";
import { RemediationService } from "../remediation/remediation-gate.ts";
import { createAsyncApprovalGate } from "../embassy/async-approval.ts";

const UNKNOWN_PURPOSE: Purpose = {
  kind: "unknown",
  statement: "This file has not been read yet.",
  confidence: "none",
  evidence: [],
  columns: [],
};

export interface WedgeOptions {
  cwd: string;
  defaultsRoot?: string;
  port?: number;
  hub?: AlertHub;
  host?: string;
  installRoot?: string;
  portalVault?: VaultProvider;
  liveProviders?: readonly string[];
  evaluationIntervalMs?: number;
  memory?: {
    readonly store: MemoryStore;
    readonly tenant?: string;
    readonly latest?: () => Readonly<Record<string, number>>;
  };
}

export interface RunningWedge {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_EVALUATION_INTERVAL_MS = 5_000;

async function readCsvFor(absolute: string): Promise<CsvReadResult | undefined> {
  const csv = await csvRead({ path: absolute }).catch(() => undefined);
  if (csv === undefined) return undefined;
  if (csv.problems.length > 0) return undefined;
  return csv;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
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

function toResponse(result: ConductorResult): Record<string, unknown> {
  const analysis = result.report?.analysis;
  return {
    status: result.status,
    state: result.state,
    markdown: result.report?.markdown,
    failure: result.failure,
    questions: result.questions,
    artifacts: result.artifacts,
    schema: result.report?.schema === undefined ? undefined : {
      id: result.report.schema.id,
      source: result.report.schema.source,
      learnedRoles: result.report.schema.learnedRoles,
    },
    purpose: analysis?.purpose,
    ...(analysis === undefined ? {} : {
      analysis: {
        totalRows: analysis.totalRows,
        errorRows: analysis.errorRows,
        errorRate: analysis.errorRate,
        problems: Array.isArray(analysis.problems) ? analysis.problems.slice(0, 50) : [],
        mappings: Array.isArray(analysis.mappings) ? analysis.mappings.slice(0, 32) : [],
        byHour: Array.isArray(analysis.byHour)
          ? analysis.byHour.slice(0, 500).map(({ key, count, errorCount, errorRate }) => ({ key, count, errorCount, errorRate }))
          : [],
        latencyBands: Array.isArray(analysis.latency)
          ? analysis.latency.slice(0, 32).map(({ label, count }) => ({ label, count }))
          : [],
        categories: Array.isArray(analysis.categories)
          ? analysis.categories.slice(0, 50).map(({ key, count, p95Elapsed }) => ({ key, count, p95Elapsed }))
          : [],
      },
    }),
    kernelEvents: result.kernelEvents,
    progress: result.progress,
  };
}

function statusFor(result: ConductorResult): number {
  if (result.status === "DELIVERED") return 200;
  const tier = result.failure?.kernelReasonCode;
  return tier === undefined ? 400 : 403;
}

function headerSafeName(target: string): string {
  const base = path.basename(target).replace(/\.[^.]+$/, "") || "analysis";
  const safe = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return `${(safe === "" ? "analysis" : safe)}-analysis.html`;
}

async function toStandaloneExport(
  analysis: BottleneckAnalysis,
  target: string,
  learned: Readonly<Record<string, string>>,
  thread: readonly { role: string; text: string }[],
): Promise<string> {
  const { toReactDashboard } = await import("./react-report.ts");
  return toReactDashboard(analysis, {
    title: `Exported analysis: ${path.basename(target)}`,
    sourceName: target,
    learned,
    transcript: thread.map((turn) => ({
      role: turn.role === "user" ? "user" : "agent",
      text: turn.text,
      widgets: [],
      suggestions: [],
    })),
  });
}

function anomaliesFor(analysis: BottleneckAnalysis): {
  column: string; severity: "critical" | "warning" | "info"; kind: string; detail: string; factor: number | null;
}[] {
  const byName = new Map(analysis.numerical.columns.map((c) => [c.column, c]));
  const out: {
    column: string; severity: "critical" | "warning" | "info"; kind: string; detail: string; factor: number | null;
  }[] = [];
  for (const health of analysis.health.columns) {
    const stat = byName.get(health.column);
    const factor = (value: number | null, fence: number | null): number | null => {
      if (fence === null || fence === 0 || value === null) return null;
      const ratio = Math.abs(value / fence);
      return Number.isFinite(ratio) ? ratio : null;
    };
    if (health.outliers > 0 && health.worstValue !== null) {
      out.push({
        column: health.column, severity: "critical", kind: "extreme value",
        detail: `${Math.abs(health.worstValue).toLocaleString("en-US")} against a fence of ${Math.round(health.fence ?? 0).toLocaleString("en-US")}`,
        factor: factor(health.worstValue, health.fence),
      });
    } else if (stat?.outliers !== undefined && stat.outliers > 0 && stat.outlierMax !== null) {
      out.push({
        column: health.column, severity: "warning", kind: "marginal value",
        detail: `${stat.outliers} value(s) past the 1.5x fence, worst ${stat.outlierMax.toLocaleString("en-US")}`,
        factor: factor(stat.outlierMax, stat.fenceExtremeUpper ?? null),
      });
    }
    if (health.dirty > 0) {
      out.push({
        column: health.column, severity: "warning", kind: "type mismatch",
        detail: `${health.dirty} cell(s) hold something that is not a number${health.examples.length > 0 ? `, e.g. ${health.examples.join(", ")}` : ""}`,
        factor: null,
      });
    }
    if (health.empty > 0) {
      out.push({
        column: health.column, severity: "info", kind: "missing values",
        detail: `${health.empty} empty cell(s)`, factor: null,
      });
    }
  }
  return out;
}

export function createWedgeServer(options: WedgeOptions): Server {
  const cwd = path.resolve(options.cwd);
  const installRoot = options.installRoot ?? process.cwd();
  const sessions = path.join(cwd, "workspace", "sessions");

  const sandboxRoot = path.join(cwd, "gate-data", "patches");
  mkdirSync(sandboxRoot, { recursive: true });
  const gate = createAsyncApprovalGate({ audit: () => undefined });
  const remediation = new RemediationService({ gate, sandboxRoot, tenant: options.memory?.tenant ?? "default" });

  const registry = new DynamicAgentRegistry();
  const liveTenant = options.memory?.tenant;

  let routes: MemoryRouter | undefined;

  const gateway = new OmniRouteGateway({
    ...(options.memory === undefined || liveTenant === undefined
      ? {}
      : {
          onDecision: (alert: SwarmAlert) => {
            const payload = buildAlertPayload(alert);
            options.memory?.store.recordDecision({
              tenant: liveTenant,
              agentId: `${liveTenant}/${alert.provider}`,
              verdict: {
                at: alert.at,
                provider: alert.provider,
                records: alert.verdict.records,
                breached: payload.summary.breachedColumns,
                document: {
                  open: payload.summary.open,
                  partitions: payload.summary.partitions,
                  columns: payload.columns,
                  busiestHour: alert.verdict.busiestHour,
                  topKeys: alert.verdict.topKeys,
                },
              },
              alert: {
                id: payload.id,
                severity: payload.severity,
                document: { title: payload.title, body: payload.body, firstObservation: alert.firstObservation },
              },
              audit: {
                actor: "system",
                action: "raise-alert",
                document: { provider: alert.provider, firstObservation: alert.firstObservation },
              },
            });
            routes?.hub.publish(
              liveTenant,
              frame(payload.id, "alert", {
                id: payload.id,
                title: payload.title,
                body: payload.body,
                severity: payload.severity,
                source: payload.source,
                at: payload.at,
                summary: payload.summary,
                columns: payload.columns,
              }),
            );
          },
        }),
  });
  const liveProviders = options.liveProviders ?? ["pega", "webhook"];
  const bindings = new Map<string, boolean>();
  for (const name of liveProviders) {
    gateway.connect({ name, keyColumn: "service", timeColumn: "pega_time" });
    bindings.set(name, true);
  }
  const liveProvider = liveProviders[0] ?? "pega";

  const evaluation = createEvaluationScheduler({
    gateway,
    providers: () => [...bindings.keys()],
    intervalMs: options.evaluationIntervalMs ?? DEFAULT_EVALUATION_INTERVAL_MS,
    onError: (error, context) => {
      const reason = error instanceof Error ? error.message : String(error);
      const subject = context.provider ?? "the provider list";
      console.error(`[evaluation] ${subject} could not be evaluated: ${reason}`);
    },
  });

  const liveNewest = new Map<string, number>();

  const portalRoutes: PortalRouter = createPortalRoutes({
    registry,
    store: new InMemoryPortalStore(),
    vault: options.portalVault ?? environmentVault(),
    ...(options.memory === undefined
      ? {}
      : {
          onSchemaRegistered: (tenant: string, schema: AgentSchema) => {
            options.memory?.store.putSchema(tenant, schema.id, schema.version, schema, Date.now());
          },
        }),
    live: {
      verdict: (provider) => gateway.verdict(provider),
      push: (provider, event) => {
        const at = typeof event.at === "number" ? event.at : Date.now();
        const previous = liveNewest.get(provider);
        if (previous === undefined || at > previous) liveNewest.set(provider, at);
        gateway.push(provider, event);
      },
      connected: (provider) => bindings.has(provider),
    },
    liveProvider,
  });

  const defaultLatest = (): Readonly<Record<string, number>> => {
    const verdict = gateway.verdict(liveProvider);
    if (verdict === undefined || verdict.records === 0) return {};
    const newest = liveNewest.get(liveProvider);
    if (newest === undefined) return {};
    const out: Record<string, number> = {};
    for (const agent of registry.describeAll()) out[agent.id] = newest;
    return out;
  };

  const memoryRoutes: MemoryRouter | undefined =
    options.memory === undefined
      ? undefined
      : createMemoryRoutes({
          store: options.memory.store,
          live: {
            providers: liveProviders,
            latest: options.memory.latest ?? defaultLatest,
            accepts: (document) => validateSchema(document).ok,
          },
          vault: options.portalVault ?? environmentVault(),
          ...(options.hub === undefined ? {} : { hub: options.hub }),
        });
  routes = memoryRoutes;

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");

        // Handle CORS Preflight & Global Headers
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");

        if (request.method === "OPTIONS") {
          response.writeHead(204);
          response.end();
          return;
        }

        // Render Health Check Endpoint
        if (url.pathname === "/health") {
          sendJson(response, 200, { status: "ok", uptime: process.uptime() });
          return;
        }

        if (memoryRoutes !== undefined && url.pathname === MEMORY_ALERTS_PATH) {
          const streamHeaders: Record<string, string | undefined> = {};
          for (const [name, value] of Object.entries(request.headers)) {
            streamHeaders[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
          }
          await memoryRoutes.openStream(request.method ?? "GET", url.pathname, streamHeaders, response, request);
          return;
        }

        if (memoryRoutes !== undefined && url.pathname.startsWith("/api/memory/")) {
          const headers: Record<string, string | undefined> = {};
          for (const [name, value] of Object.entries(request.headers)) {
            headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
          }
          let payload: unknown;
          if (request.method === "POST") {
            try {
              const raw = await readBody(request);
              payload = raw.trim() === "" ? undefined : JSON.parse(raw);
            } catch {
              sendJson(response, 400, { error: "the request body is not valid JSON" });
              return;
            }
          }
          const result = await memoryRoutes.handle(request.method ?? "GET", url.pathname, headers, payload);
          const text = JSON.stringify(result.body ?? null);
          response.writeHead(result.status, {
            ...result.headers,
            "content-length": Buffer.byteLength(text),
          });
          response.end(text);
          return;
        }

        if (url.pathname.startsWith("/api/portal/")) {
          const headers: Record<string, string | undefined> = {};
          for (const [name, value] of Object.entries(request.headers)) {
            headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
          }
          let payload: unknown;
          if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
            try {
              const raw = await readBody(request);
              payload = raw.trim() === "" ? undefined : JSON.parse(raw);
            } catch {
              sendJson(response, 400, { error: "the request body is not valid JSON" });
              return;
            }
          }
          const result = await portalRoutes.handle(request.method ?? "GET", url.pathname, headers, payload);
          const text = JSON.stringify(result.body ?? null);
          response.writeHead(result.status, {
            ...result.headers,
            "content-length": Buffer.byteLength(text),
          });
          response.end(text);
          return;
        }

        if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
          const page = await import("./page.ts").then((m) => m.PAGE_HTML);
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": Buffer.byteLength(page),
            "cache-control": "no-store",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
            "x-content-type-options": "nosniff",
          });
          response.end(page);
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/dashboard") {
          const target = url.searchParams.get("path");
          if (target === null || target.trim().length === 0) {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "name a file: /api/dashboard?path=<file>" },
            });
            return;
          }
          const resolved = resolveWithinRoot(cwd, target);
          if (!resolved.allowed) {
            sendJson(response, 403, {
              status: "FAILED",
              failure: {
                code: "PATH_OUTSIDE_WORKSPACE",
                reason: `path boundary violation: ${resolved.reason ?? "the file is outside the workspace"}`,
                kernelReasonCode: "PATH_OUTSIDE_WORKSPACE",
              },
            });
            return;
          }
          const conductor = new Conductor({
            cwd,
            defaultsRoot: options.defaultsRoot ?? installRoot,
            projectConfig: { policyMode: "TRUSTED_PROJECT", allowedRoots: [cwd] },
          });
          const result = await conductor.run(`bottleneck report; input=${target}`, {
            mode: "bottleneck",
            format: "markdown",
            output: path.join(cwd, "workspace", "bottleneck-report.md"),
            title: titleFor({ fileName: path.basename(target), purpose: UNKNOWN_PURPOSE }),
          });
          if (result.status !== "DELIVERED" || result.report === undefined) {
            sendJson(response, statusFor(result), toResponse(result));
            return;
          }
          const { toReactDashboard, dashboardCsp } = await import("./react-report.ts");
          const DASHBOARD_CSP = dashboardCsp(true);
          const html = toReactDashboard(result.report.analysis, {
            title: titleFor({ fileName: path.basename(target), purpose: result.report.analysis.purpose }),
            live: { path: target, sessionId: newSessionId() },
            learned: result.report.schema?.roles ?? {},
          });
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": Buffer.byteLength(html),
            "cache-control": "no-store",
            "content-security-policy": DASHBOARD_CSP,
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          });
          response.end(html);
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/report") {
          const raw = await readBody(request);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "the request body is not valid JSON" },
            });
            return;
          }
          const target = (parsed as { path?: unknown } | null)?.path;
          if (typeof target !== "string" || target.trim().length === 0) {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "no file path was supplied" },
            });
            return;
          }
          const conductor = new Conductor({
            cwd,
            defaultsRoot: options.defaultsRoot ?? installRoot,
            projectConfig: { policyMode: "TRUSTED_PROJECT", allowedRoots: [cwd] },
          });
          const result = await conductor.run(`bottleneck report; input=${target}`, {
            mode: "bottleneck",
            format: "markdown",
            output: path.join(cwd, "workspace", "bottleneck-report.md"),
            title: titleFor({ fileName: path.basename(target), purpose: UNKNOWN_PURPOSE }),
          });
          sendJson(response, statusFor(result), toResponse(result));
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/export") {
          const raw = await readBody(request);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "the request body is not valid JSON" },
            });
            return;
          }
          const body = (parsed as { path?: unknown; thread?: unknown } | null);
          const target = body?.path;
          if (typeof target !== "string" || target.trim().length === 0) {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "no file path was supplied, so there is nothing to export" },
            });
            return;
          }
          const thread: { role: string; text: string }[] = [];
          if (Array.isArray(body?.thread)) {
            for (const turn of body!.thread as unknown[]) {
              const t = turn as { role?: unknown; text?: unknown };
              if (t && typeof t.text === "string" && (t.role === "agent" || t.role === "user")) {
                thread.push({ role: t.role, text: t.text.slice(0, 4000) });
              }
            }
            if (thread.length > 200) thread.length = 200;
          }
          const resolvedExport = resolveWithinRoot(cwd, target);
          if (!resolvedExport.allowed) {
            sendJson(response, 403, {
              status: "FAILED",
              failure: {
                code: "PATH_OUTSIDE_WORKSPACE",
                reason: `path boundary violation: ${resolvedExport.reason ?? "the file is outside the workspace"}`,
                kernelReasonCode: "PATH_OUTSIDE_WORKSPACE",
              },
            });
            return;
          }
          const csvForExport = await readCsvFor(resolvedExport.resolvedPath as string);
          if (csvForExport === undefined) {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: `the file ${path.basename(target)} could not be read` },
            });
            return;
          }
          const rowsForExport = csvForExport.rows;
          const { resolveSchemaMemory: resolveForExport } = await import("../conductor/schema-memory.ts");
          const schemaForExport = await resolveForExport({
            cwd, headers: csvForExport.headers, rows: rowsForExport,
            defaultsRoot: options.defaultsRoot ?? installRoot,
          });
          const analysisForExport = await analyseBottlenecks(csvForExport, schemaForExport);
          const { toReactDashboard } = await import("./react-report.ts");
          const html = await toStandaloneExport(analysisForExport, target, schemaForExport?.roles ?? {}, thread);

          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-length": Buffer.byteLength(html),
            "content-disposition": `attachment; filename="${headerSafeName(target)}"`,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          response.end(html);
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/chat") {
          const raw = await readBody(request);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "the request body is not valid JSON" },
            });
            return;
          }
          const chat = (parsed as { path?: unknown; message?: unknown; sessionId?: unknown } | null);
          const target = chat?.path;
          const message = chat?.message;
          if (typeof target !== "string" || target.trim().length === 0) {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "no file path was supplied" },
            });
            return;
          }
          if (typeof message !== "string") {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "no question was supplied" },
            });
            return;
          }
          const resolvedChat = resolveWithinRoot(cwd, target);
          if (!resolvedChat.allowed) {
            sendJson(response, 403, {
              status: "FAILED",
              failure: {
                code: "PATH_OUTSIDE_WORKSPACE",
                reason: `path boundary violation: ${resolvedChat.reason ?? "the file is outside the workspace"}`,
                kernelReasonCode: "PATH_OUTSIDE_WORKSPACE",
              },
            });
            return;
          }
          const csvForChat = await readCsvFor(resolvedChat.resolvedPath as string);
          if (csvForChat === undefined) {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: `the file ${path.basename(target)} could not be read` },
            });
            return;
          }
          const rowsForChat = csvForChat.rows;
          const { resolveSchemaMemory } = await import("../conductor/schema-memory.ts");
          const { replyTo } = await import("../conductor/conversation.ts");
          const schemaForChat = await resolveSchemaMemory({
            cwd, headers: csvForChat.headers, rows: rowsForChat,
            defaultsRoot: options.defaultsRoot ?? installRoot,
          });
          const analysisForChat = await analyseBottlenecks(csvForChat, schemaForChat);
          let sessionId = newSessionId();
          if (typeof chat?.sessionId === "string") {
            try {
              sessionId = assertSessionId(chat.sessionId);
            } catch {
              sessionId = newSessionId();
            }
          }
          const answer = replyTo({
              source: target,
              totalRows: analysisForChat.totalRows,
              purpose: analysisForChat.purpose,
              columns: analysisForChat.numerical.columns.map((c) => ({
                name: c.column, mean: c.mean, min: c.min, max: c.max,
                measured: c.measured, dirty: c.dirty, empty: c.empty,
                histogram: c.histogram,
              })),
              anomalies: anomaliesFor(analysisForChat),
              ranking: analysisForChat.categories.slice(0, 10).map((c) => ({ key: c.key, count: c.count })),
              timeline: analysisForChat.hourly.hours.map((h) => ({
                hour: h.key, count: h.count, share: h.share,
                multiple: h.multiple, spike: h.isSpike, rule: h.rule,
              })),
              learned: schemaForChat?.roles ?? {},
              rows: rowsForChat,
            }, message);

          sendJson(response, 200, { status: "OK", sessionId: sessionId, reply: answer });
          try {
            await appendTurn(sessions, sessionId, { role: "user", text: message });
            await appendTurn(sessions, sessionId, {
              role: "agent",
              text: answer.text,
              widgets: answer.widgets,
              suggestions: answer.suggestions,
            });
          } catch {
            // Swallowed
          }
          return;
        }

        if (request.method === "GET" && url.pathname === "/api/session") {
          const requested = url.searchParams.get("id");
          if (requested === null || requested.trim().length === 0) {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "name a session: /api/session?id=<id>" },
            });
            return;
          }
          try {
            assertSessionId(requested);
          } catch {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_SESSION_ID", reason: "a session id may only contain lowercase hex and dashes" },
            });
            return;
          }
          const record = await readSession(sessions, requested);
          sendJson(response, 200, { status: "OK", session: record ?? null });
          return;
        }

        if (request.method === "POST" && url.pathname === "/api/feedback") {
          const raw = await readBody(request);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "the request body is not valid JSON" },
            });
            return;
          }
          const body = (parsed as { path?: unknown; column?: unknown; role?: unknown } | null);
          const target = body?.path;
          if (typeof target !== "string" || target.trim().length === 0) {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: "no file path was supplied, so there is nothing to correct" },
            });
            return;
          }
          const resolved = resolveWithinRoot(cwd, target);
          if (!resolved.allowed) {
            sendJson(response, 403, {
              status: "FAILED",
              failure: {
                code: "PATH_OUTSIDE_WORKSPACE",
                reason: `path boundary violation: ${resolved.reason ?? "the file is outside the workspace"}`,
                kernelReasonCode: "PATH_OUTSIDE_WORKSPACE",
              },
            });
            return;
          }
          const csv = await readCsvFor(resolved.resolvedPath as string);
          if (csv === undefined) {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: `the file ${path.basename(target)} could not be read` },
            });
            return;
          }
          const applied = await applyFeedback({
            cwd,
            headers: csv.headers,
            rows: csv.rows,
            column: body?.column,
            role: body?.role,
          });
          if (!applied.ok) {
            sendJson(response, 400, {
              status: "FAILED",
              failure: { code: "BAD_REQUEST", reason: applied.reason },
            });
            return;
          }
          const conductor = new Conductor({
            cwd,
            defaultsRoot: options.defaultsRoot ?? installRoot,
            projectConfig: { policyMode: "TRUSTED_PROJECT", allowedRoots: [cwd] },
          });
          const result = await conductor.run(`bottleneck report; input=${target}`, {
            mode: "bottleneck",
            format: "markdown",
            output: path.join(cwd, "workspace", "bottleneck-report.md"),
            title: titleFor({ fileName: path.basename(target), purpose: UNKNOWN_PURPOSE }),
          });
          sendJson(response, statusFor(result), { ...toResponse(result), feedback: { reason: applied.reason, roles: applied.roles ?? {} } });
          return;
        }
        
        // GET /api/v1/stream/alerts (Real-Time SSE Stream)
        if (request.method === "GET" && url.pathname === "/api/v1/stream/alerts") {
          response.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "Access-Control-Allow-Origin": "*",
          });

          response.write(`data: ${JSON.stringify({ type: "connected", timestamp: new Date().toISOString() })}\n\n`);
          sseClients.add(response);

          request.on("close", () => {
            sseClients.delete(response);
          });
          return;
        }

        // GET /api/v1/governance/ledger
        if (request.method === "GET" && url.pathname === "/api/v1/governance/ledger") {
          try {
            await dbPool.query(`
              CREATE TABLE IF NOT EXISTS approval_tasks (
                task_token TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                subject_json TEXT NOT NULL,
                decided_at BIGINT,
                approved_by TEXT,
                reason TEXT,
                result_expires_at BIGINT,
                collected_at BIGINT,
                created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
              )
            `);
            const colCheck = await dbPool.query(`
              SELECT column_name 
              FROM information_schema.columns 
              WHERE table_name='approval_tasks' AND column_name IN ('owasp_ref', 'nist_ref')
            `);
            const columnNames = new Set(colCheck.rows.map(r => r.column_name));
            const hasTraceability = columnNames.has("owasp_ref") && columnNames.has("nist_ref");

            const queryResult = await dbPool.query(`
              SELECT task_token, status, subject_json, decided_at, approved_by,
                     reason, result_expires_at, collected_at, created_at
                     ${hasTraceability ? ", owasp_ref, nist_ref" : ""}
              FROM approval_tasks
              ORDER BY created_at DESC
            `);

            const ledger = queryResult.rows.map((row) => {
              let subject: unknown;
              try {
                subject = typeof row.subject_json === "string" ? JSON.parse(row.subject_json) : row.subject_json;
              } catch {
                subject = row.subject_json;
              }
              return {
                token: row.task_token,
                status: row.status,
                subject,
                decidedAt: ledgerTimestamp(row.decided_at),
                approvedBy: row.approved_by ?? null,
                reason: row.reason ?? null,
                resultExpiresAt: ledgerTimestamp(row.result_expires_at),
                collectedAt: ledgerTimestamp(row.collected_at),
                createdAt: ledgerTimestamp(row.created_at),
                owaspRef: hasTraceability ? row.owasp_ref ?? null : null,
                nistRef: hasTraceability ? row.nist_ref ?? null : null,
              };
            });
            sendJson(response, 200, ledger);
            return;
          } catch (error) {
            sendJson(response, 200, []);
            return;
          }
        }

        // GET /api/v1/remediation/patches
        if (request.method === "GET" && url.pathname === "/api/v1/remediation/patches") {
          const files = readdirSync(sandboxRoot).filter(f => f.endsWith('.yaml') || f.endsWith('.tf'));
          const patches = await Promise.all(files.map(async (file) => {
            const document = await readFile(path.join(sandboxRoot, file), 'utf8');
            const patchId = file.replace(/\.(yaml|tf)$/, '');
            return { patchId, format: file.endsWith('.yaml') ? 'kubernetes' : 'terraform', document, state: 'AWAITING_APPROVAL' };
          }));
          sendJson(response, 200, patches);
          return;
        }

        // POST /api/v1/remediation/approvals
        if (request.method === "POST" && url.pathname === "/api/v1/remediation/approvals") {
          const body = JSON.parse(await readBody(request));
          remediation.review(body.task_token, { approved: body.status === 'approved', approvedBy: "Incident Commander", reason: "HITL review" });
          sendJson(response, 200, { status: "success" });
          return;
        }

        // POST /api/v1/workspace/ingest
        if (request.method === "POST" && url.pathname === "/api/v1/workspace/ingest") {
          await handleIngest(request, response, { cwd, onBroadcast: broadcastAlert });
          return;
        }

        // POST /api/v1/agent/task
        if (request.method === "POST" && url.pathname === "/api/v1/agent/task") {
          const raw = await readBody(request);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            sendJson(response, 400, { error: "the request body is not valid JSON" });
            return;
          }

          const body = parsed as { workspacePath?: unknown; prompt?: unknown } | null;
          const workspacePath = body?.workspacePath;
          const prompt = body?.prompt;

          if (typeof workspacePath !== "string" || workspacePath.trim().length === 0) {
            sendJson(response, 400, { error: "workspacePath is required." });
            return;
          }
          if (typeof prompt !== "string" || prompt.trim().length === 0) {
            sendJson(response, 400, { error: "prompt is required." });
            return;
          }

          const taskId = workspacePath;
          let currentIterations = 0;

          try {
            if (redis.status === 'ready') {
              const key = `neurofabric:task:iterations:${taskId}`;
              const results = await redis.pipeline().incr(key).expire(key, 300).exec();
              if (results && results[0][1]) {
                currentIterations = results[0][1] as number;
              }
            } else {
              currentIterations = (taskIterationMap.get(taskId) ?? 0) + 1;
              taskIterationMap.set(taskId, currentIterations);
            }
          } catch (e) {
            currentIterations = (taskIterationMap.get(taskId) ?? 0) + 1;
            taskIterationMap.set(taskId, currentIterations);
          }

          if (currentIterations > MAX_ITERATIONS) {
            sendJson(response, 429, { error: 'CIRCUIT_BREAKER_TRIPPED', details: 'Iteration threshold exceeded.' });
            return;
          }

          try {
            const resolvedTask = resolveWithinRoot(cwd, workspacePath);
            if (!resolvedTask.allowed) {
              sendJson(response, 403, {
                status: "FAILED",
                failure: {
                  code: "PATH_OUTSIDE_WORKSPACE",
                  reason: `path boundary violation: ${resolvedTask.reason ?? "the file is outside the workspace"}`,
                  kernelReasonCode: "PATH_OUTSIDE_WORKSPACE",
                },
              });
              return;
            }

            const conductor = new Conductor({
              cwd,
              defaultsRoot: options.defaultsRoot ?? installRoot,
              projectConfig: { policyMode: "TRUSTED_PROJECT", allowedRoots: [cwd] },
              remediation,
            });
            const result = await conductor.run(`${prompt}; input=${workspacePath}`, {
              mode: "omni",
              output: path.join(cwd, "workspace", "task-output"),
              title: titleFor({ fileName: path.basename(workspacePath), purpose: UNKNOWN_PURPOSE }),
            });

            sendJson(response, statusFor(result), toResponse(result));
          } finally {
            if (redis.status === 'ready') {
              await redis.del(`neurofabric:task:iterations:${taskId}`).catch(() => {});
            } else {
              taskIterationMap.delete(taskId);
            }
          }
          return;
        }

        // POST /api/v1/governance/verdict
        if (request.method === "POST" && url.pathname === "/api/v1/governance/verdict") {
          const raw = await readBody(request);
          let parsed: any;
          try {
            parsed = JSON.parse(raw);
          } catch {
            sendJson(response, 400, { error: "the request body is not valid JSON" });
            return;
          }

          const { task_token, status, approved_by, reason, result_json, ttl_seconds = 3600 } = parsed;
          if (!task_token || !status) {
            sendJson(response, 400, { error: "task_token and status are required." });
            return;
          }

          try {
            await dbPool.query("ALTER TABLE approval_tasks ADD COLUMN IF NOT EXISTS owasp_ref TEXT");
            await dbPool.query("ALTER TABLE approval_tasks ADD COLUMN IF NOT EXISTS nist_ref TEXT");

            const SCHEMA_MUTATION_RE = /\b(ALTER|DROP|CREATE|TRUNCATE|RENAME|ATTACH|DETACH)\b/i;
            const payloadStr = result_json ? JSON.stringify(result_json) : "";
            const isSchemaMutation = SCHEMA_MUTATION_RE.test(payloadStr);
            const owaspTag = isSchemaMutation ? "OWASP LLM03: Excessive Agency" : null;
            const nistTag = isSchemaMutation ? "NIST AI RMF: GOVERN 1.2" : null;

            const existingResult = await dbPool.query("SELECT status FROM approval_tasks WHERE task_token = $1", [task_token]);
            const existing = existingResult.rows[0];

            if (!existing) {
              sendJson(response, 404, { error: "Task not found." });
              return;
            }
            if (existing.status !== "pending") {
              sendJson(response, 400, { error: `Cannot update task. Current status is '${existing.status}'.` });
              return;
            }

            const decided_at = Math.floor(Date.now() / 1000);
            const result_expires_at = decided_at + Math.floor(ttl_seconds);
            const result_string = result_json ? JSON.stringify(result_json) : null;

            await dbPool.query(`
              UPDATE approval_tasks
              SET status = $1, result_json = $2, decided_at = $3, approved_by = $4,
                  reason = $5, result_expires_at = $6, owasp_ref = $7, nist_ref = $8
              WHERE task_token = $9
            `, [
              status,
              result_string,
              decided_at,
              approved_by || "system",
              reason || null,
              result_expires_at,
              owaspTag,
              nistTag,
              task_token,
            ]);

            sendJson(response, 200, {
              success: true,
              task_token,
              status,
              decided_at: ledgerTimestamp(decided_at),
              ...(isSchemaMutation ? { owasp_ref: owaspTag, nist_ref: nistTag } : {}),
            });
            return;
          } catch (error) {
            sendJson(response, 500, { error: "Internal server error processing verdict.", detail: String(error) });
            return;
          }
        }

        // POST /api/v1/embassy/decisions (HITL Approve/Reject)
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
          const reviewer = typeof parsed?.reviewer === "string" && parsed.reviewer.trim() !== "" ? parsed.reviewer : "operator";

          if (taskId === undefined || decision === undefined) {
            sendJson(response, 400, { error: "taskId and decision ('APPROVED' | 'REJECTED') are required" });
            return;
          }

          try {
            await dbPool.query("ALTER TABLE approval_tasks ADD COLUMN IF NOT EXISTS resolved_at BIGINT").catch(() => undefined);
            await dbPool.query("ALTER TABLE approval_tasks ADD COLUMN IF NOT EXISTS reviewer TEXT").catch(() => undefined);
            await dbPool.query(
              `UPDATE approval_tasks
               SET status = $1, resolved_at = EXTRACT(EPOCH FROM NOW()) * 1000, reviewer = $2, decided_at = EXTRACT(EPOCH FROM NOW())
               WHERE task_token = $3`,
              [decision, reviewer, taskId],
            );
          } catch (err) {
            console.warn('[ledger] decision persist failed:', err instanceof Error ? err.message : err);
          }

          // CLOSED-LOOP: on approval, execute remediation and start canary observation.
          if (decision === 'APPROVED') {
            try {
              let patch: any = undefined;
              try {
                const rowRes = await dbPool.query("SELECT subject_json FROM approval_tasks WHERE task_token = $1", [taskId]);
                const subjectJson = rowRes.rows[0]?.subject_json;
                const subject = typeof subjectJson === 'string' ? JSON.parse(subjectJson) : subjectJson;
                patch = subject?.patch;
              } catch { /* subject lookup failed */ }

              const execution = await new AutonomousDeploymentAdapter().applyRemediation(patch ?? {});
              const output = execution.output as { target?: string; executedAt?: string };

              const target = output?.target ?? 'unknown';
              await dbPool.query(
                `ALTER TABLE approval_tasks ADD COLUMN IF NOT EXISTS target TEXT;
                 ALTER TABLE approval_tasks ADD COLUMN IF NOT EXISTS patchDiff TEXT;
                 UPDATE approval_tasks
                   SET target = $1, patchDiff = $2, status = 'CANARY_VERIFYING',
                       resolved_at = EXTRACT(EPOCH FROM NOW()) * 1000, decided_at = EXTRACT(EPOCH FROM NOW())
                 WHERE task_token = $3`,
                [target, patch?.diff ?? '', taskId],
              ).catch((err) =>
                console.warn('[ledger] canary init columns failed:', err instanceof Error ? err.message : err),
              );

              setDbPool(dbPool);
              startCanaryObservation(taskId, target, patch?.diff ?? '');

              broadcastAlert({ type: 'REMEDIATION_DEPLOYED', data: { taskId, target } });
            } catch (err) {
              console.warn('[execution] closed-loop remediation failed:', err instanceof Error ? err.message : err);
              void dbPool.query(
                `UPDATE approval_tasks SET status = 'ROLLED_BACK', reason = $1 WHERE task_token = $2`,
                [err instanceof Error ? err.message : String(err), taskId],
              ).catch(() => undefined);
            }
          } else {
            try {
              await dbPool.query(
                `UPDATE approval_tasks
                 SET status = 'REJECTED', resolved_at = EXTRACT(EPOCH FROM NOW()) * 1000, decided_at = EXTRACT(EPOCH FROM NOW())
                 WHERE task_token = $1`,
                [taskId],
              ).catch((err) =>
                console.warn('[ledger] decision reject persist failed:', err instanceof Error ? err.message : err),
              );
            } catch (err) {
              console.warn('[ledger] decision reject persist failed:', err instanceof Error ? err.message : err);
            }
          }

          broadcastAlert({ type: 'DECISION_RESOLVED', data: { taskId, decision } });

          sendJson(response, 200, { success: true, taskId, status: decision });
          return;
        }

        // GET /api/v1/governance/result/:token
        const resultMatch = url.pathname.match(/^\/api\/v1\/governance\/result\/(.+)$/);
        if (request.method === "GET" && resultMatch) {
          const token = resultMatch[1];
          try {
            const taskResult = await dbPool.query("SELECT * FROM approval_tasks WHERE task_token = $1", [token]);
            const task = taskResult.rows[0];

            if (!task) {
              sendJson(response, 404, { error: "Task not found." });
              return;
            }

            if (task.status === "pending") {
              sendJson(response, 202, { status: "pending", message: "Task is awaiting governance decision." });
              return;
            }

            if (task.status === "approved" || task.status === "rejected") {
              const collected_at = Math.floor(Date.now() / 1000);
              await dbPool.query(`
                UPDATE approval_tasks 
                SET status = 'consumed', collected_at = $1 
                WHERE task_token = $2
              `, [collected_at, token]);

              sendJson(response, 200, {
                status: task.status,
                result: typeof task.result_json === "string" ? JSON.parse(task.result_json) : task.result_json,
                decided_at: task.decided_at,
                approved_by: task.approved_by,
                reason: task.reason,
                collected_at: ledgerTimestamp(collected_at)
              });
              return;
            }

            sendJson(response, 200, {
              status: task.status,
              result: typeof task.result_json === "string" ? JSON.parse(task.result_json) : task.result_json,
              message: `Task is no longer active (Status: ${task.status})`
            });
            return;
          } catch (error) {
            sendJson(response, 500, { error: "Internal server error retrieving result.", detail: String(error) });
            return;
          }
        }

        // GET /api/v1/ops/metrics (JSON KPI snapshot)
        if (request.method === "GET" && url.pathname === "/api/v1/ops/metrics") {
          let suppressed = 0;
          try {
            suppressed = (await alertsSuppressed.get()).values[0]?.value ?? 0;
          } catch { /* registry unavailable */ }
          let streamLagMs = 0;
          try {
            if (redis.status !== 'ready') await redis.connect();
            const info = await redis.xinfo('GROUPS', 'telemetry_stream');
            const groups = info as any[];
            const g = groups.find((grp: any) => (grp[1] ?? grp?.name) === 'telemetry_workers');
            if (g) {
              const lagIdx = g.indexOf('lag');
              streamLagMs = lagIdx >= 0 ? Number(g[lagIdx + 1]) ?? 0 : 0;
            }
          } catch { /* redis unavailable */ }
          sendJson(response, 200, { suppressedAlerts: suppressed, streamLagMs });
          return;
        }

        // GET /api/v1/metrics/ingestion
        if (request.method === "GET" && url.pathname === "/api/v1/metrics/ingestion") {
          sendJson(response, 200, metricsCollector.getSnapshot());
          return;
        }

        // GET /metrics
        if (request.method === "GET" && url.pathname === "/metrics") {
          response.writeHead(200, { "content-type": register.contentType });
          response.end(await register.metrics());
          return;
        }
      } catch (error) {
        sendJson(response, 500, {
          status: "FAILED",
          failure: { code: "SERVER_ERROR", reason: error instanceof Error ? error.message : String(error) },
        });
      }
    })();
  });

  server.once("close", () => evaluation.stop());
  evaluation.start();

  return server;
}

export async function startWedgeServer(options: WedgeOptions): Promise<RunningWedge> {
  const server = createWedgeServer(options);
  const port = options.port ?? (Number(process.env.PORT) || 10000);
  const host = options.host ?? "0.0.0.0";

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;

  return {
    url: `http://${host}:${bound}`,
    port: bound,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    }),
  };
}

// Top-level entrypoint execution
const PORT = Number(process.env.PORT) || 10000;
const HOST = "0.0.0.0";

startWedgeServer({ cwd: process.cwd(), port: PORT, host: HOST })
  .then((wedge) => console.log(`🚀 [NeuroFabric] Backend actively listening on http://${HOST}:${PORT}`))
  .catch((err) => {
    console.error("❌ [NeuroFabric] Failed to start server:", err);
    process.exit(1);
  });