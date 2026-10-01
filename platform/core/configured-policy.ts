import path from "node:path";
import { scanStrings, truncatedScanReason } from "./policy.ts";
import { scanCommandText, scanToolPathCandidates } from "./tool-paths.ts";
import { parseCommandLine } from "./command-position.ts";
import { globToRegExp, normalizeForMatch, type PolicyConfig, type RuleVerdict } from "./policy-config.ts";
import { WorkspaceBoundary } from "./workspace.ts";
import { callSignature } from "./call-signature.ts";
import type {
  BudgetLevel,
  DenialRefusal,
  DenialTier,
  PolicyDecision,
  PolicyEngine,
  PolicyMode,
  PolicyRequest,
  ToolBudgetTelemetry,
  ToolDescriptor,
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
 * Field names whose values are LOCATORS — where a write lands — rather than
 * content it persists. These are the ONLY exemption in the secret scan.
 *
 * A file named for the concept is not a secret, so `docs/password-policy.md` is
 * allowed to be created by a write whose content is clean. That exemption is
 * preserved here by name, and everything else is scanned.
 */
const PATH_PARAM_NAMES: ReadonlySet<string> = new Set([
  "path",
  "paths",
  "new_path",
  "newPath",
  "newPaths",
  "old_path",
  "oldPath",
  "oldPaths",
  "file_path",
  "filePath",
  "filePaths",
  "files",
  "notebook_path",
  "notebookPath",
]);

/**
 * Tools whose write payload is exempt from the deny-scan, by NAME.
 *
 * D-022: the deny-scan and the vault have different jurisdictions. The scan
 * exists to stop a credential reaching an un-sanctioned persistence; `vault_store`
 * IS the sanctioned credential store, and its control is the approval gate. A
 * deny-scan there would let an automated control override a human sanction, and
 * a vault that cannot store a credential is a dead design. This is a boundary,
 * not a hole.
 *
 * It lives in platform code rather than in the policy file deliberately: a
 * security exemption should be a reviewed code change, not a config flip.
 */
const SCAN_EXEMPT_TOOLS: ReadonlySet<string> = new Set(["vault_store"]);

/**
 * Commands that ENUMERATE: they list what exists, they do not read contents and
 * they do not write.
 *
 * This is the only set eligible for a soft refusal (§2.4(b)). It is an
 * explicit allowlist, never a heuristic on the path or the arguments, because a
 * command that is merely *named* like a lister must not inherit lister
 * semantics. Anything not listed -- every read, every write, every unknown tool
 * -- keeps the full weight of a policy violation.
 */
const ENUMERATION_TOOLS: ReadonlySet<string> = new Set(["ls", "dir", "glob", "find", "fd", "tree"]);

function isEnumeration(tool: ToolDescriptor): boolean {
  return tool.riskLevel !== "WRITE" && ENUMERATION_TOOLS.has(tool.name.toLowerCase());
}

/**
 * True when the shell would EXPAND the candidate rather than open it.
 *
 * A glob is a pattern, not a location: it names no file. Scoped by its literal
 * prefix it is an ordinary in-root enumeration; unscoped, or scoped outside the
 * roots, it is the §2.4(b) case. The three separators are all included because
 * the shell honours all three.
 */
function isPattern(candidate: string): boolean {
  return /[*?]/.test(candidate);
}

/**
 * The literal directory a pattern would have to enter before the shell expands
 * it: everything up to and including the last separator that precedes the first
 * magic character.
 *
 * `notes/*.txt` is scoped by `notes/`, because that is the directory the
 * expansion is confined to. A pattern with no separator before its first magic
 * character has no literal directory to be scoped by and yields the empty
 * string; containment has already been decided on the full spelling by then, so
 * the empty prefix carries no authority of its own.
 */
function literalPatternPrefix(value: string): string {
  const magic = value.search(/[*?]/);
  if (magic === -1) return value;
  const before = value.slice(0, magic);
  const cut = Math.max(before.lastIndexOf("/"), before.lastIndexOf("\\"));
  return cut === -1 ? "" : value.slice(0, cut + 1);
}

/**
 * Every string in a write payload, at any depth, except values whose key is a
 * locator name.
 *
 * Fail-closed by construction: there is no allowlist of "content-ish" fields to
 * fall out of. A field name this function has never heard of is scanned, so a
 * new harness field cannot become a silent bypass — it would have to be added
 * to `PATH_PARAM_NAMES` to escape, which is a visible edit to this file.
 */
function collectScannedStrings(value: unknown, key?: string): string[] {
  if (key !== undefined && PATH_PARAM_NAMES.has(key)) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectScannedStrings(item));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([childKey, child]) =>
    collectScannedStrings(child, childKey),
  );
}

/**
 * Every string in a write payload at any depth, locator fields INCLUDED.
 *
 * D-023: the size limit is a budget on the call, not on one nominated field. It
 * previously read the same closed allowlist the deny-scan used, so a large
 * `newText` or `oldText` measured as zero bytes and bypassed the cap entirely.
 * `docs/POLICY_PORT.md` specifies the limit as "UTF-8 bytes of the write
 * payload", so this restores the written spec rather than changing it.
 *
 * There is deliberately no tool exemption here, and no locator exemption: a
 * budget applies to the vault exactly as it applies to any other write.
 * Approval sanctions a write, it does not waive the budget.
 */
function collectBilledStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectBilledStrings(item));
  if (value === null || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap((child) => collectBilledStrings(child));
}

/**
 * D-027: the hard nesting bound for a write payload.
 *
 * 12 is `MAX_DEPTH` from `platform/core/redaction.ts`, deliberately the same
 * number, so the repository has one depth convention across both of its
 * recursive boundary walkers rather than two limits to learn for one concern.
 */
const MAX_WRITE_PAYLOAD_DEPTH = 12;

/**
 * The deepest container nesting in a write payload's values, or 0 if there is
 * none.
 *
 * ITERATIVE on purpose. A guard that measures depth by recursing would be
 * vulnerable to the very stack exhaustion it exists to prevent, so this walks an
 * explicit stack and cannot overflow at any input depth. A `visited` set makes it
 * terminate on a cyclic payload, which `JSON.parse` would never produce but a
 * hand-built tool argument could.
 *
 * The top-level argument object is the baseline, not a level: a payload of
 * `{ path, body }` where `body` is nested 13 deep measures 13, which is the
 * number the bound is written about.
 */
function maxWritePayloadDepth(input: unknown): number {
  const topLevel =
    input !== null && typeof input === "object"
      ? Object.values(input as Record<string, unknown>)
      : [input];

  let deepest = 0;
  const visited = new Set<object>();
  const stack: Array<{ node: unknown; depth: number }> = [];

  for (const value of topLevel) stack.push({ node: value, depth: 0 });

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const { node, depth } = frame;
    if (node === null || typeof node !== "object") continue;
    if (visited.has(node)) continue;
    visited.add(node);

    const next = depth + 1;
    if (next > deepest) deepest = next;

    const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>);
    for (const child of children) stack.push({ node: child, depth: next });
  }

  return deepest;
}

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

  /**
   * The refusal class decided by the LAST evaluation, or undefined.
   *
   * Scoped to exactly one call: `evaluate` clears it before it starts and reads
   * it once, and neither `evaluate` nor `evaluateRules` awaits anything between
   * the two, so no second evaluation can observe or overwrite it in between. It
   * exists so that `evaluateRules` and `evaluatePaths` keep returning plain
   * denial strings -- which is what preserves the precedence of the rule checks
   * exactly as it was -- while the one caller that needs the classification gets
   * it without the other eleven return sites having to learn a new shape.
   */
  private scopeRefusal: DenialRefusal | undefined;

  /**
   * RULING 1 (2026-10-01): the tier decided by the LAST evaluation, set at the
   * same moment and by the same discipline as `scopeRefusal` above — cleared
   * before anything can set it, read once, never awaited between.
   *
   * Every rule site sets it EXPLICITLY. That is the whole fail-closed story for
   * this field: a site added later and not taught about tiers leaves the
   * decision TIERLESS, and a tierless denial is a SOFT refusal — so forgetting
   * is survivable-but-wrong rather than silently fatal. `policy-port.test.ts`
   * pins that every rule site is classified, which is what turns "forgot" from a
   * silent hole into a red test.
   */
  private denialTier: DenialTier | undefined;

  /** Record the tier for the denial this evaluation is about to return. */
  private deny(reason: string, tier: DenialTier): string {
    this.denialTier = tier;
    return reason;
  }

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
    // Cleared before anything can set it, so a stale class can never leak into
    // this call's decision. See the field's own note for why it is safe.
    this.scopeRefusal = undefined;
    this.denialTier = undefined;
    const denial = this.evaluateRules(request);
    if (denial) {
      // RULING 3: A REFUSAL IS COUNTED, AND IT IS NOT PAID FOR.
      //
      // The hole this closes, measured by ruling3-refusal-budget.test.ts: the
      // budget increment below is only reached when a call is ALLOWED, so a
      // refused call cost nothing and the same refused call could be proposed
      // forever. A refusal books no retry and no replan either (D1), so nothing
      // bounded that loop at all — the policy would be refusing correctly and
      // the task would never end.
      //
      // What is added is COUNTABILITY, not cost. The refusal increments the
      // repeat map — the same per-(task, signature) map the allowed-call
      // telemetry already used — and touches no counter. The budget therefore
      // still cannot be exhausted purely by being refused, which is the failure
      // mode a naive fix would have introduced.
      //
      // `countsFor` is called for its side effect of materialising the task's
      // telemetry entry. It creates a zeroed record and increments nothing, so
      // `toolBudget` can answer for a task whose every call so far was refused
      // instead of reporting "nothing known" for a task it knows plenty about.
      this.countsFor(request.taskId);
      const repeats = this.repeatsFor(request.taskId);
      const signature = callSignature(request);
      repeats.set(signature, (repeats.get(signature) ?? 0) + 1);
      // D5 / §2.4(b): a scope refusal is still a DENY -- nothing is read and
      // nothing executes -- but it is marked, and the mark is what lets the
      // adapter carry "refused, not violated" to the result instead of
      // terminating the task on it.
      //
      // RULING 1: `tier` is the OTHER mark, and it answers a different
      // question. `refusal` says this denial was not a rule breach; `tier` says
      // what kind of rule it was. They are independent: an out-of-scope
      // enumeration is a refusal AND a soft one, and a destructive command is
      // neither a refusal nor soft.
      //
      // `tier` is absent only if a rule site did not set one, and an absent tier
      // is read as SOFT by recovery — so a site that forgets degrades to the
      // pre-ruling behaviour rather than to a hard denial nobody asked for.
      const decision: PolicyDecision = this.scopeRefusal === undefined
        ? { decision: "DENY", reason: denial, violation: this.config.onViolation }
        : { decision: "DENY", reason: denial, violation: this.config.onViolation, refusal: this.scopeRefusal };
      return this.denialTier === undefined ? decision : { ...decision, tier: this.denialTier };
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

    // 1. Deny list always wins. SOFT: which tool may be used is a question of
    //    authority the agent or the user can answer; nothing about the call is
    //    dangerous, only unwanted.
    if (this.config.deniedTools.includes(tool.name)) {
      return this.deny(`${where}: '${tool.name}' is in deniedTools`, "SOFT_REFUSE");
    }

    // 2. An empty allow list means "no name-based gating", not "allow all".
    if (this.config.allowedTools.length > 0 && !this.config.allowedTools.includes(tool.name)) {
      return this.deny(`${where}: '${tool.name}' is not in allowedTools`, "SOFT_REFUSE");
    }

    // 3. Limits, checked before the call is counted.
    //
    //    SOFT, and deliberately so: an exhausted budget is not a hazard, it is
    //    the end of the road. The task is still a task that can report what it
    //    accomplished, and terminating here would replace a truthful "out of
    //    budget" certificate with a death that names no budget at all.
    const counts = this.countsFor(taskId);
    if (counts.toolCalls >= this.config.limits.maxToolCallsPerTask) {
      return this.deny(`${where}: maxToolCallsPerTask exceeded (${this.config.limits.maxToolCallsPerTask})`, "SOFT_REFUSE");
    }
    if (tool.riskLevel === "WRITE" && counts.fileWrites >= this.config.limits.maxFileWritesPerTask) {
      return this.deny(`${where}: maxFileWritesPerTask exceeded (${this.config.limits.maxFileWritesPerTask})`, "SOFT_REFUSE");
    }

    // 4. Content patterns, each scoped to the payload it is actually about.
    //
    //    Destructive patterns are matched against COMMAND text, so they fire
    //    whatever the tool's tier. Secret patterns are matched only against the
    //    content a write would persist: searching for a secret is analysis,
    //    writing one is the hazard.
    const commandScope = scanCommandText(tool, input);
    const commandScan = scanStrings(commandScope.text);
    const commandDenial = this.matchIn(
      this.config.destructiveCommandPatterns,
      commandScan.strings,
      "destructive command pattern matched",
      where,
    );
    if (commandDenial) return commandDenial;

    const tokenDenial = this.matchCommandTokens(
      this.config.destructiveCommandTokens,
      commandScan.strings,
      where,
    );
    if (tokenDenial) return tokenDenial;

    if (tool.riskLevel === "WRITE") {
      // 4b. Nesting depth (D-027). A payload deeper than the bound is refused
      //     rather than walked, so neither recursive walker below is ever handed
      //     a payload that can exhaust the stack: `collectScannedStrings` (the
      //     deny-scan) and `collectBilledStrings` (the byte cap). Without this,
      //     a sufficiently deep write threw `RangeError: Maximum call stack
      //     size exceeded` out of the guard instead of returning a decision.
      //
      //     The check sits BEFORE `SCAN_EXEMPT_TOOLS` on purpose. `vault_store`
      //     is exempt from the deny-scan, but its payload still reaches the byte
      //     cap, whose walker was equally unbounded. Scoping the bound to the
      //     scanned subset alone would have left the vault reachable.
      //
      //     "Too deep to scan safely" is itself the reason, so this does not
      //     depend on finding a pattern at the bottom.
      const depth = maxWritePayloadDepth(input);
      if (depth > MAX_WRITE_PAYLOAD_DEPTH) {
        return this.deny(`${where}: write payload nesting depth ${depth} exceeds the limit of ${MAX_WRITE_PAYLOAD_DEPTH}`, "HARD_DENY");
      }
    }

    // 4c. An incomplete security scan fails closed. Placed AFTER the D-027
    //     write-depth check above so a deep WRITE keeps D-027's own reason
    //     rather than being relabelled by the generic scanner rule, and so this
    //     covers the tiers D-027 deliberately never reached: reads, controlled
    //     calls, and anything else that was previously uninspected-but-allowed.
    if (commandScan.truncated || commandScope.truncated) {
      return this.deny(`${where}: ${truncatedScanReason(tool.name)}`, "HARD_DENY");
    }

    if (tool.riskLevel === "WRITE" && !SCAN_EXEMPT_TOOLS.has(tool.name)) {
      const secretDenial = this.matchIn(
        this.config.secretWritePatterns,
        collectScannedStrings(input),
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
        return this.deny(`${where}: maxBytesPerWrite exceeded (${bytes} > ${this.config.limits.maxBytesPerWrite})`, "SOFT_REFUSE");
      }
    }

    return undefined;
  }

  private evaluatePaths(request: PolicyRequest, where: string): string | undefined {
    const scan = scanToolPathCandidates(request.tool, request.input);
    // Checked before the empty-list shortcut below. "No candidates" and "the
    // walk stopped before it could find any" both present as an empty list, and
    // only one of them means the boundary has actually cleared the payload.
    if (scan.truncated) return this.deny(`${where}: ${truncatedScanReason(request.tool.name)}`, "HARD_DENY");
    const candidates = scan.candidates;
    if (candidates.length === 0) return undefined;

    const writing = request.tool.riskLevel === "WRITE";
    for (const candidate of candidates) {
      const verdict = this.boundary.check(candidate);
      if (!verdict.allowed) {
        const denial = this.deny(
          `${where}: path boundary violation: ${candidate}: ${verdict.reason}`,
          // RULING 1: a WRITE that escapes the workspace is an escape. A READ
          // that points outside it is a scope question, and is D1.1's SOFT case:
          // the agent can be told "that is outside the workspace" and ask.
          writing ? "HARD_DENY" : "SOFT_REFUSE",
        );
        // §2.4(b): a refusal of SCOPE rather than a violation. A glob is not a
        // location -- it names no file, it asks the shell to enumerate a span --
        // so an out-of-root one is a refusal of scope and nothing more.
        //
        // Three conditions, all required, so this can only ever narrow the
        // class and never widen it:
        //   1. the call is an ENUMERATION, never a read and never a write;
        //   2. the candidate is a PATTERN, so the shell would expand it;
        //   3. the boundary check itself is untouched -- the span really is
        //      outside the roots, and the call is still refused.
        // A read or a write of an out-of-root span stays a hard violation.
        if (!writing && isEnumeration(request.tool) && isPattern(candidate)) {
          this.scopeRefusal = "out_of_scope_discovery";
        }
        return denial;
      }

      const resolved = verdict.resolvedPath ?? candidate;
      const relative = this.relativeToRoots(resolved);
      if (relative === undefined) continue; // inside a root, but not relativisable; containment already passed

      // A glob names no file. Matching its PATTERN TEXT against a file rule is a
      // coincidence of spelling rather than a permission -- `notes/*.txt` is
      // refused by a rule shaped for markdown paths, which is a dead task for an
      // enumeration that is plainly in scope -- so a pattern is judged on its
      // literal PREFIX, the directory the expansion is confined to. Containment
      // was already decided above, on the full spelling.
      //
      // A rule that DENIES the prefix still refuses, so scoping a pattern by its
      // prefix cannot unbind a deny rule from the subtree the pattern sits in.
      // An unmatched prefix is scoped by containment alone and does NOT fall
      // through to the default-deny branch, which stays reserved for real
      // locations: a pattern is not one.
      if (isPattern(candidate)) {
        const prefix = literalPatternPrefix(relative);
        const scoped = this.matchRule(normalizeForMatch(prefix), writing);
        if (scoped?.verdict === "deny") {
          return this.deny(`${where}: path rule '${scoped.pattern}' denies ${writing ? "write" : "read"} of '${prefix}'`,
          // A rule that denies a WRITE is a hazard class: the location is one
          // the operator has singled out. The same rule on a READ is a scope
          // question, and the agent can be redirected in-root.
          writing ? "HARD_DENY" : "SOFT_REFUSE");
        }
        continue;
      }

      const matched = this.matchRule(normalizeForMatch(relative), writing);
      if (matched === undefined) {
        // Default deny, exactly as the legacy engine's unmatched branch did.
        return this.deny(`${where}: no matching file rule for '${relative}' (default deny)`, "SOFT_REFUSE");
      }
      if (matched.verdict === "deny") {
        return this.deny(`${where}: path rule '${matched.pattern}' denies ${writing ? "write" : "read"} of '${relative}'`,
          writing ? "HARD_DENY" : "SOFT_REFUSE");
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
      // A token is exempt ONLY when the parser positively placed it in a
      // pattern position. When the parser could not classify the command at all
      // -- unbalanced quote, unknown wrapper, truncated form, nesting past the
      // depth cap -- NOTHING is exempt and the old whole-text rule applies, so
      // this can only ever keep a denial that would otherwise have been lost.
      const parsed = parseCommandLine(text);
      const exempt = parsed.classified ? parsed.patternTokens : new Set<string>();

      for (const candidate of commandTokens(text)) {
        if (exempt.has(candidate)) continue;
        if (wanted.has(candidate.toLowerCase())) {
          // POSITION, NOT SPELLING, DECIDES THE TIER. A configured token that
          // IS the command being run is a deletion in itself and ends the task.
          // The same token anywhere else -- a commit message, a grep pattern, a
          // quoted argument -- is data: still refused, still never executed, but
          // survivable, so the agent can rephrase and continue.
          //
          // Both branches refuse. The tier only decides whether the RUN ends.
          // An unclassified parse contributes whatever commands it did resolve,
          // and anything not positively identified as the operation defaults to
          // the survivable tier: execution is refused either way, so preferring
          // SOFT cannot turn a refusal into an execution.
          const operation = parsed.commandTokens.has(candidate);
          return this.deny(`${where}: destructive command '${candidate}' is denied; shell must not bypass deletion control`,
            operation ? "HARD_DENY" : "SOFT_REFUSE");
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
          return this.deny(`${where}: ${label}: '${pattern}'`, "HARD_DENY");
        }
      }
    }
    return undefined;
  }

  /**
   * UTF-8 bytes of what the call would actually WRITE.
   *
   * The legacy engine measured `args["content"]`, so only the content-bearing
   * arguments are counted here. Counting the path or the file mode as well would
   * reject writes for reasons that have nothing to do with their size.
   */
  private payloadBytes(request: PolicyRequest): number {
    return collectBilledStrings(request.input)
      .reduce((total, text) => total + Buffer.byteLength(text, "utf8"), 0);
  }
}

export function isConfiguredPolicy(policy: PolicyEngine): policy is ConfiguredPolicy {
  return policy instanceof ConfiguredPolicy;
}
