import type { CsvReadResult } from "./capabilities.ts";
import type { ResolvedSchema } from "./schema-memory.ts";

/**
 * BOTTLENECK ANALYSIS for Stage 2.
 *
 * The dashboard is the artifact; the BOTTLENECK RANKING is the product. So
 * every figure this module produces carries the rows it came from. A claim a
 * reader cannot check is a claim they have to trust, and the whole reason to
 * rank rather than graph is that the ranking gets argued with.
 *
 * Pure functions, no I/O, no policy, no kernel. Everything here is a function of
 * the parsed rows, which makes it directly testable and keeps the governed tool
 * call thin.
 *
 * TIMESTAMPS. A real Splunk export mixes encodings across searches, so `_time`
 * arrives as epoch seconds in some rows and ISO-8601 in others. Both are
 * normalised to epoch milliseconds. A value that is neither is reported as
 * unusable rather than coerced to zero, because a timestamp of zero is a
 * confident lie and would put the row in 1970.
 */

/** One counted thing, with the rows that justify it. */
export interface Bottleneck {
  /** What is being ranked -- a source name, an error signature, an hour. */
  readonly key: string;
  readonly count: number;
  readonly errorCount: number;
  readonly errorRate: number;
  /** Source row numbers (1-based, header excluded). The audit trail. */
  readonly rows: readonly number[];
}

/**
 * A column read for a role, and how much of that reading is a guess.
 *
 * R9: column NAMES are evidence. They are not proof, and this carries the
 * difference explicitly so the report can print it rather than the reader having
 * to guess which numbers were inferred.
 *
 * `hypothesis: true` means the name was the only thing that decided it. The
 * elapse column of a Pega export is named for a duration and holds a duration,
 * but states no unit anywhere, so the reading is sound and the UNIT is not.
 */
export interface ColumnMapping {
  readonly role: string;
  readonly column: string;
  readonly hypothesis: boolean;
  readonly note: string;
}

/** A column that was available but carries no ranking information. */
export interface DegenerateColumn {
  readonly column: string;
  readonly distinctValues: number;
  readonly note: string;
}

/** A ranked alert category, with the elapsed time it cost. */
export interface CategoryStat {
  readonly key: string;
  readonly count: number;
  /** Sum of the duration column, or null when there is no credible one. */
  readonly totalElapsed: number | null;
  /** Rows over the threshold. Zero when there is no threshold column. */
  readonly breachCount: number;
  readonly rows: readonly number[];
}

export interface LatencyBand {
  readonly label: string;
  readonly count: number;
  readonly rows: readonly number[];
}

export interface BottleneckAnalysis {
  readonly totalRows: number;
  readonly errorRows: number;
  readonly errorRate: number;
  /** Ranked worst-first by error volume, ties broken by rate then name. */
  readonly bySource: readonly Bottleneck[];
  /** Distinct error signatures, ranked by how often they recur. */
  readonly recurring: readonly Bottleneck[];
  /** Error volume bucketed by hour. */
  readonly byHour: readonly Bottleneck[];
  readonly latency: readonly LatencyBand[];
  /** Rows whose timestamp could not be read, so they are excluded from byHour. */
  readonly unreadableTimestamps: readonly number[];
  /** Structural problems carried through from the reader. Never exceptions. */
  readonly problems: readonly string[];
  /** Every column read for a role, and whether that reading was a hypothesis. */
  readonly mappings: readonly ColumnMapping[];
  /** Columns that exist but carry no ranking information. */
  readonly degenerateColumns: readonly DegenerateColumn[];
  /** Roles with no credible column. The report must say so, not degrade. */
  readonly missing: readonly string[];
  /** Where the role mapping came from. Absent when everything was inferred. */
  readonly schemaSource?: "SESSION_ARCHIVE" | "DEFAULT";
  /** Roles whose column came from a stored schema rather than from name inference. */
  readonly verifiedRoles?: readonly string[];
  /** Which column supplied the category ranking. */
  readonly categoryColumn: string | null;
  /** Categories by frequency, and by total elapsed -- which are not the same order. */
  readonly categories: readonly CategoryStat[];
  readonly categoriesByElapsed: readonly CategoryStat[];
  /**
   * True when the time column carries no zone, so the instants are host-relative.
   *
   * This is not pedantry. Bucketing a naive timestamp under a heading that says
   * UTC is only true on a host whose zone IS UTC. On a half-hour-offset host
   * every bucket is silently shifted by thirty minutes, and the report looks
   * entirely normal while being wrong.
   */
  readonly timestampsAreNaive: boolean;
}

const ERROR_STATUSES = new Set(["4", "5"]);

/**
 * R9: CANDIDATE COLUMNS PER ROLE, most specific first.
 *
 * Every entry is a name that DESCRIBES the role. None of it is proof, which is
 * why each candidate is reported as a hypothesis and why the category role is
 * additionally checked for cardinality below.
 */
const ROLE_CANDIDATES: Record<string, readonly string[]> = {
  time: ["_time", "timestamp", "time"],
  source: ["source", "source_host", "sourcetype", "host", "host_name"],
  // Most specific first: a code discriminates better than a type.
  category: ["alert_code", "alertcode", "alert_type", "alertType", "category", "event_type", "type"],
  message: ["_raw", "message", "msg", "description", "details"],
  status: ["status", "code", "http_status"],
  duration: ["elapsed_time", "elapsed_ms", "duration_ms", "duration", "elapsed"],
  threshold: ["threshold", "limit", "threshold_ms"],
};

/**
 * Resolve roles from column NAMES, then REJECT a degenerate category.
 *
 * The rejection is the whole point of this function. alertType is named exactly
 * like a category column and holds ONE distinct value across the entire export,
 * so ranking by it yields one bucket containing everything: a table that looks
 * like an answer and is not one. A name describes intent; it says nothing about
 * cardinality, and the reader would have learned the hard way that the two
 * diverge.
 *
 * So a candidate with a single distinct value is demoted -- reported, never used.
 */
function resolveMappings(csv: CsvReadResult, schema?: ResolvedSchema): {
  mappings: ColumnMapping[];
  degenerate: DegenerateColumn[];
  chosen: Record<string, string | undefined>;
  verified: string[];
} {
  const mappings: ColumnMapping[] = [];
  const degenerate: DegenerateColumn[] = [];
  const chosen: Record<string, string | undefined> = {};
  const used = new Set<string>();
  const verified: string[] = [];

  const distinctOf = (column: string): number => {
    const values = new Set<string>();
    for (const row of csv.rows) values.add(String(row[column] ?? ""));
    return values.size;
  };

  for (const [role, candidates] of Object.entries(ROLE_CANDIDATES)) {
    // A stored schema's column is tried FIRST, ahead of every name candidate.
    // That is the whole point of shipping one: on a second Pega export the
    // verified mapping is used, instead of re-running name inference and hoping
    // the candidates still describe the columns.
    const stored = schema?.roles[role];
    const ordered = (stored !== undefined && csv.headers.includes(stored))
      ? [stored, ...candidates.filter((c) => c !== stored)]
      : [...candidates];
    const present = ordered.filter((c) => csv.headers.includes(c));
    // EVERY present candidate is checked for degeneracy, not only the ones
    // reached before a choice is made. Checking lazily would report a
    // single-valued column as healthy simply because a better candidate was
    // found first, which hides exactly the trap this exists to catch.
    const usable = present.filter((c) => {
      const distinct = distinctOf(c);
      if (role === "category" && distinct <= 1) {
        degenerate.push({
          column: c,
          distinctValues: distinct,
          note: "single distinct value; cannot rank",
        });
        return false;
      }
      return true;
    });
    const pick = usable.find((c) => !used.has(c)) ?? usable[0];
    if (pick === undefined) { chosen[role] = undefined; continue; }
    chosen[role] = pick;
    used.add(pick);
    const distinct = distinctOf(pick);
    // A column that came from a stored schema is VERIFIED: someone checked it
    // against a real export of this shape. Everything else is still a
    // hypothesis, and is still printed as one.
    const fromStore = pick === stored && stored !== undefined;
    if (fromStore) verified.push(role);
    const hypothesis = !fromStore;
    const note = fromStore
      ? `verified schema "${schema?.id}"`
      : role === "duration"
        ? "unit not stated in export"
        : `inferred from name; ${distinct} distinct`;
    mappings.push({ role, column: pick, hypothesis, note });
  }
  return { mappings, degenerate, chosen, verified };
}

/**
 * The signature of a failure: the leading status word and the first clause of
 * the message, with volatile numbers masked.
 *
 * Masking is what makes recurrence visible. `waiters=57` and `waiters=73` are
 * the same bottleneck; without masking every error is unique and the ranking
 * degenerates into a list.
 */
export function errorSignature(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (!/\b(4\d\d|5\d\d)\b/.test(trimmed) && !/^ERROR/i.test(trimmed)) return undefined;
  const firstClause = trimmed.split(",")[0].trim();
  // `\d+`, NOT `\b\d+\b`. A word boundary does not exist between "3000" and
  // "ms", so a bounded mask leaves every duration unmasked and every timeout
  // looking like a unique event -- which defeats recurrence entirely. That
  // mistake was made here and caught by the Stage 2 acceptance run.
  return firstClause
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

/** Epoch seconds or ISO-8601 to epoch ms. Undefined when neither parses. */
export function parseInstant(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isError(status: string): boolean {
  return ERROR_STATUSES.has(status.trim()[0] ?? "");
}

function rank(entries: Map<string, { error: number; rows: number[] }>): Bottleneck[] {
  return [...entries.entries()]
    .map(([key, v]) => ({
      key,
      count: v.rows.length,
      errorCount: v.error,
      errorRate: v.rows.length === 0 ? 0 : v.error / v.rows.length,
      rows: [...v.rows].sort((a, b) => a - b),
    }))
    .sort((a, b) => b.errorCount - a.errorCount || b.errorRate - a.errorRate || a.key.localeCompare(b.key));
}

function bucket(map: Map<string, { error: number; rows: number[] }>, key: string, error: boolean, row: number): void {
  const entry = map.get(key) ?? { error: 0, rows: [] };
  if (error) entry.error += 1;
  entry.rows.push(row);
  map.set(key, entry);
}

/** Turn a parsed CSV into the ranked bottleneck view. Never throws. */
export function analyseBottlenecks(
  csv: CsvReadResult,
  /**
   * A stored mapping for THIS file, when one resolved. Its roles are taken as
   * verified rather than inferred -- including the cardinality rejection, which
   * is a property of the data and is re-checked below either way.
   */
  schema?: ResolvedSchema,
): BottleneckAnalysis {
  const { mappings, degenerate, chosen, verified } = resolveMappings(csv, schema);

  const timeCol = chosen.time;
  const sourceCol = chosen.source;
  const statusCol = chosen.status;
  const rawCol = chosen.message;
  const latencyCol = chosen.duration;
  const categoryCol = chosen.category;
  const thresholdCol = chosen.threshold;

  const sources = new Map<string, { error: number; rows: number[] }>();
  const signatures = new Map<string, { error: number; rows: number[] }>();
  const hours = new Map<string, { error: number; rows: number[] }>();
  const unreadable: number[] = [];
  const bands: { limit: number; label: string; rows: number[] }[] = [
    { limit: 50, label: "<50ms", rows: [] },
    { limit: 200, label: "50-200ms", rows: [] },
    { limit: 1000, label: "200ms-1s", rows: [] },
    { limit: Infinity, label: ">1s", rows: [] },
  ];

  let errorRows = 0;

  const categories = new Map<string, { count: number; elapsed: number | null; breach: number; rows: number[] }>();

  let naiveTimestamps = 0;
  let timestampRows = 0;
  const NAIVE_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;
  // A zone suffix makes the instant unambiguous. Without this check the shape
  // regex matches the PREFIX of a Z-suffixed timestamp and reports a UTC instant
  // as host-relative, which is the opposite error and just as misleading.
  const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/;

  csv.rows.forEach((row, index) => {
    // +2: sample rows start after the header, and the row numbers a reader sees
    // are file line numbers. Getting this wrong would cite the wrong evidence.
    const rowNumber = index + 2;
    const status = statusCol === undefined ? "" : String(row[statusCol] ?? "");
    const error = statusCol === undefined ? false : isError(status);
    if (error) errorRows += 1;

    if (sourceCol !== undefined) bucket(sources, String(row[sourceCol] ?? "(none)"), error, rowNumber);

    if (rawCol !== undefined && error) {
      const signature = errorSignature(String(row[rawCol] ?? ""));
      if (signature !== undefined) bucket(signatures, signature, true, rowNumber);
    }

    if (timeCol !== undefined) {
      const raw = String(row[timeCol] ?? "");
      timestampRows += 1;
      if (NAIVE_TIME.test(raw.trim()) && !HAS_ZONE.test(raw.trim())) naiveTimestamps += 1;
      const instant = parseInstant(raw);
      if (instant === undefined) {
        unreadable.push(rowNumber);
      } else {
        const hour = new Date(instant).toISOString().slice(0, 13);
        bucket(hours, hour, error, rowNumber);
      }
    }

    if (latencyCol !== undefined) {
      const duration = Number(String(row[latencyCol] ?? ""));
      if (Number.isFinite(duration)) {
        for (const band of bands) {
          if (duration < band.limit) { band.rows.push(rowNumber); break; }
        }
      }
    }

    // Categories: counted by frequency, and independently accumulated by elapsed
    // time, because the two orderings routinely disagree and the owner's
    // question asks for both.
    if (categoryCol !== undefined) {
      const key = String(row[categoryCol] ?? "(none)");
      const entry = categories.get(key) ?? { count: 0, elapsed: latencyCol === undefined ? null : 0, breach: 0, rows: [] };
      const rawDuration = latencyCol === undefined ? Number.NaN : Number(String(row[latencyCol] ?? ""));
      if (entry.elapsed !== null && Number.isFinite(rawDuration)) entry.elapsed += rawDuration;
      if (thresholdCol !== undefined && Number.isFinite(rawDuration)
        && Number(String(row[thresholdCol] ?? Number.NaN)) < rawDuration) {
        entry.breach += 1;
      }
      entry.count += 1;
      entry.rows.push(rowNumber);
      categories.set(key, entry);
    }
  });

  // `rows`, NEVER `sample`. The sample is capped for charting; analysing it
  // would report a confident answer about a fraction of the export, with
  // nothing on the page to say so. A real 101-row export was half-analysed this
  // way before a red test caught it.
  const categoryStats: CategoryStat[] = [...categories.entries()].map(([key, v]) => ({
    key,
    count: v.count,
    totalElapsed: v.elapsed,
    breachCount: v.breach,
    rows: [...v.rows].sort((a, b) => a - b),
  }));
  const byFrequency = [...categoryStats].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const byElapsed = [...categoryStats].sort(
    (a, b) => (b.totalElapsed ?? -1) - (a.totalElapsed ?? -1) || b.count - a.count,
  );

  // A required role with no credible column is NAMED. An empty table reads as
  // "nothing recurred", which is the opposite of "this file cannot say".
  const missing = (["category", "time", "source", "message", "duration"] as const)
    .filter((role) => chosen[role] === undefined)
    .map((role) => (role === "message" ? "message" : role));

  const total = csv.rows.length;
  return {
    totalRows: total,
    errorRows,
    errorRate: total === 0 ? 0 : errorRows / total,
    bySource: rank(sources),
    recurring: rank(signatures),
    byHour: rank(hours),
    latency: bands.filter((b) => b.rows.length > 0).map((b) => ({ label: b.label, count: b.rows.length, rows: b.rows })),
    unreadableTimestamps: unreadable,
    problems: csv.problems,
    mappings,
    degenerateColumns: degenerate,
    missing,
    schemaSource: schema?.source,
    verifiedRoles: verified,
    categoryColumn: categoryCol ?? null,
    categories: byFrequency,
    categoriesByElapsed: byElapsed,
    timestampsAreNaive: timestampRows > 0 && naiveTimestamps === timestampRows,
  };
}