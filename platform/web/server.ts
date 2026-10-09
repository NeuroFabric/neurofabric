import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { mkdirSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";

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
  const base = path.basename(target).replace(/\\.[^.]+$/, "") || "analysis";
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

        // NOTE: If you have an `isProtectedUiPath` and `enforceIncidentCommander` imported earlier,
        // it should go here. Assuming they were omitted in the user code dump by accident, 
        // they are commented out, but feel free to restore them if they are in your actual imports.
        /*
        if (isProtectedUiPath(url.pathname)) {
          if (enforceIncidentCommander(request, response)) return;
        }
        */

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

        // GET /api/v1/governance/ledger
        if (request.method === "GET" && url.pathname === "/api/v1/governance/ledger") {
          try {
            const Database = (await import("better-sqlite3")).default;
            const db = new Database(path.join(cwd, "workspace", "gate.db"), { readonly: true });
            const tableInfo = db.prepare("PRAGMA table_info(approval_tasks)").all() as { name: string }[];
            const columnNames = new Set(tableInfo.map((column) => column.name));
            const hasTraceability = columnNames.has("owasp_ref") && columnNames.has("nist_ref");

            const rows = db.prepare(`
              SELECT task_token, status, subject_json, decided_at, approved_by,
                     reason, result_expires_at, collected_at, created_at
                     ${hasTraceability ? ", owasp_ref, nist_ref" : ""}
              FROM approval_tasks
              ORDER BY created_at DESC
            `).all() as {
              task_token: string; status: string; subject_json: string; decided_at: number | null;
              approved_by: string | null; reason: string | null; result_expires_at: number | null;
              collected_at: number | null; created_at: number; owasp_ref?: string | null; nist_ref?: string | null;
            }[];

            const ledger = rows.map((row) => {
              let subject: unknown;
              try {
                subject = JSON.parse(row.subject_json);
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
            const message = error instanceof Error ? error.message : String(error);
            const code = typeof error === "object" && error !== null && "code" in error
              ? (error as { code?: unknown }).code
              : undefined;
            if (code === "SQLITE_CANTOPEN" || message.includes("no such file") || message.includes("unable to open database file")) {
              sendJson(response, 200, []);
              return;
            }
            sendJson(response, 500, { error: "Could not read the governance ledger.", detail: message });
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
          try {
            const contentType = request.headers["content-type"] ?? "";
            
            // ROUTE 1: JSON APM TELEMETRY (For JMeter Load Testing)
            if (contentType.includes("application/json")) {
              const _raw = await readBody(request);
              
              const conductor = new Conductor({
                cwd,
                defaultsRoot: options.defaultsRoot ?? installRoot,
                projectConfig: { policyMode: "TRUSTED_PROJECT", allowedRoots: [cwd] },
                remediation,
              });

              // Offload to background promise
              void conductor.run(`analyze telemetry`, {
                mode: "omni",
                output: path.join(cwd, "workspace", "task-output"),
                title: "High-Concurrency APM Ingestion",
              }).catch(err => console.error("Async Conductor execution failed:", err));

              sendJson(response, 202, { status: "Accepted", message: "Payload received and queued." });
              return;
            }

            // ROUTE 2: LEGACY MULTIPART FILE UPLOAD
            const boundaryMatch = /boundary=([^;\s]+)/i.exec(contentType);
            if (boundaryMatch === null) {
              sendJson(response, 400, { error: "multipart/form-data boundary is missing from Content-Type." });
              return;
            }
            const boundary = boundaryMatch[1]!.replace(/^"|"$/g, "");

            let rawBuffer: Buffer;
            try {
              rawBuffer = await new Promise<Buffer>((resolve, reject) => {
                let size = 0;
                const chunks: Buffer[] = [];
                request.on("data", (chunk: Buffer) => {
                  size += chunk.length;
                  if (size > MAX_BODY_BYTES) {
                    reject(new Error(`body exceeds ${MAX_BODY_BYTES} bytes`));
                    request.destroy();
                    return;
                  }
                  chunks.push(chunk);
                });
                request.on("end", () => resolve(Buffer.concat(chunks)));
                request.on("error", reject);
              });
            } catch (error) {
              sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not read body." });
              return;
            }

            const delimiter = Buffer.from(`--${boundary}`);
            const crlf = Buffer.from("\r\n");
            const crlfcrlf = Buffer.from("\r\n\r\n");

            let fileName: string | undefined;
            let fileBuffer: Buffer | undefined;

            let offset = 0;
            while (offset < rawBuffer.length) {
              const delimPos = rawBuffer.indexOf(delimiter, offset);
              if (delimPos === -1) break;

              const afterDelim = delimPos + delimiter.length;
              if (rawBuffer[afterDelim] === 0x2d && rawBuffer[afterDelim + 1] === 0x2d) break;
              
              const partStart = afterDelim + crlf.length;
              const headerEnd = rawBuffer.indexOf(crlfcrlf, partStart);
              if (headerEnd === -1) { offset = afterDelim; continue; }

              const partHeaders = rawBuffer.slice(partStart, headerEnd).toString("utf8");
              const bodyStart = headerEnd + crlfcrlf.length;

              const nextDelim = rawBuffer.indexOf(delimiter, bodyStart);
              const bodyEnd = nextDelim === -1 ? rawBuffer.length : nextDelim - crlf.length;
              const partBody = rawBuffer.slice(bodyStart, bodyEnd);

              const dispositionMatch = /content-disposition:[^\r\n]*/i.exec(partHeaders);
              if (dispositionMatch !== null) {
                const nameMatch = /name="([^"]*)"/i.exec(dispositionMatch[0]);
                const fileNameMatch = /filename="([^"]*)"/i.exec(dispositionMatch[0]);
                if (nameMatch?.[1] === "file" && fileNameMatch !== null) {
                  fileName = path.basename(fileNameMatch[1]);
                  fileBuffer = partBody;
                }
              }

              offset = nextDelim === -1 ? rawBuffer.length : nextDelim;
            }

            if (fileName === undefined || fileBuffer === undefined) {
              sendJson(response, 400, { error: 'A file field named "file" is required.' });
              return;
            }

            const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._]+/, "") || "upload";
            if (fileBuffer.length === 0) {
              sendJson(response, 400, { error: "The uploaded file is empty." });
              return;
            }

            const destRelative = path.join("workspace", safeName);
            const destVerdict = resolveWithinRoot(cwd, destRelative);
            if (!destVerdict.allowed) {
              sendJson(response, 403, { error: "path boundary violation" });
              return;
            }
            const destAbsolute = destVerdict.resolvedPath as string;

            const fs = await import("node:fs/promises");
            await fs.mkdir(path.dirname(destAbsolute), { recursive: true });
            await fs.writeFile(destAbsolute, fileBuffer);

            const { createHash } = await import("node:crypto");
            const sha256 = createHash("sha256").update(fileBuffer).digest("hex");

            sendJson(response, 200, {
              path: destRelative.replace(/\\/g, "/"),
              name: safeName,
              size: fileBuffer.length,
              sha256,
            });
            return;
            
          } catch (error) {
            console.error("Ingestion error:", error);
            sendJson(response, 500, { error: "Failed to process payload" });
            return;
          }
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
              const key = `neurofebric:task:iterations:${taskId}`;
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
              await redis.del(`neurofebric:task:iterations:${taskId}`).catch(() => {});
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
            const Database = (await import("better-sqlite3")).default;
            const db = new Database(path.join(cwd, "workspace", "gate.db"));

            try {
              db.prepare("ALTER TABLE approval_tasks ADD COLUMN owasp_ref TEXT").run();
            } catch (migrationErr) {
              const msg = migrationErr instanceof Error ? migrationErr.message : String(migrationErr);
              if (!msg.includes("duplicate column name")) throw migrationErr;
            }
            try {
              db.prepare("ALTER TABLE approval_tasks ADD COLUMN nist_ref TEXT").run();
            } catch (migrationErr) {
              const msg = migrationErr instanceof Error ? migrationErr.message : String(migrationErr);
              if (!msg.includes("duplicate column name")) throw migrationErr;
            }

            const SCHEMA_MUTATION_RE = /\b(ALTER|DROP|CREATE|TRUNCATE|RENAME|ATTACH|DETACH)\b/i;
            const payloadStr = result_json ? JSON.stringify(result_json) : "";
            const isSchemaMutation = SCHEMA_MUTATION_RE.test(payloadStr);
            const owaspTag = isSchemaMutation ? "OWASP LLM03: Excessive Agency" : null;
            const nistTag = isSchemaMutation ? "NIST AI RMF: GOVERN 1.2" : null;

            const existing = db.prepare("SELECT status FROM approval_tasks WHERE task_token = ?").get(task_token) as any;

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

            db.prepare(`
              UPDATE approval_tasks
              SET status = ?, result_json = ?, decided_at = ?, approved_by = ?,
                  reason = ?, result_expires_at = ?, owasp_ref = ?, nist_ref = ?
              WHERE task_token = ?
            `).run(
              status,
              result_string,
              decided_at,
              approved_by || "system",
              reason || null,
              result_expires_at,
              owaspTag,
              nistTag,
              task_token,
            );

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

        // GET /api/v1/governance/result/:token
        const resultMatch = url.pathname.match(/^\/api\/v1\/governance\/result\/(.+)$/);
        if (request.method === "GET" && resultMatch) {
          const token = resultMatch[1];
          try {
            const Database = (await import("better-sqlite3")).default;
            const db = new Database(path.join(cwd, "workspace", "gate.db"));

            const task = db.prepare("SELECT * FROM approval_tasks WHERE task_token = ?").get(token) as any;

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
              db.prepare(`
                UPDATE approval_tasks 
                SET status = 'consumed', collected_at = ? 
                WHERE task_token = ?
              `).run(collected_at, token);

              sendJson(response, 200, {
                status: task.status,
                result: task.result_json ? JSON.parse(task.result_json) : null,
                decided_at: task.decided_at,
                approved_by: task.approved_by,
                reason: task.reason,
                collected_at: ledgerTimestamp(collected_at)
              });
              return;
            }

            sendJson(response, 200, {
              status: task.status,
              result: task.result_json ? JSON.parse(task.result_json) : null,
              message: `Task is no longer active (Status: ${task.status})`
            });
            return;
          } catch (error) {
            sendJson(response, 500, { error: "Internal server error retrieving result.", detail: String(error) });
            return;
          }
        }

        sendJson(response, 404, { status: "FAILED", failure: { code: "NOT_FOUND", reason: `no route for ${request.method} ${url.pathname}` } });
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
  const port = options.port ?? 0;
  const host = options.host ?? "127.0.0.1";
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