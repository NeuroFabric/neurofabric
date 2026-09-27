export interface CoreLimits {
  maxTaskDurationMs: number;
  maxStepDurationMs: number;
  maxToolDurationMs: number;
  maxToolRetries: number;
  maxReplans: number;
  maxRecoveryDepth: number;
  maxExecutionTimeMs: number;
  maxParallelTasks: number;
  maxParallelTools: number;
  maxOutputBytes: number;
  maxArtifactBytes: number;
  maxContextTokens: number;
}

export const DEFAULT_LIMITS: CoreLimits = {
  maxTaskDurationMs: 30 * 60 * 1000,
  maxStepDurationMs: 5 * 60 * 1000,
  maxToolDurationMs: 2 * 60 * 1000,
  maxToolRetries: 2,
  maxReplans: 2,
  maxRecoveryDepth: 3,
  maxExecutionTimeMs: 30 * 60 * 1000,
  maxParallelTasks: 1,
  maxParallelTools: 1,
  maxOutputBytes: 2 * 1024 * 1024,
  maxArtifactBytes: 10 * 1024 * 1024,
  maxContextTokens: 200_000,
};

export function validateLimits(limits: Partial<CoreLimits>): CoreLimits {
  const merged = { ...DEFAULT_LIMITS, ...limits };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid core limit: ${name}`);
  }
  return merged;
}
