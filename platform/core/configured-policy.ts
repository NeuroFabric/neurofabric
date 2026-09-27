import path from "node:path";
import { collectStrings } from "./policy.ts";
import { extractCommandText, extractToolPathCandidates } from "./tool-paths.ts";
import { globToRegExp, normalizeForMatch, type PolicyConfig, type RuleVerdict } from "./policy-config.ts";
import { WorkspaceBoundary } from "./workspace.ts";
import type {
  BudgetLevel,
  PolicyDecision,
  PolicyEngine,
  PolicyMode,
  PolicyRequest,
  ToolBudgetTelemetry,
} from "./types.ts";

/**
 * Policy driven by a validated declarative config.
 *
 * This is the kernel side of the legacy Python harness's policy engine. The
 * conceptual order is unchanged (deny beats allow, then limits, then content
 * patterns, then paths, then write size), and the reasoning behind each step is
 * documented in docs/POLICY_PORT.md.
 *
 * The invariant that matters: `evaluate` here can only ever return DENY. Anything
 * it permits is handed to the wrapped tier policy, which is what decides whether
 * a write needs approval. A config file therefore cannot grant a permission that
 * the trust model would otherwise require approval for.
 */
/**
 * Argument names that carry the payload a write persists. Used for both the
 * secret patterns and the write-size limit, so the two always agree on what
 * "the content" is.
 */
const CONTENT_PARAM_NAMES: ReadonlySet<string> = new Set([
  "content",
  "contents",
  "text",
  "body",
  "data",
  "new_string",
  "old_string",
]);

/**
 * Where a metered budget starts warning, as a fraction of the limit.
 *
 * Two thresholds rather than one, so the agent is told while there is still room
 * to finish a plan (F-008). They are advisory only: nothing here can deny a
 * call, and the limit is still enforced exactly where it always was.
 */
const LOW_BUDGET_FRACTION = 0.75;
const CRITICAL_BUDGET_FRACTION = 0.9;

/** Which warning band a used count falls in. Rounded UP, so a small limit warns early. */
function budgetLevel(used: number, limit: number): BudgetLevel {
  if (used >= Math.ceil(limit * CRITICAL_BUDGET_FRACTION)) return "critical";
  if (used >= Math.ceil(limit * LOW_BUDGET_FRACTION)) return "low";
  return "ok";
}

/**
 * A stable identity for one call, used only to count repeats.
 *
 * Object keys are sorted so two structurally identical calls compare equal
 * regardless of construction order, and the result is never returned, logged or
 * traced — only the count derived from it is. The separator is a control
 * character that cannot appear in a tool name, so distinct calls cannot collide.
 */
function callSignature(request: PolicyRequest): string {
  return `${request.tool?.name ?? ""}\u0000${request.operation}\u0000${stableStringify(request.input)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
}

/**
 * Split command text into candidate program tokens.
 *
 * Shell quoting, redirection and separators are removed so that `bash -c "rm -rf
 * /"` and `echo x && rm -f y` both yield `rm` as a token. Only the resulting
 * words are returned, so a word that merely contains a program name is not
 * mistaken for one.
 */
export function commandTokens(text: string): string[] {
  return text
    .split(/[\s"'`()<>;|&,]+/)
    .map((token) => token.replace(/^[=/-]+/, "").replace(/[=/]+$/, ""))
    .filter((token) => token.length > 0);
}

export class ConfiguredPolicy implements PolicyEngine {
  readonly mode: PolicyMode;
  private readonly config: PolicyConfig;
  private readonly boundary: WorkspaceBoundary;
  private readonly base: PolicyEngine;
  /** Per-task accounting, mirroring the legacy engine's per-run counters. */
  private readonly counters = new Map<string, { toolCalls: number; fileWrites: number }>();
  /**
   * Per-task count of each distinct call signature, so a repeated identical call
   * is visible as a count instead of only as a growing total.
   *
   * The SIGNATURE is derived from the call's input, which may contain file
   * contents. Only the signature is stored, only the resulting count is ever
   * returned, and the signature is never emitted to a trace or a log.
   */
  private readonly callRepeats = new Map<string, Map<string, number>>();
  private readonly matchers: RegExp[];

  constructor(config: PolicyConfig, options: { mode: PolicyMode; base: PolicyEngine; allowedRoots: string[] }) {
    this.config = config;
    this.mode = options.mode;
    this.base = options.base;
    this.boundary = new WorkspaceBoundary(options.allowedRoots);
    this.matchers = config.fileRules.map((rule) => globToRegExp(normalizeForMatch(rule.pattern)));
  }

  /** Drop the accounting for a finished task. Called when a new task begins. */
  forgetTask(taskId: string): void {
    this.counters.delete(taskId);
    this.callRepeats.delete(taskId);
  }

  /**
   * Budget telemetry for the call `evaluate` has just counted (F-008).
   *
   * Reports the position in the budget and how many times this exact call has
   * been made, so a task that is running low says so BEFORE the terminal denial,
   * and wasted reads are visible. Purely observational: the thresholds below
   * never deny, and the limit check in `evaluateRules` is untouched.
   */
  toolBudget(request: PolicyRequest): ToolBudgetTelemetry | undefined {
    const counts = this.counters.get(request.taskId);
    if (!counts) return undefined; // this engine never counted the call
    const limit = this.config.limits.maxToolCallsPerTask;
    const signature = callSignature(request);
    const repeats = this.callRepeats.get(request.taskId);
    const repeatCount = repeats?.get(signature) ?? 0;
    return {
      used: counts.toolCalls,
      limit,
      remaining: Math.max(0, limit - counts.toolCalls),
      level: budgetLevel(counts.toolCalls, limit),
      repeatCount,
    };
  }

  evaluate(request: PolicyRequest): PolicyDecision {
    const denial = this.evaluateRules(request);
    if (denial) {
      return { decision: "DENY", reason: denial, violation: this.config.onViolation };
    }

    const counts = this.countsFor(request.taskId);
    counts.toolCalls += 1;
    if (request.tool.riskLevel === "WRITE") counts.fileWrites += 1;
    // Counted at the same moment as the budget, so the repeat count a caller
    // reads afterwards always describes the call that was just allowed.
    const repeats = this.repeatsFor(request.taskId);
    const signature = callSignature(request);
    repeats.set(signature, (repeats.get(signature) ?? 0) + 1);

    return this.base.evaluate(request);
  }

  async evaluateWithApproval(request: PolicyRequest): Promise<PolicyDecision> {
    const decision = this.evaluate(request);
    if (decision.decision !== "REQUIRE_APPROVAL") return decision;
    // The wrapped engine owns the approval provider; the rules above already ran.
    return this.base.evaluateWithApproval(request);
  }

  private countsFor(taskId: string): { toolCalls: number; fileWrites: number } {
    let counts = this.counters.get(taskId);
    if (!counts) {
      counts = { toolCalls: 0, fileWrites: 0 };
      this.counters.set(taskId, counts);
    }
    return counts;
  }

  private repeatsFor(taskId: string): Map<string, number> {
    let repeats = this.callRepeats.get(taskId);
    if (!repeats) {
      repeats = new Map<string, number>();
      this.callRepeats.set(taskId, repeats);
    }
    return repeats;
  }

  /** Accounting for a task, for tests and for the trace. */
  usageFor(taskId: string): { toolCalls: number; fileWrites: number } {
    return this.counters.get(taskId) ?? { toolCalls: 0, fileWrites: 0 };
  }

  /** The declarative rules alone, without the tier policy underneath. */
  private evaluateRules(request: PolicyRequest): string | undefined {
    const { tool, input, taskId } = request;
    const where = `policy ${path.basename(this.config.source)}`;

    // 1. Deny list always wins.
    if (this.config.deniedTools.includes(tool.name)) {
      return `${where}: '${tool.name}' is in deniedTools`;
    }

    // 2. An empty allow list means "no name-based gating", not "allow all".
    if (this.config.allowedTools.length > 0 && !this.config.allowedTools.includes(tool.name)) {
      return `${where}: '${tool.name}' is not in allowedTools`;
    }

    // 3. Limits, checked before the call is counted.
    const counts = this.countsFor(taskId);
    if (counts.toolCalls >= this.config.limits.maxToolCallsPerTask) {
      return `${where}: maxToolCallsPerTask exceeded (${this.config.limits.maxToolCallsPerTask})`;
    }
    if (tool.riskLevel === "WRITE" && counts.fileWrites >= this.config.limits.maxFileWritesPerTask) {
      return `${where}: maxFileWritesPerTask exceeded (${this.config.limits.maxFileWritesPerTask})`;
    }

    // 4. Content patterns, each scoped to the payload it is actually about.
    //
    //    Destructive patterns are matched against COMMAND text, so they fire
    //    whatever the tool's tier. Secret patterns are matched only against the
    //    content a write would persist: searching for a secret is analysis,
    //    writing one is the hazard.
    const commandDenial = this.matchIn(
      this.config.destructiveCommandPatterns,
      collectStrings(extractCommandText(tool, input)),
      "destructive command pattern matched",
      where,
    );
    if (commandDenial) return commandDenial;

    const tokenDenial = this.matchCommandTokens(
      this.config.destructiveCommandTokens,
      collectStrings(extractCommandText(tool, input)),
      where,
    );
    if (tokenDenial) return tokenDenial;

    if (tool.riskLevel === "WRITE") {
      const secretDenial = this.matchIn(
        this.config.secretWritePatterns,
        this.contentPayloadStrings(input),
        "secret write pattern matched",
        where,
      );
      if (secretDenial) return secretDenial;
    }

    // 5. Paths. Containment is decided by the boundary, not by the rules, so a
    //    catch-all `**` can only ever mean "somewhere inside an allowed root".
    const pathDenial = this.evaluatePaths(request, where);
    if (pathDenial) return pathDenial;

    // 6. Write size.
    if (tool.riskLevel === "WRITE") {
      const bytes = this.payloadBytes(request);
      if (bytes > this.config.limits.maxBytesPerWrite) {
        return `${where}: maxBytesPerWrite exceeded (${bytes} > ${this.config.limits.maxBytesPerWrite})`;
      }
    }

    return undefined;
  }

  private evaluatePaths(request: PolicyRequest, where: string): string | undefined {
    const candidates = extractToolPathCandidates(request.tool, request.input);
    if (candidates.length === 0) return undefined;

    const writing = request.tool.riskLevel === "WRITE";
    for (const candidate of candidates) {
      const verdict = this.boundary.check(candidate);
      if (!verdict.allowed) {
        return `${where}: path boundary violation: ${candidate}: ${verdict.reason}`;
      }

      const resolved = verdict.resolvedPath ?? candidate;
      const relative = this.relativeToRoots(resolved);
      if (relative === undefined) continue; // inside a root, but not relativisable; containment already passed

      const matched = this.matchRule(normalizeForMatch(relative), writing);
      if (matched === undefined) {
        // Default deny, exactly as the legacy engine's unmatched branch did.
        return `${where}: no matching file rule for '${relative}' (default deny)`;
      }
      if (matched.verdict === "deny") {
        return `${where}: path rule '${matched.pattern}' denies ${writing ? "write" : "read"} of '${relative}'`;
      }
    }
    return undefined;
  }

  /** First matching rule wins. Returns undefined when nothing matches. */
  private matchRule(relative: string, writing: boolean): { pattern: string; verdict: RuleVerdict } | undefined {
    for (const [index, matcher] of this.matchers.entries()) {
      if (matcher.test(relative)) {
        const rule = this.config.fileRules[index];
        return { pattern: rule.pattern, verdict: writing ? rule.write : rule.read };
      }
    }
    return undefined;
  }

  /** The path relative to the first allowed root that contains it. */
  private relativeToRoots(candidate: string): string | undefined {
    for (const root of this.boundary.roots) {
      const relative = path.relative(root, candidate);
      if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        return relative;
      }
    }
    return undefined;
  }

  /**
   * The deletion guard: refuse a command that invokes a listed destructive
   * program, whatever flags it carries.
   *
   * Comparison is on whole tokens, so `rm`, `rm -f`, `rm -rf`, `rm -r -f` and
   * `rm file` are all caught while a word that merely ends in `rm` is not. Shell
   * quoting and separators are stripped first, so `bash -c "rm -rf /"` is caught
   * too — which is the injected-content case.
   */
  private matchCommandTokens(
    tokens: readonly string[],
    texts: readonly string[],
    where: string,
  ): string | undefined {
    if (tokens.length === 0) return undefined;
    const wanted = new Set(tokens.map((token) => token.toLowerCase()));

    for (const text of texts) {
      for (const candidate of commandTokens(text)) {
        if (wanted.has(candidate.toLowerCase())) {
          return `${where}: destructive command '${candidate}' is denied; shell must not bypass deletion control`;
        }
      }
    }
    return undefined;
  }

  /** First pattern present in any of `texts`, as a denial reason. */
  private matchIn(
    patterns: readonly string[],
    texts: readonly string[],
    label: string,
    where: string,
  ): string | undefined {
    for (const pattern of patterns) {
      const needle = pattern.toLowerCase();
      for (const text of texts) {
        if (text.toLowerCase().includes(needle)) {
          return `${where}: ${label}: '${pattern}'`;
        }
      }
    }
    return undefined;
  }

  /**
   * The content a write would actually PERSIST.
   *
   * Only content-bearing arguments are returned. The path and the file mode are
   * deliberately excluded: a file named `passwords.md` is not a secret, and
   * neither is a document that happens to discuss secrets.
   */
  private contentPayloadStrings(input: unknown): string[] {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return [];
    const values: string[] = [];
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (CONTENT_PARAM_NAMES.has(key)) values.push(...collectStrings(value));
    }
    return values;
  }

  /**
   * UTF-8 bytes of what the call would actually WRITE.
   *
   * The legacy engine measured `args["content"]`, so only the content-bearing
   * arguments are counted here. Counting the path or the file mode as well would
   * reject writes for reasons that have nothing to do with their size.
   */
  private payloadBytes(request: PolicyRequest): number {
    return this.contentPayloadStrings(request.input)
      .reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0);
  }
}

export function isConfiguredPolicy(policy: PolicyEngine): policy is ConfiguredPolicy {
  return policy instanceof ConfiguredPolicy;
}
