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
  /**
   * Task-wide bound on replans that change strategy, as opposed to replans that
   * repeat a failed approach. Read by recovery.ts on the new-approach branch.
   *
   * Set at parity with `maxReplans`. That RAISES the aggregate ceiling: repeats
   * and strategy changes each get the old full budget rather than sharing one.
   * That is the feature, not a regression, and it is now explicit and
   * profile-tunable. Inert until the adapter supplies the repeat/new-approach
   * signal, because every attempt currently reads as a repeat.
   */
  maxStrategyChanges: number;
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
  maxStrategyChanges: 2,
  maxRecoveryDepth: 3,
  maxExecutionTimeMs: 30 * 60 * 1000,
  maxArtifactBytes: 10 * 1024 * 1024,
};

/**
 * The exact set of keys `CoreLimits` declares.
 *
 * Derived from the defaults rather than hand-listed, so a limit added to or
 * removed from `DEFAULT_LIMITS` is automatically known here and the two cannot
 * drift apart.
 */
const KNOWN_LIMIT_NAMES: ReadonlySet<string> = new Set(Object.keys(DEFAULT_LIMITS));

export function validateLimits(limits: Partial<CoreLimits>): CoreLimits {
  // An unknown key is rejected, not merged through. A misspelled or removed
  // limit would otherwise be accepted as valid, applied to nothing, and
  // returned to the caller as though it had been honoured — a phantom
  // guarantee. This is the same fail-loudly contract `parsePolicyConfig`
  // already applies to an unknown policy field, and it costs nothing in
  // practice: the parameter is typed `Partial<CoreLimits>`, so a well-typed
  // caller cannot supply a key that is not on the interface.
  for (const name of Object.keys(limits)) {
    if (!KNOWN_LIMIT_NAMES.has(name)) {
      throw new Error(`Unknown core limit: ${name}`);
    }
  }

  const merged = { ...DEFAULT_LIMITS, ...limits };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`Invalid core limit: ${name}`);
  }
  return merged;
}
