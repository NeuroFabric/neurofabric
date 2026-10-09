import { RemediationProposal, ExecutionResult } from "./engine.ts";
import { EventEmitter } from "node:events";

// Shared event emitter for HITL events (process-local).
// platform/web/server.ts subscribes to 'hitl:events' and fans payloads out to SSE clients.
const hitlEmitter = new EventEmitter();
hitlEmitter.setMaxListeners(0);

export const hitlEventBus = hitlEmitter;

export interface HitlProposalPayload {
  taskId: string;
  incidentId: string;
  source: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  confidence: number;
  blastRadius: 'low' | 'medium' | 'high';
  patch: unknown;
  format: string;
  status: 'PENDING';
  createdAt: string;
}

export class HitlAdapter {
  async execute(proposal: RemediationProposal): Promise<ExecutionResult> {
    const metadata = proposal.metadata ?? {};
    const patch = proposal.patch;
    const incidentId = String(metadata['incidentId'] ?? `inc-${Date.now()}`);
    const confidence = typeof proposal.confidence === "number" ? proposal.confidence : 0;
    const blastRadius = proposal.blastRadius;
    const taskId = `hitl-${incidentId}-${Date.now()}`;

    const severity = (metadata['severity'] as string) ?? (blastRadius === 'high' ? 'critical' : 'warning');
    const payload: HitlProposalPayload = {
      taskId,
      incidentId,
      source: String(metadata['source'] ?? 'system'),
      severity: severity as 'critical' | 'warning' | 'info',
      message:
        typeof patch === 'object' && patch !== null && 'message' in patch
          ? String((patch as { message?: unknown }).message ?? '')
          : '',
      confidence,
      blastRadius,
      patch,
      format: 'unified_diff',
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    };

    // Dual dispatch: SSE broadcast + ledger persistence listeners both subscribe here.
    hitlEmitter.emit('hitl:events', payload);

    return {
      executionId: taskId,
      output: { success: true, taskId, status: 'PENDING' },
    };
  }
}
