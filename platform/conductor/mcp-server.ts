import { parseLogFile } from "./log-parser.ts";
import path from "node:path";
import { classifySql } from "../core/sql-guard.ts";
import { executeReadOnlySql, type SqlExecutor } from "./readonly-sql.ts";
import {
  parseTarget,
  patchSandboxRoot,
  proposeInfrastructurePatch,
} from "../remediation/iac-generator.ts";

let McpServerMod: any, zMod: any, ClientMod: any, InMemoryTransportMod: any;
let isLoaded = false;

async function loadMcp() {
  if (isLoaded) return;
  const mcpServer = await import("@modelcontextprotocol/sdk/server/mcp.js").catch(() => null);
  const zod = await import("zod").catch(() => null);
  const mcpClient = await import("@modelcontextprotocol/sdk/client/index.js").catch(() => null);
  const inMemory = await import("@modelcontextprotocol/sdk/inMemory.js").catch(() => null);
  if (!mcpServer || !zod || !mcpClient || !inMemory) {
    throw new Error("MCP SDK or Zod is not installed");
  }
  McpServerMod = mcpServer.McpServer;
  zMod = zod.z;
  ClientMod = mcpClient.Client;
  InMemoryTransportMod = inMemory.InMemoryTransport;
  isLoaded = true;
}

export const server = new Proxy({}, {
  get: (target, prop) => {
    if (!isLoaded) throw new Error("MCP not loaded. Call connectMcp() first.");
    return (_server as any)[prop];
  }
}) as any;

export const client = new Proxy({}, {
  get: (target, prop) => {
    if (!isLoaded) throw new Error("MCP not loaded. Call connectMcp() first.");
    return (_client as any)[prop];
  }
}) as any;

let _server: any;
let _client: any;
let _serverTransport: any;
let _clientTransport: any;

let performanceSql: SqlExecutor = executeReadOnlySql;

export function setPerformanceSqlExecutor(executor: SqlExecutor): void {
  performanceSql = executor;
}

export function resetPerformanceSqlExecutor(): void {
  performanceSql = executeReadOnlySql;
}

async function initMcpInstances() {
  await loadMcp();
  _server = new McpServerMod({ name: "neurofebric-gateway", version: "1.0.0" });

  _server.tool("query_telemetry", "Query structured telemetry data from a log profile", {
    metricName: zMod.enum(['p99_latency', 'http_5xx', 'throughput']),
    timeWindowHours: zMod.number().min(1).max(24),
    filePath: zMod.string().describe("Path to the log file to analyze")
  }, async ({ metricName, timeWindowHours, filePath }: any) => {
    const result = await parseLogFile(filePath);
    if (!result.ok) return { content: [{ type: "text", text: `Error parsing log: ${result.error}` }] };
    let data: any;
    switch (metricName) {
      case 'p99_latency': data = result.byHour.map((h: any) => ({ time: h.key, p99: h.p99LatencyMs })); break;
      case 'http_5xx': data = result.http5xx; break;
      case 'throughput': data = result.byHour.map((h: any) => ({ time: h.key, count: h.count })); break;
    }
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  });

  _server.tool("query_database_performance", "Query database performance metrics", {
    query: zMod.string().describe("SQL query to execute read-only performance check")
  }, async ({ query }: any) => {
    const verdict = classifySql(query);
    if (!verdict.allowed) return { content: [{ type: "text", text: `SQL Rejected: ${verdict.reason}` }], isError: true };
    try {
      const rows = performanceSql(query);
      return { content: [{ type: "text", text: JSON.stringify({ status: "success", query, readOnly: true, rows }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `SQL Rejected: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  _server.tool("fetch_infrastructure_logs", "Retrieve recent log traces", {
    correlationId: zMod.string().optional().describe("Correlation ID"),
    metadataTag: zMod.string().optional().describe("Metadata tag")
  }, async ({ correlationId, metadataTag }: any) => {
    const traces = [{ timestamp: new Date().toISOString(), correlationId: correlationId || "corr-default-123", tag: metadataTag || "prod-service", level: "warn", message: "Database connection pool saturated" }];
    return { content: [{ type: "text", text: JSON.stringify(traces, null, 2) }] };
  });

  _server.tool("propose_infrastructure_patch", "Generate patch into the remediation sandbox", {
    target: zMod.string().describe("Target resource"),
    format: zMod.enum(["kubernetes", "terraform"]).describe("Format"),
    desiredState: zMod.record(zMod.string(), zMod.union([zMod.string(), zMod.number(), zMod.boolean()])).describe("Desired state")
  }, async ({ target, format, desiredState }: any) => {
    try {
      const proposal = await proposeInfrastructurePatch({ target: parseTarget(target), format, desiredState }, patchSandboxRoot());
      return { content: [{ type: "text", text: JSON.stringify({ patchId: proposal.patchId, path: proposal.path, format: proposal.format, state: proposal.state, applied: false, document: proposal.document }, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Patch Rejected: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
    }
  });

  _server.tool("generate_sql_remediation", "Generate SQL index patches safely", {
    filePath: zMod.string().describe("Path to file")
  }, async ({ filePath }: any) => {
    const result = await parseLogFile(filePath);
    if (!result.ok) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    return { content: [{ type: "text", text: result.sqlIndexPatch || "-- No remediation needed" }] };
  });

  const transports = InMemoryTransportMod.createLinkedPair();
  _clientTransport = transports[0];
  _serverTransport = transports[1];
  _client = new ClientMod({ name: "neurofebric-conductor", version: "1.0.0" });
}

let mcpConnected: Promise<void> | undefined;

export async function connectMcp() {
  if (mcpConnected === undefined) {
    mcpConnected = initMcpInstances().then(() => {
      return Promise.all([
        _server.connect(_serverTransport),
        _client.connect(_clientTransport),
      ]);
    }).then(() => undefined);
  }
  return mcpConnected;
}
