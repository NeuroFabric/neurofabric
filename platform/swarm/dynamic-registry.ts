import {
  FindingSink,
  RateWindow,
  normaliseToken,
} from "./agents/stream-harness.ts";
import {
  descriptorOf,
  type AgentDescriptor,
  type DiagnosticAgent,
  type DiagnosticDomain,
  type DiagnosticFinding,
  type DiagnosticInput,
  type DiagnosticResult,
  type FindingSeverity,
  type TelemetryEvent,
} from "./diagnostic-agent.ts";

/**
 * THE FACTORY. Agents from configuration instead of from code.
 *
 * === WHAT THIS IS AND IS NOT ===
 *
 * It is not a plugin loader and it does not execute customer code. It is a
 * declarative evaluator: a customer supplies JSON -- patterns, thresholds, the
 * streams they care about -- and the platform applies it to a stream it already
 * understands. Nothing in a schema can read a file, open a socket, or reach
 * another agent, and the reason is structural rather than a matter of trust: the
 * schema is data interpreted by code that already exists, so there is no
 * interpreter for a customer's intentions to escape through.
 *
 * === THE HARD PROBLEM IS THE REGEX, AND IT IS NOT SOLVED HERE ===
 *
 * Everything else in a schema is bounded by construction: a threshold is a
 * number, a stream name is a string of fixed length, a rule count has a ceiling.
 * A regular expression is not. A customer-supplied pattern with nested quantifiers
 * -- `(a+)+` -- runs in time exponential in the length of the subject string, and
 * the subject strings here are attacker-shaped because they came off a network.
 *
 * So there are four defences and they are MITIGATIONS, not a fix:
 *
 *   1. A length ceiling on the pattern itself.
 *   2. Rejection of the classic nested-quantifier shape, before compilation.
 *   3. Compilation ONCE at registration. A schema's patterns are compiled when it
 *      is registered and never again, so a bad pattern cannot cost a
 *      recompilation per event.
 *   4. A bounded subject: every field value came through the line ceiling, so the
 *      worst case for any single match is bounded even where it is slow.
 *
 * What this does NOT do is bound worst-case time in general. A pattern can be
 * nested-quantifier-free by our heuristic and still be slow; our heuristic does not
 * catch nested groups two deep. The real fix is a linear-time engine -- RE2, or a
 * WASM regex -- and the platform has zero runtime dependencies by decision
 * (D-018), so bringing one in is a decision for the Owner rather than a detail to
 * quietly assume. Until then, a schema author is trusted to the same degree as any
 * other integrator, and `SCHEMA_LIMITS` below is where that ceiling is stated in
 * code instead of in a caveat.
 */

/** The ceilings a schema is held to. Named so a caller can publish them. */
export const SCHEMA_LIMITS = {
  maxRulesPerSchema: 256,
  maxPatternLength: 512,
  maxIdLength: 64,
  maxStreamsPerSchema: 32,
  maxStreamNameLength: 64,
  maxFindingWords: 200,
} as const;

/**
 * THE NESTED-QUANTIFIER HEURISTIC.
 *
 * Looks for a group whose body contains a quantifier and which is itself
 * quantified. It catches `(a+)+`, `(a*)*`, `(a{1,3})?` and the common variants.
 * It does NOT catch nesting two groups deep, and it does not catch every
 * polynomial-backtracking shape. Stated here rather than as a guarantee, because a
 * heuristic described as a guarantee is the one that gets relied upon.
 */
const NESTED_QUANTIFIER = /\([^()]*[+*{][^()]*\)\s*[+*?{]/;

export type NumericOperator = ">" | ">=" | "<" | "<=" | "==" | "!=";
export type RuleKind = "regex" | "threshold" | "rate" | "missing-field";

export interface RuleSpec {
  /** Unique within the schema. The finding's rule id, so a portal can link to it. */
  readonly id: string;
  readonly kind: RuleKind;
  readonly severity: FindingSeverity;
  /** What the reader is told. Not a format string -- it is prose, with the value below it. */
  readonly message: string;
  /** regex: the pattern. threshold and missing-field: the field to read. */
  readonly field?: string;
  /** regex only. */
  readonly pattern?: string;
  /** regex only, restricted to "i" and "m". An arbitrary flag set is a foot-gun. */
  readonly flags?: string;
  /** threshold only. */
  readonly operator?: NumericOperator;
  /** threshold only. */
  readonly value?: number;
  /** rate only: the window the rate is measured over. */
  readonly windowMs?: number;
  /** rate only: fire when the count in the window exceeds this. */
  readonly rateAbove?: number;
}

export interface AgentSchema {
  readonly id: string;
  readonly title: string;
  readonly domain: DiagnosticDomain;
  readonly version: string;
  /** Human-readable purposes, published in the portal and used for selection. */
  readonly capabilities: readonly string[];
  /**
   * THE STREAMS THIS SCHEMA CONSUMES.
   *
   * Empty means "every stream", which is the permissive default and the right one
   * for a schema nobody has characterised yet. Naming streams is how a customer
   * says "these events are mine", and events from any other stream are SKIPPED
   * and COUNTED rather than evaluated, so a schema cannot fire on telemetry it was
   * never written for.
   */
  readonly streams: readonly string[];
  readonly rules: readonly RuleSpec[];
}

/** Why a schema was refused. Field-named, never value-echoing. */
export interface SchemaIssue {
  readonly path: string;
  readonly reason: string;
}

export type SchemaValidation =
  | { readonly ok: true; readonly schema: AgentSchema }
  | { readonly ok: false; readonly issues: readonly SchemaIssue[] };

const SEVERITIES: ReadonlySet<string> = new Set(["info", "warning", "critical"]);
const KINDS: ReadonlySet<string> = new Set(["regex", "threshold", "rate", "missing-field"]);
const OPERATORS: ReadonlySet<string> = new Set([">", ">=", "<", "<=", "==", "!="]);
const DOMAINS: ReadonlySet<string> = new Set(["anomaly", "supply-chain", "financial-compliance", "performance"]);

/**
 * VALIDATE A DOCUMENT, WITHOUT COMPILING ANYTHING.
 *
 * Separate from compilation on purpose: a portal must be able to tell a customer
 * what is wrong with their JSON without a registry existing, and a validation
 * failure that throws is a validation failure that becomes a 500.
 *
 * Unknown KEYS are rejected rather than ignored. A schema author who writes
 * `"treshold"` should be told, not left with a rule that never fires because the
 * threshold defaulted to nothing -- a misspelled key in a security rule is the
 * difference between a finding and silence.
 */
export function validateSchema(document: unknown): SchemaValidation {
  const issues: SchemaIssue[] = [];
  const push = (path: string, reason: string) => { issues.push({ path, reason }); };

  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { ok: false, issues: [{ path: "$", reason: "a schema must be a JSON object" }] };
  }
  const root = document as Record<string, unknown>;

  const allowed = new Set(["id", "title", "domain", "version", "capabilities", "streams", "rules"]);
  for (const key of Object.keys(root)) {
    if (!allowed.has(key)) push(`$.${key}`, "unrecognised field");
  }

  const id = root.id;
  if (typeof id !== "string" || id.trim() === "") push("$.id", "id is required and must be a non-empty string");
  else if (id.length > SCHEMA_LIMITS.maxIdLength) {
    push("$.id", `id is longer than ${SCHEMA_LIMITS.maxIdLength} characters`);
  }

  if (typeof root.title !== "string" || root.title.trim() === "") {
    push("$.title", "title is required and must be a non-empty string");
  }
  if (typeof root.domain !== "string" || !DOMAINS.has(root.domain)) {
    push("$.domain", "domain must be one of: anomaly, supply-chain, financial-compliance, performance");
  }
  if (typeof root.version !== "string" || root.version.trim() === "") {
    push("$.version", "version is required; use a semantic version so a portal can pin one");
  }

  if (!Array.isArray(root.capabilities)) push("$.capabilities", "capabilities must be an array of strings");
  else if (root.capabilities.some((entry) => typeof entry !== "string" || entry === "")) {
    push("$.capabilities", "every capability must be a non-empty string");
  }

  const streams: string[] = [];
  if (root.streams !== undefined) {
    if (!Array.isArray(root.streams)) push("$.streams", "streams must be an array of stream names");
    else if (root.streams.length > SCHEMA_LIMITS.maxStreamsPerSchema) {
      push("$.streams", `more than ${SCHEMA_LIMITS.maxStreamsPerSchema} streams`);
    } else {
      for (const [i, entry] of root.streams.entries()) {
        if (typeof entry !== "string" || entry.trim() === "") {
          push(`$.streams[${i}]`, "a stream name must be a non-empty string");
        } else if (entry.length > SCHEMA_LIMITS.maxStreamNameLength) {
          push(`$.streams[${i}]`, `a stream name is longer than ${SCHEMA_LIMITS.maxStreamNameLength} characters`);
        } else {
          streams.push(entry.trim());
        }
      }
    }
  }

  const rules: RuleSpec[] = [];
  if (!Array.isArray(root.rules)) {
    push("$.rules", "rules must be an array");
  } else if (root.rules.length === 0) {
    // An agent with no rules is not a broken agent, it is a question that has not
    // been asked yet, and it must be said so rather than accepted as a detector
    // that will always return clean.
    push("$.rules", "a schema needs at least one rule");
  } else if (root.rules.length > SCHEMA_LIMITS.maxRulesPerSchema) {
    push("$.rules", `more than ${SCHEMA_LIMITS.maxRulesPerSchema} rules`);
  } else {
    root.rules.forEach((entry, i) => {
      const rule = validateRule(entry, `$.rules[${i}]`, push);
      if (rule !== undefined) rules.push(rule);
    });
    const seen = new Set<string>();
    for (const [i, rule] of rules.entries()) {
      if (seen.has(rule.id)) push(`$.rules[${i}].id`, `duplicate rule id "${rule.id}" within the schema`);
      seen.add(rule.id);
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    schema: {
      id: (id as string).trim(),
      title: root.title as string,
      domain: root.domain as DiagnosticDomain,
      version: root.version as string,
      capabilities: (root.capabilities as string[]).map((entry) => entry),
      streams,
      rules,
    },
  };
}

function validateRule(
  entry: unknown,
  path: string,
  push: (path: string, reason: string) => void,
): RuleSpec | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    push(path, "a rule must be a JSON object");
    return undefined;
  }
  const rule = entry as Record<string, unknown>;
  const allowed = new Set([
    "id", "kind", "severity", "message", "field", "pattern", "flags", "operator", "value", "windowMs", "rateAbove",
  ]);
  for (const key of Object.keys(rule)) if (!allowed.has(key)) push(`${path}.${key}`, "unrecognised field");

  if (typeof rule.id !== "string" || rule.id.trim() === "") push(`${path}.id`, "id is required");
  if (typeof rule.kind !== "string" || !KINDS.has(rule.kind)) {
    push(`${path}.kind`, "kind must be one of: regex, threshold, rate, missing-field");
  }
  if (typeof rule.severity !== "string" || !SEVERITIES.has(rule.severity)) {
    push(`${path}.severity`, "severity must be one of: info, warning, critical");
  }
  if (typeof rule.message !== "string" || rule.message.trim() === "") push(`${path}.message`, "message is required");

  const kind = typeof rule.kind === "string" ? rule.kind : "";

  if (kind === "regex") {
    if (typeof rule.pattern !== "string" || rule.pattern === "") push(`${path}.pattern`, "a regex rule needs a pattern");
    else {
      if (rule.pattern.length > SCHEMA_LIMITS.maxPatternLength) {
        push(`${path}.pattern`, `pattern is longer than ${SCHEMA_LIMITS.maxPatternLength} characters`);
      }
      if (NESTED_QUANTIFIER.test(rule.pattern)) {
        push(`${path}.pattern`, "pattern looks like a nested quantifier, which can backtrack exponentially");
      }
      try {
        // Compiled here so an invalid pattern is a validation issue rather than a
        // 500 on the first event that reaches it. The flags value is narrowed to a
        // string first: `rule` is an untrusted record, so it is `unknown`.
        compilePattern(rule.pattern, typeof rule.flags === "string" ? rule.flags : undefined);
      } catch (error) {
        // The engine's own message is KEPT and wrapped rather than replaced: an
        // author needs to know the pattern will not compile AND why, and the
        // reason is the part the engine is better at wording than we are.
        const why = error instanceof Error ? error.message : "unknown reason";
        push(`${path}.pattern`, `pattern will not compile: ${why}`);
      }
    }
  }

  if (kind === "threshold") {
    if (typeof rule.field !== "string" || rule.field === "") push(`${path}.field`, "a threshold rule needs a field");
    if (typeof rule.operator !== "string" || !OPERATORS.has(rule.operator)) {
      push(`${path}.operator`, "operator must be one of: >, >=, <, <=, ==, !=");
    }
    if (typeof rule.value !== "number" || !Number.isFinite(rule.value)) {
      push(`${path}.value`, "a threshold rule needs a finite numeric value");
    }
  }

  if (kind === "rate") {
    if (typeof rule.field !== "string" || rule.field === "") push(`${path}.field`, "a rate rule needs a field");
    if (typeof rule.windowMs !== "number" || !Number.isFinite(rule.windowMs) || rule.windowMs <= 0) {
      push(`${path}.windowMs`, "a rate rule needs a positive windowMs");
    } else if (rule.windowMs > 86_400_000) {
      push(`${path}.windowMs`, "a window longer than one day is a tally, not a rate");
    }
    if (typeof rule.rateAbove !== "number" || !Number.isFinite(rule.rateAbove) || rule.rateAbove < 0) {
      push(`${path}.rateAbove`, "a rate rule needs a non-negative rateAbove");
    }
  }

  if (kind === "missing-field" && (typeof rule.field !== "string" || rule.field === "")) {
    push(`${path}.field`, "a missing-field rule needs a field");
  }

  return {
    id: String(rule.id ?? "").trim(),
    kind: kind as RuleKind,
    severity: (typeof rule.severity === "string" ? rule.severity : "info") as FindingSeverity,
    message: String(rule.message ?? "").trim(),
    ...(typeof rule.field === "string" ? { field: rule.field } : {}),
    ...(typeof rule.pattern === "string" ? { pattern: rule.pattern } : {}),
    ...(typeof rule.flags === "string" ? { flags: rule.flags } : {}),
    ...(typeof rule.operator === "string" ? { operator: rule.operator as NumericOperator } : {}),
    ...(typeof rule.value === "number" ? { value: rule.value } : {}),
    ...(typeof rule.windowMs === "number" ? { windowMs: rule.windowMs } : {}),
    ...(typeof rule.rateAbove === "number" ? { rateAbove: rule.rateAbove } : {}),
  };
}

/**
 * COMPILE A PATTERN, WITH THE FLAG SET RESTRICTED.
 *
 * Only `i` and `m` are allowed. The reason is not pedantry: `g` makes `exec`
 * stateful across calls, so a schema with a `g` pattern would find every second
 * event differently depending on what came before it, and a detector whose
 * results depend on call order rather than on data is not a detector.
 */
function compilePattern(pattern: string, flags?: string): RegExp {
  if (flags !== undefined) {
    for (const flag of flags) {
      if (flag !== "i" && flag !== "m") throw new Error(`flag "${flag}" is not permitted; use i or m`);
    }
  }
  return new RegExp(pattern, flags ?? "");
}

interface CompiledRule {
  readonly spec: RuleSpec;
  readonly pattern?: RegExp;
  /** Only for rate rules: one fixed ring per rule, allocated once. */
  readonly window?: RateWindow;
}

interface CompiledSchema {
  readonly schema: AgentSchema;
  readonly rules: readonly CompiledRule[];
}

/** Compile a validated schema. Throws only if validation was bypassed. */
export function compileSchema(schema: AgentSchema): CompiledSchema {
  return {
    schema,
    rules: schema.rules.map((spec) => ({
      spec,
      ...(spec.pattern === undefined ? {} : { pattern: compilePattern(spec.pattern, spec.flags) }),
      ...(spec.kind === "rate" && spec.windowMs !== undefined ? { window: new RateWindow(spec.windowMs) } : {}),
    })),
  };
}

/** An empty stream, for a caller that wants a verdict with nothing to read. */
const NO_EVENTS: AsyncIterable<TelemetryEvent> = {
  async *[Symbol.asyncIterator]() {
    // Intentionally yields nothing.
  },
};

/**
 * AN AGENT GENERATED FROM A SCHEMA.
 *
 * Implements the same `DiagnosticAgent` as a hand-written one, so it registers,
 * routes and is dispatched by the same registry with no special case anywhere.
 * That is the whole claim of this file: a customer-authored agent is not a second
 * kind of agent, it is the same kind with a different source of rules.
 */
export class DynamicAgent implements DiagnosticAgent {
  readonly id: string;
  readonly title: string;
  readonly domain: DiagnosticDomain;
  readonly maturity = "ready" as const;
  readonly version: string;
  readonly capabilities: readonly string[];
  private readonly compiled: CompiledSchema;
  private readonly sinkCap: number;
  private readonly clock: () => number;

  /** Evaluations completed. Published so an idle agent is distinguishable from a broken one. */
  evaluations = 0;

  constructor(schema: AgentSchema, options: { sinkCap?: number; clock?: () => number } = {}) {
    const validation = validateSchema(schema);
    if (!validation.ok) {
      // Throwing here is correct: the registry validates first, so reaching this
      // means a caller bypassed the service, and an agent built from a schema that
      // was never valid would silently never fire.
      throw new Error(`cannot build an agent from an invalid schema: ${validation.issues.map((i) => `${i.path} ${i.reason}`).join("; ")}`);
    }
    this.compiled = compileSchema(validation.schema);
    this.id = validation.schema.id;
    this.title = validation.schema.title;
    this.domain = validation.schema.domain;
    this.version = validation.schema.version;
    this.capabilities = validation.schema.capabilities;
    this.sinkCap = options.sinkCap ?? 200;
    this.clock = options.clock ?? Date.now;
  }

  /** The schema this agent was built from, for a portal to render or export. */
  get schema(): AgentSchema {
    return this.compiled.schema;
  }

  get ruleCount(): number {
    return this.compiled.rules.length;
  }

  /**
   * Selection by the schema's OWN vocabulary, not by a hardcoded list.
   *
   * The title, the capabilities and the stream names are what a customer typed,
   * so they are what a customer will ask with. An empty scope matches nothing: an
   * agent that claimed every prompt would make first-match routing meaningless.
   */
  handles(scope: string): boolean {
    const text = normaliseToken(scope);
    if (text === "") return false;
    const terms = [
      this.title,
      ...this.capabilities,
      ...this.compiled.schema.streams,
    ].map(normaliseToken);
    return terms.some((term) => term !== "" && text.includes(term));
  }

  async diagnose(input: DiagnosticInput): Promise<DiagnosticResult> {
    const events = input.stream ?? NO_EVENTS;
    const wanted = new Set(this.compiled.schema.streams.map(normaliseToken));
    const sink = new FindingSink(this.sinkCap);
    const hitsByRule = new Map<string, number>();
    const streamSeen = new Map<string, number>();

    let read = 0;
    let skipped = 0;
    let offStream = 0;
    let unevaluable = 0;

    for await (const event of events) {
      read += 1;
      const name = event.partition ?? event.fields.stream ?? event.fields.partition;
      if (name === undefined || name === "") {
        offStream += 1;
        continue;
      }
      streamSeen.set(name, (streamSeen.get(name) ?? 0) + 1);

      // A schema that named its streams evaluates only those, and says how many
      // events it declined rather than pretending the stream was empty.
      if (wanted.size > 0 && !wanted.has(normaliseToken(name))) {
        offStream += 1;
        continue;
      }

      for (const rule of this.compiled.rules) {
        const outcome = this.evaluate(rule, event, name);
        if (outcome === undefined) continue;
        // "Skipped" is not "clean": the rule could not judge this event, and a
        // tally that counted it as a pass would report a rule as having been
        // evaluated over data it never saw.
        if (outcome === "skipped") {
          unevaluable += 1;
          continue;
        }
        hitsByRule.set(rule.spec.id, (hitsByRule.get(rule.spec.id) ?? 0) + 1);
        sink.offer(outcome);
      }
    }

    // Rate rules are evaluated AFTER the stream, because a rate is a property of
    // the window and is not knowable while the window is still filling.
    for (const rule of this.compiled.rules) {
      if (rule.spec.kind !== "rate" || rule.window === undefined) continue;
      const now = this.clock();
      const observed = rule.window.count(now);
      if (observed <= (rule.spec.rateAbove ?? 0)) continue;
      hitsByRule.set(rule.spec.id, (hitsByRule.get(rule.spec.id) ?? 0) + 1);
      sink.offer({
        severity: rule.spec.severity,
        title: `${rule.spec.id}: ${rule.spec.message}`,
        detail: `${observed} occurrences in a ${rule.window.resolutionMs}ms window, above the `
          + `configured threshold of ${rule.spec.rateAbove}. Counted to bucket resolution, so the `
          + "true figure may differ by up to one bucket.",
        evidence: [
          `rule:${rule.spec.id}`,
          `observed:${observed}`,
          `threshold:${rule.spec.rateAbove}`,
          `resolution_ms:${rule.window.resolutionMs}`,
          ...(rule.spec.field === undefined ? [] : [`field:${rule.spec.field}`]),
        ],
      });
    }

    this.evaluations += 1;

    const stats: Record<string, number> = {
      eventsRead: read,
      eventsSkippedOffStream: offStream,
      eventsUnattributed: unparsed(streamSeen, read),
      distinctStreams: streamSeen.size,
      rulesEvaluated: this.compiled.rules.length,
      findingsRetained: sink.retained,
      findingsOmitted: sink.omitted,
      criticalRetained: sink.countAt("critical"),
      warningRetained: sink.countAt("warning"),
      infoRetained: sink.countAt("info"),
      unevaluableEvents: unevaluable,
    };

    return {
      agentId: this.id,
      status: "ok",
      summary: summarise(this.compiled.schema, stats, [...hitsByRule.entries()]),
      findings: sink.findings,
      stats,
      at: new Date().toISOString(),
    };
  }

  /**
   * One rule against one event.
   *
   * `undefined` means the rule did not fire. `"skipped"` means the event could not
   * be judged by this rule at all -- a non-numeric value where a threshold rule
   * expected a number. Those are different outcomes and collapsing them is how an
   * agent reports that it evaluated a rule over data it never saw.
   */
  private evaluate(
    rule: CompiledRule,
    event: TelemetryEvent,
    stream: string,
  ): DiagnosticFinding | "skipped" | undefined {
    const spec = rule.spec;
    const fields = event.fields;

    if (spec.kind === "regex") {
      const pattern = rule.pattern;
      if (pattern === undefined) return undefined;
      // Every value in the event is a candidate. Scanning all of them rather than
      // a named field is what lets a schema work without knowing the schema of
      // the stream -- which is the premise of a schema-driven platform.
      for (const [key, value] of Object.entries(fields)) {
        if (pattern.test(value)) {
          return {
            severity: spec.severity,
            title: `${spec.id}: ${spec.message}`,
            detail: `field "${key}" matched the configured pattern`,
            evidence: [`rule:${spec.id}`, `field:${key}`, `stream:${stream}`, `value:${clip(value)}`],
          };
        }
      }
      return undefined;
    }

    const raw = spec.field === undefined ? undefined : fields[spec.field];
    if (spec.kind === "missing-field") {
      if (raw !== undefined && raw !== "") return undefined;
      return {
        severity: spec.severity,
        title: `${spec.id}: ${spec.message}`,
        detail: `the field "${spec.field}" was absent or empty`,
        evidence: [`rule:${spec.id}`, `field:${spec.field ?? "?"}`, `stream:${stream}`],
      };
    }

    if (raw === undefined) return undefined;

    if (spec.kind === "threshold") {
      const numeric = Number(raw);
      // A non-numeric value is not a threshold violation, it is an event that
      // cannot be judged by this rule. Converting NaN into "0" and comparing
      // would manufacture findings out of missing data.
      if (!Number.isFinite(numeric)) return "skipped";
      if (!compare(numeric, spec.operator ?? ">", spec.value ?? 0)) return undefined;
      return {
        severity: spec.severity,
        title: `${spec.id}: ${spec.message}`,
        detail: `${spec.field} was ${numeric}, which is ${spec.operator} the configured ${spec.value}`,
        evidence: [`rule:${spec.id}`, `field:${spec.field ?? "?"}`, `observed:${numeric}`, `threshold:${spec.value ?? 0}`, `stream:${stream}`],
      };
    }

    if (spec.kind === "rate") {
      rule.window?.hit(event.at ?? this.clock());
    }
    return undefined;
  }

  describe(): AgentDescriptor {
    return descriptorOf(this);
  }
}

/** Events that named no stream, inferred from those that did. */
function unparsed(streamSeen: Map<string, number>, read: number): number {
  const named = [...streamSeen.values()].reduce((sum, n) => sum + n, 0);
  return Math.max(0, read - named);
}

function clip(value: string): string {
  return value.length <= 120 ? value : `${value.slice(0, 120)}...[truncated]`;
}

function compare(actual: number, operator: NumericOperator, expected: number): boolean {
  switch (operator) {
    case ">": return actual > expected;
    case ">=": return actual >= expected;
    case "<": return actual < expected;
    case "<=": return actual <= expected;
    case "==": return actual === expected;
    case "!=": return actual !== expected;
  }
}

/**
 * THE VERDICT. Numbers that all come from `stats`, so the prose cannot disagree
 * with the counters.
 */
function summarise(
  schema: AgentSchema,
  stats: Record<string, number>,
  hits: readonly (readonly [string, number])[],
): string {
  const head = `schema ${schema.id}@${schema.version} read ${stats.eventsRead} events`
    + ` (${stats.distinctStreams} stream${stats.distinctStreams === 1 ? "" : "s"})`;
  if (hits.length === 0) {
    return `${head}; none of its ${stats.rulesEvaluated} rule${stats.rulesEvaluated === 1 ? "" : "s"} fired.`;
  }
  // Copied before sorting: the caller's array is readonly, and mutating the
  // argument to a pure summariser is how a caller ends up with reordered state.
  const ranked = [...hits].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const named = ranked
    .slice(0, 5)
    .map(([id, n]) => `${id} (${n})`)
    .join(", ");
  const more = ranked.length > 5 ? `, and ${ranked.length - 5} further rule${ranked.length - 5 === 1 ? "" : "s"}` : "";
  const caveats: string[] = [];
  if (stats.findingsOmitted > 0) {
    caveats.push(`${stats.findingsOmitted} further finding${stats.findingsOmitted === 1 ? " was" : "s were"} omitted by the cap`);
  }
  if (stats.eventsSkippedOffStream > 0) {
    caveats.push(`${stats.eventsSkippedOffStream} event${stats.eventsSkippedOffStream === 1 ? " was" : "s were"} skipped as outside the declared streams`);
  }
  const body = `${head}; ${stats.rulesEvaluated} rule${stats.rulesEvaluated === 1 ? "" : "s"} fired: ${named}${more}.`;
  return caveats.length === 0 ? body : `${body} ${caveats.join("; ")}.`;
}

/* ==================================================================== */
/* THE REGISTRY SERVICE                                                 */
/* ==================================================================== */

/** How many schemas one registry holds. A PaaS that accepts unlimited tenants is a leak. */
const DEFAULT_CAPACITY = 1024;

export interface RegistryStats {
  readonly schemas: number;
  readonly capacity: number;
  readonly evaluations: number;
  readonly rejections: number;
}

/**
 * REGISTER, STORE, RETRIEVE.
 *
 * Deliberately in-memory and deliberately bounded, and both facts are load-bearing
 * for a factory rather than a convenience: a customer's schema has to be somewhere
 * it can be fetched by an id an API can hold, and it has to be somewhere that
 * cannot grow until the process dies.
 *
 * REPLACEMENT, NOT SHADOWING: registering a new VERSION of an existing id swaps
 * the active agent and returns the previous one, so a portal can pin the version
 * it was rendered against and a caller can undo. Registering an identical id AND
 * version is a no-op returning the existing agent -- an idempotent deploy is a
 * property worth having, and one that recompiled would be a way to burn CPU on a
 * retry loop.
 */
export class DynamicAgentRegistry {
  private readonly agents = new Map<string, DynamicAgent>();
  private readonly schemas = new Map<string, AgentSchema>();
  private readonly capacity: number;
  private evaluations = 0;
  private rejections = 0;

  // Not a parameter property: Node's strip-only type erasure cannot erase one,
  // and this repository has now been reminded of that more than once.
  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  get size(): number {
    return this.agents.size;
  }

  /** Register a schema document. Returns the agent and any agent it replaced. */
  register(
    document: unknown,
    options: { sinkCap?: number; clock?: () => number } = {},
  ): { agent: DynamicAgent; replaced?: DynamicAgent } {
    const validation = validateSchema(document);
    if (!validation.ok) {
      this.rejections += 1;
      throw new SchemaRejected(validation.issues);
    }
    const schema = validation.schema;
    const existing = this.agents.get(schema.id);
    if (existing !== undefined && existing.version === schema.version && existing.ruleCount === schema.rules.length) {
      return { agent: existing };
    }
    if (this.agents.size >= this.capacity && existing === undefined) {
      this.rejections += 1;
      throw new SchemaRejected([{
        path: "$",
        reason: `the registry holds ${this.capacity} schemas and this would be one more`,
      }]);
    }
    const agent = new DynamicAgent(schema, options);
    this.agents.set(schema.id, agent);
    this.schemas.set(schema.id, schema);
    return { agent, ...(existing === undefined ? {} : { replaced: existing }) };
  }

  get(id: string): DynamicAgent | undefined {
    return this.agents.get(id);
  }

  /** The raw schema, which is what a portal renders and what an export writes. */
  schemaOf(id: string): AgentSchema | undefined {
    return this.schemas.get(id);
  }

  /** The raw schemas. Bounded by `capacity`. */
  schemas_(): readonly AgentSchema[] {
    return [...this.schemas.values()];
  }

  ids(): readonly string[] {
    return [...this.agents.keys()];
  }

  remove(id: string): boolean {
    this.schemas.delete(id);
    return this.agents.delete(id);
  }

  /** Record an evaluation, so the service can report whether anything is being used. */
  noteEvaluation(): void {
    this.evaluations += 1;
  }

  stats(): RegistryStats {
    return {
      schemas: this.agents.size,
      capacity: this.capacity,
      evaluations: this.evaluations,
      rejections: this.rejections,
    };
  }

  describeAll(): readonly AgentDescriptor[] {
    return [...this.agents.values()].map((agent) => agent.describe());
  }
}

/**
 * SCHEMA REFUSED, as a value.
 *
 * Its own type so an HTTP layer can map it to 400 without inspecting a message,
 * and so the reasons stay a list an author can act on rather than one sentence.
 */
export class SchemaRejected extends Error {
  readonly issues: readonly SchemaIssue[];

  constructor(issues: readonly SchemaIssue[]) {
    super(`schema refused: ${issues.map((issue) => `${issue.path} ${issue.reason}`).join("; ")}`);
    this.name = "SchemaRejected";
    this.issues = issues;
  }
}
