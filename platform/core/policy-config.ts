import { readFile } from "node:fs/promises";
import path from "node:path";
import { CoreError } from "./errors.ts";
import { parseVaultConfig, type VaultConfig } from "./vault.ts";

/**
 * Declarative kernel policy.
 *
 * These rules are a port of the legacy Python harness's
 * `policies/default_policy.yaml` (see docs/POLICY_PORT.md for the mapping).
 * They are DATA, loaded from a file and validated here — nothing about them is
 * hard-coded in the extension or in the kernel.
 *
 * Two properties are load-bearing and must not be weakened:
 *
 *   1. These rules can only REMOVE a permission. Evaluation happens before the
 *      tool's risk tier is consulted, and nothing here returns ALLOW.
 *   2. Validation fails loudly. A malformed policy file throws at startup
 *      rather than silently degrading to "no rules", because a policy that
 *      fails open is worse than no policy at all.
 */

export type RuleVerdict = "allow" | "deny";
export type OnViolation = "block" | "abort";

export interface FileRule {
  /** Glob matched against the path relative to the workspace root. */
  pattern: string;
  read: RuleVerdict;
  write: RuleVerdict;
}

export interface PolicyLimits {
  maxToolCallsPerTask: number;
  maxFileWritesPerTask: number;
  maxBytesPerWrite: number;
}

export interface PolicyConfig {
  version: number;
  deniedTools: string[];
  allowedTools: string[];
  fileRules: FileRule[];
  /**
   * Case-insensitive substrings matched against COMMAND text only, for every
   * tool tier. These name operations that destroy state, so they apply wherever
   * a command is actually about to run.
   */
  destructiveCommandPatterns: string[];
  /**
   * Command *programs* refused at every tool tier, matched as whole tokens
   * rather than as substrings.
   *
   * This is the deletion guard, and it exists because `bash` is a permitted
   * tool and the Pi integration has no separate denied delete tool. A deletion
   * performed through the shell is therefore reachable no matter which tool
   * names it, so the only place to stop it is the command itself. Matching
   * whole tokens is what makes it explicit and complete: `rm`, `rm -f`,
   * `rm -rf`, `rm -r -f` and plain `rm file` are all the same decision, and a
   * word that merely contains `rm` is not caught by accident.
   */
  destructiveCommandTokens: string[];
  /**
   * Case-insensitive substrings matched ONLY against the content payload of a
   * write-tier tool.
   *
   * The restriction to writes is the whole point: a secret must not be
   * *persisted*, but reading or searching for one is a legitimate analysis
   * operation. Matching these patterns against a `grep` pattern argument would
   * block the analysis skills from investigating credential handling at all.
   */
  secretWritePatterns: string[];
  limits: PolicyLimits;
  /**
   * Named operator-defined limit overrides, selected via `activeLimitProfile`.
   * Kept on the parsed config for traceability; `limits` already carries the
   * merged, effective values.
   */
  limitProfiles?: Record<string, Partial<PolicyLimits>>;
  activeLimitProfile?: string;
  /**
   * The credentials vault block, when the operator has configured one (D-016).
   *
   * ABSENT means inert, not enabled: with no block the vault's tools are not
   * registered and nothing about the vault exists to this engine. A block that
   * IS present is validated in full, and an unknown field inside it fails the
   * load rather than being ignored — the same rule the unscoped content field
   * follows, for the same reason (a key an operator believes is in force but
   * which is silently dropped is the usability bug this avoids).
   */
  vault?: VaultConfig;
  onViolation: OnViolation;
  /** Absolute path of the file this came from, for every decision message. */
  source: string;
}

export const POLICY_CONFIG_FILE = "neurofebric-policy.json";

/**
 * The configuration that applies when no policy file is present: rules removed,
 * tier-based enforcement unchanged. This is deliberately not "allow everything";
 * it is the pre-port behaviour.
 */
export const EMPTY_POLICY_LIMITS: PolicyLimits = {
  maxToolCallsPerTask: Number.MAX_SAFE_INTEGER,
  maxFileWritesPerTask: Number.MAX_SAFE_INTEGER,
  maxBytesPerWrite: Number.MAX_SAFE_INTEGER,
};

/** Profile names follow the same kebab-case convention as skill names. */
const PROFILE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const LIMIT_KEYS = [
  "maxToolCallsPerTask",
  "maxFileWritesPerTask",
  "maxBytesPerWrite",
] as const;

/**
 * Named limit overrides the operator defines in the policy file and selects
 * with `activeLimitProfile`. Selection is deliberately operator-only (D-004: the
 * agent never edits its own policy configuration), and an unknown or malformed
 * selection fails at load, exactly like every other policy field — a profile
 * that silently does nothing is the same usability bug `deniedContentPatterns`
 * had.
 */
function parseLimitProfiles(value: unknown, source: string): Record<string, Partial<PolicyLimits>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(source, "limitProfiles must be an object mapping profile names to partial limits", "limitProfiles");
  }
  const profiles: Record<string, Partial<PolicyLimits>> = {};
  for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!PROFILE_NAME.test(name)) {
      fail(source, `limitProfiles '${name}' must be kebab-case`, "limitProfiles");
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      fail(source, `limitProfiles.${name} must be an object`, `limitProfiles.${name}`);
    }
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!(LIMIT_KEYS as readonly string[]).includes(key)) {
        fail(source, `limitProfiles.${name}.${key} is not a known limit (expected one of: ${LIMIT_KEYS.join(", ")})`, `limitProfiles.${name}.${key}`);
      }
    }
    const profile: Partial<PolicyLimits> = {};
    for (const key of LIMIT_KEYS) {
      if (entry[key] !== undefined) {
        profile[key] = positiveInt(entry[key], source, `limitProfiles.${name}.${key}`, 0);
      }
    }
    profiles[name] = profile;
  }
  return profiles;
}

const SUPPORTED_VERSIONS = new Set([1]);

function fail(source: string, message: string, field?: string): never {
  throw new CoreError("CONFIGURATION_ERROR", `${source}: ${message}`, field ? { field } : undefined);
}

function record(value: unknown, source: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(source, "policy config must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function stringList(value: unknown, source: string, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(source, `${field} must be an array of strings`, field);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "string" || item.trim() === "") {
      fail(source, `${field} must contain non-empty strings`, field);
    }
    if (seen.has(item)) fail(source, `duplicate entry '${item}' in ${field}`, field);
    seen.add(item);
    out.push(item);
  }
  return out;
}

function positiveInt(value: unknown, source: string, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(source, `${field} must be a positive integer`, field);
  }
  return value;
}

function parseFileRules(value: unknown, source: string): FileRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) {
    fail(source, "fileRules must be a non-empty array (the last rule must be a catch-all)", "fileRules");
  }
  const rules: FileRule[] = [];
  for (const [index, item] of (value as unknown[]).entries()) {
    const field = `fileRules[${index}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      fail(source, `${field} must be an object with pattern, read and write`, field);
    }
    const rule = item as Record<string, unknown>;
    if (typeof rule.pattern !== "string" || rule.pattern.trim() === "") {
      fail(source, `${field}.pattern must be a non-empty glob string`, field);
    }
    for (const key of ["read", "write"] as const) {
      if (rule[key] !== "allow" && rule[key] !== "deny") {
        fail(source, `${field}.${key} must be "allow" or "deny"`, field);
      }
    }
    rules.push({ pattern: rule.pattern, read: rule.read as RuleVerdict, write: rule.write as RuleVerdict });
  }
  return rules;
}

/**
 * Validate an already-parsed policy document. Every message names the offending
 * file and field, because this runs at session start and the operator has to be
 * able to fix it without a debugger.
 */
export function parsePolicyConfig(raw: unknown, source: string): PolicyConfig {
  // The unscoped field was the live usability bug fixed in Task 1. Naming the
  // replacement here is better than silently ignoring the key, which would let
  // an operator believe a rule is still in force when it is not.
  if (record(raw, source).deniedContentPatterns !== undefined) {
    fail(
      source,
      "deniedContentPatterns is no longer supported; split it into "
        + "'destructiveCommandPatterns' (matched against command text) and "
        + "'secretWritePatterns' (matched against write payloads only)",
      "deniedContentPatterns",
    );
  }

  const root = record(raw, source);
  const version = root.version ?? 1;
  if (typeof version !== "number" || !SUPPORTED_VERSIONS.has(version)) {
    fail(source, `version ${JSON.stringify(version)} is not supported (expected 1)`, "version");
  }

  const onViolation = root.onViolation ?? "block";
  if (onViolation !== "block" && onViolation !== "abort") {
    fail(source, `onViolation must be "block" or "abort"; got ${JSON.stringify(onViolation)}`, "onViolation");
  }

  const limitsRaw = root.limits === undefined ? {} : record(root.limits, source);
  const baseLimits: PolicyLimits = {
    maxToolCallsPerTask: positiveInt(limitsRaw.maxToolCallsPerTask, source, "limits.maxToolCallsPerTask", EMPTY_POLICY_LIMITS.maxToolCallsPerTask),
    maxFileWritesPerTask: positiveInt(limitsRaw.maxFileWritesPerTask, source, "limits.maxFileWritesPerTask", EMPTY_POLICY_LIMITS.maxFileWritesPerTask),
    maxBytesPerWrite: positiveInt(limitsRaw.maxBytesPerWrite, source, "limits.maxBytesPerWrite", EMPTY_POLICY_LIMITS.maxBytesPerWrite),
  };

    // `limitProfiles` is optional; absent means "no profiles defined", which is
  // distinct from a malformed one.
  const limitProfiles = root.limitProfiles === undefined ? {} : parseLimitProfiles(root.limitProfiles, source);

  const activeRaw = root.activeLimitProfile;
  if (activeRaw !== undefined && (typeof activeRaw !== "string" || !PROFILE_NAME.test(activeRaw))) {
    fail(source, "activeLimitProfile must be a kebab-case profile name", "activeLimitProfile");
  }
  const activeLimitProfile = activeRaw as string | undefined;

  // The active profile is merged here, at load time, so `limits` is always the
  // effective view: enforcement, denial messages, and the trace never need to
  // know profiles exist. An unknown selection fails closed rather than running
  // on limits the operator believes were replaced.
  let limits = baseLimits;
  if (activeLimitProfile !== undefined) {
    const profile: Partial<PolicyLimits> | undefined = limitProfiles[activeLimitProfile];
    if (profile === undefined) {
      fail(source, `activeLimitProfile '${activeLimitProfile}' matches no entry in limitProfiles`, "activeLimitProfile");
    }
    limits = { ...baseLimits, ...profile };
  }

  return {
    version,
    deniedTools: stringList(root.deniedTools, source, "deniedTools"),
    allowedTools: stringList(root.allowedTools, source, "allowedTools"),
    fileRules: parseFileRules(root.fileRules, source),
    destructiveCommandPatterns: stringList(root.destructiveCommandPatterns, source, "destructiveCommandPatterns"),
    destructiveCommandTokens: stringList(root.destructiveCommandTokens, source, "destructiveCommandTokens"),
    secretWritePatterns: stringList(root.secretWritePatterns, source, "secretWritePatterns"),
    limits,
    limitProfiles,
    ...(activeLimitProfile !== undefined ? { activeLimitProfile } : {}),
    // A present block is validated here, at load, so nothing downstream has to
    // re-check it and no caller can receive a half-valid vault config.
    ...(root.vault === undefined ? {} : { vault: parseVaultConfig(root.vault, source) as VaultConfig }),
    onViolation,
    source,
  };
}

/**
 * Load the policy for `projectRoot`.
 *
 * A missing file is not an error: the project simply runs on tier-based policy
 * alone. A *malformed* file is a hard error — see the fail-loudly note above.
 */
export async function loadPolicyConfig(projectRoot: string): Promise<PolicyConfig | undefined> {
  const filePath = path.join(projectRoot, ".pi", POLICY_CONFIG_FILE);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new CoreError("CONFIGURATION_ERROR", `${filePath}: policy config is not valid JSON (${(error as Error).message})`);
  }
  return parsePolicyConfig(parsed, filePath);
}

/**
 * Glob matcher for the `fileRules` patterns: `*` matches within a path segment,
 * `**` crosses segments, `?` matches a single character. Anchored at both ends.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
        // `**/` should also match zero segments, so `a/**/b` matches `a/b`.
        if (pattern[index + 1] === "/") index += 1;
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** Windows and POSIX separators are equivalent in a rule pattern. */
export function normalizeForMatch(value: string): string {
  return value.replace(/\\/g, "/");
}
