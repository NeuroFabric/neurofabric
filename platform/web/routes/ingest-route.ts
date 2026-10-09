import { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { resolveWithinRoot } from "../../core/workspace.ts";
import { queueTelemetry } from "../../ingestion/redis-queue.ts";
import { EventCorrelator } from "../../ingestion/correlator.ts";
import { sanitizeTelemetry } from "../../ingestion/sanitizer.ts";
import { alertsSuppressed } from "../../observability/metrics.ts";

const correlator = new EventCorrelator();

export async function handleIngest(request: IncomingMessage, response: ServerResponse, options: { cwd: string; onBroadcast?: (payload: unknown) => void; }) {
  const contentType = (request.headers["content-type"] ?? "").toLowerCase();
  
  if (contentType.includes("application/json")) {
    let body = "";
    for await (const chunk of request) body += chunk;
    
    // 1. Scrub secrets on the raw string before parsing
    const cleanBody = sanitizeTelemetry(body);
    const cleanTelemetry = JSON.parse(cleanBody);
    
    // 2. Pass the sanitized object to the correlator
    const aggregated = await correlator.aggregateAlerts(cleanTelemetry);
    
    if (aggregated === null) {
      alertsSuppressed.inc();
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "Suppressed", message: "Redundant alert dropped" }));
      return;
    }
    
    await queueTelemetry(JSON.stringify(aggregated));

    // Broadcast immediately so SSE dashboards see the event without waiting on the worker
    options.onBroadcast?.({
      type: 'TELEMETRY_EVENT',
      data: {
        id: `tel-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        source: aggregated.source ?? cleanTelemetry.source ?? 'unknown',
        severity: aggregated.severity ?? cleanTelemetry.severity ?? 'info',
        message: aggregated.message ?? cleanTelemetry.message ?? 'Telemetry heartbeat',
        timestamp: new Date().toISOString(),
        rawLog: aggregated.raw_log ?? cleanTelemetry.raw_log ?? ''
      }
    });

    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "Accepted", message: "Payload queued." }));
    return;
  }
  
  response.writeHead(400, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "Only application/json is supported for new ingestion." }));
}