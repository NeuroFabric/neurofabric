/**
 * THE BACKEND CONTRACT, MIRRORED ON THE FRONTEND SIDE.
 *
 * === WHY THESE TYPES EXIST HERE AND NOT ONLY IN TYPESCRIPT ===
 *
 * TypeScript types are erased at runtime. `const config: PortalConfig =
 * JSON.parse(text)` asserts nothing: it moves a string into a variable and
 * labels it, and if the label is wrong the program keeps running until the wrong
 * label is read. Every function in this file therefore takes `unknown` and
 * returns a verdict, so a payload from the network is CHECKED rather than
 * ANNOTATED.
 *
 * This is the same discipline `platform/api/portal-routes.ts` applies on the
 * server, and for the same reason it re-validates a portal config on READ and
 * not only on write: a read path that trusts its own store is one refactor away
 * from serving a malformed layout to every customer at once. The mirror image
 * of that argument applies here. The store is replaceable, the deployment is
 * replaceable, and a frontend that trusts its wire format is one rolling deploy
 * away from rendering `undefined.length`.
 *
 * === WHY UNKNOWN FIELDS ARE IGNORED RATHER THAN REFUSED ===
 *
 * The backend refuses unknown fields in a schema (`$.foo` is an error) because a
 * misspelled key there silently disables behaviour the author asked for. The read
 * side is the opposite case: the server owns the shape and may grow it, and a
 * frontend that refuses every field it does not recognise breaks the moment a
 * field is added. So these validators extract what they understand and ignore the
 * rest. The type declares what the UI depends on, not everything that may travel.
 *
 * === MISSING IS NOT UNDEFINED ===
 *
 * Optional fields are rebuilt with a conditional spread rather than assigned, so
 * an absent `agentId` stays ABSENT from the object instead of becoming
 * `agentId: undefined`. That distinction is load-bearing: the backend omits
 * `agentId` for a static widget and sets it for an agent-backed one, and
 * `"agentId" in widget` is exactly how a renderer tells a static widget from a
 * live one.
 */

/** The closed unions the backend enforces. */
export type DiagnosticDomain = "anomaly" | "supply-chain" | "financial-compliance" | "performance";
export type AgentMaturity = "stub" | "ready";
export type FindingSeverity = "info" | "warning" | "critical";
export type RuleKind = "regex" | "threshold" | "rate" | "missing-field";
export type NumericOperator = ">" | ">=" | "<" | "<=" | "==" | "!=";
export type WidgetKind = "metric" | "table" | "chart" | "feed";
export type FieldType = "text" | "number" | "select" | "boolean";

/**
 * The member sets, TYPED as their union rather than as `ReadonlySet<string>`.
 *
 * Typing the set is what makes `memberOf` a type guard. A `ReadonlySet<string>`
 * can tell you a value is a member but cannot narrow `unknown` to `WidgetKind`,
 * so every use site would need a cast -- and a cast at each of ten use sites is
 * ten places for the validator and the type to drift apart.
 */
const WIDGET_KIND_SET: ReadonlySet<WidgetKind> = new Set<WidgetKind>(["metric", "table", "chart", "feed"]);
const FIELD_TYPE_SET: ReadonlySet<FieldType> = new Set<FieldType>(["text", "number", "select", "boolean"]);
const LAYOUT_SET: ReadonlySet<"grid" | "stack"> = new Set(["grid", "stack"]);
const DOMAIN_SET: ReadonlySet<DiagnosticDomain> = new Set<DiagnosticDomain>([
  "anomaly",
  "supply-chain",
  "financial-compliance",
  "performance",
]);
const MATURITY_SET: ReadonlySet<AgentMaturity> = new Set<AgentMaturity>(["stub", "ready"]);
const RULE_KIND_SET: ReadonlySet<RuleKind> = new Set<RuleKind>(["regex", "threshold", "rate", "missing-field"]);
const SEVERITY_SET: ReadonlySet<FindingSeverity> = new Set<FindingSeverity>(["info", "warning", "critical"]);
const OPERATOR_SET: ReadonlySet<NumericOperator> = new Set<NumericOperator>([">", ">=", "<", "<=", "==", "!="]);

export interface PortalWidget {
  readonly id: string;
  readonly kind: WidgetKind;
  readonly title: string;
  /** Omitted entirely for a static widget. Presence is meaningful. */
  readonly agentId?: string;
  readonly span?: string;
}

export interface PortalField {
  readonly name: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required?: boolean;
}

export interface PortalForm {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly PortalField[];
}

export interface PortalDashboard {
  readonly agentId: string;
  readonly title: string;
  readonly layout: "grid" | "stack";
  readonly columns: number;
}

export interface PortalConfig {
  readonly tenant: string;
  readonly title: string;
  readonly version: string;
  readonly widgets: readonly PortalWidget[];
  readonly forms: readonly PortalForm[];
  readonly dashboards: readonly PortalDashboard[];
}

export interface AgentDescriptor {
  readonly id: string;
  readonly title: string;
  readonly domain: DiagnosticDomain;
  readonly maturity: AgentMaturity;
  readonly version: string;
  readonly capabilities: readonly string[];
}

export interface AgentRoster {
  readonly at: string;
  readonly total: number;
  readonly agents: readonly AgentDescriptor[];
  readonly ready: number;
  readonly stubCount: number;
}

export interface RuleSpec {
  readonly id: string;
  readonly kind: RuleKind;
  readonly severity: FindingSeverity;
  readonly message: string;
  readonly field?: string;
  readonly pattern?: string;
  readonly flags?: string;
  readonly operator?: NumericOperator;
  readonly value?: number;
  readonly windowMs?: number;
  readonly rateAbove?: number;
}

export interface AgentSchema {
  readonly id: string;
  readonly title: string;
  readonly domain: DiagnosticDomain;
  readonly version: string;
  readonly capabilities: readonly string[];
  readonly streams: readonly string[];
  readonly rules: readonly RuleSpec[];
}

/** The `POST /api/portal/schema` success body. `replacedVersion` is null on a first install. */
export interface SchemaInstall {
  readonly agent: AgentDescriptor;
  readonly replacedVersion: string | null;
}

/** A validation failure from either side of the wire. */
export interface ShapeIssue {
  readonly path: string;
  readonly reason: string;
}

export type ShapeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ShapeIssue[] };

/** A validator that failed. Carries every issue, not just the first. */
export class ShapeMismatch extends Error {
  readonly issues: readonly ShapeIssue[];
  constructor(what: string, issues: readonly ShapeIssue[]) {
    super(`${what} did not match the expected shape (${issues.length} issue${issues.length === 1 ? "" : "s"})`);
    this.name = "ShapeMismatch";
    this.issues = issues;
  }
}

/* -------------------------------------------------------------------------- */
/* PRIMITIVES                                                                  */
/* -------------------------------------------------------------------------- */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/**
 * Membership as a TYPE GUARD.
 *
 * `value is T` is the whole point. Without it a guard narrows nothing and every
 * call site needs a cast to put a narrowed union back into its field.
 */
function memberOf<T extends string>(set: ReadonlySet<T>, value: unknown): value is T {
  return typeof value === "string" && set.has(value as T);
}

/**
 * Read an OPTIONAL field without letting a wrong type through.
 *
 * Returns `undefined` when the key is absent OR present-and-wrong-typed, and
 * pushes an issue for the second case. The alternative -- letting a bad type
 * ride along and fail later inside a component -- is the failure this whole file
 * exists to prevent.
 */
function optional<T>(
  entry: Record<string, unknown>,
  key: string,
  path: string,
  isValid: (value: unknown) => value is T,
  issues: ShapeIssue[],
): T | undefined {
  const value = entry[key];
  if (value === undefined) return undefined;
  if (!isValid(value)) {
    issues.push({ path: `${path}.${key}`, reason: "present but of the wrong type" });
    return undefined;
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* PORTAL CONFIG                                                               */
/* -------------------------------------------------------------------------- */

export function validatePortalConfig(input: unknown): ShapeResult<PortalConfig> {
  const issues: ShapeIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: "$", reason: "a portal config must be a JSON object" }] };
  }

  const tenant = input.tenant;
  if (!isNonEmptyString(tenant)) issues.push({ path: "$.tenant", reason: "tenant is required" });

  const title = input.title;
  if (!isNonEmptyString(title)) issues.push({ path: "$.title", reason: "title is required" });

  const version = input.version;
  if (!isNonEmptyString(version)) issues.push({ path: "$.version", reason: "version is required" });

  const widgets: PortalWidget[] = [];
  if (input.widgets !== undefined) {
    if (!Array.isArray(input.widgets)) {
      issues.push({ path: "$.widgets", reason: "widgets must be an array" });
    } else {
      input.widgets.forEach((raw, i) => {
        const path = `$.widgets[${i}]`;
        if (!isRecord(raw)) {
          issues.push({ path, reason: "a widget must be an object" });
          return;
        }
        if (!isNonEmptyString(raw.id)) issues.push({ path: `${path}.id`, reason: "id is required" });
        if (!memberOf(WIDGET_KIND_SET, raw.kind)) {
          issues.push({ path: `${path}.kind`, reason: "kind must be one of: metric, table, chart, feed" });
        }
        if (!isNonEmptyString(raw.title)) issues.push({ path: `${path}.title`, reason: "title is required" });

        const agentId = optional(raw, "agentId", path, isNonEmptyString, issues);
        const span = optional(raw, "span", path, isNonEmptyString, issues);
        widgets.push({
          id: typeof raw.id === "string" ? raw.id : "",
          kind: memberOf(WIDGET_KIND_SET, raw.kind) ? raw.kind : "metric",
          title: typeof raw.title === "string" ? raw.title : "",
          // Conditional spread: an absent agentId stays absent, not `undefined`.
          ...(agentId === undefined ? {} : { agentId }),
          ...(span === undefined ? {} : { span }),
        });
      });
    }
  }

  const forms: PortalForm[] = [];
  if (input.forms !== undefined) {
    if (!Array.isArray(input.forms)) {
      issues.push({ path: "$.forms", reason: "forms must be an array" });
    } else {
      input.forms.forEach((raw, i) => {
        const path = `$.forms[${i}]`;
        if (!isRecord(raw)) {
          issues.push({ path, reason: "a form must be an object" });
          return;
        }
        if (!isNonEmptyString(raw.id)) issues.push({ path: `${path}.id`, reason: "id is required" });
        if (!isNonEmptyString(raw.title)) issues.push({ path: `${path}.title`, reason: "title is required" });

        const fields: PortalField[] = [];
        if (!Array.isArray(raw.fields)) {
          issues.push({ path: `${path}.fields`, reason: "fields must be an array" });
        } else {
          raw.fields.forEach((entry, j) => {
            const fieldPath = `${path}.fields[${j}]`;
            if (!isRecord(entry)) {
              issues.push({ path: fieldPath, reason: "a field must be an object" });
              return;
            }
            if (!isNonEmptyString(entry.name)) issues.push({ path: `${fieldPath}.name`, reason: "name is required" });
            if (!isNonEmptyString(entry.label)) issues.push({ path: `${fieldPath}.label`, reason: "label is required" });
            if (!memberOf(FIELD_TYPE_SET, entry.type)) {
              issues.push({ path: `${fieldPath}.type`, reason: "type must be one of: text, number, select, boolean" });
            }
            const required = optional(entry, "required", fieldPath, (v): v is boolean => typeof v === "boolean", issues);
            fields.push({
              name: typeof entry.name === "string" ? entry.name : "",
              label: typeof entry.label === "string" ? entry.label : "",
              type: memberOf(FIELD_TYPE_SET, entry.type) ? entry.type : "text",
              ...(required === undefined ? {} : { required }),
            });
          });
        }
        forms.push({
          id: typeof raw.id === "string" ? raw.id : "",
          title: typeof raw.title === "string" ? raw.title : "",
          fields,
        });
      });
    }
  }

  const dashboards: PortalDashboard[] = [];
  if (input.dashboards !== undefined) {
    if (!Array.isArray(input.dashboards)) {
      issues.push({ path: "$.dashboards", reason: "dashboards must be an array" });
    } else {
      input.dashboards.forEach((raw, i) => {
        const path = `$.dashboards[${i}]`;
        if (!isRecord(raw)) {
          issues.push({ path, reason: "a dashboard must be an object" });
          return;
        }
        if (!isNonEmptyString(raw.agentId)) issues.push({ path: `${path}.agentId`, reason: "agentId is required" });
        if (!memberOf(LAYOUT_SET, raw.layout)) {
          issues.push({ path: `${path}.layout`, reason: "layout must be grid or stack" });
        }
        if (!isWholeNumber(raw.columns) || raw.columns < 1 || raw.columns > 12) {
          issues.push({ path: `${path}.columns`, reason: "columns must be a whole number from 1 to 12" });
        }
        dashboards.push({
          agentId: typeof raw.agentId === "string" ? raw.agentId : "",
          title: typeof raw.title === "string" ? raw.title : "",
          layout: raw.layout === "stack" ? "stack" : "grid",
          columns: isWholeNumber(raw.columns) && raw.columns >= 1 && raw.columns <= 12 ? raw.columns : 1,
        });
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      tenant: tenant as string,
      title: title as string,
      version: version as string,
      widgets,
      forms,
      dashboards,
    },
  };
}

/** The `GET /api/portal/config` envelope: `{ derived, config }`. */
export function validatePortalEnvelope(input: unknown): ShapeResult<{ derived: boolean; config: PortalConfig }> {
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: "$", reason: "the portal envelope must be an object" }] };
  }
  if (typeof input.derived !== "boolean") {
    return { ok: false, issues: [{ path: "$.derived", reason: "derived must be a boolean" }] };
  }
  const inner = validatePortalConfig(input.config);
  if (!inner.ok) {
    return { ok: false, issues: inner.issues.map((issue) => ({ ...issue, path: `$.config${issue.path}` })) };
  }
  return { ok: true, value: { derived: input.derived, config: inner.value } };
}

/* -------------------------------------------------------------------------- */
/* AGENTS                                                                      */
/* -------------------------------------------------------------------------- */

function validateDescriptor(input: unknown, path: string, issues: ShapeIssue[]): AgentDescriptor {
  if (!isRecord(input)) {
    issues.push({ path, reason: "an agent must be an object" });
    return { id: "", title: "", domain: "anomaly", maturity: "stub", version: "", capabilities: [] };
  }
  if (!isNonEmptyString(input.id)) issues.push({ path: `${path}.id`, reason: "id is required" });
  if (!isNonEmptyString(input.title)) issues.push({ path: `${path}.title`, reason: "title is required" });
  if (!memberOf(DOMAIN_SET, input.domain)) issues.push({ path: `${path}.domain`, reason: "domain is not a known domain" });
  if (!memberOf(MATURITY_SET, input.maturity)) issues.push({ path: `${path}.maturity`, reason: "maturity is unknown" });
  if (!isNonEmptyString(input.version)) issues.push({ path: `${path}.version`, reason: "version is required" });
  if (!isStringArray(input.capabilities)) {
    issues.push({ path: `${path}.capabilities`, reason: "capabilities must be an array of strings" });
  }
  return {
    id: typeof input.id === "string" ? input.id : "",
    title: typeof input.title === "string" ? input.title : "",
    domain: memberOf(DOMAIN_SET, input.domain) ? input.domain : "anomaly",
    maturity: memberOf(MATURITY_SET, input.maturity) ? input.maturity : "stub",
    version: typeof input.version === "string" ? input.version : "",
    capabilities: isStringArray(input.capabilities) ? [...input.capabilities] : [],
  };
}

export function validateAgentRoster(input: unknown): ShapeResult<AgentRoster> {
  const issues: ShapeIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: "$", reason: "the roster must be an object" }] };
  }
  if (!Array.isArray(input.agents)) {
    return { ok: false, issues: [{ path: "$.agents", reason: "agents must be an array" }] };
  }
  const agents = input.agents.map((raw, i) => validateDescriptor(raw, `$.agents[${i}]`, issues));

  if (!isWholeNumber(input.total)) issues.push({ path: "$.total", reason: "total must be a whole number" });
  if (!isWholeNumber(input.ready)) issues.push({ path: "$.ready", reason: "ready must be a whole number" });
  if (!isWholeNumber(input.stubCount)) issues.push({ path: "$.stubCount", reason: "stubCount must be a whole number" });

  // The counters are CROSS-CHECKED against the roster rather than trusted.
  // These three numbers are published so a portal can tell a customer which
  // agents are real, and a badge reading "3 ready" above a list of two ready
  // agents is a worse lie than a missing badge: it is confidently wrong.
  const ready = agents.filter((a) => a.maturity === "ready").length;
  const stubs = agents.filter((a) => a.maturity === "stub").length;
  if (typeof input.ready === "number" && input.ready !== ready) {
    issues.push({ path: "$.ready", reason: `ready says ${input.ready} but the roster holds ${ready}` });
  }
  if (typeof input.stubCount === "number" && input.stubCount !== stubs) {
    issues.push({ path: "$.stubCount", reason: `stubCount says ${input.stubCount} but the roster holds ${stubs}` });
  }
  if (typeof input.total === "number" && input.total !== agents.length) {
    issues.push({ path: "$.total", reason: `total says ${input.total} but the roster holds ${agents.length}` });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      at: typeof input.at === "string" ? input.at : "",
      total: agents.length,
      agents,
      ready,
      stubCount: stubs,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* SCHEMAS                                                                     */
/* -------------------------------------------------------------------------- */

function validateRule(input: unknown, path: string, issues: ShapeIssue[]): RuleSpec {
  if (!isRecord(input)) {
    issues.push({ path, reason: "a rule must be an object" });
    return { id: "", kind: "regex", severity: "info", message: "" };
  }
  if (!isNonEmptyString(input.id)) issues.push({ path: `${path}.id`, reason: "id is required" });
  if (!memberOf(RULE_KIND_SET, input.kind)) issues.push({ path: `${path}.kind`, reason: "kind is not a known rule kind" });
  if (!memberOf(SEVERITY_SET, input.severity)) issues.push({ path: `${path}.severity`, reason: "severity is unknown" });
  if (!isNonEmptyString(input.message)) issues.push({ path: `${path}.message`, reason: "message is required" });

  const field = optional(input, "field", path, isNonEmptyString, issues);
  const pattern = optional(input, "pattern", path, isNonEmptyString, issues);
  const flags = optional(input, "flags", path, isNonEmptyString, issues);
  const operator = optional(input, "operator", path, (v): v is NumericOperator => memberOf(OPERATOR_SET, v), issues);
  const value = optional(input, "value", path, (v): v is number => typeof v === "number", issues);
  const windowMs = optional(input, "windowMs", path, (v): v is number => typeof v === "number", issues);
  const rateAbove = optional(input, "rateAbove", path, (v): v is number => typeof v === "number", issues);

  return {
    id: typeof input.id === "string" ? input.id : "",
    kind: memberOf(RULE_KIND_SET, input.kind) ? input.kind : "regex",
    severity: memberOf(SEVERITY_SET, input.severity) ? input.severity : "info",
    message: typeof input.message === "string" ? input.message : "",
    ...(field === undefined ? {} : { field }),
    ...(pattern === undefined ? {} : { pattern }),
    ...(flags === undefined ? {} : { flags }),
    ...(operator === undefined ? {} : { operator }),
    ...(value === undefined ? {} : { value }),
    ...(windowMs === undefined ? {} : { windowMs }),
    ...(rateAbove === undefined ? {} : { rateAbove }),
  };
}

export function validateAgentSchema(input: unknown): ShapeResult<AgentSchema> {
  const issues: ShapeIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: "$", reason: "a schema must be a JSON object" }] };
  }
  if (!isNonEmptyString(input.id)) issues.push({ path: "$.id", reason: "id is required" });
  if (!isNonEmptyString(input.title)) issues.push({ path: "$.title", reason: "title is required" });
  if (!memberOf(DOMAIN_SET, input.domain)) issues.push({ path: "$.domain", reason: "domain is not a known domain" });
  if (!isNonEmptyString(input.version)) issues.push({ path: "$.version", reason: "version is required" });
  if (!isStringArray(input.capabilities)) {
    issues.push({ path: "$.capabilities", reason: "capabilities must be an array of strings" });
  }
  if (!isStringArray(input.streams)) issues.push({ path: "$.streams", reason: "streams must be an array of strings" });
  if (!Array.isArray(input.rules)) issues.push({ path: "$.rules", reason: "rules must be an array" });

  const rules = Array.isArray(input.rules)
    ? input.rules.map((raw, i) => validateRule(raw, `$.rules[${i}]`, issues))
    : [];

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      id: input.id as string,
      title: input.title as string,
      domain: input.domain as DiagnosticDomain,
      version: input.version as string,
      capabilities: [...(input.capabilities as readonly string[])],
      streams: [...(input.streams as readonly string[])],
      rules,
    },
  };
}

/** The `GET /api/portal/schema/:id` envelope: `{ schema }`. */
export function validateSchemaEnvelope(input: unknown): ShapeResult<AgentSchema> {
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: "$", reason: "the schema envelope must be an object" }] };
  }
  const inner = validateAgentSchema(input.schema);
  if (!inner.ok) {
    return { ok: false, issues: inner.issues.map((issue) => ({ ...issue, path: `$.schema${issue.path}` })) };
  }
  return { ok: true, value: inner.value };
}

export function validateSchemaInstall(input: unknown): ShapeResult<SchemaInstall> {
  const issues: ShapeIssue[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: [{ path: "$", reason: "the install result must be an object" }] };
  }
  const agent = validateDescriptor(input.agent, "$.agent", issues);
  // `replacedVersion` is null on a first install and a string on a replace, so
  // it must accept null and must not accept `undefined`: the two mean "first
  // install" and "the server omitted the field", and only the first is a valid
  // answer.
  if (input.replacedVersion !== null && typeof input.replacedVersion !== "string") {
    issues.push({ path: "$.replacedVersion", reason: "replacedVersion must be a string or null" });
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: { agent, replacedVersion: input.replacedVersion as string | null },
  };
}

/* -------------------------------------------------------------------------- */
/* ERROR BODIES                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Read the `issues` array the backend attaches to a 400 and a 500.
 *
 * Returned rather than thrown because a caller displaying "what is wrong with my
 * schema" needs the list and should not have to write a try/catch to get it. A
 * body with no usable `issues` yields an empty list, never a crash: the status
 * code alone is still a complete answer.
 */
export function readIssueList(input: unknown): readonly ShapeIssue[] {
  if (!isRecord(input)) return [];
  const issues = input.issues;
  if (!Array.isArray(issues)) return [];
  return issues
    .filter(isRecord)
    .filter((entry): entry is Record<string, unknown> => typeof entry.path === "string" && typeof entry.reason === "string")
    .map((entry) => ({ path: entry.path as string, reason: entry.reason as string }));
}