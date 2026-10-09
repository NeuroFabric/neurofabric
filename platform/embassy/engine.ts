// Embassy Engine for Self-Healing AIOps
// Implements Design 3: Optimize for the Most Common Caller

// ==== Adapter Interfaces (Ports) ====

export interface RemediationAdapter {
  execute(proposal: RemediationProposal): Promise<ExecutionResult>;
}

export interface AutonomousDeploymentAdapter extends RemediationAdapter {}
export interface HitlAdapter extends RemediationAdapter {}

export interface RollbackCircuit {
  revert(executionId: string): Promise<RollbackResult>;
}

// ==== Core Types ====

export interface RemediationProposal {
  /** The patch/action to apply (e.g., `{ action: "restart pod", podId: "abc-123" }`). */
  patch: unknown;
  /** Confidence score (0‑100) – if omitted, the Embassy will compute it internally. */
  confidence?: number;
  /** Blast‑radius categorization: "low", "medium", or "high". */
  blastRadius: "low" | "medium" | "high";
  /** Optional metadata for auditing/tracing. */
  metadata?: Record<string, unknown>;
}

export interface RemediationOptions {
  /** Timeout (ms) for waiting on telemetry before giving up. Default: 30000. */
  timeoutMs?: number;
  /** Force a specific adapter (bypassing confidence‑based routing). */
  overrideAdapter?: RemediationAdapter;
  /** Skip automatic rollback even if telemetry degrades. Default: false. */
  skipRollback?: boolean;
  /** Replace the built‑in confidence scorer with a custom function. */
  confidenceScorer?: (patch: unknown) => number;
}

export interface RemediationOutcome {
  /** Status of the overall remediation. */
  status: "success" | "failed" | "rolled_back";
  /** Timestamp of completion (ISO string). */
  timestamp: string;
  /** Structured log of steps taken (for auditing). */
  logs: LogEntry[];
  /** If status === "failed", details about the failure. */
  error?: ExecutionError;
}

export interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  metadata?: Record<string, unknown>;
}

export interface ExecutionError {
  message: string;
  details?: unknown;
}

export interface ExecutionResult {
  /** Identifier for the execution (used for telemetry/rollback). */
  executionId: string;
  /** Raw output from the adapter. */
  output: unknown;
}

export interface RollbackResult {
  /** Whether the rollback succeeded. */
  success: boolean;
  /** Any error details. */
  error?: unknown;
}

export type TelemetryVerdict = "healthy" | "degrading" | "failed";

// ==== Embassy Implementation ====

export class Embassy implements EmbassyInterface {
  private autonomousAdapter: RemediationAdapter;
  private hitlAdapter: RemediationAdapter;
  private rollbackCircuit: RollbackCircuit;
  private confidenceScorer: (patch: unknown) => number;
  private telemetryMonitor: (executionId: string, timeoutMs: number) => Promise<TelemetryVerdict>;
  private logger: (entry: LogEntry) => void;

  constructor(
    autonomousAdapter: RemediationAdapter,
    hitlAdapter: RemediationAdapter,
    rollbackCircuit: RollbackCircuit,
    confidenceScorer?: (patch: unknown) => number,
    telemetryMonitor?: (executionId: string, timeoutMs: number) => Promise<TelemetryVerdict>,
    logger?: (entry: LogEntry) => void
  ) {
    this.autonomousAdapter = autonomousAdapter;
    this.hitlAdapter = hitlAdapter;
    this.rollbackCircuit = rollbackCircuit;
    this.confidenceScorer = confidenceScorer ?? this.defaultConfidenceScorer;
    this.telemetryMonitor = telemetryMonitor ?? this.defaultTelemetryMonitor;
    this.logger = logger ?? this.defaultLogger;
  }

  async remediate(
    proposal: RemediationProposal,
    options: RemediationOptions = {}
  ): Promise<RemediationOutcome> {
    const startTime = Date.now();
    const logs: LogEntry[] = [];

    const log = (entry: Omit<LogEntry, 'timestamp'>) => {
      const logEntry = { timestamp: new Date().toISOString(), ...entry };
      logs.push(logEntry);
      this.logger(logEntry);
    };

    try {
      // Step 1: Determine confidence (use provided or compute)
      const confidence =
        proposal.confidence !== undefined
          ? proposal.confidence
          : this.confidenceScorer(proposal.patch);
      log({ level: "info", message: `Confidence assessed: ${confidence}%`, metadata: { confidence } });

      // Step 2: Choose adapter based on confidence or override
      let adapter: RemediationAdapter;
      if (options.overrideAdapter) {
        adapter = options.overrideAdapter;
        log({ level: "info", message: "Adapter overridden" });
      } else if (confidence >= 95) {
        adapter = this.autonomousAdapter;
        log({ level: "info", message: "High confidence → using Autonomous Deployment Adapter" });
      } else {
        adapter = this.hitlAdapter;
        log({ level: "info", message: "Low confidence → using Human-in-the-Loop Adapter" });
      }

      // Step 3: Execute via chosen adapter
      log({ level: "info", message: `Executing via adapter` });
      const executionResult = await adapter.execute(proposal);

      log({ level: "info", message: `Execution completed, ID: ${executionResult.executionId}` });

      // Step 4: Monitor telemetry
      const timeoutMs = options.timeoutMs ?? 30000;
      log({ level: "info", message: `Monitoring telemetry for ${timeoutMs}ms` });
      const telemetryVerdict = await this.telemetryMonitor(executionResult.executionId, timeoutMs);
      log({ level: "info", message: `Telemetry verdict: ${telemetryVerdict}`, metadata: { verdict: telemetryVerdict } });

      // Step 5: Handle rollback if needed and not skipped
      if (!options.skipRollback && telemetryVerdict === "degrading") {
        log({ level: "warn", message: "Telemetry degrading → invoking RollbackCircuit" });
        const rollbackResult = await this.rollbackCircuit.revert(executionResult.executionId);
        if (rollbackResult.success) {
          log({ level: "info", message: "Rollback succeeded" });
          return {
            status: "rolled_back",
            timestamp: new Date().toISOString(),
            logs,
          };
        } else {
          log({ level: "error", message: "Rollback failed", metadata: { error: rollbackResult.error } });
          return {
            status: "failed",
            timestamp: new Date().toISOString(),
            logs,
            error: { message: "Rollback failed", details: rollbackResult.error },
          };
        }
      }

      // Success case
      return {
        status: "success",
        timestamp: new Date().toISOString(),
        logs,
      };
    } catch (err) {
      log({ level: "error", message: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`, metadata: { error: err } });
      return {
        status: "failed",
        timestamp: new Date().toISOString(),
        logs,
        error: { message: err instanceof Error ? err.message : String(err), details: err },
      };
    }
  }

  // ==== Default Implementations (can be overridden via options or constructor) ====

  private defaultConfidenceScorer(_patch: unknown): number {
    // Simplistic default: medium confidence for unknown patches.
    // In practice, this would analyze patch type, historical data, blast radius, etc.
    return 50;
  }

  private async defaultTelemetryMonitor(_executionId: string, _timeoutMs: number): Promise<TelemetryVerdict> {
    // Default implementation: assume healthy (no telemetry integration).
    // In practice, this would subscribe to metrics and resolve based on health signals.
    return "healthy";
  }

  private defaultLogger(entry: LogEntry): void {
    // Default logger: console.log (structured JSON could be used here).
    console.log(JSON.stringify(entry));
  }
}

// ==== Embassy Interface (for type safety) ====

export interface EmbassyInterface {
  remediate(
    proposal: RemediationProposal,
    options?: RemediationOptions
  ): Promise<RemediationOutcome>;
}