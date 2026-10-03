import type { CsvReadResult } from "./capabilities.ts";
import {
  fencesFromQuartiles,
  outliersFromSorted,
  percentileSorted,
  streamCsvRecordsSync,
  MAX_DURATIONS as MAX_DURATIONS_PER_KEY,
  MAX_LOGGERS as MAX_LOGGERS_PER_KEY,
  type FenceSummary,
  type StreamColumnSnapshot,
} from "./stream-profile.ts";
import { profileGenericColumns, type ResolvedSchema } from "./schema-memory.ts";
import { describePurpose, type Purpose } from "./semantics.ts";

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
  /** key plus its human-readable alias, when one is unambiguous (R13). */
  readonly label: string;
  readonly count: number;
  /** Sum of the duration column in milliseconds (R10), or null when absent. */
  readonly totalElapsed: number | null;
  /**
   * The three measures that make a total interpretable, all in milliseconds and
   * all null when there is no credible duration column.
   *
   * `count` is EVERY row in the category; these are the rows that carried a
   * MEASURABLE duration. The two differ whenever a duration was blank or
   * unparseable, and the difference is real: a blank is not a zero, and
   * averaging it in as one would drag the mean toward zero on rows nobody
   * measured. So these are null-safe by construction rather than by a filter
   * applied at render time.
   */
  readonly meanElapsed: number | null;
  readonly medianElapsed: number | null;
  readonly p95Elapsed: number | null;
  /** Rows over the threshold. Zero when there is no threshold column. */
  readonly breachCount: number;
  readonly rows: readonly number[];
}

/**
 * The disagreement between ranking by frequency and ranking by elapsed time.
 *
 * This is the finding the product exists to surface. A category can top the
 * frequency table on sheer volume while contributing a rounding error of the
 * total cost, and the one burying the other is whichever ranking you did not
 * print. Measured rather than eyeballed, so the page can state the ratio.
 */
/**
 * WHAT THE REPORT CALLS THE THINGS IT IS COUNTING.
 *
 * The report used to say "alert(s)" because every file it had ever seen was a
 * Pega alert export. That was a defensible default and it became a lie the
 * moment the generic profiler let an access log through: not merely wrong
 * vocabulary, but an assertion that the file contained alerts. A reader has no
 * way to tell an unfounded claim about their data from a founded one.
 *
 * `thresholdLabel` is NULL when the file states no threshold, and that null is
 * what makes the breach column DROPPABLE rather than a column of zeros. "Zero
 * over threshold" against a limit the file never mentioned is a false
 * all-clear, and a zero is a fact-shaped hole -- worse than an absent column,
 * because absent can be noticed and zero cannot.
 */
export interface ReportVocabulary {
  /** Singular, for headings and "X per record" phrasing. */
  readonly unit: string;
  /** The mid-sentence form, "13 record(s)". */
  readonly unitPlural: string;
  /** Capitalised unit, for section headings. */
  readonly headingUnit: string;
  /** Null when the file states no threshold, and the column must be dropped. */
  readonly thresholdLabel: string | null;
}

export interface Divergence {
  readonly byFrequency: CategoryStat;
  readonly byElapsed: CategoryStat;
  /** Total elapsed of the elapsed-leader over the frequency-leader. */
  readonly totalRatio: number | null;
  /** Alert count of the elapsed-leader over the frequency-leader. */
  readonly alertRatio: number | null;
}

export interface LatencyBand {
  readonly label: string;
  readonly count: number;
  readonly rows: readonly number[];
}

/** One hour bucket, measured against the rest of the window. */
export interface HourStat {
  /** ISO hour key, "2026-09-30T13". Sorts chronologically as a string. */
  readonly key: string;
  readonly count: number;
  /** Fraction of all readable rows, so the spike is quantified in context. */
  readonly share: number;
  /** count / meanPerHour, or null when there is no mean. */
  readonly multiple: number | null;
  readonly isSpike: boolean;
  /** Plain-language reason, shown next to the flag. */
  readonly rule: string | null;
}

/**
 * THE SHAPE OF A DAY, AND WHETHER ANY OF IT IS ABNORMAL.
 *
 * The ranking answers what a bottleneck COST. This answers WHEN, which is a
 * different question with a different fix: three million milliseconds spread
 * evenly over a week is a capacity problem, and the same total inside four
 * minutes on Tuesday is an incident.
 *
 * `meanPerHour` divides by the buckets OBSERVED, never by 24. Dividing by 24
 * would make every ordinary hour in a six-hour export look like a spike, which
 * is the failure mode of assuming a window instead of measuring one.
 */
export interface HourlyProfile {
  readonly hours: readonly HourStat[];
  readonly countedRows: number;
  readonly buckets: number;
  readonly meanPerHour: number;
  /** Population standard deviation of the per-hour counts. */
  readonly sigma: number;
  /** A bucket must exceed this multiple of the mean to be flagged. */
  readonly spikeMultiple: number;
  readonly flagged: number;
  /** True when there are too few buckets for the ratio test to mean anything. */
  readonly insufficient: boolean;
}

/**
 * THE EXTENT OF A RANKING, published so a bounded computation can admit it.
 *
 * Every ranking accumulator in this file is capped -- keys, citations, durations
 * -- because an unbounded Map over a `category` column holding a million distinct
 * strings is the memory wall again wearing a different hat. The caps are what
 * make a 500,000-row file affordable. The cost is that a ranking can become a
 * ranking of the most frequent keys rather than of all of them, and that is a
 * fact about the answer, not about the implementation -- so it travels with the
 * answer.
 */
export interface RankingScope {
  /** Rows the rankings covered. Equal to `fileRows` -- every row, both paths. */
  readonly rowsRanked: number;
  /** The file's true row count, as the reader counted it while streaming. */
  readonly fileRows: number;
  /**
   * True when the rankings came from the streaming pass rather than from the
   * retained window. Both rank every row; this says which route produced them.
   */
  readonly viaStreamingPass: boolean;
  /** Distinct category keys currently tracked, against the budget. */
  readonly categoryKeysTracked: number;
  /** Keys evicted to stay inside the budget. Zero means the ranking is complete. */
  readonly droppedCategoryKeys: number;
  /** The key budget, so the report can state the limit it enforced. */
  readonly categoryKeyBudget: number;
}

export interface BottleneckAnalysis {
  /** What the engine believes this file IS. See semantics.ts. */
  readonly purpose: Purpose;
  readonly totalRows: number;
  readonly errorRows: number;
  readonly errorRate: number;
  /** Ranked worst-first by error volume, ties broken by rate then name. */
  readonly bySource: readonly Bottleneck[];
  /**
   * WHAT THE RANKINGS ACTUALLY COVER, and what was dropped to keep them bounded.
   *
   * This exists because every accumulator behind a ranking is now capped, and a
   * cap that cannot say it has been hit is a cap that lies. `droppedCategoryKeys`
   * is non-zero when distinct categories exceeded the budget and the rarest were
   * evicted -- in which case the ranking is a ranking of the most frequent keys,
   * not of all of them, and the user is told so instead of being shown a chart
   * that looks complete.
   *
   * `viaStreamingPass` records HOW the same answer was reached. It is not a
   * quality signal: both paths rank every row, and a reader who believed
   * otherwise would be right to distrust the numbers.
   */
  readonly rankingScope: RankingScope;
  /** Distinct error signatures, ranked by how often they recur. */
  readonly recurring: readonly Bottleneck[];
  /** Error volume bucketed by hour. */
  readonly byHour: readonly Bottleneck[];
  /**
   * The shape of the day, with spikes flagged. Additive: `byHour` still holds
   * the plain counts, and nothing that consumed it changed.
   */
  readonly hourly: HourlyProfile;
  /**
   * Descriptive statistics for the file's numeric columns. The FALLBACK, for a
   * file with no categorical ranking to show.
   *
   * ALWAYS COMPUTED, not only when the ranking is empty, and that is the
   * deliberate choice: a field whose contents depend on a sibling field's
   * emptiness is exactly the conditional shape that turns into a bug later. The
   * pass is bounded by the profiler's 200-row classification sample plus one
   * arithmetic pass over the file, which is not a cost worth optimising into a
   * landmine. The RENDERER decides when to show it.
   */
  readonly numerical: NumericalProfile;
  /** Dirty cells and outliers, across every numeric column. See `DataHealth`. */
  readonly health: DataHealth;
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
  /** "GENERIC" means inferred from values, never checked by a person. */
  readonly schemaSource?: "SESSION_ARCHIVE" | "DEFAULT" | "GENERIC";
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
  /** R10: the owner has ruled the elapsed column to be milliseconds. */
  readonly durationUnit: "ms";
  /** R10 was a ruling, so the unit is established rather than inferred. */
  readonly durationUnitIsRuled: true;
  /** R11: the owner has ruled timestamps to be UTC. */
  readonly timeZoneIsRuled: true;
  /** Loggers that map to more than one code, so no alias is printed for them. */
  readonly ambiguousAliases: readonly string[];
  /** Null when both rankings agree. See D2: a headline that always shouts is noise. */
  readonly divergence: Divergence | null;
  /** How this report describes the rows it counted. See `ReportVocabulary`. */
  readonly vocabulary: ReportVocabulary;
}

/**
 * RULINGS BY A PERSON, not inferences from a column name.
 *
 * R10: the Pega elapsed column is milliseconds. R11: its timestamps are UTC.
 * Both were open questions in the first real-data findings and both are now
 * settled. They live here, in ONE place, and the schema memory persists them --
 * because re-deriving a ruling from a header on every run would quietly discard
 * it the first time the file was needed.
 *
 * R12 (hostnames stay out of generated artefacts) is NOT here: it is a rendering
 * control, not a fact about a schema, and it is enforced in the renderer.
 */
export const OWNER_RULINGS = { durationUnit: "ms", timeZone: "UTC" } as const;

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
  alias: ["logger_name", "logger", "source_module"],
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
    //
    // "CAME FROM A STORE" IS NOT THE SAME AS "WAS VERIFIED", AND THE GENERIC
    // PROFILER IS WHY. It fills `roles` too, so a naive equality test would mark
    // a regex's guess over column values as ESTABLISHED -- giving the report a
    // green badge that a person never earned. Inference from values is better
    // informed than inference from a name, but it is still inference, so it is
    // still printed as a hypothesis.
    const fromStore = pick === stored && stored !== undefined && schema?.source !== "GENERIC";
    if (fromStore) verified.push(role);
    const hypothesis = !fromStore;
    const note = fromStore
      ? `verified schema "${schema?.id}"`
      : schema?.source === "GENERIC"
        // The note must describe HOW this was guessed, because "inferred from
        // name" is now only half true and an inaccurate note about evidence is
        // worse than no note.
        ? `inferred from name and a profile of ${distinct} sampled value(s)`
        : role === "duration"
        // R10 superseded the old wording on this branch. It used to say the unit
        // was not stated in the export, which was true of the file and false of
        // the decision: the owner has ruled the elapsed column to be
        // milliseconds, so the note names the ruling instead of the gap. The
        // merge had dropped it, and a test asserting the ruling went red.
        ? "ms by owner ruling R10"
        : role === "time"
          ? "UTC by owner ruling R11"
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

/**
 * A RANKED GROUP OF ROWS: the entries behind a ranking.
 *
 * `count` is carried EXPLICITLY rather than being `rows.length`, and that is the
 * change that made a whole-file ranking possible. Citations are now a SAMPLE --
 * capped per key -- because a category with 400,000 rows used to hold 400,000
 * line numbers, so the array that existed to help a reader jump to a row was the
 * thing preventing the product from ranking 400,000 rows at all.
 *
 * So: `count` is a measurement over every row, `rows` is a convenience of bounded
 * size, and neither is derived from the other.
 */
interface RankedGroup {
  error: number;
  rows: number[];
  count: number;
}

function rank(entries: Map<string, RankedGroup>): Bottleneck[] {
  return [...entries.entries()]
    .map(([key, v]) => ({
      key,
      count: v.count,
      errorCount: v.error,
      errorRate: v.count === 0 ? 0 : v.error / v.count,
      rows: [...v.rows].sort((a, b) => a - b),
    }))
    .sort((a, b) => b.errorCount - a.errorCount || b.errorRate - a.errorRate || a.key.localeCompare(b.key));
}

/**
 * A logger's readable form for a label: its final dotted segment.
 *
 * Fully qualified names run past seventy characters, which breaches the
 * committed report's cell budget and reads worse. The last segment is the part
 * a human recognises -- the class or handler name -- and discarding the package
 * prefix is a DISPLAY choice, not a semantic one: the full value is still what
 * the mapping used, and the analysis returns it unchanged.
 */
function aliasLabel(value: string): string {
  const last = value.split(".").filter((s) => s.length > 0).at(-1) ?? value;
  return last.length > 24 ? `${last.slice(0, 23)}…` : last;
}

function categoryLabel(key: string, alias: string | undefined): string {
  return alias === undefined ? key : `${key} (${aliasLabel(alias)})`;
}

/**
 * Mean, median and p95 over the durations that were actually MEASURED.
 *
 * NEAREST-RANK PERCENTILE, and that is a choice worth defending. The 95th
 * percentile is the value at rank ceil(0.95 * n), 1-indexed and clamped, which
 * always returns a duration some row ACTUALLY had. Linear interpolation, the
 * more common textbook choice, can return a number between two rows -- fine for
 * a statistic, wrong for a report whose entire promise is that every figure can
 * be traced to a row. "p95 is 10,000 ms" should let a reader go find a
 * 10,000 ms row, and with nearest-rank there always is one.
 *
 * MEDIAN AVERAGES THE MIDDLE PAIR on an even count, which is why the renderers
 * format these figures rather than concatenating them.
 *
 * Empty in, null out. Never zero: zero is a claim that the work was free.
 */
function durationStats(samples: readonly number[]): { mean: number | null; median: number | null; p95: number | null } {
  if (samples.length === 0) return { mean: null, median: null, p95: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  const median = n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const rank = Math.min(n, Math.max(1, Math.ceil(0.95 * n)));
  const mean = sorted.reduce((sum, v) => sum + v, 0) / n;
  return { mean, median, p95: sorted[rank - 1] };
}

/** Line citations kept per key. The COUNT beside them is exact; these are a sample. */
const MAX_CITATIONS = 200;

function bucket(map: Map<string, RankedGroup>, key: string, error: boolean, row: number): void {
  const entry = map.get(key) ?? { error: 0, rows: [], count: 0 };
  if (error) entry.error += 1;
  entry.count += 1;
  if (entry.rows.length < MAX_CITATIONS) entry.rows.push(row);
  map.set(key, entry);
}

/** Turn a parsed CSV into the ranked bottleneck view. Never throws. */
/**
 * ONE NUMERIC COLUMN, SUMMARISED.
 *
 * `measured` and `missing` are reported SEPARATELY and add up to the row count,
 * because a column that silently drops two values out of twenty is not
 * summarising the column. `missing` counts blanks and wrongly-typed cells
 * together, and neither is treated as zero -- see `durationStats` for why that
 * distinction is load-bearing rather than pedantic.
 */
export interface NumericColumnStat {
  readonly column: string;
  /** Values that parsed as a number. */
  readonly measured: number;
  /** Cells that were not usable: `empty + dirty`. */
  readonly missing: number;
  /**
   * CELLS THAT WERE BLANK. The value is absent.
   *
   * Distinct from `dirty` because it calls for a different investigation: a null
   * is usually a pipeline that dropped a value, and it is usually benign.
   */
  readonly empty: number;
  /**
   * CELLS THAT HELD SOMETHING WHICH IS NOT A NUMBER.
   *
   * This is a TYPE MISMATCH, and it is the signature of a broken producer: a bad
   * cast, a locale change, a sentinel like "N/A" written into a float column, or
   * a column that is not what its name says. Conflating it with `empty` costs
   * the reader the entire diagnosis, and the two call for opposite responses.
   */
  readonly dirty: number;
  /** Distinct offending values, capped, so one broken column cannot flood a report. */
  readonly dirtyExamples: readonly string[];
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  /** max - min, the reason the column survived the cap. */
  readonly spread: number | null;
  /** Measured values beyond the Tukey fences. Zero when none, NOT null. */
  readonly outliers: number;
  /** The most extreme value beyond a fence on the low side. */
  readonly outlierMin: number | null;
  /** The most extreme value beyond a fence, so the flag carries its magnitude. */
  readonly outlierMax: number | null;
  /** Values beyond the OUTER (3x) fence: the actionable ones. */
  readonly extremeOutliers: number;
  /**
   * TRUE when the QUARTILES behind these fences came from a sample of the column
   * rather than from the column.
   *
   * It is absent for every column small enough to be held whole, which is every
   * column a person is likely to open, and it is stated rather than smoothed over
   * because a fence position estimated from 4096 of 500,000 values is a
   * good estimate and NOT a measurement. The outlier COUNT beside it is exact
   * either way: the reader verifies it against every row in a second pass.
   */
  readonly quantilesSampled?: boolean;
  /** The outer fence, so an extreme claim is as checkable as a marginal one. */
  readonly fenceExtremeLower: number | null;
  readonly fenceExtremeUpper: number | null;
  /**
   * The fences used, published so the judgement can be checked.
   *
   * A flag with no threshold stated is an oracle. Null means no fence was
   * computed, which happens only when the column is too short to support one --
   * never "checked and found clean".
   */
  readonly fenceLower: number | null;
  readonly fenceUpper: number | null;
  /** The detection method, or null when too few values were present to apply one. */
  readonly method: "IQR" | null;
  /**
   * A bounded histogram, so a question can be ANSWERED rather than routed.
   *
   * The conversation can report a mean, a max and a count of outliers, and it
   * cannot say "how many rows are over 5,000" -- because a summary is not
   * invertible. The user asks that question constantly, and without this the
   * agent would have to decline it, which is the same as being a help page.
   *
   * Bucketed rather than stored, for two reasons. It is bounded: twenty pairs per
   * column, whatever the row count. And it is honest -- a bucket is a RANGE, so
   * an answer computed from one says which range, and `query.ts` refuses to
   * present a bucket as a point value. Storing every measured value would make
   * exact answers possible and would put an entire file into the browser payload
   * of a dashboard whose entire value proposition is that it does not exfiltrate
   * the CSV.
   */
  readonly histogram: readonly HistogramBucket[];
}

/** One bucket. Inclusive low, exclusive high, except the last which is closed. */
export interface HistogramBucket {
  readonly lo: number;
  readonly hi: number;
  readonly count: number;
}

/** How many buckets per numeric column. Enough for a range, bounded for size. */
export const HISTOGRAM_BUCKETS = 20;

/**
 * BUCKET THE MEASURED VALUES.
 *
 * Computed from the SAME `values` array the mean, the fences and the outlier
 * counts came from, so a histogram and a summary can never disagree about which
 * cells were measured. A histogram built from the raw rows would be able to
 * disagree, and would be able to count a dirty cell the mean excluded.
 */
function bucketOf(values: readonly number[], min: number, max: number): HistogramBucket[] {
  // Mutable while the counters are filled; structurally the published shape, and
  // the alternative -- rebuilding an array per value -- is an allocation per row.
  const out: { lo: number; hi: number; count: number }[] = [];
  if (values.length === 0) return out;
  const width = (max - min) / HISTOGRAM_BUCKETS;
  // A column whose every value is identical has a zero-width range. Division by
  // it would produce NaN buckets, so it gets one bucket that holds everything.
  if (!(width > 0)) return [{ lo: min, hi: max, count: values.length }];
  for (let i = 0; i < HISTOGRAM_BUCKETS; i += 1) {
    out.push({ lo: min + i * width, hi: min + (i + 1) * width, count: 0 });
  }
  for (const v of values) {
    let index = Math.floor((v - min) / width);
    // The maximum lands exactly on the last bucket's edge, and would index past
    // the end. It belongs IN the last bucket, which is why that one is closed.
    if (index >= HISTOGRAM_BUCKETS) index = HISTOGRAM_BUCKETS - 1;
    if (index < 0) index = 0;
    out[index]!.count += 1;
  }
  return out;
}

/**
 * THE FALLBACK ANALYSIS, for a file with no ranking to make.
 *
 * A matrix of anonymous numeric columns has no category, no timestamp and no
 * source, so every ranking this product knows how to compute is empty. That is
 * a true conclusion drawn from the wrong question: the file still contains
 * thousands of numbers, and "what is in this file" has an answer.
 */
export interface NumericalProfile {
  readonly columns: readonly NumericColumnStat[];
  /** Every numeric column in the file, including any not shown. */
  readonly numericColumns: number;
  /** True when `columns` shows a capped subset. Never truncate silently. */
  readonly truncated: boolean;
  readonly rows: number;
}

/** What is wrong with ONE column, for the health section. */
export interface ColumnHealth {
  readonly column: string;
  readonly dirty: number;
  readonly empty: number;
  /**
   * Beyond the OUTER (3x IQR) fence only.
   *
   * The conventional 1.5x count is deliberately NOT here. A 1.5x fence flags
   * roughly 1.4 per cent of a normal distribution by definition, so on the
   * Owner's 4,000-value noise matrix it named 37 outliers across 17 columns and
   * buried the one real finding. The marginal count is still computed and still
   * printed in the numerical table, where comparing columns is the point; this
   * section is the automated warning, and a warning that fires on ordinary
   * variation is not one.
   */
  readonly outliers: number;
  readonly marginalOutliers: number;
  /** The most extreme outlier value, so the warning carries a magnitude. */
  readonly worstValue: number | null;
  /** The fence that value cleared, so the claim can be checked. */
  readonly fence: number | null;
  /** Distinct offending values, for the type mismatch. */
  readonly examples: readonly string[];
}

/**
 * THE FILE'S HEALTH, IN SENTENCES RATHER THAN TABLE CELLS.
 *
 * Scoped to EVERY numeric column, not to the ten the summary displays. This is
 * the detail that matters most and the easiest to get wrong: a health check that
 * read only the visible ten would report "no dirty data" while a dirty column
 * sat silently in the hidden ten, which is worse than no health check at all,
 * because it issues a clean bill of health for a file that is not clean.
 *
 * `columns` lists only the columns that have something to report, so a reader is
 * never scrolling a list of the well-behaved to find the two that are not.
 */
export interface DataHealth {
  readonly columns: readonly ColumnHealth[];
  readonly dirtyColumns: number;
  readonly outlierColumns: number;
  readonly dirtyCells: number;
  readonly emptyCells: number;
  readonly outlierCells: number;
  /** No dirty cells and no outliers anywhere. A FINDING, not an absence. */
  readonly clean: boolean;
}

/** Ten rows is a data dictionary; twenty is noise. The report says which. */
const MAX_NUMERIC_COLUMNS = 10;

/** How many distinct offending values one column may show. */
const MAX_DIRTY_EXAMPLES = 3;

/**
 * Values required before outlier detection runs at all.
 *
 * Quartiles over four points are interpolation dressed up as a distribution.
 * Flagging an outlier from four samples manufactures certainty rather than
 * reporting it, so below this floor `method` is null and the report says the
 * engine did not look.
 */
const MIN_OUTLIER_SAMPLES = 8;

/** Tukey's constant. 1.5 is the standard fence; 3.0 is the "extreme" variant. */
const OUTLIER_IQR_FACTOR = 1.5;

/**
 * Tukey's OUTER fence. The difference between "unusual" and "wrong".
 *
 * FOUND BY RUNNING THE OWNER'S OWN FILE, not by reasoning about it.
 * random_data_with_issue.csv is 200 rows of standard-normal noise, 4,000 values
 * across 20 columns, and a 1.5x-IQR fence flags roughly 1.4 per cent of a normal
 * distribution BY DEFINITION. It reported 37 outliers across 17 columns. That is
 * statistically correct and completely useless as a report: the one genuine
 * finding, col_15 at 9,999,999.99, was one clause among seventeen and a reader
 * learned nothing from the other sixteen.
 *
 * So both fences are computed. At 3x IQR a normal distribution flags about 3 in
 * 10,000, so a clean random file reports NOTHING while col_15 still stands out
 * by six orders of magnitude. The health section reports only this one, because
 * an automated warning that fires on ordinary variation is not a warning.
 */
const EXTREME_IQR_FACTOR = 3;

/**
 * The p-th percentile by linear interpolation between closest ranks (type 7).
 *
 * INTERPOLATION, not the nearest-rank rule used for the hourly p95, and the
 * difference is deliberate. There, the reported number was a claimed
 * measurement and had to be a value some row actually held. Here the result is a
 * THRESHOLD -- a boundary, not an observation -- and the one every statistics
 * library uses is interpolation, so a reader who checks this against pandas gets
 * the same fence rather than a near miss and a suspicion that we invented one.
 */
function percentile(sorted: readonly number[], p: number): number {
  // The arithmetic now lives with the streaming profile, and this is a delegate
  // rather than a copy. A fence computed two ways is a fence a reader cannot
  // check, and this one is quoted against pandas in the report.
  return percentileSorted(sorted, p);
}

/**
 * Count values beyond the Tukey fences.
 *
 * IQR RATHER THAN Z-SCORE, because a z-score compares a point against the mean
 * and standard deviation OF THE DISTRIBUTION CONTAINING IT. One absurd value
 * inflates the very sigma it has to clear: a column with 199 values near zero and
 * one at 9,999,999.99 gets sigma around 700,000, so the point reads as about 13
 * sigma -- detectable only because it is so absurd, while a merely awkward 50
 * against the same column is invisible. Tukey fences are built from the
 * QUARTILES, which one value cannot move.
 *
 * The CONSTANT COLUMN IS THE DEGENERATE CASE worth naming: IQR is then zero, both
 * fences sit on the single value, every value equals them, and nothing is
 * flagged. That is the correct answer and it falls out of the arithmetic rather
 * than needing a branch.
 */
interface OutlierResult {
  readonly outliers: number;
  readonly low: number | null;
  readonly high: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  /** Beyond the 3x outer fence: the actionable ones. */
  readonly extreme: number;
  readonly extremeLower: number | null;
  readonly extremeUpper: number | null;
}

const NO_OUTLIERS: OutlierResult = { outliers: 0, low: null, high: null, lower: null, upper: null, extreme: 0, extremeLower: null, extremeUpper: null };

/**
 * THE CONSTANT COLUMN IS THE DEGENERATE CASE worth naming, because it is the one
 * most likely to produce Infinity or a spurious flag. IQR is then zero, every
 * fence sits on the single value, every value equals them, and nothing is
 * flagged. That is the correct answer and it falls out of the arithmetic rather
 * than needing a branch.
 */
function detectOutliers(values: readonly number[]): OutlierResult {
  // ONE IMPLEMENTATION. The streamed path calls the same function over a
  // reservoir, so a fence computed from the whole column and a fence computed
  // from a sample of it cannot drift into two different definitions of "IQR".
  return outliersFromSorted([...values].sort((a, b) => a - b));
}

/**
 * DESCRIBE EVERY NUMERIC COLUMN, SHOW THE MOST VARIED.
 *
 * WHICH COLUMNS COME FROM THE PROFILER, but the ARITHMETIC IS OVER EVERY ROW.
 * `profileGenericColumns` classifies from a 200-row sample because deciding
 * whether a column is numeric does not need every row -- but a mean computed
 * over 200 of 2000 rows, presented next to a row count that says 2000, is the
 * silent-partial-answer bug this codebase has been bitten by twice. Classification
 * may be sampled; statistics may not.
 *
 * ORDER IS BY SPREAD, not file position. Taking the first ten columns would show
 * col_1..col_10 and hide the eleven most informative, and a column whose every
 * value is identical is the least informative thing in a numeric file. The name
 * breaks ties so two runs produce byte-identical reports.
 *
 * A cell that will not parse is EXCLUDED from min, max and mean, and counted in
 * `missing`. It is never treated as zero: zero is a value the file stated.
 */
function numericalProfile(csv: CsvReadResult): { numerical: NumericalProfile; health: DataHealth } {
  const numericColumns = profileGenericColumns(csv.headers, csv.rows).filter((c) => c.kind === "numeric");
  const stats = numericColumns.map((c): NumericColumnStat => {
    // THE STREAMED PATH, when the reader streamed. Classification still comes
    // from the 200-row profile sample -- deciding whether a column is numeric
    // does not need every row -- but the arithmetic below it is computed over the
    // WHOLE FILE rather than over the retained window, which is the difference
    // between a mean of 500,000 rows and a mean of the first 10,000.
    const shot = csv.profile?.columns[c.column];
    if (shot !== undefined) return streamedNumericStat(c.column, shot, csv.profile?.outliers?.[c.column]);
    let measured = 0;
    let empty = 0;
    let dirty = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    // The surviving values, kept so the fences can be computed over exactly the
    // cells the figures above were computed over. Computing them from the raw
    // rows instead would let a dirty cell move the threshold that judges it.
    const values: number[] = [];
    // DISTINCT offending values, capped. A column of four thousand identical
    // "N/A" cells must not produce four thousand words in the report, and the
    // count above already carries the magnitude.
    const examples = new Set<string>();
    for (const row of csv.rows) {
      const raw = String(row[c.column] ?? "").trim();
      // THE THREE-WAY SPLIT, AND THE ORDER MATTERS. An empty cell is checked
      // FIRST and is never handed to Number(), because Number("") is 0 and
      // Number(" ") is 0: a blank would become a measurement of zero and drag
      // the mean down, asserting that unmeasured work was free. Only then is
      // "not a number" called DIRTY, because holding text in a numeric column is
      // a fact about the producer and not about absence.
      if (raw.length === 0) { empty += 1; continue; }
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        dirty += 1;
        if (examples.size < MAX_DIRTY_EXAMPLES) examples.add(raw);
        continue;
      }
      measured += 1;
      values.push(value);
      sum += value;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const outliers = detectOutliers(values);
    const tail = {
    outliers: outliers.outliers, outlierMin: outliers.low, outlierMax: outliers.high,
    fenceLower: outliers.lower, fenceUpper: outliers.upper,
    extremeOutliers: outliers.extreme, fenceExtremeLower: outliers.extremeLower, fenceExtremeUpper: outliers.extremeUpper,
    method: (outliers.lower === null ? null : "IQR") as "IQR" | null,
  };
    const shape = { column: c.column, measured, missing: empty + dirty, empty, dirty, dirtyExamples: [...examples], ...tail };
    if (measured === 0) return { ...shape, min: null, max: null, mean: null, spread: null, histogram: [] };
    return { ...shape, min, max, mean: sum / measured, spread: max - min, histogram: bucketOf(values, min, max) };
  });

  const ordered = [...stats].sort((a, b) => (b.spread ?? -1) - (a.spread ?? -1) || a.column.localeCompare(b.column));
  return {
    numerical: {
      columns: ordered.slice(0, MAX_NUMERIC_COLUMNS),
      numericColumns: stats.length,
      truncated: stats.length > MAX_NUMERIC_COLUMNS,
      rows: csv.profile?.rowCount ?? csv.rows.length,
    },
    // Health is built from the FULL list, before the display cap. See DataHealth.
    health: dataHealth(ordered),
  };
}

/**
 * A COLUMN DESCRIBED BY THE STREAM, rather than by an array of its values.
 *
 * This is the whole point of the streaming rewrite: on a file larger than the
 * retention window, min, max, mean, the empty/dirty split and the fences are
 * computed over EVERY row instead of over the ten thousand rows the analyser
 * happened to keep. The arithmetic is the analyser's own, called on the
 * reservoir -- `outliersFromSorted` is the same function the in-memory path uses,
 * so a streamed fence and a computed fence cannot mean two different things.
 *
 * The cells are unchanged in KIND: a blank is still counted as empty before it is
 * ever offered to `Number()` (because `Number("")` is 0, and a blank would become
 * a measurement of unmeasured work), and an unparseable cell is still DIRTY rather
 * than dropped. Only the extent of the arithmetic changed.
 */
function streamedNumericStat(
  column: string,
  shot: StreamColumnSnapshot,
  fences: FenceSummary | undefined,
): NumericColumnStat {
  const f = fences ?? fencesFromQuartiles(shot.q1, shot.q3);
  const shape = {
    column,
    measured: shot.measured,
    missing: shot.empty + shot.dirty,
    empty: shot.empty,
    dirty: shot.dirty,
    dirtyExamples: [...shot.dirtyExamples],
    outliers: f.outliers,
    outlierMin: f.low,
    outlierMax: f.high,
    fenceLower: f.lower,
    fenceUpper: f.upper,
    extremeOutliers: f.extreme,
    fenceExtremeLower: f.extremeLower,
    fenceExtremeUpper: f.extremeUpper,
    method: (f.lower === null ? null : "IQR") as "IQR" | null,
    // STATED, NOT SMOOTHED OVER. Absent whenever the reservoir held the column
    // whole, which is every column under 4096 values.
    ...(shot.exact ? {} : { quantilesSampled: true }),
  };
  if (shot.measured === 0) return { ...shape, min: null, max: null, mean: null, spread: null, histogram: [] };
  const min = shot.min ?? 0;
  const max = shot.max ?? 0;
  // The buckets come from the reservoir while the RANGE comes from the whole
  // column, so a chart spanning the real min and max is drawn from a sample of
  // the values inside it. `query.ts` refuses to present a bucket as a point
  // value, so the honesty requirement is already carried downstream.
  return { ...shape, min, max, mean: shot.mean ?? 0, spread: max - min, histogram: bucketOf(shot.sample, min, max) };
}

/**
 * TURN THE PER-COLUMN STATS INTO A VERDICT.
 *
 * Called with the FULL list, before the ten-column display cap, which is the
 * whole point: health is not scoped to what the report chose to show.
 */
function dataHealth(all: readonly NumericColumnStat[]): DataHealth {
  const columns = all
    .filter((c) => c.dirty > 0 || c.empty > 0 || c.outliers > 0)
    .map((c): ColumnHealth => ({
      column: c.column,
      dirty: c.dirty,
      empty: c.empty,
      outliers: c.extremeOutliers,
      marginalOutliers: c.outliers,
      worstValue: c.outlierMax ?? c.outlierMin,
      fence: c.outlierMax !== null ? c.fenceUpper : c.outlierMin !== null ? c.fenceLower : null,
      examples: c.dirtyExamples,
    }))
    // Worst first: type mismatches above blank cells above outliers is NOT the
    // order, because a broken producer outranks a null, and an absurd value
    // outranks both. Sorting by severity keeps the top of the list actionable.
    .sort((a, b) => b.dirty - a.dirty || b.outliers - a.outliers || a.column.localeCompare(b.column));
  return {
    columns,
    dirtyColumns: columns.filter((c) => c.dirty > 0).length,
    outlierColumns: columns.filter((c) => c.outliers > 0).length,
    dirtyCells: columns.reduce((s, c) => s + c.dirty, 0),
    emptyCells: columns.reduce((s, c) => s + c.empty, 0),
    outlierCells: columns.reduce((s, c) => s + c.outliers, 0),
    clean: columns.length === 0,
  };
}

/** Hours below this cannot support a ratio test. See `hourlyProfile`. */
const MIN_HOUR_BUCKETS = 4;

/**
 * A bucket must exceed this multiple of the hourly mean to be flagged.
 *
 * NOT 2-SIGMA, and the reason is worth keeping. A z-score test assumes the
 * statistic is compared against a stable distribution, but a single spike
 * INFLATES the standard deviation of the very distribution it is being tested
 * against: for 5, 4, 6, 5, 80, 5 the mean is 17.5 and sigma is 28.6, so
 * mean + 2sigma is 74.7 and the spike at 80 clears it by five. On a shorter
 * window it cannot clear its own tail at all -- with 10, 20, 70 the threshold
 * is 85.9 and the spike is NOT flagged. A test that stops working at exactly the
 * sample sizes real exports have is worse than no test, because it reports a
 * clean bill of health. The ratio has no such failure mode. Sigma is still
 * computed and reported, as context.
 */
const SPIKE_MULTIPLE = 2;

/**
 * MEASURE THE SHAPE OF THE DAY.
 *
 * The mean divides by the buckets OBSERVED, not by 24 and not by the whole
 * timestamp span. A six-hour export divided by 24 says every hour is quiet,
 * which is true of the wrong denominator; and dividing by the span would let a
 * file with a gap in the middle quietly lower its own baseline.
 *
 * `insufficient` exists so that silence is never mistaken for normality. With
 * two hours, 30 then 70, the ratio test calls 70 a spike against a mean of 50 --
 * which is arithmetic, not evidence. Below the floor nothing is flagged and the
 * report says the window was too short to judge, because a table that simply
 * omits a column reads as "nothing to see here".
 */
function hourlyProfile(hours: Map<string, RankedGroup>): HourlyProfile {
  const entries = [...hours.entries()].sort(([a], [b]) => a.localeCompare(b));
  // THE COUNT, not the citations. See `RankedGroup`: a timeline that summed its
  // citation arrays would report the busiest hour as 200 and every other hour as
  // fewer, which is a chart of the sampling policy rather than of the file.
  const counts = entries.map(([, v]) => v.count);
  const countedRows = counts.reduce((s, n) => s + n, 0);
  const buckets = counts.length;
  const meanPerHour = buckets === 0 ? 0 : countedRows / buckets;
  const variance = buckets === 0 ? 0 : counts.reduce((s, n) => s + (n - meanPerHour) ** 2, 0) / buckets;
  const insufficient = buckets < MIN_HOUR_BUCKETS;

  const hours2 = entries.map(([key, v]): HourStat => {
    const count = v.count;
    const multiple = meanPerHour > 0 ? count / meanPerHour : null;
    const isSpike = !insufficient && multiple !== null && multiple > SPIKE_MULTIPLE;
    return {
      key,
      count,
      share: countedRows === 0 ? 0 : count / countedRows,
      multiple,
      isSpike,
      rule: isSpike && multiple !== null ? `${multiple.toFixed(1)}x the hourly average` : null,
    };
  });

  return {
    hours: hours2,
    countedRows,
    buckets,
    meanPerHour,
    sigma: Math.sqrt(variance),
    spikeMultiple: SPIKE_MULTIPLE,
    flagged: hours2.filter((h) => h.isSpike).length,
    insufficient,
  };
}

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
  const aliasCol = chosen.alias;

  const sources = new Map<string, RankedGroup>();
  const signatures = new Map<string, RankedGroup>();
  const hours = new Map<string, RankedGroup>();
  const unreadable: number[] = [];
  const bands: { limit: number; label: string; rows: number[]; count: number }[] = [
    { limit: 50, label: "<50ms", rows: [], count: 0 },
    { limit: 200, label: "50-200ms", rows: [], count: 0 },
    { limit: 1000, label: "200ms-1s", rows: [], count: 0 },
    { limit: Infinity, label: ">1s", rows: [], count: 0 },
  ];

  let errorRows = 0;

  const categories = new Map<string, { count: number; elapsed: number | null; breach: number; rows: number[]; loggers: Set<string>; durations: number[] }>();

  /**
   * HOW MANY DISTINCT CATEGORY KEYS ARE TRACKED.
   *
   * The rankings are Maps, and a Map grows with the number of DISTINCT VALUES --
   * so a `category` column holding a million different strings would hold a
   * million entries, which is the memory wall again wearing a different hat.
   *
   * 256 is not a tight budget, it is a generous one: it is exact for every real
   * categorical column this product meets (`alertType`, `channel`, `region`,
   * `status` -- dozens, not hundreds). Past it the rarest key is dropped and the
   * analysis records that it did, because a ranking that quietly omits a key is
   * the silent-partial-answer bug this codebase has paid for twice.
   */
  const MAX_CATEGORY_KEYS = 256;
  let droppedCategoryKeys = 0;
  const boundCategories = (): void => {
    if (categories.size <= MAX_CATEGORY_KEYS) return;
    let smallestKey = "";
    let smallest = Number.POSITIVE_INFINITY;
    for (const [key, value] of categories) {
      if (value.count < smallest) {
        smallest = value.count;
        smallestKey = key;
      }
    }
    categories.delete(smallestKey);
    droppedCategoryKeys += 1;
  };

  let naiveTimestamps = 0;
  let timestampRows = 0;
  const NAIVE_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;
  // A zone suffix makes the instant unambiguous. Without this check the shape
  // regex matches the PREFIX of a Z-suffixed timestamp and reports a UTC instant
  // as host-relative, which is the opposite error and just as misleading.
  const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/;

  /**
   * ONE ROW, INTO EVERY ACCUMULATOR. The single implementation both drivers use.
   *
   * The in-memory driver and the streaming driver differ ONLY in where the row
   * came from. Everything that decides what a row MEANS -- whether it is an
   * error, which hour it belongs to, whether its duration breached the threshold
   * -- is written once, here, so a 500,000-row file and a 400-row file cannot
   * reach different conclusions about the same row.
   *
   * It takes a GETTER rather than an object for a reason that only shows up at
   * scale: building a `Record<string, string>` for half a million rows would
   * allocate half a million short-lived objects, which is precisely the GC churn
   * the streaming rewrite exists to avoid. A closure over a cell array allocates
   * once per row and nothing that survives it.
   */
  const takeRow = (get: (column: string) => string, rowNumber: number): void => {
    const status = statusCol === undefined ? "" : get(statusCol);
    const error = statusCol === undefined ? false : isError(status);
    if (error) errorRows += 1;

    if (sourceCol !== undefined) bucket(sources, get(sourceCol) || "(none)", error, rowNumber);

    if (rawCol !== undefined && error) {
      const signature = errorSignature(get(rawCol));
      if (signature !== undefined) bucket(signatures, signature, true, rowNumber);
    }

    if (timeCol !== undefined) {
      const raw = get(timeCol);
      timestampRows += 1;
      if (NAIVE_TIME.test(raw.trim()) && !HAS_ZONE.test(raw.trim())) naiveTimestamps += 1;
      const instant = parseInstant(raw);
      if (instant === undefined) {
        if (unreadable.length < MAX_CITATIONS) unreadable.push(rowNumber);
      } else {
        const hour = new Date(instant).toISOString().slice(0, 13);
        bucket(hours, hour, error, rowNumber);
      }
    }

    if (latencyCol !== undefined) {
      const duration = Number(get(latencyCol));
      if (Number.isFinite(duration)) {
        for (const band of bands) {
          if (duration < band.limit) {
            band.count += 1;
            if (band.rows.length < MAX_CITATIONS) band.rows.push(rowNumber);
            break;
          }
        }
      }
    }

    // Categories: counted by frequency, and independently accumulated by elapsed
    // time, because the two orderings routinely disagree and the owner's
    // question asks for both.
    if (categoryCol !== undefined) {
      const key = get(categoryCol) || "(none)";
      const entry = categories.get(key) ?? { count: 0, elapsed: latencyCol === undefined ? null : 0, breach: 0, rows: [], loggers: new Set<string>(), durations: [] };
      // A BLANK IS NOT A ZERO. `Number("")` is 0 and `Number(" ")` is 0, so the
      // obvious parse silently invents a measurement: a row with no duration was
      // being counted as a row that took 0 ms, which drags the mean down and
      // quietly asserts the work was free. An unparseable cell is therefore NOT
      // MEASURED, and it is excluded from the total and from all three measures
      // alike -- one branch, so the four can never disagree about the sample.
      const raw = latencyCol === undefined ? "" : get(latencyCol).trim();
      const rawDuration = raw.length === 0 ? Number.NaN : Number(raw);
      // One branch, so the total and the three measures can never disagree about
      // which rows were measured. A blank or non-numeric duration is skipped
      // entirely rather than folded in as a zero.
      if (entry.elapsed !== null && Number.isFinite(rawDuration)) {
        entry.elapsed += rawDuration;
        // DURATIONS ARE SAMPLED, the total is not. The mean and the median are
        // computed from a bounded window so a category with 400,000 rows cannot
        // hold 400,000 numbers, while `elapsed` stays exact over every row.
        if (entry.durations.length < MAX_DURATIONS_PER_KEY) entry.durations.push(rawDuration);
      }
      if (thresholdCol !== undefined && Number.isFinite(rawDuration)
        && Number(get(thresholdCol)) < rawDuration) {
        entry.breach += 1;
      }
      entry.count += 1;
      if (entry.rows.length < MAX_CITATIONS) entry.rows.push(rowNumber);
      if (aliasCol !== undefined) {
        const logger = get(aliasCol).trim();
        if (logger.length > 0 && entry.loggers.size < MAX_LOGGERS_PER_KEY) entry.loggers.add(logger);
      }
      categories.set(key, entry);
    }
    // The distinct-key budget, enforced per row rather than in a final sweep, so
    // the Map never exceeds its cap even transiently.
    boundCategories();
  };

  // === THE TWO DRIVERS, AND WHY THE SECOND ONE EXISTS ===
  //
  // When the retained window holds the whole file -- which is every file under
  // 10,000 rows, and every file anybody opens in a browser -- the rows are
  // already in memory and are read from there. Nothing changes for them.
  //
  // When it does not, the same `takeRow` is driven by a SECOND STREAMING PASS
  // over the file. That is the whole of the fix: the rankings and the timeline
  // now describe every row instead of the first ten thousand, and they do it
  // through the identical per-row logic rather than a parallel implementation
  // that would agree until somebody edited one.
  //
  // The pass costs I/O and no memory. Every accumulator it feeds is bounded --
  // citations capped, durations capped, distinct keys capped -- so a 500,000-row
  // file costs the same footprint as a 50,000-row one.
  const windowIsWholeFile = csv.rows.length >= (csv.profile?.rowCount ?? csv.rows.length);
  let categorisedRows = csv.rows.length;
  if (windowIsWholeFile) {
    csv.rows.forEach((row, index) => {
      // +2: body rows start after the header, and the row numbers a reader sees
      // are file line numbers. Getting this wrong would cite the wrong evidence.
      takeRow((column) => String(row[column] ?? ""), index + 2);
    });
  } else {
    // The column positions, resolved ONCE rather than per row: a Map lookup per
    // column beats an indexOf scan per column, and this runs half a million times.
    const position = new Map(csv.headers.map((header, index) => [header, index]));
    let seenHeader = false;
    streamCsvRecordsSync(csv.path, (cells, line) => {
      if (!seenHeader) {
        seenHeader = true;
        return;
      }
      takeRow((column) => {
        const index = position.get(column);
        return index === undefined ? "" : cells[index] ?? "";
      }, line);
    });
    categorisedRows = csv.profile?.rowCount ?? csv.rows.length;
  }

  // `rows`, NEVER `sample`. The sample is capped for charting; analysing it
  // would report a confident answer about a fraction of the export, with
  // nothing on the page to say so. A real 101-row export was half-analysed this
  // way before a red test caught it.
  // R13. An alias is only printed when the mapping is unambiguous in BOTH
  // directions. One logger serving several codes is a coincidence, and
  // labelling the majority of its rows with it would be wrong for them.
  const aliasOf = new Map<string, string>();
  const ambiguousAliases: string[] = [];
  for (const [key, v] of categories) {
    if (v.loggers.size !== 1) continue;
    const logger = [...v.loggers][0];
    const sharedWith = [...categories.entries()].filter(([, o]) => o.loggers.has(logger));
    if (sharedWith.length === 1) aliasOf.set(key, logger);
    else ambiguousAliases.push(logger);
  }

  const categoryStats: CategoryStat[] = [...categories.entries()].map(([key, v]) => {
    const stats = durationStats(v.durations);
    return {
      key,
      label: categoryLabel(key, aliasOf.get(key)),
      count: v.count,
      totalElapsed: v.elapsed,
      meanElapsed: stats.mean,
      medianElapsed: stats.median,
      p95Elapsed: stats.p95,
      breachCount: v.breach,
      rows: [...v.rows].sort((a, b) => a - b),
    };
  });
  const byFrequency = [...categoryStats].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const byElapsed = [...categoryStats].sort(
    (a, b) => (b.totalElapsed ?? -1) - (a.totalElapsed ?? -1) || b.count - a.count,
  );

  // A required role with no credible column is NAMED. An empty table reads as
  // "nothing recurred", which is the opposite of "this file cannot say".
  const missing = (["category", "time", "source", "message", "duration"] as const)
    .filter((role) => chosen[role] === undefined)
    .map((role) => (role === "message" ? "message" : role));

  const divergence = byFrequency[0] !== undefined && byElapsed[0] !== undefined
    && byFrequency[0].key !== byElapsed[0].key
    ? {
      byFrequency: byFrequency[0],
      byElapsed: byElapsed[0],
      totalRatio: byFrequency[0].totalElapsed && byElapsed[0].totalElapsed
        ? byElapsed[0].totalElapsed / byFrequency[0].totalElapsed : null,
      alertRatio: byFrequency[0].count === 0 ? null : byElapsed[0].count / byFrequency[0].count,
    }
    : null;

  const numeric = numericalProfile(csv);
  // THE ROWS THE RANKINGS ACTUALLY COVER. Not `csv.rows.length`: that is the
  // retained window, and on a file larger than it the window is a fraction of the
  // file. A product that claims 500,000 rows and then ranks ten thousand of them
  // is describing a different export from the one the user opened.
  const total = categorisedRows;

  // THE SCOPE, PUBLISHED. See `RankingScope`: the caps that make a whole-file
  // ranking affordable are only honest if the answer says when they were reached.
  const rankingScope: RankingScope = {
    rowsRanked: total,
    fileRows: csv.profile?.rowCount ?? csv.rows.length,
    viaStreamingPass: !windowIsWholeFile,
    categoryKeysTracked: categories.size,
    droppedCategoryKeys,
    categoryKeyBudget: MAX_CATEGORY_KEYS,
  };
  // PEGA VOCABULARY IS EARNED, NEVER DEFAULTED. "Alert" and "threshold" appear
  // only when a mapping a PERSON checked is actually being applied. Three states
  // exist and only two were ever legitimate:
  //
  //   DEFAULT -- the shipped Pega schema, verified against a real export. The
  //     domain is established, so the wording is supported.
  //   GENERIC -- inferred from column values, always a hypothesis.
  //   undefined -- NOTHING WAS ESTABLISHED. This is the state that used to
  //     claim alerts by default, and it was the worst of the three: absence of
  //     evidence was being rendered as positive knowledge. A file shaped like a
  //     Pega export is not a verified Pega export, and 20 anonymous numeric
  //     columns described as an alert ranking is a sentence with no referent.
  //
  // SESSION_ARCHIVE IS NOT ENOUGH, and this changed once interactive corrections
  // arrived. It used to sit alongside DEFAULT, on the argument that a user
  // correcting a mapping is a person checking it. That is true of the ROLE and
  // silent about the DOMAIN: the correction loop lets somebody point the
  // duration role at a column called amount in a sales CSV, and an archive entry
  // then exists for a file with no alerts in it. A mapping somebody checked is
  // still a mapping ABOUT SOMETHING, and only the shipped Pega schema says what.
  // So the archive earns established MAPPINGS, not Pega NOUNS.
  //
  // The threshold label follows from the SAME condition rather than from the
  // column being named "threshold". A guessed column is still a guess, so an
  // unverified file gets the neutral "over limit" and only a verified one gets
  // "over threshold".
  const schemaVerified = schema?.source === "DEFAULT";
  const generic = !schemaVerified;
  const statesThreshold = thresholdCol !== undefined && csv.headers.includes(thresholdCol);
  const vocabulary: ReportVocabulary = schemaVerified
    ? { unit: "alert", unitPlural: "alert(s)", headingUnit: "Alert", thresholdLabel: statesThreshold ? "over threshold" : null }
    : { unit: "record", unitPlural: "record(s)", headingUnit: "Record", thresholdLabel: statesThreshold ? "over limit" : null };
  return {
    totalRows: total,
    /**
     * WHAT THIS FILE IS, before any statistic about it.
     *
     * Computed from the headers and a bounded sample, so it costs the same on a
     * million rows as on three, and it is available to everything downstream
     * that has to SAY SOMETHING about the file -- the greeting, the report
     * title, the headings. See semantics.ts for why it is a hypothesis with
     * evidence attached rather than a bare label.
     */
    purpose: describePurpose({ headers: csv.headers, rows: csv.rows }),
    errorRows,
    errorRate: total === 0 ? 0 : errorRows / total,
    bySource: rank(sources),
    rankingScope,
    recurring: rank(signatures),
    byHour: rank(hours),
    hourly: hourlyProfile(hours),
    numerical: numeric.numerical,
    health: numeric.health,
    latency: bands.filter((b) => b.count > 0).map((b) => ({ label: b.label, count: b.count, rows: b.rows })),
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
    durationUnit: OWNER_RULINGS.durationUnit,
    durationUnitIsRuled: true,
    timeZoneIsRuled: true,
    ambiguousAliases: [...new Set(ambiguousAliases)],
    divergence,
    vocabulary,
  };
}