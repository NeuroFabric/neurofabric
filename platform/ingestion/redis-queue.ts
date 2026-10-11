import { Redis } from "ioredis";
import path from "node:path";
import { Embassy } from "../embassy/engine.ts";
import type { RemediationProposal, ExecutionResult } from "../embassy/engine.ts";
import { AutonomousDeploymentAdapter } from "../embassy/AutonomousDeploymentAdapter.ts";
import { HitlAdapter } from "../embassy/HitlAdapter.ts";

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
});

export const TELEMETRY_STREAM = "telemetry_stream";
export const CONSUMER_GROUP = "telemetry_workers";

/**
 * Queue a telemetry payload to the Redis Stream.
 * @param payload JSON string of the telemetry payload
 * @returns The ID of the inserted stream entry
 */
export async function queueTelemetry(payload: string): Promise<string> {
  if (redis.status !== 'ready') {
    await redis.connect();
  }
  // XADD telemetry_stream * payload <json>
const id = await redis.xadd('telemetry_stream', '*', 'payload', payload);
if (!id) throw new Error("Redis failed to return a stream ID");
return id;
}

/**
 * Ensures the consumer group exists. Call once at startup.
 */
export async function ensureConsumerGroup(): Promise<void> {
  if (redis.status !== 'ready') {
    await redis.connect();
  }
  try {
    await redis.xgroup('CREATE', TELEMETRY_STREAM, CONSUMER_GROUP, '0', 'MKSTREAM').catch(err => { if (!err.message.includes('BUSYGROUP')) throw err; });
  } catch (err: any) {
    if (!err.message.includes('BUSYGROUP')) {
      throw err;
    }
  }
}

/**
 * Worker that consumes from the telemetry stream and processes with Conductor and Embassy.
 */
export class TelemetryWorker {
  private conductor: any;
  private consumerName: string;
  private running = false;
  private pollIntervalMs: number;
  private embassy: Embassy;

  constructor(conductor: any, pollIntervalMs = 1000) {
    this.conductor = conductor;
    this.consumerName = `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.pollIntervalMs = pollIntervalMs;
    // Initialize Embassy with adapters
    this.embassy = new Embassy(
      new AutonomousDeploymentAdapter(),
      new HitlAdapter(),
      {
        // RollbackCircuit stub
        async revert(executionId: string): Promise<{ success: boolean; error?: unknown }> {
          console.log("StubRollbackCircuit.revert:", executionId);
          return { success: true };
        }
      },
      // confidenceScorer optional, telemetryMonitor optional, logger optional
      undefined,
      undefined,
      (entry) => console.log(JSON.stringify(entry))
    );
  }

  /**
   * Start the polling loop.
   */
  async start(): Promise<void> {
    await ensureConsumerGroup();
    this.running = true;
    this.poll();
  }

  /**
   * Stop the polling loop gracefully.
   */
  stop(): void {
    this.running = false;
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const streams = await redis.xreadgroup(
          'GROUP', CONSUMER_GROUP, this.consumerName,
          'COUNT', 10,
          'BLOCK', 2000,
          'STREAMS', TELEMETRY_STREAM, '>'
        );

        if (!streams) continue;

        for (const [streamName, messages] of streams) {
          for (const [messageId, fields] of messages) {
            if (!fields) continue;
              const payloadStr = fields[1];
            if (!payloadStr) continue;

            try {
              const payload = JSON.parse(payloadStr);
              const isCritical = payload.severity === 'critical';
              // Build a remediation proposal from telemetry payload.
              // Critical incidents score 45% confidence with high blast radius so they
              // route to HitlAdapter; routine warnings execute autonomously at 98%.
              const proposal: RemediationProposal = {
                patch: {
                  target: 'deployment/' + (payload.source || 'service'),
                  action: 'rollback_revision',
                  message: payload.message,
                  diff: '--- kubernetes/deployment.yaml\n+++ kubernetes/deployment.yaml\n@@ -18,3 +18,3 @@\n-  image: registry.internal/app:v2.4.1\n+  image: registry.internal/app:v2.4.0\n-  max_connections: 50\n+  max_connections: 500'
                },
                confidence: isCritical ? 45 : 98,
                blastRadius: isCritical ? 'high' : 'low',
                metadata: {
                  source: payload.source || 'system',
                  incidentId: payload.incidentId || `inc-${Date.now()}`
                }
              };
              console.log('[TelemetryWorker] Dispatched proposal to Embassy:', (proposal.metadata as { incidentId?: string })?.incidentId);
              const outcome = await this.embassy.remediate(proposal);
              console.log("TelemetryWorker: Embassy remediation outcome:", outcome);

              await redis.xack(TELEMETRY_STREAM, CONSUMER_GROUP, messageId);
            } catch (err) {
              console.error(`TelemetryWorker: Failed to process message ${messageId}:`, err);
            }
          }
        }
      } catch (err) {
        if (this.running) {
          console.error("TelemetryWorker poll error:", err);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
  }
}

