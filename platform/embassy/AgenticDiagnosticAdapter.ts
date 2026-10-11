/**
 * AGENTIC DIAGNOSTIC ADAPTER — LLM-driven root-cause analysis.
 *
 * Responsibilities:
 * 1. Accept a diagnostic payload { service, stackTrace, context }.
 * 2. When a critical anomaly occurs, construct a system prompt that includes:
 *      • Runtime stack traces & error signatures.
 *      • Affected microservice topology context & blast radius.
 *      • Recent configuration commits or deployment diffs.
 * 3. Prompt the model for STRICT JSON output matching:
 *      {
 *        "rootCause": string,
 *        "explanation": string,
 *        "blastRadius": string,
 *        "confidence": number,
 *        "diff": string
 *      }
 * 4. Maintain a deterministic heuristic fallback when no API key is present.
 *
 * Provider support:
 *   • GEMINI_API_KEY  -> Google Gemini generateContent endpoint.
 *   • LLM_API_KEY     -> OpenAI-compatible chat completions endpoint
 *                        (override base with LLM_API_BASE, default
 *                        https://api.openai.com/v1).
 *
 * Design notes:
 *   • Every network call is bounded by a short timeout so a slow or
 *     unreachable model never blocks the remediation pipeline.
 *   • On any failure (missing key, HTTP error, malformed JSON) the
 *     adapter transparently falls back to rule-based heuristics, so the
 *     caller always receives a well-formed IncidentReport.
 *   • The adapter is side-effect free: it returns the report and lets the
 *     caller decide how to broadcast / actuate it.
 */

export interface DiagnosticContext {
  topology?: string;
  blastRadius?: string;
  recentDiffs?: string;
  recentCommits?: string;
  [key: string]: unknown;
}

export interface DiagnosticPayload {
  service: string;
  stackTrace: string;
  context?: DiagnosticContext;
}

export interface IncidentReport {
  rootCause: string;
  explanation: string;
  blastRadius: string;
  confidence: number;
  diff: string;
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_API_BASE = process.env.LLM_API_BASE || "https://api.openai.com/v1";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const LLM_REQUEST_TIMEOUT_MS = 8000;

export class AgenticDiagnosticAdapter {
  private readonly geminiApiKey: string | undefined;
  private readonly llmApiKey: string | undefined;
  private readonly llmApiBase: string;

  constructor(
    opts: { geminiApiKey?: string; llmApiKey?: string; llmApiBase?: string } = {}
  ) {
    this.geminiApiKey = opts.geminiApiKey ?? GEMINI_API_KEY;
    this.llmApiKey = opts.llmApiKey ?? LLM_API_KEY;
    this.llmApiBase = (opts.llmApiBase ?? LLM_API_BASE).replace(/\/$/, "");
  }

  /** True when a live LLM provider is configured. */
  get isLiveModelConfigured(): boolean {
    return Boolean(this.geminiApiKey || this.llmApiKey);
  }

  /**
   * Diagnose a service anomaly and produce a structured RCA report.
   *
   * @param payload { service, stackTrace, context }
   * @returns { IncidentReport } structured RCA output
   */
  async diagnose(payload: DiagnosticPayload): Promise<IncidentReport> {
    if (this.geminiApiKey) {
      try {
        const report = await this.callGemini(payload);
        if (this.isValidReport(report)) return report;
      } catch (err) {
        console.warn(
          "[AgenticDiagnosticAdapter] Gemini RCA failed, falling back to heuristic:",
          err instanceof Error ? err.message : err
        );
      }
    }

    if (this.llmApiKey) {
      try {
        const report = await this.callOpenAiCompatible(payload);
        if (this.isValidReport(report)) return report;
      } catch (err) {
        console.warn(
          "[AgenticDiagnosticAdapter] LLM RCA failed, falling back to heuristic:",
          err instanceof Error ? err.message : err
        );
      }
    }

    return this.heuristicFallback(payload);
  }

  // -------------------------------------------------------------------------
  // Prompt construction
  // -------------------------------------------------------------------------

  private buildPrompt(payload: DiagnosticPayload): string {
    const { service, stackTrace, context } = payload;
    const topology = context?.topology || "unknown topology";
    const blastRadius = context?.blastRadius || "unknown";
    const recentDiffs = context?.recentDiffs || "none available";
    const recentCommits = context?.recentCommits || "none available";

    return [
      "You are a principal SRE performing root-cause analysis on a production incident.",
      "Analyse the evidence below and produce a precise remediation.",
      "",
      "## Affected Microservice",
      service,
      "",
      "## Runtime Stack Trace & Error Signatures",
      stackTrace,
      "",
      "## Microservice Topology Context",
      topology,
      "",
      "## Estimated Blast Radius",
      blastRadius,
      "",
      "## Recent Configuration Commits / Deployment Diffs",
      recentCommits,
      "",
      recentDiffs,
      "",
      "Respond with STRICT JSON only (no markdown fences, no prose). The JSON",
      "MUST match this schema exactly:",
      JSON.stringify(
        {
          rootCause: "string — concise root cause",
          explanation: "string — reasoning + recommended remediation steps",
          blastRadius: "string — low | medium | high with % estimate",
          confidence: "number — integer 0..100",
          diff: "string — unified diff patch that remediates the root cause",
        },
        null,
        2
      ),
    ].join("\n");
  }

  // -------------------------------------------------------------------------
  // LLM providers
  // -------------------------------------------------------------------------

  private async callGemini(payload: DiagnosticPayload): Promise<IncidentReport> {
    const prompt = this.buildPrompt(payload);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(this.geminiApiKey!)}`;

    const data = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
      }),
    });

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini returned an empty response");
    return this.normalizeReport(JSON.parse(this.extractJson(text)), payload.service);
  }

  private async callOpenAiCompatible(payload: DiagnosticPayload): Promise<IncidentReport> {
    const prompt = this.buildPrompt(payload);
    const url = `${this.llmApiBase}/chat/completions`;

    const data = await this.fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.llmApiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: "You are a principal SRE. Respond with strict JSON only." },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });

    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error("LLM returned an empty response");
    return this.normalizeReport(JSON.parse(this.extractJson(text)), payload.service);
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        throw new Error(`LLM API returned HTTP ${res.status}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Response normalisation & validation
  // -------------------------------------------------------------------------

  private extractJson(text: string): string {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return text.slice(start, end + 1);
    return text;
  }

  private normalizeReport(raw: any, service: string): IncidentReport {
    return {
      rootCause: String(raw?.rootCause ?? raw?.root_cause ?? `Anomaly detected in ${service}`),
      explanation: String(raw?.explanation ?? raw?.proposedFix ?? raw?.recommendation ?? ""),
      blastRadius: String(raw?.blastRadius ?? raw?.blast_radius ?? "medium"),
      confidence: Number(raw?.confidence ?? 50),
      diff: String(raw?.diff ?? ""),
    };
  }

  private isValidReport(report: any): boolean {
    return (
      report != null &&
      typeof report.rootCause === "string" &&
      typeof report.explanation === "string" &&
      typeof report.blastRadius === "string" &&
      typeof report.confidence === "number" &&
      typeof report.diff === "string"
    );
  }

  // -------------------------------------------------------------------------
  // Deterministic heuristic fallback (no API key / LLM failure)
  // -------------------------------------------------------------------------

  private heuristicFallback(payload: DiagnosticPayload): IncidentReport {
    const { service, stackTrace } = payload;
    const lowerStack = (stackTrace || "").toLowerCase();

    let rootCause: string;
    let explanation: string;
    let diff: string;
    let blastRadius: string;
    let confidence: number;

    if (lowerStack.includes("deadlock")) {
      rootCause = `Deadlock on shared resource — ${service}`;
      explanation =
        "Thread contention on a shared lock is stalling request processing. Increase lock timeout, implement try-lock with exponential back-off, and review resource acquisition ordering.";
      diff = `-- a/${service}.yaml\n+++ b/${service}.yaml\n@@ -10,3 +10,3 @@\n- lock_timeout: 5s\n+ lock_timeout: 30s`;
      blastRadius = "high";
      confidence = 88;
    } else if (lowerStack.includes("timeout") || lowerStack.includes("connect")) {
      rootCause = `Connection/timeout failure — ${service}`;
      explanation =
        "Downstream connectivity is degraded. Verify downstream service health, increase the connection pool, and confirm network policies allow traffic.";
      diff = `-- a/${service}.yaml\n+++ b/${service}.yaml\n@@ -10,3 +10,3 @@\n- pool_size: 50\n+ pool_size: 100`;
      blastRadius = "medium";
      confidence = 72;
    } else if (lowerStack.includes("memory") || lowerStack.includes("oom")) {
      rootCause = `Out-of-memory error — ${service}`;
      explanation =
        "Container exceeded its memory cgroup limit. Raise the memory limit, audit for leaks, and add OOM-kill monitoring.";
      diff = `-- a/${service}.yaml\n+++ b/${service}.yaml\n@@ -10,3 +10,3 @@\n- memory_limit: 512Mi\n+ memory_limit: 1Gi`;
      blastRadius = "high";
      confidence = 81;
    } else if (lowerStack.includes("auth") || lowerStack.includes("token")) {
      rootCause = `Authentication/authorization failure — ${service}`;
      explanation =
        "Credential or token validation is failing. Rotate credentials, verify the JWT secret, and check OAuth scopes.";
      diff = `-- a/${service}.yaml\n+++ b/${service}.yaml\n@@ -10,3 +10,3 @@\n- secret_ref: old\n+ secret_ref: new`;
      blastRadius = "medium";
      confidence = 68;
    } else {
      rootCause = `Unexpected anomaly in ${service}`;
      explanation =
        "No signature matched the stack trace. Review recent deployments, examine recent config changes, and run health-check endpoints.";
      diff = `-- a/${service}.yaml\n+++ b/${service}.yaml\n@@ -10,3 +10,3 @@\n- status: running\n+ status: rebooting`;
      blastRadius = "low";
      confidence = 55;
    }

    return { rootCause, explanation, blastRadius, confidence, diff };
  }
}

// ---------------------------------------------------------------------------
// Convenience singleton
// ---------------------------------------------------------------------------

export const agenticDiagnosticAdapter = new AgenticDiagnosticAdapter();
