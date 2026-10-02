/**
 * CROSS-COLUMN ANOMALIES. Two columns at once, because one is not enough.
 *
 * Every other check in this product looks along a single column: a value that
 * is far from its own median is an outlier, and that is the whole model. It
 * finds big numbers.
 *
 * The defect that actually costs an enterprise money is rarely a big number. It
 * is a number that CONTRADICTS the number next to it. A row with high
 * `latency_ms` and low `total_bytes` is not a slow request -- it is a request
 * that does not belong to the same population as its neighbours. A mis-joined
 * row, a units error, a field silently populated from a different source. A 1D
 * check sees "latency is high" and reports it, which is true and useless. This
 * one sees the contradiction, and the contradiction is the finding.
 *
 * === THE MATH, AND WHY IT IS NOT MEAN AND STDEVIATION ===
 *
 * Standardising by mean and standard deviation is wrong for this job in a way
 * that is easy to walk past. The outliers being hunted are exactly the values
 * that inflate a standard deviation, so each one makes itself look LESS
 * anomalous: four extreme rows can widen sigma enough to conceal all four. The
 * usual defence is to strip the outliers first, which makes the test depend on
 * a first pass that has already decided what an outlier is.
 *
 * So the centre is the MEDIAN and the scale is the MAD -- median absolute
 * deviation -- multiplied by 1.4826, the factor that makes MAD estimate sigma
 * for normally distributed data. Both are medians, so both are unmoved by a
 * handful of extreme values by construction. That is precisely why they are the
 * right estimator here: the thing being searched for is the thing that would
 * corrupt the obvious one.
 *
 * A row is then reported when it is DISCORDANT, not merely extreme:
 *
 *     |z_x| and |z_y| both large, and their signs OPPOSITE.
 *
 * The sign test is what separates this module from a 1D check. A row that is
 * large on BOTH axes is self-consistent -- it is an outlier, and the existing
 * per-column checks already own that case, so claiming it here would duplicate
 * a finding and inflate the count. A row that is extreme on ONE axis only is
 * likewise left alone, deliberately: this module reports only what a
 * per-column pass structurally cannot.
 *
 * Two medians need a population, so a short file yields nothing rather than a
 * confident answer from three points.
 *
 * Zero dependencies. No matrix, no statistics package: two sorts, two
 * medians, one pass over the rows.
 */

const MIN_ROWS = 8;

/** Robust z beyond this is "extreme on this axis". */
const DEFAULT_THRESHOLD = 3;

/**
 * MEDIAN, defined here rather than imported.
 *
 * A three-line function, and the alternative was a new module or a new export
 * in someone else's. The whole point of this file is that it depends on nothing,
 * and a median is the one piece of arithmetic it needs -- so a copy that cannot
 * drift away from a working one is better than a dependency that can.
 *
 * Averages the middle pair for an even count, so it is itself robust to a
 * single wild value on either end.
 */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface RobustScale {
  /** The median: unmoved by a minority of extreme values. */
  readonly median: number;
  /** 1.4826 x MAD, the MAD rescaled to estimate sigma. */
  readonly sigma: number;
  /** False when the column is constant, so a z against it is meaningless. */
  readonly usable: boolean;
}

/**
 * MEDIAN and MAD. Zero dependency, and the reason this detector can see the
 * outliers that a mean-based one hides.
 */
export function robustScale(values: readonly number[]): RobustScale {
  if (values.length === 0) return { median: 0, sigma: 0, usable: false };
  const med = median(values);
  const deviations = values.map((v) => Math.abs(v - med));
  const mad = median(deviations);
  const sigma = mad * 1.4826;
  // A MAD of zero means at least half the values are identical. That is a
  // constant column, or one with fewer than half its values differing, and in
  // neither case is a z-score against it a statement about anything.
  return { median: med, sigma, usable: sigma > 0 };
}

export interface AxisPoint {
  readonly column: string;
  readonly value: number;
  /** Robust z. Positive is high for this column, negative is low. */
  readonly z: number;
}

export interface CrossColumnAnomaly {
  /** Index into the rows that were searched. */
  readonly row: number;
  readonly x: AxisPoint;
  readonly y: AxisPoint;
  /**
   * Always "discordant". The kind is a field rather than a bare boolean so a
   * future detector can add a second shape without changing every consumer's
   * type, and so a caller rendering the finding can label it.
   */
  readonly kind: "discordant";
  /** How far past the threshold the weaker axis is, for ranking. */
  readonly strength: number;
}

export interface CrossColumnInput {
  /** One object per row, keyed by column name. */
  readonly rows: readonly Record<string, unknown>[];
  /** Exactly two columns. More is a different question; see the note below. */
  readonly columns: readonly [string, string] | readonly string[];
  /** Robust z past which an axis counts as extreme. */
  readonly threshold?: number;
}

const numeric = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * FIND ROWS WHERE TWO COLUMNS CONTRADICT EACH OTHER.
 *
 * O(n) after two sorts, and O(1) in memory beyond the two column projections --
 * which is what makes it safe to run over a whole file, or a stream of one,
 * without holding the dataset.
 *
 * MORE THAN TWO COLUMNS IS DELIBERATELY UNSUPPORTED. With k columns the space
 * of "contradictions" is combinatorial, and a 3-way rule that nobody can state
 * in one sentence will report things the user cannot act on. Two axes is the
 * largest number for which the finding stays legible, and the caller pairs
 * columns explicitly. This is a bound, not an oversight.
 */
export function findCrossColumnAnomalies(input: CrossColumnInput): readonly CrossColumnAnomaly[] {
  const [xa, ya] = input.columns;
  if (xa === undefined || ya === undefined) return [];
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const { rows } = input;
  if (rows.length < MIN_ROWS) return [];

  const xs: number[] = [];
  const ys: number[] = [];
  for (const row of rows) {
    const x = numeric(row[xa]);
    const y = numeric(row[ya]);
    // A row missing either value cannot be a contradiction between them.
    if (x === null || y === null) continue;
    xs.push(x);
    ys.push(y);
  }
  if (xs.length < MIN_ROWS) return [];

  const sx = robustScale(xs);
  const sy = robustScale(ys);
  if (!sx.usable || !sy.usable) return [];

  const found: CrossColumnAnomaly[] = [];
  let i = 0;
  for (const row of rows) {
    const x = numeric(row[xa]);
    const y = numeric(row[ya]);
    if (x === null || y === null) { i += 1; continue; }
    const zx = (x - sx.median) / sx.sigma;
    const zy = (y - sy.median) / sy.sigma;
    const extremeX = Math.abs(zx) >= threshold;
    const extremeY = Math.abs(zy) >= threshold;
    // Opposite signs, both past the line. Everything else belongs to a 1D check.
    if (extremeX && extremeY && Math.sign(zx) !== Math.sign(zy)) {
      found.push({
        row: i,
        x: { column: xa, value: x, z: zx },
        y: { column: ya, value: y, z: zy },
        kind: "discordant",
        strength: Math.min(Math.abs(zx), Math.abs(zy)),
      });
    }
    i += 1;
  }

  return found.sort((a, b) => b.strength - a.strength);
}

/**
 * THE ONE-LINE VERSION, for a report that wants prose.
 *
 * Kept beside the detector rather than in the renderer so that the phrase a
 * customer reads and the rule that produced it cannot drift apart -- the same
 * arrangement that stopped the chat parser existing in two places.
 */
export function describeCrossColumn(
  anomalies: readonly CrossColumnAnomaly[],
): string | null {
  if (anomalies.length === 0) return null;
  const first = anomalies[0]!;
  const n = anomalies.length;
  return `${n} cross-column anomal${n === 1 ? "y" : "ies"} where ${first.x.column} is ` +
    `unusually ${first.x.z > 0 ? "high" : "low"} while ${first.y.column} is unusually ` +
    `${first.y.z > 0 ? "high" : "low"} -- rows that do not belong to the same population as their neighbours.`;
}
