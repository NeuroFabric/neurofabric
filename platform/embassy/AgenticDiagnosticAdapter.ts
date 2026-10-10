/**
 * AGENTIC DIAGNOSTIC ADAPTER — LLM‑root‑cause analysis stub.
 *
 * Responsibilities:
 * 1. Accept a diagnostic payload { service, stackTrace, context }.
 * 2. Synthesize a structured incident report:
      { rootCause: string; proposedFix: string; diff: string;
        blastRadius: string; confidence: number }.
 * 3. When the inferred severity is critical, automatically emit a telemetry
 *    ingestion event against `POST /api/v1/workspace/ingest` so the event
 *    flows through the existing SSE / HITL pipeline.
 *
 * Design notes:
 *   • This is a **stub** — the reasoning is rule‑based, not an actual LLM call.
   • The structured format matches the expected contract for downstream
     alert‑clustering and RCA pipelines.
   • The `diff` field contains a contextual unified‑diff snippet derived
     from the service name and stackTrace; callers can replace it with a
     real git diff if desired.
   • The `confidence` score is deterministic (55‑92) based on keyword
     presence, simulating a model‑graded certainty.
   • Emission to `POST /api/v1/workspace/ingest` is fire‑and‑forget; if the
     server is unavailable the adapter still returns the report so the caller
     is never blocked.
 */

export interface DiagnosticPayload {
  service: string;
  stackTrace: string;
  context?: any;
}

export interface IncidentReport {
  rootCause: string;
  proposedFix: string;
  diff: string;
  blastRadius: string;
  confidence: number;
}

export class AgenticDiagnosticAdapter {
  private readonly ingestUrl: string;

  constructor(ingestUrl: string = "http://127.0.0.1:8080/api/v1/workspace/ingest") {
    this.ingestUrl = ingestUrl;
  }

  /**
   * Diagnose a service anomaly and produce an incident report.
   *
   * @param payload { service, stackTrace, context }
   * @returns { IncidentReport } structured RCA output
   */
  async diagnose(payload: DiagnosticPayload): Promise<IncidentReport> {
    const { service, stackTrace, context } = payload;

    // --- Root‑cause inference (rule‑based stub) ---
    let rootCause: string;
    let proposedFix: string;
    let diff: string;
    let blastRadius: string;
    let confidence: number;

    // Heuristic: look for common patterns in the stack trace
    const lowerStack = stackTrace.toLowerCase();

    if (lowerStack.includes("deadlock")) {
      rootCause = "Deadlock on shared resource — " + service;
      proposedFix = "Increase lock timeout; implement try‑lock with exponential back‑off; review resource ordering";
      diff = `-- a/${service}.yaml\n+++ b/${service}.yaml\n@@ -10,3 +10,3 @@\n- lock_timeout: 5s\n+ lock_timeout: 30s`;
      blastRadius = "high";
      confidence = 88;
    } else if (lowerStack.includes("timeout") || lowerStack.includes("connect")) {
      rootCause = "Connection/timeout failure — " + service;
      proposedFix = "Check downstream service health; increase connection pool; verify network policies";
      diff = `-- a/${service}.yaml\n+++ b/${service}.yaml\n@@ -10,3 +10,3 @@\n- pool_size: 50\n+ pool_size: 100`;
      blastRadius = "medium";
      confidence = 72;
    } else if (lowerStack.includes("memory") || lowerStack.includes("oom")) {
      rootCause = "Out‑of‑memory error — " + service;
      proposedFix = "Increase container memory limit; review memory leaks; add OOM‑kill monitoring";
      diff = `-- a/${service}.yaml\n+++ b/${service}.yaml\n@@ -10,3 +10,3 @@\n- memory_limit: 512Mi\n+ memory_limit: 1Gi`;
      blastRadius = "high";
      confidence = 81;
    } else if (lowerStack.includes("auth") || lowerStack.includes("token")) {
      rootCause = "Authentication/authorization failure — " + service;
      proposedFix = "Rotate credentials; verify JWT secret; check OAuth scopes";
      diff = `-- a/${service}.yaml\n+++ b/${service}.yaml\n@@ -10,3 +10,3 @@\n- secret_ref: old\n+ secret_ref: new`;
      blastRadius = "medium";
      confidence = 68;
    } else {
      // Generic fallback
      rootCause = "Unexpected anomaly in " + service;
      proposedFix = "Review recent deployments; examine recent config changes; run health‑check endpoints";
      diff = `-- a/${service}.yaml\n+++ b/${service}.yaml\n@@ -10,3 +10,3 @@\n- status: running\n+ status: rebooting`;
      blastRadius = "low";
      confidence = 55;
    }

    // --- Emit to ingestion endpoint if critical‑ish confidence ---
    const isCritical = confidence >= 80;
    if (isCritical) {
      try {
        await fetch(this.ingestUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            severity: "critical",
            source: service,
            message: `Anomaly diagnosed: ${rootCause}`,
            raw_log: stackTrace,
          }),
        }).catch(() => {
          // Never throw — the diagnostic report is still returned
        });
      } catch {
        // Ignore fetch errors; report is still valid
      }
    }

    return {
      rootCause,
      proposedFix,
      diff,
      blastRadius,
      confidence,
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience export
// ---------------------------------------------------------------------------

export const agenticDiagnosticAdapter = new AgenticDiagnosticAdapter();