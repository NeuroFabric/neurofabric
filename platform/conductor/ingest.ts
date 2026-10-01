import path from "node:path";

import { KernelAdapter } from "../pi/kernel-adapter.ts";
import { buildPolicy, resolveAllowedRoots, type NeurofebricProjectConfig } from "../pi/project-config.ts";
import { WorkspaceBoundary } from "../core/workspace.ts";
import { parsePolicyConfig, type PolicyConfig } from "../core/policy-config.ts";
import type { DenialTier } from "../core/types.ts";
import { CSV_READ, csvRead, type CsvReadResult } from "./capabilities.ts";

/**
 * GOVERNED INGESTION.
 *
 * One function, used by the CLI and by the tests, so there is exactly one place
 * where a path becomes readable. It does not resolve-then-check: the path is
 * handed to the kernel and the kernel decides, because a second opinion about
 * what is permitted is precisely the failure mode this project keeps ruling
 * against.
 *
 * The refusal returned is the kernel's own, with its own tier. That matters more
 * than it looks: SOFT_REFUSE means the task survives and the user can point the
 * tool somewhere else, HARD_DENY means the call was a hazard in itself. An
 * entry point that flattened both into "error" would be discarding the exact
 * information the tier system exists to carry.
 */

/** A path the kernel permitted. */
export interface IngestAllowed {
  readonly refused: false;
  readonly path: string;
  readonly csv: CsvReadResult;
  readonly rowCount: number;
  readonly problems: readonly string[];
}

/** A path the kernel did not permit, or a file that could not be read. */
export interface IngestRefused {
  readonly refused: true;
  readonly reason: string;
  /** Present only for a POLICY refusal. Absent for an ordinary I/O failure. */
  readonly tier?: DenialTier;
  /** "policy" when the kernel refused it, "io" when the file could not be read. */
  readonly kind: "policy" | "io";
}

export type IngestResult = IngestAllowed | IngestRefused;

export interface IngestOptions {
  /** The workspace root. Everything readable must resolve inside it. */
  cwd: string;
  /** Exactly what the user typed. Never trusted, never pre-resolved. */
  requested: string;
  /** Optional project configuration; defaults to trusted mode rooted at cwd. */
  projectConfig?: NeurofebricProjectConfig;
  policyConfig?: PolicyConfig;
  policyMode?: NeurofebricProjectConfig["policyMode"];
}

const TASK_ID = "ingest";
const CALL_ID = "ingest-1";

/**
 * Admit a user-supplied path through the kernel, then read it.
 *
 * The order is the contract: precheck FIRST, and the file is only opened once
 * the kernel has allowed the call. Reading first and checking afterwards would
 * mean the bytes of a forbidden file had already been loaded.
 */
export async function governedIngest(options: IngestOptions): Promise<IngestResult> {
  const config = options.projectConfig
    ?? { policyMode: options.policyMode ?? "TRUSTED_PROJECT", allowedRoots: ["."] };
  const root = path.resolve(options.cwd);
  const requested = String(options.requested ?? "");
  // Resolving to an absolute path is NOT a check. It only makes the kernel's
  // own boundary comparison well defined; whether the result is permitted is
  // decided below, by the kernel, from the policy.
  const candidate = path.resolve(root, requested);

  const boundary = new WorkspaceBoundary(resolveAllowedRoots(config, root));
  const kernel = new KernelAdapter();
  kernel.setBoundary(boundary);
  kernel.setPolicy(buildPolicy(config, root, options.policyConfig));
  kernel.registerTools([CSV_READ]);
  await kernel.beginTask("ingest the requested export", `ingest ${requested}`);

  const bound = await kernel.beginToolExecution(CALL_ID, "csv_read", { toolCallId: CALL_ID });
  if (bound === undefined) {
    return { refused: true, kind: "policy", reason: `the kernel refused to bind the read (task is ${kernel.currentTask?.status})` };
  }

  const { decision } = await kernel.precheckToolCall("csv_read", "execute", { path: candidate }, undefined, CALL_ID);
  if (decision.decision !== "ALLOW") {
    const tier = (decision as { tier?: DenialTier }).tier;
    await kernel.recordToolResult(CALL_ID, "csv_read", undefined, true, undefined, decision.reason);
    return {
      refused: true,
      kind: "policy",
      reason: decision.reason,
      ...(tier === undefined ? {} : { tier }),
    };
  }

  // Only now is the file opened.
  try {
    const csv = await csvRead(
      { path: candidate },
      // Defence in depth: the kernel already allowed this path. Re-checking
      // here costs nothing and means a future refactor that reorders the two
      // cannot quietly drop the second one.
      { boundary: { check: (p: string) => ({ allowed: boundary.check(p).allowed }) } },
    );
    await kernel.recordToolResult(CALL_ID, "csv_read", { rowCount: csv.rowCount }, false);
    await kernel.finishTask({ ok: true });
    return { refused: false, path: candidate, csv, rowCount: csv.rowCount, problems: csv.problems };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await kernel.recordToolResult(CALL_ID, "csv_read", undefined, true);
    // Deliberately NO tier: the policy allowed this path, the filesystem did not
    // deliver it. Those are different failures and conflating them would report
    // a permission problem where there was an I/O problem.
    return { refused: true, kind: "io", reason };
  }
}

/** Build a policy config from the project's own file, when one exists. */
export function projectPolicyConfig(source: string): PolicyConfig | undefined {
  return parsePolicyConfig(JSON.parse(source), "neurofebric-policy.json");
}