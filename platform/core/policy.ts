import path from "node:path";
import { CoreError } from "./errors.ts";
import { extractPathCandidates, MAX_SECURITY_SCAN_DEPTH, newScanState, WorkspaceBoundary, type ScanState, type StringScan } from "./workspace.ts";
import { scanCommandText, scanToolPathCandidates } from "./tool-paths.ts";

export type { StringScan } from "./workspace.ts";
import type { PolicyDecision, PolicyRequest, ToolBudgetTelemetry } from "./types.ts";

export interface ApprovalProvider {
  requestApproval(request: PolicyRequest): Promise<boolean>;
}

/**
 * The contract both policy implementations satisfy.
 *
 * `APPROVAL` mode may return `REQUIRE_APPROVAL` and consult an approval
 * provider. `TRUSTED_PROJECT` mode never returns `REQUIRE_APPROVAL` and never
 * consults one — it resolves to `ALLOW` or `DENY`.
 */
export interface PolicyEngine {
  readonly mode: PolicyMode;
  evaluate(request: PolicyRequest): PolicyDecision;

  /**
   * Evaluate and, if the result is `REQUIRE_APPROVAL`, resolve it against this
   * engine's own approval provider.
   *
   * NOT on the production path. `KernelAdapter.precheckToolCall` calls
   * `evaluate` once and resolves the requirement itself, because this method
   * calls `evaluate` internally — a caller that used it after an `evaluate`
   * would meter a metered policy twice for one call and deny at half the
   * configured budget. It remains part of the contract for embedders that want
   * the two-step form, and it is covered by tests.
   */
  evaluateWithApproval(request: PolicyRequest): Promise<PolicyDecision>;

  /**
   * Budget telemetry for the call just evaluated by `evaluate`.
   *
   * OPTIONAL, and absent on every engine that does not meter calls, so a caller
   * must feature-detect rather than assume a budget exists. An engine that does
   * meter reports only what it has already counted; it returns `undefined` when
   * it has no accounting for the task, which is also the correct answer when
   * this engine was not the one that evaluated the call.
   *
   * Reporting is strictly additive: the limit check itself lives in `evaluate`
   * and is unaffected by whether anything reads this.
   */
  toolBudget?(request: PolicyRequest): ToolBudgetTelemetry | undefined;
}

export type PolicyMode = "APPROVAL" | "TRUSTED_PROJECT";

/**
 * Command shapes that are refused outright in trusted-project mode.
 *
 * These are matched against the command string as a whole, case-insensitively.
 * The list targets irreversible system/state destruction and credential access,
 * not "unusual" commands. It is intentionally a deny list so that ordinary
 * development commands keep working without prompting.
 */
export const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  // Recursive / forced deletion.
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\b/i,
  /\brm\s+-[a-z]*r[a-z]*f/i,
  /\brmdir\b.*\/s/i,
  /\bdel\b.*\/[a-z]*s/i,
  /\bRemove-Item\b.*-Recurse/i,
  /\berase\b.*\/[a-z]*s/i,
  // Disk and filesystem-level destruction.
  /\bmkfs(\.\w+)?\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdd\s+if=/i,
  /\bdiskpart\b/i,
  /\bDisk\.Format/i,
  // Process and machine control.
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/,
  /\b(shutdown|halt|reboot|poweroff)\b/i,
  /\bStop-Process\b/i,
  /\bkillall\b/i,
  /\btaskkill\b.*\/f/i,
  // Privilege and ownership tampering.
  /\b(takeown|icacls)\b/i,
  /\bchmod\s+(-[a-z]+\s+)*777\b/i,
  /\bchown\s+-R\s+root/i,
  // Registry / VCS history destruction.
  /\breg\s+delete\b/i,
  /\bgit\s+push\b.*--force(?!-with-lease)/i,
  // Force-refspec: '+' prefix on a pushed ref ('+main', '+refs/heads/main',
  // '+HEAD:main'). Anchored on whitespace or a quote before the '+' — a bare
  // '+' search would false-positive on branch names like 'feature+name'
  // (docs/REFSPEC_GUARD_SPEC.md row 8). Quote arm covers 'git push origin "+main"'.
  /\bgit\s+push\b.*(?:\s|["'])\+\S/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b.*-[a-z]*f/i,
  // Data-layer destruction.
  /\bdrop\s+(database|table|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b/i,
  // Branch-removal, flag form (D-015, operator ruling Option 3): the --delete
  // form deletes a remote branch and is not a force-push, so neither the
  // --force entry nor the '+' refspec entry reaches it. The trailing \b also
  // matches any --delete-prefixed option; accepted deny-safe per ruling 7 and
  // pinned by docs/REFSPEC_GUARD_SPEC.md row 10. No such longer option exists.
  /\bgit\s+push\b.*--delete\b/i,
  // Branch-removal, colon form (D-015, operator ruling Option 3): a refspec
  // whose source side is empty, as in ':refs/heads/main', deletes the
  // destination branch. Anchored on whitespace or a quote before the colon so
  // a legitimate 'src:dst' refspec such as 'HEAD:main' is untouched — that
  // anchor is what row 11 pins.
  /\bgit\s+push\b.*(?:\s|["']):\S/i,
];

export const SECRET_ACCESS_PATTERNS: readonly RegExp[] = [
  // Credential material by filename.
  /(^|[\s/\\"'`=])\.env(\.[a-z]+)?\b/i,
  /\bid_rsa\b/i,
  /\bid_ed25519\b/i,
  /\b\.ssh\b/i,
  /\.aws[\s/\\]credentials/i,
  /\.npmrc\b/i,
  /\.netrc\b/i,
  /\.pypirc\b/i,
  /\.docker[\s/\\]config\.json/i,
  /credentials\.json/i,
  /\.git-credentials\b/i,
  /(^|[\s/\\])\.htpasswd\b/i,
  // Credential dumping from the environment or keychain.
  /\bprintenv\b/i,
  /\bGet-ChildItem\s+Env:/i,
  /\bsetx\b/i,
  /secretstore|keychain|\bsecurity\s+find-generic-password\b/i,
  // Unix shadow file.
  /\/etc\/(shadow|gshadow|sudoers)\b/i,
];

/** The outcome of a bounded string scan: what was seen, and whether it finished. */

/**
 * Every string inside an arbitrary tool input, for pattern scanning, together
 * with whether the walk was able to finish.
 *
 * Secret and destructive pattern matching is a security scan, so truncation is
 * part of its result: a pattern walk that stopped at the depth bound has NOT
 * cleared the payload, and a caller that reads an empty list as "no match" is
 * reading an uninspected payload as a safe one.
 */
export function scanStrings(value: unknown, state: ScanState = newScanState(), depth = 0): StringScan {
  const strings: string[] = [];
  const visit = (item: unknown, at: number): void => {
    if (at > MAX_SECURITY_SCAN_DEPTH) {
      state.truncated = true;
      return;
    }
    if (item === null || item === undefined) return;
    if (typeof item === "string") {
      strings.push(item);
      return;
    }
    if (typeof item !== "object") return;
    for (const nested of Array.isArray(item) ? item : Object.values(item as Record<string, unknown>)) {
      visit(nested, at + 1);
    }
  };
  visit(value, depth);
  return { strings, truncated: state.truncated };
}

/** The strings from `scanStrings`, without the truncation flag. */
export function collectStrings(value: unknown, depth = 0): string[] {
  return scanStrings(value, newScanState(), depth).strings;
}

/** First pattern present in an already-scanned set of strings. */
function matchIn(scan: StringScan, patterns: readonly RegExp[]): RegExp | undefined {
  for (const text of scan.strings) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) return pattern;
    }
  }
  return undefined;
}

function firstMatch(value: unknown, patterns: readonly RegExp[]): RegExp | undefined {
  return matchIn(scanStrings(value), patterns);
}

/**
 * The fail-closed reason for a security scan that could not complete.
 *
 * Deterministic, and it deliberately quotes only the bound and the tool name --
 * never any part of the payload, which may itself be the secret the scan was
 * looking for.
 */
export function truncatedScanReason(tool: string): string {
  return `security scan incomplete: '${tool}' input nesting exceeds the safe scan depth of ${MAX_SECURITY_SCAN_DEPTH}; an uninspected payload is refused, not treated as clean`;
}

/**
 * Basenames that are credential material regardless of the directory holding
 * them.
 *
 * `SECRET_ACCESS_PATTERNS` matches `.env` only when it begins a path component,
 * so it misses `config/app.env`, `deploy/prod.env`, and similar. These are
 * checked against the basename of every path-like value in the request.
 */
const SENSITIVE_BASENAMES: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /\.env$/i,
  /^\.env$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.?(netrc|npmrc|pypirc|git-credentials|htpasswd|kubeconfig)$/i,
  /^credentials(\.json|\.yaml|\.yml)?$/i,
  /^secrets?(\.json|\.yaml|\.yml)?$/i,
];

/** True when any path-like value in the request has a sensitive basename. */
export function sensitiveBasenameMatch(input: unknown, candidates?: readonly string[]): string | undefined {
  for (const candidate of candidates ?? extractPathCandidates(input)) {
    const base = path.basename(candidate.replace(/\\/g, "/"));
    for (const pattern of SENSITIVE_BASENAMES) {
      if (pattern.test(base)) return base;
    }
  }
  return undefined;
}

/**
 * Classify a request for trusted-project mode.
 *
 * Returns a denial reason, or `undefined` when the operation is ordinary
 * development work that may proceed without interaction.
 */
export function classifyTrustedOperation(request: PolicyRequest, boundary: WorkspaceBoundary): string | undefined {
  const { tool, input } = request;

  // A destructive-classified tool is never auto-executed.
  if (tool.riskLevel === "DESTRUCTIVE") return `tool '${tool.name}' is classified DESTRUCTIVE`;

  const pathScan = scanToolPathCandidates(tool, input);
  const commandScan = scanCommandText(tool, input);
  const textScan = scanStrings(commandScan.text);
  // Both halves of the command scan: the walk over the text it did reach, and
  // whether the text it reached was the whole story.
  const commandTruncated = commandScan.truncated || textScan.truncated;

  const basename = sensitiveBasenameMatch(input, pathScan.candidates);
  if (basename) return `operation targets credential file '${basename}'`;

  const secret = matchIn(textScan, SECRET_ACCESS_PATTERNS);
  if (secret) return `operation touches credential material (matched ${secret.source})`;

  const destructive = matchIn(textScan, DESTRUCTIVE_PATTERNS);
  if (destructive) return `command is destructive (matched ${destructive.source})`;

  // Fail closed on an incomplete scan. A pattern that matched is still
  // evidence, so the specific reasons above are reported first; this catches
  // the case that actually matters, where the walk stopped before it could see
  // the payload at all. It is checked before the boundary because an empty
  // candidate list and a truncated one look identical to the checks below.
  if (pathScan.truncated || commandTruncated) return truncatedScanReason(tool.name);

  const escape = boundary.checkCandidates(pathScan.candidates);
  if (!escape.allowed) return `path boundary violation: ${escape.reason}`;

  return undefined;
}

export class DefaultPolicy implements PolicyEngine {
  readonly mode: PolicyMode = "APPROVAL";
  private readonly approval?: ApprovalProvider;

  constructor(approval?: ApprovalProvider) {
    this.approval = approval;
  }

  evaluate(request: PolicyRequest): PolicyDecision {
    if (request.tool.riskLevel === "DESTRUCTIVE") {
      if (request.approval === true) return { decision: "ALLOW" };
      return { decision: "REQUIRE_APPROVAL", reason: "Destructive operations require explicit approval" };
    }
    if (request.tool.sideEffect === "SIDE_EFFECTING" && request.tool.riskLevel === "WRITE") {
      return { decision: "REQUIRE_APPROVAL", reason: "Write operations require explicit approval" };
    }
    if (request.tool.riskLevel === "READ_ONLY") return { decision: "ALLOW" };
    if (request.tool.riskLevel === "CONTROLLED") {
      return { decision: "REQUIRE_APPROVAL", reason: "Controlled operations require explicit approval" };
    }
    return { decision: "DENY", reason: "No policy rule allows this operation" };
  }

  async evaluateWithApproval(request: PolicyRequest): Promise<PolicyDecision> {
    const decision = this.evaluate(request);
    if (decision.decision !== "REQUIRE_APPROVAL") return decision;
    if (!this.approval) return decision;
    const approved = await this.approval.requestApproval(request);
    return approved ? { decision: "ALLOW" } : { decision: "DENY", reason: "Approval denied" };
  }
}

/**
 * Trusted-project policy.
 *
 * For a local development project the operator has already granted standing
 * consent, so ordinary operations resolve to `ALLOW` with no interaction at
 * all — there is no code path from this policy to a confirmation prompt.
 *
 * This is not a weakened boundary. It is a different, fail-closed one:
 *   - unregistered tools are rejected upstream by the ToolRegistry;
 *   - paths outside the approved roots are denied;
 *   - credential access and destructive commands are denied outright.
 *
 * Because these are denials rather than prompts, a hostile or mistaken request
 * fails immediately and is reported to the model instead of stalling the run.
 */
export class TrustedProjectPolicy implements PolicyEngine {
  readonly mode: PolicyMode = "TRUSTED_PROJECT";
  private readonly boundary: WorkspaceBoundary;

  constructor(options: { allowedRoots: string[] }) {
    this.boundary = new WorkspaceBoundary(options.allowedRoots);
  }

  evaluate(request: PolicyRequest): PolicyDecision {
    const denial = classifyTrustedOperation(request, this.boundary);
    if (denial) return { decision: "DENY", reason: `Neurofebric policy: ${denial}` };
    return { decision: "ALLOW" };
  }

  /**
   * Present for interface compatibility. Any approval provider is deliberately
   * ignored: trusted-project mode never escalates to a human.
   */
  async evaluateWithApproval(request: PolicyRequest): Promise<PolicyDecision> {
    return this.evaluate(request);
  }
}

export function assertAllowed(decision: PolicyDecision): void {
  if (decision.decision === "DENY") throw new CoreError("POLICY_ERROR", decision.reason);
  if (decision.decision === "REQUIRE_APPROVAL") throw new CoreError("POLICY_ERROR", decision.reason);
}
