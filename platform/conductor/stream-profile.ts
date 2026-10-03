import { createReadStream } from "node:fs";
import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/**
 * STREAMING PROFILING. The memory wall, and the arithmetic that goes through it.
 *
 * === WHY THIS FILE EXISTS, AND THE NUMBER THAT PROVES IT ===
 *
 * `csvRead` used to do `readFile(path, "utf8")`. Every byte of the export became
 * one JS string BEFORE a single row was parsed -- a 500,000-row CSV is roughly
 * 60 MB on disk and a 60 MB UTF-16 STRING in memory, so the reader's own
 * footprint grew with the file whether or not the analysis needed the rows. Then
 * the parse built an array of arrays, and `rows` built an array of objects, and
 * the analyser held a `number[]` per numeric column and SORTED it to find its
 * quartiles. Four copies of the dataset, the last two of them per column.
 *
 * That is the wall, and it is not a slow wall. It is the point at which the
 * process is OOM-killed on an enterprise export, and the point at which every
 * keystroke of a report takes long enough that the GC pauses become the
 * product's dominant behaviour. The fix is not "be faster"; it is to stop
 * holding what does not need holding.
 *
 * === WHAT IS STREAMED, AND WHAT IS BOUNDED, AND WHY IT IS NOT A TRADEOFF ===
 *
 * The file is read as CHUNKS and consumed as RECORDS. No stage ever holds more
 * than one record, and every statistic is an ACCUMULATOR whose size is fixed at
 * construction:
 *
 *   - min, max, sum, count, and the three-way empty/dirty/numeric split are
 *     O(1) per column and EXACT over every row, forever.
 *   - quartiles come from a RESERVOIR (Algorithm R) of 4096 values per column.
 *     Uniform sampling with a fixed seed, so the answer is reproducible and a
 *     report does not change between two runs of the same file. While a column
 *     holds 4096 values or fewer the reservoir IS the column, and the quartiles
 *     are exact -- which is why every small-file answer this repository asserts
 *     on is unchanged.
 *   - the top categories come from SPACE-SAVING, a bounded heavy-hitter
 *     counter whose error is at most one per eviction, rather than from a Map
 *     that grows with the number of distinct values in the column.
 *   - the MAD the anomaly agent needs is the median of the absolute deviations,
 *     taken from the same reservoir, so it costs nothing beyond what is already
 *     kept.
 *
 * So the memory ceiling is (columns x 4096 numbers) REGARDLESS OF ROW COUNT, and
 * a column's statistics get BETTER as the file grows rather than merely
 * survivable. The one honest cost: on a column with more than 4096 measured
 * values, the quartiles are an estimate. Every snapshot therefore carries
 * `exact`, and the analysis records which it used, because a threshold computed
 * from a sample and presented as a measurement is the silent-partial-answer bug
 * this codebase has already paid for twice.
 *
 * === WHY NOT readline ===
 *
 * `readline` splits on newlines and cannot know that a newline inside a quoted
 * field is not a record boundary. The real Pega export in `data/` contains
 * `"2026-09-30 11:15:22,000"` -- a quoted field with an embedded comma, and the
 * shape a quoted multi-line description takes -- so a line-splitting reader
 * reports that file as ragged, which is the one thing a reader must never do to
 * a file it has not understood. So this is a byte-level state machine fed by the
 * stream, and the only thing it ever holds is the record it is currently
 * building.
 */

/**
 * HOW MANY VALUES PER COLUMN ARE KEPT FOR QUANTILES.
 *
 * 4096 is chosen so that a column of ordinary enterprise width is kept WHOLE:
 * the fixtures, the 200-row profiler sample and any file a person actually opens
 * in a browser are exact, and only a genuinely large export reaches the
 * approximation path. At 8 bytes per double that is 32 KB per numeric column,
 * against the megabytes a full column costs today.
 */
export const RESERVOIR_SIZE = 4096;

/**
 * THE CAP ON REPORTED PROBLEMS.
 *
 * A file that is ragged on every one of 500,000 rows must not produce 500,000
 * strings, each with its own row number, held in memory and then serialised into
 * a report. The count keeps rising; the list stops. The same bound as the dirty
 * examples, for the same reason.
 */
export const MAX_PROBLEMS = 50;

/** The heavy-hitter budget: how many distinct category keys are tracked at once. */
export const HEAVY_HITTERS = 256;

/**
 * A DETERMINISTIC RANDOM SOURCE.
 *
 * `Math.random` would make every report non-reproducible: the same file would
 * produce slightly different fences on two runs, and a diff between two reports
 * of one export would show changes nobody made. This is mulberry32, seeded from
 * a constant, so the sample is fixed for the life of the process.
 */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * ALGORITHM R: a fixed-size uniform sample of an unbounded stream.
 *
 * Every element is given an equal chance of being in the sample regardless of
 * when it arrived, which is the property a quantile estimate needs and the one
 * a "keep the first 4096 rows" cap cannot offer: a file sorted by value would
 * return 4096 identical numbers and report a zero-width distribution with no
 * outliers, which is exactly backwards.
 */
export class Reservoir {
  private readonly items: number[] = [];
  private seen = 0;
  private readonly capacity: number;
  private readonly random: () => number;

  // NOT a parameter property, and that is a deliberate constraint rather than a
  // style choice: this repository runs on Node's strip-only type erasure, which
  // cannot erase a constructor parameter property. A `private readonly x` in the
  // parameter list compiles and then fails to LOAD, which is the worst possible
  // failure mode -- a green typecheck and a suite that cannot start.
  constructor(capacity: number, random: () => number = seededRandom(0x5eed)) {
    if (capacity < 1) throw new Error("a reservoir needs room for at least one value");
    this.capacity = capacity;
    this.random = random;
  }

  /** Values offered so far -- NOT the sample size. */
  get observed(): number {
    return this.seen;
  }

  /** True while the sample still holds EVERY value, so quantiles are exact. */
  get exact(): boolean {
    return this.seen <= this.capacity;
  }

  add(value: number): void {
    this.seen += 1;
    if (this.items.length < this.capacity) {
      this.items.push(value);
      return;
    }
    const candidate = Math.floor(this.random() * this.seen);
    if (candidate < this.capacity) this.items[candidate] = value;
  }

  /** The sample, sorted. The caller's copy; the reservoir keeps its own order. */
  sorted(): number[] {
    return [...this.items].sort((a, b) => a - b);
  }
}

/**
 * SPACE-SAVING: the top keys of an unbounded stream, in bounded memory.
 *
 * A `Map<string, number>` over a `category` column is not a memory problem in a
 * fixture and is a memory problem in production: a file with a million distinct
 * logger names, or a column holding free text, holds a million map entries and
 * a million strings for the privilege of reporting the top ten. This keeps K
 * counters and, when a key arrives that is not among them, replaces the
 * smallest -- so every reported count over-counts by at most one, which is the
 * standard guarantee and is a bound rather than a hope.
 */
export class HeavyHitters {
  private readonly counts = new Map<string, number>();
  private readonly capacity: number;

  constructor(capacity: number = HEAVY_HITTERS) {
    this.capacity = capacity;
  }

  add(key: string): void {
    const known = this.counts.get(key);
    if (known !== undefined) {
      this.counts.set(key, known + 1);
      return;
    }
    if (this.counts.size < this.capacity) {
      this.counts.set(key, 1);
      return;
    }
    let smallestKey = "";
    let smallest = Number.POSITIVE_INFINITY;
    for (const [key2, count] of this.counts) {
      if (count < smallest) {
        smallest = count;
        smallestKey = key2;
      }
    }
    this.counts.delete(smallestKey);
    this.counts.set(key, smallest + 1);
  }

  get size(): number {
    return this.counts.size;
  }

  /**
   * The tracked keys, most frequent first, name breaking ties so two runs of one
   * file produce byte-identical output.
   */
  top(limit: number): { key: string; count: number }[] {
    return [...this.counts]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
      .slice(0, limit);
  }
}

/**
 * The p-th percentile by linear interpolation between closest ranks (type 7).
 *
 * THE SAME ARITHMETIC the analyser already used, moved here so the streaming path
 * and the in-memory path cannot disagree about what "the p95" means. A fence
 * computed two ways is a fence a reader cannot check.
 */
export function percentileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * A fence summary. The same eight numbers the analyser has always reported, so
 * the streamed path and the in-memory path are the SAME code rather than two
 * implementations that agree until somebody edits one.
 */
/** Line numbers kept per key. A convenience, so a sample is the honest budget. */
export const MAX_CITATIONS = 200;

/** Durations kept per key, for the median and the p95. */
export const MAX_DURATIONS = 2048;

/** Distinct aliases kept per key. */
export const MAX_LOGGERS = 64;

/** Distinct hourly buckets kept before the timeline starts dropping hours. */
export const MAX_HOUR_KEYS = 20_000;

/**
 * A KEY, with everything the report needs about it, in bounded memory.
 *
 * Citations and durations are the two things that made a full-file ranking
 * impossible: every row used to push its line number into its category's `rows`
 * array and its duration into `durations`, so a category with 400,000 rows held
 * 400,000 line numbers -- and the report cites them. So both are now SAMPLED,
 * while the COUNT beside them stays exact and unbounded.
 *
 * That distinction is the whole trick. "How many rows are in this category" must
 * be a measurement; "which lines should I look at" is a convenience, and a
 * convenience that costs a million array slots is not one worth keeping.
 */
export interface KeyedAggregate {
  readonly key: string;
  /** EXACT, over every row the stream saw. */
  readonly count: number;
  readonly errors: number;
  /** The total of the measured durations. Exact. */
  readonly sum: number;
  /** Durations, capped, for the median and the p95. */
  readonly durations: readonly number[];
  /** Line numbers, capped, for the report's citations. */
  readonly rows: readonly number[];
  /** Distinct aliases, capped. */
  readonly loggers: readonly string[];
  /** How many rows exceeded the threshold, when one was supplied. */
  readonly breaches: number;
}

/**
 * SPACE-SAVING WITH A PAYLOAD, keyed by a string.
 *
 * `HeavyHitters` above tracks counts, which is all the reader needs. The analyser
 * needs counts AND errors AND elapsed time AND citations per key, and needs them
 * while streaming. So this carries the payload in the same bounded table: K keys,
 * each holding a fixed budget of numbers and line references.
 *
 * THE ACCURACY CLAIM, stated because it is not free. While the file has K or
 * fewer distinct keys every count here is EXACT -- which is every real categorical
 * column: `alertType`, `channel`, `region`, `status`. Beyond K the eviction is
 * Space-Saving's: a key arriving when the table is full takes the slot of the
 * smallest counter and starts from that counter's value, so a reported count
 * over-counts by at most the number of evictions. `approximate` says which regime
 * the numbers are in, and it is published to the report rather than left for the
 * reader to guess.
 */
export class KeyedAggregator {
  private readonly keys: Map<string, {
    count: number;
    errors: number;
    sum: number;
    breaches: number;
    durations: number[];
    rows: number[];
    loggers: Set<string>;
  }> = new Map();
  private evicted = false;
  private readonly capacity: number;
  private readonly citationCap: number;
  private readonly durationCap: number;
  private readonly loggerCap: number;

  constructor(options: {
    readonly capacity?: number;
    readonly citations?: number;
    readonly durations?: number;
    readonly loggers?: number;
  } = {}) {
    this.capacity = options.capacity ?? HEAVY_HITTERS;
    this.citationCap = options.citations ?? MAX_CITATIONS;
    this.durationCap = options.durations ?? MAX_DURATIONS;
    this.loggerCap = options.loggers ?? MAX_LOGGERS;
  }

  /** True once a key has been evicted, so the counts are Space-Saving estimates. */
  get approximate(): boolean {
    return this.evicted;
  }

  get size(): number {
    return this.keys.size;
  }

  add(key: string, options: {
    readonly row?: number;
    readonly duration?: number | null;
    readonly isError?: boolean;
    readonly breach?: boolean;
    readonly logger?: string | null;
  } = {}): void {
    let entry = this.keys.get(key);
    if (entry === undefined) {
      if (this.keys.size >= this.capacity) {
        // Evict the smallest counter and INHERIT its value, which is what makes a
        // reported count an over-estimate bounded by the evictions rather than an
        // under-estimate that silently loses rows.
        let smallestKey = "";
        let smallest = Number.POSITIVE_INFINITY;
        for (const [k, v] of this.keys) {
          if (v.count < smallest) {
            smallest = v.count;
            smallestKey = k;
          }
        }
        const victim = this.keys.get(smallestKey);
        this.keys.delete(smallestKey);
        entry = {
          count: victim?.count ?? 0,
          errors: victim?.errors ?? 0,
          sum: victim?.sum ?? 0,
          breaches: victim?.breaches ?? 0,
          durations: [],
          rows: [],
          loggers: new Set<string>(),
        };
        this.evicted = true;
      }
      entry = { count: 0, errors: 0, sum: 0, breaches: 0, durations: [], rows: [], loggers: new Set<string>() };
      this.keys.set(key, entry);
    }
    entry.count += 1;
    if (options.isError === true) entry.errors += 1;
    if (options.breach === true) entry.breaches += 1;
    if (typeof options.duration === "number" && Number.isFinite(options.duration)) {
      entry.sum += options.duration;
      if (entry.durations.length < this.durationCap) entry.durations.push(options.duration);
    }
    if (typeof options.row === "number" && entry.rows.length < this.citationCap) entry.rows.push(options.row);
    const logger = options.logger;
    if (typeof logger === "string" && logger.length > 0 && entry.loggers.size < this.loggerCap) {
      entry.loggers.add(logger);
    }
  }

  entries(): KeyedAggregate[] {
    return [...this.keys.entries()]
      .map(([key, v]) => ({
        key,
        count: v.count,
        errors: v.errors,
        sum: v.sum,
        breaches: v.breaches,
        durations: [...v.durations].sort((a, b) => a - b),
        rows: [...v.rows].sort((a, b) => a - b),
        loggers: [...v.loggers],
      }));
  }

  /** The aliases of one key, for the ambiguity check. Empty when it was evicted. */
  loggersOf(key: string): readonly string[] {
    const entry = this.keys.get(key);
    return entry === undefined ? [] : [...entry.loggers];
  }
}

/**
 * A KEYED HOUR COUNTER, which is deliberately NOT Space-Saving.
 *
 * Space-Saving keeps the busiest K keys, which is right for a ranking of
 * categories and catastrophic for a TIMELINE: dropping an hour from the middle of
 * a day leaves a hole in the chart and makes the spike test compare a real bucket
 * against a mean computed without it. So every hour is kept, up to a cap high
 * enough to cover years (20,000 hours is about 2.3 years) and each one costs ONE
 * number.
 */
export class HourlyCounter {
  private readonly counts = new Map<string, { count: number; errors: number; rows: number[] }>();
  private overflowed = 0;
  private readonly keyCap: number;
  private readonly citationCap: number;

  constructor(options: { readonly keys?: number; readonly citations?: number } = {}) {
    this.keyCap = options.keys ?? MAX_HOUR_KEYS;
    this.citationCap = options.citations ?? MAX_CITATIONS;
  }

  add(hour: string, isError: boolean, row: number): void {
    let entry = this.counts.get(hour);
    if (entry === undefined) {
      // Past the cap the extra hours are COUNTED but not kept, and the analysis is
      // told the timeline was truncated rather than being handed a chart with
      // silent holes in it.
      if (this.counts.size >= this.keyCap) {
        this.overflowed += 1;
        return;
      }
      entry = { count: 0, errors: 0, rows: [] };
      this.counts.set(hour, entry);
    }
    entry.count += 1;
    if (isError) entry.errors += 1;
    if (entry.rows.length < this.citationCap) entry.rows.push(row);
  }

  /** Hours past the cap: counted, not charted. Zero unless the file spans years. */
  get dropped(): number {
    return this.overflowed;
  }

  entries(): { hour: string; count: number; errors: number; rows: readonly number[] }[] {
    return [...this.counts.entries()].map(([hour, v]) => ({ hour, ...v, rows: [...v.rows] }));
  }
}

/**
 * A fence summary. The same eight numbers the analyser has always reported, so
 * the streamed path and the in-memory path are the SAME code rather than two
 * implementations that agree until somebody edits one.
 */
export interface FenceSummary {
  readonly outliers: number;
  readonly low: number | null;
  readonly high: number | null;
  readonly lower: number | null;
  readonly upper: number | null;
  readonly extreme: number;
  readonly extremeLower: number | null;
  readonly extremeUpper: number | null;
}

/** Below this many values a column is not judged for outliers at all. */
export const MIN_OUTLIER_SAMPLES = 8;

/** The 1.5x inner fence. */
export const OUTLIER_IQR_FACTOR = 1.5;

/** The 3x outer fence: the actionable ones. */
export const EXTREME_IQR_FACTOR = 3;

const NO_FENCES: FenceSummary = {
  outliers: 0, low: null, high: null, lower: null, upper: null,
  extreme: 0, extremeLower: null, extremeUpper: null,
};

/**
 * COUNT VALUES BEYOND THE TUKEY FENCES, over a SORTED sample.
 *
 * IQR RATHER THAN Z-SCORE, because a z-score compares a point against the mean
 * and standard deviation OF THE DISTRIBUTION CONTAINING IT. One absurd value
 * inflates the very sigma it has to clear: a column with 199 values near zero
 * and one at 9,999,999.99 gets sigma around 700,000, so the point reads as about
 * 13 sigma -- detectable only because it is so absurd, while a merely awkward 50
 * against the same column is invisible. Tukey fences are built from the
 * QUARTILES, which one value cannot move.
 *
 * THE CONSTANT COLUMN IS THE DEGENERATE CASE worth naming, because it is the one
 * most likely to produce Infinity or a spurious flag. IQR is then zero, both
 * fences sit on the single value, every value equals them, and nothing is
 * flagged. That is the correct answer and it falls out of the arithmetic rather
 * than than needing a branch.
 *
 * `low` and `high` are the values CLOSEST TO THE COLUMN, not the most extreme
 * ones: the scan runs upwards and overwrites, so they are the largest value
 * below the lower fence and the smallest above the upper. They are the values a
 * user should look at first, which is why the ordering is deliberate.
 *
 * THE CALLER OWNS THE ACCURACY CLAIM. Given a reservoir rather than the column,
 * this returns a correct count OF THE RESERVOIR; whether that is the column is
 * `snapshot.exact`, and the analysis says which it used rather than presenting an
 * estimate as a measurement.
 */
export function outliersFromSorted(sorted: readonly number[]): FenceSummary {
  if (sorted.length < MIN_OUTLIER_SAMPLES) return NO_FENCES;
  const q1 = percentileSorted(sorted, 25);
  const q3 = percentileSorted(sorted, 75);
  const iqr = q3 - q1;
  const lower = q1 - OUTLIER_IQR_FACTOR * iqr;
  const upper = q3 + OUTLIER_IQR_FACTOR * iqr;
  const extremeLower = q1 - EXTREME_IQR_FACTOR * iqr;
  const extremeUpper = q3 + EXTREME_IQR_FACTOR * iqr;
  let count = 0;
  let extreme = 0;
  let low: number | null = null;
  let high: number | null = null;
  for (const value of sorted) {
    if (value < lower) {
      count += 1;
      low = value;
    } else if (value > upper) {
      count += 1;
      high = value;
    }
    if (value < extremeLower || value > extremeUpper) extreme += 1;
  }
  return { outliers: count, low, high, lower, upper, extreme, extremeLower, extremeUpper };
}

/** The fences alone, from a column's quartiles -- no counting, so no sample claim. */
export function fencesFromQuartiles(q1: number | null, q3: number | null): FenceSummary {
  if (q1 === null || q3 === null) return NO_FENCES;
  const iqr = q3 - q1;
  return {
    outliers: 0, low: null, high: null,
    lower: q1 - OUTLIER_IQR_FACTOR * iqr,
    upper: q3 + OUTLIER_IQR_FACTOR * iqr,
    extreme: 0,
    extremeLower: q1 - EXTREME_IQR_FACTOR * iqr,
    extremeUpper: q3 + EXTREME_IQR_FACTOR * iqr,
  };
}

/**
 * RESOLVE THE OUTLIER COUNTS FOR A WHOLE PROFILE, exactly.
 *
 * For every column the reservoir held whole, the count comes straight out of the
 * sample and is EXACT. For the columns it did not -- a column with more than
 * `RESERVOIR_SIZE` measured values -- the fences are estimated from the sample
 * and then verified by ONE second streaming pass, because an outlier count
 * cannot be accumulated in the pass that produces the fences: a quartile is only
 * known once the column has been seen whole.
 *
 * That second pass costs I/O and no memory, which is the right trade. The
 * alternative is reporting a count estimated from 4096 samples as though it were
 * a measurement of the file, and the user reads "3 bad cells" when there are
 * 37,000 -- which is the silent-partial-answer bug this codebase has already paid
 * for twice.
 */
export async function resolveOutliers(
  file: string,
  profile: StreamProfile,
): Promise<Record<string, FenceSummary & { readonly exact: boolean }>> {
  const out: Record<string, FenceSummary & { readonly exact: boolean }> = {};
  const needsPass: { column: string; lower: number; upper: number; extremeLower: number; extremeUpper: number }[] = [];

  for (const [name, shot] of Object.entries(profile.columns)) {
    if (shot.measured < MIN_OUTLIER_SAMPLES) {
      out[name] = { ...NO_FENCES, exact: true };
      continue;
    }
    if (shot.exact) {
      out[name] = { ...outliersFromSorted(shot.sample), exact: true };
      continue;
    }
    const fences = fencesFromQuartiles(shot.q1, shot.q3);
    out[name] = { ...fences, exact: false };
    needsPass.push({
      column: name,
      lower: fences.lower ?? 0,
      upper: fences.upper ?? 0,
      extremeLower: fences.extremeLower ?? 0,
      extremeUpper: fences.extremeUpper ?? 0,
    });
  }

  if (needsPass.length === 0) return out;
  const counted = await countBeyondFences(file, needsPass);
  for (const fence of needsPass) {
    const hit = counted[fence.column];
    if (hit === undefined) continue;
    out[fence.column] = {
      outliers: hit.outliers,
      low: hit.low,
      high: hit.high,
      lower: fence.lower,
      upper: fence.upper,
      extreme: hit.extreme,
      extremeLower: fence.extremeLower,
      extremeUpper: fence.extremeUpper,
      exact: true,
    };
  }
  return out;
}

/** Called once per complete record, with the cells and the line it started on. */
export type CsvRecordSink = (cells: string[], line: number) => void;

/**
 * THE PARSER, as a state machine with no I/O in it.
 *
 * It exists so that the asynchronous reader and the SYNCHRONOUS one run the same
 * rules. The synchronous driver was added because `analyseBottlenecks` is called
 * synchronously from a dozen places -- the Conductor, the web server, every
 * test -- and turning it async to accommodate a streaming pass would have rippled
 * through all of them. So the reader grew a second driver rather than the
 * analyser growing a second parser, and this class is the proof that there is
 * only one.
 *
 * Feed it decoded text with `write`, then `end`. Records are handed to the sink
 * the moment they complete, so the peak holding is one record plus the chunk
 * being consumed.
 */
export class CsvTokenizer {
  private field = "";
  private row: string[] = [];
  private inQuotes = false;
  private afterQuote = false;
  private line = 1;
  private records = 0;
  private readonly sink: CsvRecordSink;
  private readonly note: (message: string) => void;

  // Not parameter properties: this repository runs on Node's strip-only type
  // erasure, which cannot erase them. A green typecheck and a module that will
  // not load is the worst of both worlds, and it has already cost this codebase
  // one full debug cycle.
  constructor(sink: CsvRecordSink, note: (message: string) => void) {
    this.sink = sink;
    this.note = note;
  }

  /** How many records have been emitted, header included. */
  get count(): number {
    return this.records;
  }

  private emit(atLine: number): void {
    this.row.push(this.field);
    this.field = "";
    const cells = this.row;
    this.row = [];
    this.records += 1;
    this.sink(cells, atLine);
  }

  write(chunk: string): void {
    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i];
      if (this.inQuotes) {
        if (this.afterQuote) {
          this.afterQuote = false;
          // Two quotes in a row are one literal quote inside the field.
          if (ch === '"') {
            this.field += '"';
            continue;
          }
          this.inQuotes = false;
          // and fall through: this character is OUTSIDE the quoted field.
        } else {
          if (ch === '"') {
            this.afterQuote = true;
            continue;
          }
          if (ch === "\n") this.line += 1;
          this.field += ch;
          continue;
        }
      }
      if (ch === '"') {
        if (this.field.length > 0) this.note(`line ${this.line}: a quote appeared mid-field`);
        this.inQuotes = true;
        continue;
      }
      if (ch === ",") {
        this.row.push(this.field);
        this.field = "";
        continue;
      }
      if (ch === "\r") continue;
      if (ch === "\n") {
        // A blank line is not a record. The conventional final newline on a file
        // must not manufacture a row of one empty value against a twelve-column
        // header, which is what a real export once did.
        if (this.row.length > 0 || this.field.length > 0) this.emit(this.line);
        this.row = [];
        this.field = "";
        this.line += 1;
        continue;
      }
      this.field += ch;
    }
  }

  end(): void {
    if (this.inQuotes && !this.afterQuote) this.note("the file ends inside a quoted field");
    if (this.row.length > 0 || this.field.length > 0) this.emit(this.line);
  }
}

/**
 * READ A CSV AS A STREAM OF RECORDS, synchronously.
 *
 * `readSync` in a loop over a fixed buffer: bounded memory, no promise, and it
 * blocks only for as long as the file takes to read -- which is the same work the
 * asynchronous reader does, minus the scheduling. Decoding goes through a
 * `StringDecoder`, so a multi-byte character split across a chunk boundary is
 * still one character.
 *
 * The cost worth naming: it blocks the event loop for the duration of the file.
 * That is acceptable here because the caller is a synchronous analysis that
 * would have occupied the thread anyway, and it is NOT acceptable for a server
 * request -- which is why the asynchronous reader is what the web path uses.
 */
export function streamCsvRecordsSync(
  file: string,
  onRecord: CsvRecordSink,
  options: { readonly problems?: string[]; readonly maxProblems?: number } = {},
): void {
  const problems = options.problems ?? [];
  const maxProblems = options.maxProblems ?? MAX_PROBLEMS;
  const tokenizer = new CsvTokenizer(onRecord, (message) => {
    if (problems.length < maxProblems) problems.push(message);
  });

  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const decoder = new StringDecoder("utf8");
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      tokenizer.write(decoder.write(buffer.subarray(0, read)));
    }
    tokenizer.write(decoder.end());
    tokenizer.end();
  } finally {
    // ALWAYS closed, including on a throw from the sink. A leaked descriptor on a
    // 500,000-row file is an EMFILE for the rest of the process's life.
    closeSync(fd);
  }
}

/** One record as it comes off the stream: the cells, and the FILE line it started on. */
export interface StreamRecord {
  readonly cells: string[];
  /** 1-based line in the file, so a problem can cite the line a person sees. */
  readonly line: number;
}

export interface StreamOutcome {
  /** Every record after the header, including those past any retention cap. */
  readonly records: number;
  readonly problems: readonly string[];
}

/**
 * READ A CSV AS A STREAM OF RECORDS.
 *
 * The state machine is the parser. It is fed decoded chunks and emits each
 * record the moment it is complete, so the peak holding is one record plus one
 * chunk -- 64 KB by default -- whatever the file's size.
 *
 * EVERY RULE `parseCsv` ENFORCED IS ENFORCED HERE, and that is the requirement
 * rather than a nicety: the reader is a parser first and a memory strategy
 * second, and a streaming reader that quietly changed what counts as a record
 * would trade a crash for a wrong number, which is the worse of the two.
 * Quoted fields, escaped quotes, a quote appearing mid-field, CRLF, blank lines
 * that are not records, a final record with no terminator, and a file that ends
 * inside a quoted field.
 *
 * `onRecord` is called synchronously, once per record, as each one completes. The
 * stream is consumed one chunk at a time, so at most one chunk of records is ever
 * live; the sink must not retain the `cells` array it is handed.
 */
export async function streamCsvRecords(
  file: string,
  onRecord: CsvRecordSink,
  options: { readonly problems?: string[]; readonly maxProblems?: number } = {},
): Promise<StreamOutcome> {
  const problems = options.problems ?? [];
  const maxProblems = options.maxProblems ?? MAX_PROBLEMS;
  // THE SAME PARSER as the synchronous driver. One implementation of the rules,
  // not two that agree until somebody edits one.
  const tokenizer = new CsvTokenizer(onRecord, (message) => {
    if (problems.length < maxProblems) problems.push(message);
  });

  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024 });
  for await (const chunk of stream as AsyncIterable<string>) tokenizer.write(chunk);
  tokenizer.end();

  return { records: tokenizer.count, problems };
}

/** Everything one column has learned, in a form an analysis can read. */
export interface StreamColumnSnapshot {
  readonly name: string;
  /**
   * The reservoir, sorted. At most `RESERVOIR_SIZE` values, whatever the
   * column's real length, and the same numbers when `exact` is true.
   */
  readonly sample: readonly number[];
  /** Every row, including blanks and junk. */
  readonly seen: number;
  readonly empty: number;
  readonly dirty: number;
  readonly dirtyExamples: readonly string[];
  readonly measured: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  /** The exact total. Kept separate from `mean` because `mean * measured` is not it. */
  readonly sum: number | null;
  readonly q1: number | null;
  readonly median: number | null;
  readonly q3: number | null;
  /** Median absolute deviation -- a fence one absurd value cannot move. */
  readonly mad: number | null;
  /** True when the quantiles above are the column, not a sample of it. */
  readonly exact: boolean;
  /** How many values the quantiles were computed from. */
  readonly sampled: number;
}

const MAX_DIRTY_EXAMPLES = 3;

/**
 * ONE COLUMN, ACCUMULATED.
 *
 * The three-way split is the analyser's and is copied exactly, order included:
 * an empty cell is checked FIRST and never handed to `Number()`, because
 * `Number("")` is 0 and a blank would become a measurement of zero -- an
 * assertion that unmeasured work was free. Only then is "not a number" DIRTY.
 */
export class ColumnAccumulator {
  private seen = 0;
  private empty = 0;
  private dirty = 0;
  private measured = 0;
  private sum = 0;
  private min = Number.POSITIVE_INFINITY;
  private max = Number.NEGATIVE_INFINITY;
  private readonly examples: string[] = [];
  private readonly reservoir: Reservoir;
  readonly name: string;

  constructor(name: string, capacity: number = RESERVOIR_SIZE) {
    this.name = name;
    this.reservoir = new Reservoir(capacity);
  }

  add(raw: string): void {
    this.seen += 1;
    const text = raw.trim();
    if (text.length === 0) {
      this.empty += 1;
      return;
    }
    const value = Number(text);
    if (!Number.isFinite(value)) {
      this.dirty += 1;
      // DISTINCT offending values, capped. A column of four thousand identical
      // "N/A" cells must not produce four thousand words in the report; the
      // count above already carries the magnitude.
      if (this.examples.length < MAX_DIRTY_EXAMPLES && !this.examples.includes(text)) this.examples.push(text);
      return;
    }
    this.measured += 1;
    this.sum += value;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
    this.reservoir.add(value);
  }

  /** The sample, for the fences and the chart buckets. The caller's copy. */
  sample(): number[] {
    return this.reservoir.sorted();
  }

  /** True when the sample still holds every measured value. */
  get exact(): boolean {
    return this.reservoir.exact;
  }

  snapshot(): StreamColumnSnapshot {
    const sorted = this.reservoir.sorted();
    const measured = this.measured;
    const q1 = sorted.length === 0 ? null : percentileSorted(sorted, 25);
    const q3 = sorted.length === 0 ? null : percentileSorted(sorted, 75);
    const median = sorted.length === 0 ? null : percentileSorted(sorted, 50);
    return {
      name: this.name,
      sample: sorted,
      seen: this.seen,
      empty: this.empty,
      dirty: this.dirty,
      dirtyExamples: [...this.examples],
      measured,
      min: measured === 0 ? null : this.min,
      max: measured === 0 ? null : this.max,
      mean: measured === 0 ? null : this.sum / measured,
      sum: measured === 0 ? null : this.sum,
      q1,
      median,
      q3,
      mad: median === null ? null : percentileSorted(
        sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b),
        50,
      ),
      exact: this.reservoir.exact,
      sampled: sorted.length,
    };
  }
}

/** The profile of a whole file, in bounded memory. */
export interface StreamProfile {
  readonly file: string;
  readonly headers: readonly string[];
  readonly rowCount: number;
  /** Present only for columns that were actually read. */
  readonly columns: Readonly<Record<string, StreamColumnSnapshot>>;
  readonly topCategories: readonly { key: string; count: number }[];
  /**
   * The fence counts, resolved exactly. Attached by the reader once the file has
   * been read, because resolving them for a column too large for its reservoir
   * needs a second pass over the file.
   */
  outliers?: Readonly<Record<string, FenceSummary & { readonly exact: boolean }>>;
  /** False when any column's quantiles came from a sample. */
  readonly exact: boolean;
}

/**
 * THE ACCUMULATOR, AND THE ONLY THING THAT HAS TO KNOW A ROW ARRIVED.
 *
 * Call it per record and the whole analysis is available at the end without a
 * single row having been kept. `retain` is the escape hatch for the parts of
 * this product that genuinely need records -- the cross-column checks and the
 * renderer's sample -- and it is CAPPED, because an unbounded retention is the
 * wall wearing a different hat.
 */
export class FileProfile {
  readonly headers: string[] = [];
  private readonly accumulators: ColumnAccumulator[] = [];
  private readonly categories: HeavyHitters;
  private records = 0;
  private readonly retained: Record<string, string>[] = [];
  private readonly retentionCap: number;
  private readonly file: string;
  private categoryColumn: string | undefined;

  constructor(file: string, options: {
    readonly retain?: number;
    readonly categoryColumn?: string;
    readonly heavyHitters?: number;
  } = {}) {
    this.file = file;
    this.retentionCap = options.retain ?? 0;
    this.categoryColumn = options.categoryColumn;
    this.categories = new HeavyHitters(options.heavyHitters ?? HEAVY_HITTERS);
  }

  /** The file this profile describes. Read only, and never used to open anything. */
  get path(): string {
    return this.file;
  }

  /** Point the heavy-hitter counter at the column that ranks the file. */
  setCategoryColumn(name: string | undefined): void {
    this.categoryColumn = name;
  }

  /** The header row. Fixes the column set before any record can arrive. */
  setHeaders(cells: readonly string[]): void {
    this.headers.length = 0;
    this.accumulators.length = 0;
    for (const cell of cells) {
      const name = cell.trim();
      this.headers.push(name);
      this.accumulators.push(new ColumnAccumulator(name));
    }
  }

  /**
   * ONE RECORD. The only allocation that grows with the FILE is the retention,
   * and that is capped by construction rather than by hope.
   */
  push(cells: readonly string[]): void {
    this.records += 1;
    for (let i = 0; i < this.accumulators.length; i += 1) {
      this.accumulators[i]!.add(cells[i] ?? "");
    }
    if (this.categoryColumn !== undefined) {
      const index = this.headers.indexOf(this.categoryColumn);
      if (index >= 0) this.categories.add(cells[index] ?? "");
    }
    if (this.retained.length < this.retentionCap) {
      const row: Record<string, string> = {};
      for (let i = 0; i < this.headers.length; i += 1) row[this.headers[i]!] = cells[i] ?? "";
      this.retained.push(row);
    }
  }

  get rowCount(): number {
    return this.records;
  }

  /** The retained window: capped, and the cap is stated so a caller can admit it. */
  rows(): Record<string, string>[] {
    return this.retained;
  }

  snapshot(): StreamProfile {
    const columns: Record<string, StreamColumnSnapshot> = {};
    let exact = true;
    for (const accumulator of this.accumulators) {
      const shot = accumulator.snapshot();
      columns[accumulator.name] = shot;
      if (!shot.exact) exact = false;
    }
    return {
      file: this.file,
      headers: [...this.headers],
      rowCount: this.records,
      columns,
      topCategories: this.categories.top(10),
      exact,
    };
  }
}

/**
 * COUNT VALUES BEYOND THE FENCES, EXACTLY, IN A SECOND PASS.
 *
 * An outlier COUNT cannot be accumulated in one pass, because the fences are
 * quartiles and a quartile is only known once the column has been seen whole --
 * the same reason nobody can count outliers while streaming the values that
 * define them. So the honest options are a bounded sample and a second read, and
 * this is the second read.
 *
 * It costs one more pass over the file and NO memory: a column's fences are four
 * numbers, so a 500,000-row file is re-scanned against a handful of doubles and
 * nothing accumulates. That is a trade worth making, because the alternative is
 * reporting an outlier count estimated from 4096 samples as though it were a
 * measurement of the file -- and the user reads it as "my column has 3 bad
 * cells" when it has 37,000.
 *
 * Only called when a column's reservoir was not exact. Below 4096 values the
 * reservoir already holds the column and no second pass is made at all.
 */
export async function countBeyondFences(
  file: string,
  fences: readonly { column: string; lower: number; upper: number; extremeLower: number; extremeUpper: number }[],
): Promise<Record<string, { outliers: number; extreme: number; low: number | null; high: number | null }>> {
  const out: Record<string, { outliers: number; extreme: number; low: number | null; high: number | null }> = {};
  const wanted = new Map<string, { column: string; lower: number; upper: number; extremeLower: number; extremeUpper: number; outliers: number; extreme: number; low: number | null; high: number | null }>();
  for (const fence of fences) {
    out[fence.column] = { outliers: 0, extreme: 0, low: null, high: null };
    wanted.set(fence.column, { ...fence, outliers: 0, extreme: 0, low: null, high: null });
  }
  if (wanted.size === 0) return out;

  let header: string[] | undefined;
  await streamCsvRecords(file, (cells, line) => {
    // THE FIRST RECORD IS THE HEADER. Reading it as data would put column names
    // into the outlier counts, which is how a column of text gets reported as
    // being full of extreme values.
    if (header === undefined) {
      header = cells.map((cell) => cell.trim());
      return;
    }
    for (const [, fence] of wanted) {
      const index = header.indexOf(fence.column);
      if (index < 0) continue;
      const raw = (cells[index] ?? "").trim();
      if (raw.length === 0) continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      if (value < fence.lower) {
        fence.outliers += 1;
        if (fence.low === null || value < fence.low) fence.low = value;
      } else if (value > fence.upper) {
        fence.outliers += 1;
        if (fence.high === null || value > fence.high) fence.high = value;
      }
      if (value < fence.extremeLower || value > fence.extremeUpper) fence.extreme += 1;
    }
  });
  for (const [column, fence] of wanted) {
    out[column] = { outliers: fence.outliers, extreme: fence.extreme, low: fence.low, high: fence.high };
  }
  return out;
}