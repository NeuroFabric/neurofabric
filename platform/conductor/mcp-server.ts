import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseLogFile } from "./log-parser.ts";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

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

export async function connectMcp() {
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);
}
