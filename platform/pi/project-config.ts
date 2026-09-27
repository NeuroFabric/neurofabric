import { readFile } from "node:fs/promises";
import path from "node:path";
import { ConfiguredPolicy, TrustedProjectPolicy, type PolicyEngine, type PolicyMode } from "../core/index.ts";
import { DefaultPolicy } from "../core/index.ts";
import { loadPolicyConfig, type PolicyConfig } from "../core/policy-config.ts";

/**
 * Project-local Neurofebric configuration.
 *
 * This is read from the project directory and is only ever loaded by the
 * orchestrator extension, which Pi itself gates behind project trust. It is
 * therefore not a way to enable trusted mode in a project the operator has not
 * already trusted.
 */
export interface NeurofebricProjectConfig {
  policyMode: PolicyMode;
  allowedRoots: string[];
}

export const DEFAULT_PROJECT_CONFIG: NeurofebricProjectConfig = {
  policyMode: "APPROVAL",
  allowedRoots: ["."],
};

export const CONFIG_FILE = "neurofebric.json";

/** Narrow an untrusted parsed value to the config shape, or throw. */
export function parseProjectConfig(raw: unknown, filePath: string): NeurofebricProjectConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${filePath}: expected a JSON object`);
  }
  const record = raw as Record<string, unknown>;

  const policyMode = record.policyMode ?? DEFAULT_PROJECT_CONFIG.policyMode;
  if (policyMode !== "APPROVAL" && policyMode !== "TRUSTED_PROJECT") {
    throw new Error(`${filePath}: policyMode must be "APPROVAL" or "TRUSTED_PROJECT"`);
  }

  const roots = record.allowedRoots ?? DEFAULT_PROJECT_CONFIG.allowedRoots;
  if (!Array.isArray(roots) || roots.length === 0 || roots.some((root) => typeof root !== "string" || root === "")) {
    throw new Error(`${filePath}: allowedRoots must be a non-empty array of strings`);
  }

  return { policyMode, allowedRoots: roots as string[] };
}

/** Read the config for `projectRoot`, falling back to safe defaults. */
export async function loadProjectConfig(projectRoot: string): Promise<NeurofebricProjectConfig> {
  const filePath = path.join(projectRoot, ".pi", CONFIG_FILE);
  try {
    const content = await readFile(filePath, "utf8");
    return parseProjectConfig(JSON.parse(content), filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { ...DEFAULT_PROJECT_CONFIG };
    throw error;
  }
}

/**
 * The absolute roots a config allows, resolved against the project directory.
 *
 * This is the single place a root becomes an absolute path, so the policy and
 * anything else that must respect the same boundary (artifact verification)
 * are configured from exactly the same list. A relative root is a path from
 * the project root; an absolute one is taken as given.
 */
export function resolveAllowedRoots(config: NeurofebricProjectConfig, projectRoot: string): string[] {
  return config.allowedRoots.map((root) => (path.isAbsolute(root) ? root : path.resolve(projectRoot, root)));
}

/**
 * Build the policy for a resolved config.
 *
 * `APPROVAL` deliberately returns a policy with no approval provider attached
 * so that a run without a UI fails closed rather than hanging.
 *
 * When a declarative policy file is present it is composed *in front of* the
 * tier policy: the rules can only remove a permission, and the tier policy still
 * owns approval. See docs/POLICY_PORT.md.
 */
export function buildPolicy(
  config: NeurofebricProjectConfig,
  projectRoot: string,
  policyConfig?: PolicyConfig,
): PolicyEngine {
  const roots = resolveAllowedRoots(config, projectRoot);
  if (!policyConfig) {
    if (config.policyMode !== "TRUSTED_PROJECT") return new DefaultPolicy();
    return new TrustedProjectPolicy({ allowedRoots: roots });
  }

  const base: PolicyEngine = config.policyMode === "TRUSTED_PROJECT"
    ? new TrustedProjectPolicy({ allowedRoots: roots })
    : new DefaultPolicy();

  return new ConfiguredPolicy(policyConfig, { mode: config.policyMode, base, allowedRoots: roots });
}

/** Config plus the optional declarative policy file, as the extension loads them. */
export async function loadProjectPolicy(projectRoot: string): Promise<{
  config: NeurofebricProjectConfig;
  policyConfig?: PolicyConfig;
}> {
  const config = await loadProjectConfig(projectRoot);
  return { config, policyConfig: await loadPolicyConfig(projectRoot) };
}
