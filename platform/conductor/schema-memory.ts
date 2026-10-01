import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * SCHEMA MEMORY (Task 1 ruling).
 *
 * Two stores, one order, and the order is the decision:
 *
 *   1. `.session-archive/schemas.json` — what THIS checkout has learned. Per
 *      checkout, gitignored, never shipped. A user's own correction outranks
 *      anything we ship, because it is the only one of the two that was
 *      checked against the file in front of them.
 *   2. `configs/default-schemas.json` — core VERIFIED schemas, tracked in git,
 *      shipped with the product. The Pega mapping was established against a real
 *      export in Stage 2; re-deriving it by name-matching on every install would
 *      throw away a verified result and, worse, would re-run the R9 trap on a
 *      customer instead of on a fixture.
 *
 * So: archive first, defaults as the fallback. "Fallback" in that sentence means
 * it applies only when the archive yields nothing usable for THIS file.
 *
 * A remembered schema is applied only when the columns it names are actually
 * present. A stored mapping is a claim about a shape; applying it to a different
 * shape would rank on `undefined` and print a confident empty table, which is
 * the specific failure mode the whole R9 work exists to prevent.
 *
 * Never throws. A corrupt or absent archive degrades to the shipped defaults,
 * because a memory subsystem that can take the product down is worse than one
 * that forgets.
 */

export type SchemaSource = "SESSION_ARCHIVE" | "DEFAULT" | "GENERIC";

export interface ResolvedSchema {
  readonly id: string;
  readonly roles: Record<string, string>;
  /** Which store answered. Reported, never hidden: a mapping is only as good as its provenance. */
  readonly source: SchemaSource;
  /** Roles whose column came from the per-checkout archive. The override list. */
  readonly learnedRoles: readonly string[];
  /** Columns a store named but this file does not have. Dropped, not applied. */
  readonly absent: readonly string[];
  /** Roles the store had no column for. Named rather than left to look complete. */
  readonly unresolved: readonly string[];
}

interface StoredSchema {
  id: string;
  roles: Record<string, string | null>;
  match?: { allOf?: string[] };
}

interface SchemaFile {
  schemas: StoredSchema[];
}

const ARCHIVE_RELATIVE = path.join(".session-archive", "schemas.json");
const DEFAULT_RELATIVE = path.join("configs", "default-schemas.json");

/** Roles the product actually asks for. A schema that cannot fill these is not a match. */
const REQUIRED_ROLES = ["category", "time", "source"] as const;

/**
 * WHAT A GENERIC PROFILE MUST FILL, and why it is fewer roles than above.
 *
 * `source` and `duration` are genuinely optional for an unknown file, and the
 * analysis already reports each one it lacks in `missing`. Forcing them would
 * mean inferring a duration out of whatever number the file happened to carry --
 * a "revenue" column is a NUMBER and it is not milliseconds -- so demanding them
 * would push the profiler straight back into refusing the file.
 *
 * `category` and `time` are not optional. Without them there is no ranking and
 * no timeline, so a profile that cannot supply both is not a degraded profile, it
 * is no profile, and the honest answer is to return undefined and let the report
 * say the file matched nothing.
 */
const GENERIC_REQUIRED_ROLES = ["category", "time"] as const;

/** Rows examined per column before a profile is trusted. */
const PROFILE_SAMPLE = 200;

/**
 * SHARED FRACTION of non-blank sampled values that must agree before a column is
 * called temporal or numeric.
 *
 * Not 1.0, because a genuine numeric column with a stray "n/a" in it is still a
 * numeric column and refusing to profile it would be the profiler being brittle
 * in the exact place real exports are messy. Not lower, because at 0.5 the
 * classifier is no longer measuring anything.
 */
const BARE = 0.8;

export type InferredKind = "categorical" | "numeric" | "temporal" | "unknown";

/**
 * ONE COLUMN, AS MEASURED. The evidence behind an inferred role, kept so the
 * report can show it instead of only asserting a conclusion.
 */
export interface ColumnProfile {
  readonly column: string;
  readonly kind: InferredKind;
  /** Distinct non-blank values within the sample. */
  readonly distinctValues: number;
  /** Rows actually examined. */
  readonly sampled: number;
  /** Fraction of sampled values that parsed as a number. */
  readonly numericRatio: number;
  /** Fraction of sampled values that parsed as a date. */
  readonly temporalRatio: number;
  readonly blankRatio: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMERIC = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/** A NAME that suggests time, used to break the epoch-number tie. */
const TIMEISH = /(time|timestamp|date|datetime|epoch|stamp|_at$|^ts$|when)/i;

/** A NAME that suggests a duration. Nothing else is allowed to become one. */
const DURATIONISH = /(elapsed|duration|latency|response_time|time_taken|took|\bms\b|sec|millisec|micros|nanosec)/i;

const DURATION_NAMES = ["elapsed_time", "elapsed_ms", "duration_ms", "response_time", "latency_ms", "duration", "latency", "elapsed", "took_ms"];
const THRESHOLD_NAMES = ["threshold", "threshold_ms", "limit", "limit_ms", "quota", "sla", "max_allowed"];
const TIME_NAMES = ["_time", "timestamp", "event_time", "datetime", "occurred_at", "date", "time"];
const SOURCE_NAMES = ["host", "hostname", "host_name", "server", "server_name", "source", "source_host", "client_ip", "instance", "node", "node_id", "pod", "service", "app"];
/**
 * Category names, most analytical first. `status` and `code` lead because a
 * status column splits a log into its meaningful outcomes, while `path` and
 * `name` are usually the high-cardinality fallback nobody would rank on first.
 */
const CATEGORY_NAMES = ["status_code", "http_status", "status", "code", "error_code", "alert_code", "category", "type", "level", "severity", "result", "outcome", "path", "endpoint", "route", "url", "product", "region", "channel", "team", "name"];

function isTemporal(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  return Number.isFinite(Date.parse(value.replace(" ", "T")));
}

/**
 * Profile every column from its VALUES.
 *
 * TEMPORAL BEFORE NUMERIC, deliberately: "2026-01-04" is not a number, but an
 * EPOCH TIMESTAMP is, and without this ordering every epoch column would be
 * filed as a quantity and ranked on as one. The epoch tie is broken by the
 * COLUMN NAME -- ten or thirteen bare digits are far more often a clock than a
 * count, but not always, and a name is the only evidence available.
 *
 * Every ratio is reported so a reader can see WHY a column was classified, and
 * disagree with it using evidence rather than by taking the report's word.
 */
export function profileGenericColumns(headers: readonly string[], rows: readonly Record<string, string>[]): ColumnProfile[] {
  const sample = rows.slice(0, PROFILE_SAMPLE);
  return headers.map((column) => {
    let numeric = 0;
    let temporal = 0;
    let blank = 0;
    const distinct = new Set<string>();
    for (const row of sample) {
      const value = String(row[column] ?? "").trim();
      if (value.length === 0) { blank += 1; continue; }
      distinct.add(value);
      if (isTemporal(value)) { temporal += 1; continue; }
      if (NUMERIC.test(value)) {
        // An epoch clock is a number; only the NAME says it is a time.
        const epoch = /^\d{10}$|^\d{13}$/.test(value);
        if (!(epoch && TIMEISH.test(column))) numeric += 1;
      }
    }
    const n = sample.length;
    const nonBlank = n - blank;
    const numericRatio = nonBlank === 0 ? 0 : numeric / nonBlank;
    const temporalRatio = nonBlank === 0 ? 0 : temporal / nonBlank;
    const blankRatio = n === 0 ? 0 : blank / n;
    const kind: InferredKind = nonBlank === 0 ? "unknown"
      : temporalRatio >= BARE ? "temporal"
        : numericRatio >= BARE ? "numeric"
          : "categorical";
    return { column, kind, distinctValues: distinct.size, sampled: n, numericRatio, temporalRatio, blankRatio };
  });
}

/**
 * Propose roles from a profile. Every value here is a GUESS and is marked as
 * one downstream -- see `source: "GENERIC"` and the `hypothesis` flag.
 *
 * A DURATION MUST BE NAMED LIKE ONE. This is the rule that keeps the profiler
 * honest: a numeric column is not a duration. `revenue` is numeric, `units` is
 * numeric, `response_bytes` is numeric, and ranking any of them as elapsed time
 * would print a confident table of milliseconds that mean something else
 * entirely. So `duration` is only ever filled from a name that says so.
 *
 * Roles are assigned in one pass and a column is consumed as it is taken, so the
 * profiler cannot decide `response_bytes` is both the cost and the source.
 */
export function inferGenericRoles(profile: readonly ColumnProfile[]): Record<string, string> {
  const roles: Record<string, string> = {};
  const taken = new Set<string>();
  const byName = new Map(profile.map((c) => [c.column.toLowerCase(), c]));
  const take = (role: string, column: string | undefined): void => {
    if (column === undefined || taken.has(column)) return;
    taken.add(column);
    roles[role] = column;
  };

  const firstNamed = (names: readonly string[], kind?: InferredKind): string | undefined => {
    for (const name of names) {
      const found = byName.get(name);
      if (found !== undefined && (kind === undefined || found.kind === kind)) return found.column;
    }
    return undefined;
  };

  take("time", firstNamed(TIME_NAMES, "temporal") ?? profile.find((c) => c.kind === "temporal" && !taken.has(c.column))?.column);

  take("duration", firstNamed(DURATION_NAMES, "numeric")
    ?? profile.find((c) => !taken.has(c.column) && c.kind === "numeric" && DURATIONISH.test(c.column))?.column);

  take("threshold", firstNamed(THRESHOLD_NAMES, "numeric"));

  take("category", firstNamed(CATEGORY_NAMES)
    // Nothing named: the LOWEST-cardinality categorical column, because a
    // ranking needs a column that groups. The highest-cardinality one is almost
    // always an identifier, and ranking by an identifier produces one row per
    // row, which is a table with no content.
    ?? profile.filter((c) => !taken.has(c.column) && c.kind === "categorical")
      .sort((a, b) => a.distinctValues - b.distinctValues || a.column.localeCompare(b.column))[0]?.column);

  take("source", firstNamed(SOURCE_NAMES));

  return roles;
}

function readJsonFile(file: string): Promise<SchemaFile | undefined> {
  // Synchronous-by-promise is the honest shape: an absent or malformed store is
  // a fact, not an error, and returning undefined is what makes the fallback work.
  return import("node:fs/promises")
    .then((fs) => fs.readFile(file, "utf8"))
    .then((text): SchemaFile | undefined => {
      const parsed = JSON.parse(text) as SchemaFile | StoredSchema[];
      // BOTH shapes are accepted on purpose. The shipped config is an object so
      // it can carry a version and a comment; `.session-archive/schemas.json` is
      // a file a person edits by hand, and the shortest thing that works is a
      // bare array. Rejecting the short form would teach people that memory
      // "did not work" rather than that they used the wrong shape.
      const schemas = Array.isArray(parsed) ? parsed : parsed.schemas;
      return Array.isArray(schemas) ? { schemas } : undefined;
    })
    .catch(() => undefined);
}

/** The first stored schema whose declared columns are all present, else the best partial one. */
function select(schemas: StoredSchema[], headers: readonly string[]): StoredSchema | undefined {
  const present = new Set(headers);
  const declared = schemas.filter((s) => typeof s.id === "string" && typeof s.roles === "object" && s.roles !== null);
  const matched = declared.filter((s) => (s.match?.allOf ?? []).every((c) => present.has(c)));
  if (matched.length > 0) return matched[0];
  // No declared match. Fall back to the schema with the most of its roles
  // actually present, and only if that is enough to be worth applying.
  const scored = declared
    .map((s) => ({ s, hits: Object.values(s.roles).filter((c): c is string => typeof c === "string" && present.has(c)).length }))
    .filter((e) => e.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  return scored[0]?.s;
}

/** The roles one store can supply for this file, and the columns it named in vain. */
function rolesFrom(schema: StoredSchema, headers: readonly string[]): { roles: Record<string, string>; absent: string[] } {
  const present = new Set(headers);
  const roles: Record<string, string> = {};
  const absent: string[] = [];
  for (const [role, column] of Object.entries(schema.roles)) {
    if (typeof column !== "string" || column.length === 0) continue;
    if (!present.has(column)) { absent.push(column); continue; }
    roles[role] = column;
  }
  return { roles, absent };
}

export interface ResolveOptions {
  /** The project root. `.session-archive` is read from here. */
  cwd: string;
  /** The header row of the file being analysed. */
  headers: readonly string[];
  /**
   * The file's rows, for the generic profiler ONLY.
   *
   * A stored schema is a claim about column NAMES, so headers alone are enough
   * to apply one. A generic profile is a claim about column VALUES, and a
   * header says nothing about whether `10.0.0.1` is an address or an integer.
   * So the rows are optional: without them the profiler cannot run and the
   * resolver behaves exactly as it always did.
   */
  rows?: readonly Record<string, string>[];
  /**
   * Where the shipped defaults live. Defaults to `<cwd>/configs`, which is the
   * product layout; tests and the web server override it so a temporary
   * workspace does not have to carry a copy of the product's configs.
   */
  defaultsRoot?: string;
}

/**
 * Merge the two stores role by role: the archive first, the shipped defaults
 * filling only what the archive left empty.
 *
 * Merging rather than choosing is what makes both halves of the ruling true at
 * once. A checkout that corrected ONE role keeps that correction and still gets
 * the verified mapping for the other five; picking a whole store or the other
 * would mean either losing the correction or losing the shipped schema.
 */
export async function resolveSchemaMemory(options: ResolveOptions): Promise<ResolvedSchema | undefined> {
  const headers = options.headers;

  const archive = await readJsonFile(path.resolve(options.cwd, ARCHIVE_RELATIVE));
  const learned = archive === undefined ? undefined : select(archive.schemas, headers);
  const defaults = await readJsonFile(path.resolve(options.defaultsRoot ?? options.cwd, DEFAULT_RELATIVE));
  const core = defaults === undefined ? undefined : select(defaults.schemas, headers);

  const fromArchive = learned === undefined ? { roles: {}, absent: [] } : rolesFrom(learned, headers);
  const fromCore = core === undefined ? { roles: {}, absent: [] } : rolesFrom(core, headers);

  const roles = { ...fromCore.roles, ...fromArchive.roles };
  // A schema that cannot fill a REQUIRED role is not applied. Half a mapping is
  // not a schema; it is a report with holes that nobody labelled.
  const unresolved = REQUIRED_ROLES.filter((role) => roles[role] === undefined);

  if (unresolved.length === 0) {
    const learnedRoles = Object.keys(fromArchive.roles);
    return {
      id: learned?.id ?? core?.id ?? "unresolved",
      roles,
      source: learnedRoles.length > 0 ? "SESSION_ARCHIVE" : "DEFAULT",
      learnedRoles,
      absent: [...fromArchive.absent, ...fromCore.absent],
      unresolved,
    };
  }

  // NO STORED SCHEMA APPLIED. Profile the file instead of refusing it.
  //
  // The previous behaviour was to return undefined here, and for a Pega export
  // that was survivable -- we knew the shape. Hand the product a web access log
  // and it produced a near-empty report, which is NOT a neutral outcome: it
  // reads as "this file says nothing" when it says plenty and nobody looked.
  //
  // `source: "GENERIC"` is the load-bearing part. Downstream, a role that came
  // from a stored schema is reported as ESTABLISHED, because a person checked
  // it. A role inferred from a regex over column values is exactly as much of a
  // guess as one inferred from a name -- better informed, still a guess -- so
  // `analyseBottlenecks` refuses to mark these verified. Without that the report
  // would grow a green "established" badge on the strength of a regular
  // expression and a reader could not tell a checked mapping from a lucky one.
  if (options.rows === undefined || options.rows.length === 0) return undefined;
  const profile = profileGenericColumns(options.headers, options.rows);
  const inferred = inferGenericRoles(profile);
  const gaps = GENERIC_REQUIRED_ROLES.filter((role) => inferred[role] === undefined);
  // No rows, or nothing that groups and nothing that dates: return undefined and
  // let the report say the file matched nothing. A profile with no evidence is
  // not a weaker profile, it is an invented one.
  if (gaps.length > 0) return undefined;

  return {
    id: "generic-inferred",
    roles: inferred,
    source: "GENERIC",
    learnedRoles: [],
    absent: [],
    unresolved: [],
  };
}
