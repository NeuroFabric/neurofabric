import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseLogFile } from "./log-parser.ts";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { classifySql } from "../core/sql-guard.ts";
import { executeReadOnlySql, type SqlExecutor } from "./readonly-sql.ts";
import {
  parseTarget,
  patchSandboxRoot,
  proposeInfrastructurePatch,
} from "../remediation/iac-generator.ts";

/**
 * MCP GATEWAY.
 * 
 * Initialises the neurofebric-gateway server instance. 
 */

export const server = new McpServer({
  name: "neurofebric-gateway",
  version: "1.0.0",
});

// Telemetry Query Tool
server.tool(
  "query_telemetry",
  "Query structured telemetry data from a log profile",
  {
    metricName: z.enum(['p99_latency', 'http_5xx', 'throughput']),
    timeWindowHours: z.number().min(1).max(24),
    filePath: z.string().describe("Path to the log file to analyze"),
  },
  async ({ metricName, timeWindowHours, filePath }) => {
    const result = await parseLogFile(filePath);
    if (!result.ok) {
      return { content: [{ type: "text", text: `Error parsing log: ${result.error}` }] };
    }

    let data: any;
    switch (metricName) {
      case 'p99_latency':
        data = result.byHour.map(h => ({ time: h.key, p99: h.p99LatencyMs }));
        break;
      case 'http_5xx':
        data = result.http5xx;
        break;
      case 'throughput':
        data = result.byHour.map(h => ({ time: h.key, count: h.count }));
        break;
    }

    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  }
);

/**
 * THE ONLY SQL THIS PROCESS WILL RUN.
 *
 * Default is an in-memory read-only SQLite executor. Tests replace it so the
 * stacked-query refusal can be observed without touching a caller's database.
 * Replacement is the whole injection point: there is no flag that turns the
 * guard off.
 */
let performanceSql: SqlExecutor = executeReadOnlySql;

export function setPerformanceSqlExecutor(executor: SqlExecutor): void {
  performanceSql = executor;
}

export function resetPerformanceSqlExecutor(): void {
  performanceSql = executeReadOnlySql;
}

// Database Performance Query Tool (Read-Only Enforced)
server.tool(
  "query_database_performance",
  "Query database performance metrics (slow queries, lock contention) with read-only SQL validation",
  {
    query: z.string().describe("SQL query to execute read-only performance check"),
  },
  async ({ query }) => {
    // Guard first, then execute. classifySql is the same whitelist the kernel
    // uses; the executor opens SQLite read-only and still refuses a second
    // statement, so a stacked query never reaches the engine as a write.
    const verdict = classifySql(query);
    if (!verdict.allowed) {
      return {
        content: [{ type: "text", text: `SQL Rejected: ${verdict.reason}` }],
        isError: true,
      };
    }
    try {
      const rows = performanceSql(query);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { status: "success", query, readOnly: true, rows },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `SQL Rejected: ${message}` }],
        isError: true,
      };
    }
  }
);

// Fetch Infrastructure Logs Tool
server.tool(
  "fetch_infrastructure_logs",
  "Retrieve recent log traces based on correlation ID or metadata tag",
  {
    correlationId: z.string().optional().describe("Correlation ID or request ID"),
    metadataTag: z.string().optional().describe("Metadata tag or service name"),
  },
  async ({ correlationId, metadataTag }) => {
    const traces = [
      {
        timestamp: new Date().toISOString(),
        correlationId: correlationId || "corr-default-123",
        tag: metadataTag || "prod-service",
        level: "warn",
        message: "Database connection pool saturated",
      },
    ];
    return {
      content: [{ type: "text", text: JSON.stringify(traces, null, 2) }],
    };
  }
);

// Infrastructure Patch Proposal Tool (Sandboxed, HITL-Gated)
//
// The remediation boundary, in one tool. It writes a document
// into the sandbox and returns the patch id. It does not -- and
// structurally CANNOT -- apply anything: there is no kubectl and
// no terraform anywhere in this process (see
// platform/remediation/iac-generator.ts). Applying is an
// operator's action, taken after an Incident Commander approves
// the patch through the async approval gate.
server.tool(
  "propose_infrastructure_patch",
  "Generate a Kubernetes YAML or Terraform HCL patch into the remediation sandbox and return its patch ID. The patch is a proposal only: this tool never applies it.",
  {
    target: z.string().describe("Target resource: 'kind/name' or a bare name, e.g. deployment/payments-api"),
    format: z.enum(["kubernetes", "terraform"]).describe("The document format to generate"),
    desiredState: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).describe("The desired state, flat scalar keys"),
  },
  async ({ target, format, desiredState }) => {
    try {
      const proposal = await proposeInfrastructurePatch(
        { target: parseTarget(target), format, desiredState },
        patchSandboxRoot(),
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                patchId: proposal.patchId,
                path: proposal.path,
                format: proposal.format,
                state: proposal.state,
                // The positive statement of the one thing this
                // tool must never do. A reviewer reading the
                // response can check it without reading source.
                applied: false,
                document: proposal.document,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Patch Rejected: ${message}` }],
        isError: true,
      };
    }
  }
);

// Remediation Tool - SAFE DDL only
server.tool(
  "generate_sql_remediation",
  "Generate SQL index patches safely",
  {
    filePath: z.string().describe("Path to the file to generate remediation for"),
  },
  async ({ filePath }) => {
    const result = await parseLogFile(filePath);
    if (!result.ok) {
        return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    }
    
    return {
      content: [{ type: "text", text: result.sqlIndexPatch || "-- No remediation needed" }],
    };
  }
);

// Conductor Client Bridge
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
export const client = new Client({ name: "neurofebric-conductor", version: "1.0.0" });

let mcpConnected: Promise<void> | undefined;

export async function connectMcp() {
  // The Conductor constructor fires this on every instance. Connecting twice
  // against the same in-memory pair throws, so the second caller waits on the
  // first rather than opening a second transport.
  if (mcpConnected === undefined) {
    mcpConnected = Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]).then(() => undefined);
  }
  return mcpConnected;
}
