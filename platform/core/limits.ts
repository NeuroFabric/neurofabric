/**
 * D-009: a limit declared here is a limit that is enforced.
 *
 * F-006 removed `maxStepRetries` because it advertised a bound that did not
 * exist. The same sweep found eight more on this interface. Seven are now
 * removed (including `maxContextTokens`, D-016b) and five are enforced, so
 * every field declared here is read by live code on the production path.
 * Adding a field without enforcing it reintroduces the exact defect F-006 was
 * raised for.
 */
export interface CoreLimits {
  /** Task-wide bound on identical tool retries. Read by recovery.ts. */
  maxToolRetries: number;
  /** Task-wide bound on replans. Read by recovery.ts. */
  maxReplans: number;
  /** Task-wide bound on consecutive recovery rounds. Read by recovery.ts. */
  maxRecoveryDepth: number;
  /** Wall-clock bound on a task. Read by recovery.ts via elapsed time. */
  maxExecutionTimeMs: number;
  /** Largest artifact a tool may declare. Read by artifact.ts createArtifact. */
  maxArtifactBytes: number;
}

export const DEFAULT_LIMITS: CoreLimits = {
  maxToolRetries: 2,
  maxReplans: 2,
  maxRecoveryDepth: 3,
  maxExecutionTimeMs: 30 * 60 * 1000,
  maxArtifactBytes: 10 * 1024 * 1024,
};

export function validateLimits(limits: Partial<CoreLimits>): CoreLimits {
  const merged = { ...DEFAULT_LIMITS, ...limits };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid core limit: ${name}`);
  }
  return merged;
}
