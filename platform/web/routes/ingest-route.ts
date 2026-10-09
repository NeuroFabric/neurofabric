import { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { resolveWithinRoot } from "../../core/workspace.ts";
import { queueTelemetry } from "../../ingestion/redis-queue.ts";
import EventCorrelator from "../../ingestion/correlator.ts";
import { sanitizeTelemetry } from "../../ingestion/sanitizer.ts";
import { alertsSuppressed } from "../../observability/metrics.ts";
import { metricsCollector } from "../../ingestion/metrics-collector.ts";
import { Embassy } from "../../../platform/embassy/engine.ts";
import { AutonomousDeploymentAdapter } from "../../../platform/embassy/AutonomousDeploymentAdapter.ts";
import { HitlAdapter } from "../../../platform/embassy/HitlAdapter.ts";

const correlator = new EventCorrelator();

export async function handleIngest(request: IncomingMessage, response: ServerResponse, options: { cwd: string; onBroadcast?: (payload: unknown) => void; }) {
  const startTime = Date.now();
  const contentType = (request.headers["content-type"] ?? "").toLowerCase();
  
  if (contentType.includes("application/json")) {
    let body = "";
    for await (const chunk of request) body += chunk;
    
    // 1. Scrub secrets on the raw string before parsing
    const secretsFound = (body.match(/password|secret|token|key/gi) || []).length;
    const cleanBody = sanitizeTelemetry(body);
    const cleanTelemetry = JSON.parse(cleanBody);
    
    // 2. Pass the sanitized object to the correlator
    const aggregated = await correlator.aggregateAlerts(cleanTelemetry);
    
    const latencyMs = Date.now() - startTime;
    const sizeBytes = Buffer.byteLength(body);
    const severity = String(aggregated?.severity ?? cleanTelemetry?.severity ?? 'info');
    const source = String(aggregated?.source ?? cleanTelemetry?.source ?? 'unknown');
    
    if (aggregated === null) {
      alertsSuppressed.inc();
      metricsCollector.recordSuppression();
      // Record the suppressed event for metrics
      metricsCollector.recordIngest(sizeBytes, latencyMs, severity, source, 0);
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "Suppressed", message: "Redundant alert dropped" }));
      return;
    }
    
    await queueTelemetry(JSON.stringify(aggregated));

    // Record successful ingestion metrics
    metricsCollector.recordIngest(sizeBytes, latencyMs, severity, source, secretsFound);

    // Handle critical events with Embassy
    if (severity === 'CRITICAL') {
      // Initialize Embassy with adapters and a stub RollbackCircuit
      const embassy = new Embassy(
        new AutonomousDeploymentAdapter(),
        new HitlAdapter(),
        {
          // RollbackCircuit stub
          async revert(executionId: string): Promise<{ success: boolean; error?: unknown }> {
            // Stub implementation: always succeed
            return { success: true };
          }
        }
      );

      // Create the remediation proposal as per the task
      const proposal: {
        patch: { diff: string }
        confidence: number
        blastRadius: "low" | "high" | "medium"
        metadata: {
          source: string
          severity: string
          message: any
          incidentId: string
        }
      } = {
        patch: {
          diff: `--- a/k8s/${source}.yaml\n+++ b/k8s/${source}.yaml\n@@ -12,3 +12,3 @@\n- replicas: 5\n+ replicas: 2`
        },
        confidence: 88,
        blastRadius: 'low', // 18% mapped to low
        metadata: {
          source: source,
          severity: severity, // 'CRITICAL'
          message: aggregated.message ?? cleanTelemetry.message ?? '',
          incidentId: `inc-${Date.now()}`
        }
      };

      // Execute the proposal through the Embassy
      await embassy.remediate(proposal);

      // Broadcast the HITL_PROPOSAL event as per the task
      const incidentId = `inc-${Date.now()}`;
      const taskId = `hitl-${incidentId}-${Date.now()}`;

      options.onBroadcast?.({
        type: 'HITL_PROPOSAL',
        data: {
          taskId,
          source: source,
          severity: severity,
          confidence: 88,
          blastRadius: 'low', // as per task
          summary: `Remediation required for ${source}: ${aggregated.message ?? cleanTelemetry.message ?? ''}`,
          patchDiff: `--- a/k8s/${source}.yaml\n+++ b/k8s/${source}.yaml\n@@ -12,3 +12,3 @@\n- replicas: 5\n+ replicas: 2`
        }
      });
    }

    // Broadcast immediately so SSE dashboards see the event without waiting on the worker
    options.onBroadcast?.({
      type: 'TELEMETRY_EVENT',
      data: {
        id: `evt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        severity: severity || 'info',
        source: source || 'unknown',
        message: aggregated.message ?? cleanTelemetry.message ?? 'Telemetry heartbeat',
        timestamp: new Date().toLocaleTimeString()
      }
    });

    response.writeHead(202, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "Accepted", message: "Payload queued." }));
    return;
  }
  
  response.writeHead(400, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "Only application/json is supported for new ingestion." }));
}