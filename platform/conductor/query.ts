import type { HistogramBucket } from "./bottlenecks.ts";

/**
 * THE QUERY RESOLVER. A question about the DATA, answered by arithmetic.
 *
 * === WHY THIS EXISTS RATHER THAN ANOTHER ROUTE ===
 *
 * The router could hand a user the right chart. It could not answer "how many
 * rows are over 5,000", because a summary is not invertible: a mean, a maximum
 * and an outlier count do not determine how many values fall inside an arbitrary
 * range. So the agent would have answered "what was the worst hour" and declined
 * "how many queries took longer than two seconds" -- which is the question a
 * person with a slow database actually opens the file to ask.
 *
 * The bounded histogram on each numeric column is what makes it answerable. It
 * is computed in the SAME pass as the mean and the fences, from the same array
 * of measured values, so a summary and a histogram can never disagree about which
 * cells were counted.
 *
 * === AND THE LIMIT IS STATED RATHER THAN HIDDEN ===
 *
 * A bucket is a RANGE. "About 3,900 rows" is defensible; "3,912 rows" is a
 * fabrication, and it is the single most tempting lie in this feature. So:
 *
 *   - a threshold on a bucket EDGE is exact, because the buckets are half-open;
 *   - a threshold INSIDE a bucket yields a RANGE, and the answer says so in
 *     words and carries its bounds;
 *   - a question that cannot be answered within the bounds is DECLINED.
 *
 * Every returned number is traceable to a computed field. `matched: false` means
 * "I do not know", and the caller falls through to the router rather than
 * inventing a reply.
 */

/** The statistics this resolver can read. Deliberately the minimum it needs. */
export interface QueryData {
  readonly totalRows: number;
  readonly columns: readonly {
    readonly name: string;
    readonly mean: number | null;
    readonly min: number | null;
    readonly max: number | null;
    readonly measured: number;
    readonly dirty: number;
    readonly empty: number;
    readonly histogram?: readonly HistogramBucket[];
  }[];
  readonly ranking: readonly { readonly key: string; count: number }[];
  readonly timeline: readonly {
    readonly hour: string;
    readonly count: number;
    readonly share: number;
    readonly multiple: number | null;
    readonly spike: boolean;
    readonly rule: string | null;
  }[];
}

/** What was asked, and what came back. */
export interface Query {
  readonly matched: boolean;
  readonly kind: "rows-above" | "rows-below" | "mean" | "argmax-missing" | "worst-hour" | "none";
  /** The real column name, when the question named one. Null when it did not. */
  readonly column: string | null;
  readonly threshold: number | null;
  /** The exact count, or null when the question only has a bounded answer. */
  readonly exact: number | null;
  /** The bound the answer sits in, when it is not exact. */
  readonly bounds: { readonly lo: number; readonly hi: number } | null;
  /** Plain English, addressed to a person. Never a bare number. */
  readonly answer: string;
  /** A shape worth drawing, where there is one. */
  readonly widget?: {
    readonly kind: "histogram" | "line" | "bar";
    readonly title: string;
    readonly note: string;
    readonly payload: unknown;
  };
}

/** `nl` for counts, and a small unit-aware formatter for magnitudes. */
function n(value: number): string {
  return value.toLocaleString("en-US");
}

function fmt(value: number | null): string {
  if (value === null) return "not measurable";
  return Math.abs(value) >= 1000 ? n(Math.round(value)) : String(Math.round(value * 100) / 100);
}

function miss(matched: boolean, answer: string, extra: Partial<Query> = {}): Query {
  return {
    matched, kind: "none", column: null, threshold: null,
    exact: null, bounds: null, answer, ...extra,
  };
}

/**
 * FIND THE COLUMN A PERSON MEANT.
 *
 * Exact first, then by longest shared token. People write "elapsed time" for
 * "total_elapsed_time_ms" and "response bytes" for "response_bytes", and a
 * resolver that demanded an exact name would answer nothing.
 *
 * What it will NOT do is pick between two candidates. Two columns matching a
 * question equally well is ambiguity, and guessing which half was meant is
 * inventing a question the user did not ask -- so it returns null and the caller
 * declines.
 */
function findColumn(data: QueryData, text: string): string | null {
  const columns = data.columns.map((c) => c.name);
  const lower = text.toLowerCase();

  for (const name of columns) {
    if (lower.includes(name.toLowerCase())) return name;
  }

  const wanted = new Set(lower.split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  if (wanted.size === 0) return null;

  const scored = columns
    .map((name) => {
      const parts = name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      const hits = parts.filter((p) => wanted.has(p)).length;
      return { name, hits, length: name.length };
    })
    .filter((s) => s.hits > 0)
    // Longest name wins, so `total_elapsed_time_ms` beats `elapsed_time`.
    .sort((a, b) => b.hits - a.hits || b.length - a.length);

  // A tie is ambiguity. Decline it rather than pick.
  if (scored.length > 1 && scored[0]!.hits === scored[1]!.hits) return null;
  return scored[0]?.name ?? null;
}

/** The first number in a sentence, with commas tolerated. */
function numberIn(text: string): number | null {
  const m = /(-?\d[\d,]*\.?\d*)/.exec(text);
  if (m === null) return null;
  const value = Number(m[1]!.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

/**
 * COUNT THE BUCKETS ON ONE SIDE OF A THRESHOLD.
 *
 * EXACTNESS IS THE WHOLE GAME. The buckets are half-open -- [lo, hi) except the
 * last, which is closed -- so a threshold that lands on an edge separates whole
 * buckets and the count is exact. A threshold inside a bucket splits it, and the
 * only honest answer is the bucket's range.
 *
 * === THE BOUNDARY CONVENTION, STATED BECAUSE IT IS A REAL DECISION ===
 *
 * "Over 200" counts every bucket whose lower bound is at or above 200. A bucket
 * [200, 300) therefore counts in full, INCLUDING any value exactly equal to 200.
 *
 * That is a choice, and it is made here rather than left to chance: a histogram
 * cannot separate 200 from 200.0001, so the only two available readings are
 * "at or above 200" and "strictly above 200, minus the unknown count at exactly
 * 200". The first is exact under a stated convention; the second is a range. A
 * tool that quietly picked either one and reported it as "over 200" would be
 * asserting something the data does not support.
 *
 * For "under" the convention costs nothing: a bucket [lo, X) contains only
 * values strictly below X, so "under X" is exact even at an edge.
 */
function countOnSide(
  histogram: readonly HistogramBucket[],
  threshold: number,
  side: "above" | "below",
): { exact: number | null; bounds: { lo: number; hi: number } | null } {
  let exact = 0;
  let bounds: { lo: number; hi: number } | null = null;
  for (const b of histogram) {
    if (side === "above") {
      // Entirely above the threshold.
      if (b.lo >= threshold) { exact += b.count; continue; }
      // Entirely below.
      if (b.hi <= threshold) continue;
      // STRADDLES. Unknown, and the reason is published.
      bounds = { lo: threshold, hi: b.hi };
    } else {
      if (b.hi <= threshold) { exact += b.count; continue; }
      if (b.lo >= threshold) continue;
      bounds = { lo: b.lo, hi: threshold };
    }
  }
  return { exact, bounds };
}

/**
 * ANSWER ONE QUESTION, OR SAY THAT YOU CANNOT.
 *
 * Pure and total: every input produces a `Query`, and `matched: false` means the
 * caller should fall through rather than render this.
 */
export function resolveQuery(data: QueryData, question: string): Query {
  const text = String(question ?? "").trim();
  if (text === "") return miss(false, "");
  const lower = text.toLowerCase();

  // === THE TIMELINE, which needs no column and no threshold ===
  if (/\b(worst|busiest|peak|worst hour|busiest hour)\b/.test(lower) && /\bhour|time\b/.test(lower)) {
    if (data.timeline.length === 0) {
      return miss(false, "This file has no readable timestamps, so there is no hour to rank.");
    }
    const worst = [...data.timeline].sort((a, b) => b.count - a.count)[0]!;
    const share = (worst.share * 100).toFixed(1);
    return {
      matched: true, kind: "worst-hour", column: null, threshold: null,
      exact: worst.count, bounds: null,
      answer: `The busiest hour is ${worst.hour.replace("T", " ")}:00, with ${n(worst.count)} rows -- ` +
        `${share}% of the readable rows.${worst.spike ? ` The engine flagged it: ${worst.rule ?? "above the mean"}.` : ""}`,
      widget: { kind: "line", title: "Rows by hour", note: "Hover for the exact count.", payload: { points: data.timeline } },
    };
  }

  // === THE COLUMN WITH THE MOST MISSING VALUES ===
  if (/\bmissing|blank|null|empty|no value|not a number\b/.test(lower) &&
      /\b(which|what|most|worst|highest)\b/.test(lower)) {
    if (data.columns.length === 0) {
      return miss(false, "There are no numeric columns in this file to compare.");
    }
    const worst = [...data.columns]
      .map((c) => ({ name: c.name, missing: c.empty + c.dirty, empty: c.empty, dirty: c.dirty }))
      .sort((a, b) => b.missing - a.missing)[0]!;
    if (worst.missing === 0) {
      return miss(true, "No numeric column has a missing or unreadable value.");
    }
    const detail = worst.dirty > 0
      ? `${worst.empty} blank and ${worst.dirty} holding something that is not a number`
      : `${worst.empty} blank`;
    return {
      matched: true, kind: "argmax-missing", column: worst.name, threshold: null,
      exact: worst.missing, bounds: null,
      answer: `${worst.name} has the most unusable cells: ${worst.missing} of ${n(data.totalRows)} rows (${detail}).`,
    };
  }

  // === A COLUMN METRIC THAT NEEDS NO THRESHOLD ===
  const wantsMean = /\b(average|mean)\b/.test(lower);
  if (wantsMean) {
    const column = findColumn(data, text);
    if (column === null) {
      return miss(false, "Which column do you mean? I can report the mean of any numeric column in this file.");
    }
    const stat = data.columns.find((c) => c.name === column)!;
    if (stat.mean === null) {
      return miss(false, `${column} has no measurable values, so it has no mean.`);
    }
    return {
      matched: true, kind: "mean", column, threshold: null,
      exact: Math.round(stat.mean * 100) / 100, bounds: null,
      answer: `The mean of ${column} is ${fmt(stat.mean)}, over ${n(stat.measured)} measured ` +
        `value${stat.measured === 1 ? "" : "s"}. It ranges from ${fmt(stat.min)} to ${fmt(stat.max)}.`,
    };
  }

  // === A RANGE QUESTION, THE CASE THE ROUTER COULD NOT ANSWER ===
  const wantsAbove = /\b(over|above|greater than|more than|exceed|at least|bigger than)\b/.test(lower);
  const wantsBelow = /\b(under|below|less than|fewer than|smaller than|at most)\b/.test(lower);
  if (!wantsAbove && !wantsBelow) {
    return miss(false, "I did not recognise a question about the values in this file.");
  }

  const threshold = numberIn(text);
  if (threshold === null) {
    return miss(false, "I need a number to compare against -- for example, \"how many rows are over 5000?\".");
  }

  const column = findColumn(data, text);
  if (column === null) {
    // ONE SENTENCE FOR BOTH CASES, and the list is what does the work.
    //
    // There were two drafts here. One said "which column do you mean?" and the
    // other said "no such column". Neither covers both cases correctly: the
    // first is unhelpful when the user named a column this file does not have,
    // because they will answer with the same name; the second is unhelpful when
    // they named nothing at all. Listing what the file DOES have answers both --
    // the user sees their name is not in it, or sees the one they meant.
    return miss(false,
      `No column in this file matches that, so I cannot count anything against ${n(threshold)}. ` +
      `The numeric columns here are: ${data.columns.map((c) => c.name).join(", ")}.`);
  }
  const stat = data.columns.find((c) => c.name === column)!;
  const histogram = stat.histogram ?? [];
  if (histogram.length === 0) {
    return miss(false,
      `I do not keep a distribution for ${column}, so I cannot count how many values sit on either side of ${n(threshold)}. ` +
      `I can tell you its mean (${fmt(stat.mean)}), its range (${fmt(stat.min)} to ${fmt(stat.max)}), and its missing cells.`);
  }

  const side = wantsAbove ? "above" : "below";
  const { exact, bounds } = countOnSide(histogram, threshold, side);

  const widget = {
    kind: "histogram" as const,
    title: `Distribution of ${column}`,
    note: `Shaded past ${n(threshold)}. Each bar is a range, not a single value.`,
    payload: { buckets: histogram, threshold },
  };

  if (bounds === null) {
    // `bounds === null` implies nothing straddled the threshold, which is what
    // makes `exact` a real count here rather than a partial one.
    const whole = exact ?? 0;
    const share = stat.measured > 0 ? ((whole / stat.measured) * 100).toFixed(1) : "0";
    return {
      matched: true, kind: wantsAbove ? "rows-above" : "rows-below",
      column, threshold, exact: whole, bounds: null,
      answer: `${n(whole)} of the ${n(stat.measured)} measured values in ${column} are ` +
        `${side} ${n(threshold)} -- ${share}% of them.`,
      widget,
    };
  }

  // === THE APPROXIMATE ANSWER, AND ITS HONEST WORDING ===
  //
  // `exact` counts only the WHOLE buckets on the correct side. The straddling
  // bucket is unknown, so the true answer is somewhere between `exact` (with the
  // straddler excluded) and `exact + straddler`. Saying "at least N" and naming
  // the bucket's span is the whole of the honesty; rounding it to N+1 would be
  // the fabrication this module exists to avoid.
  const straddler = histogram.find((b) => b === bounds ? false :
    (side === "above" ? b.lo < threshold && b.hi > threshold : b.lo < threshold && b.hi > threshold));
  const straddlerCount = straddler?.count ?? 0;
  const spanLo = side === "above" ? bounds.lo : bounds.hi;
  const spanHi = side === "above" ? bounds.hi : bounds.lo;

  return {
    matched: true, kind: wantsAbove ? "rows-above" : "rows-below",
    column, threshold, exact: null, bounds,
    answer: `At least ${n(exact ?? 0)} of the ${n(stat.measured)} measured values in ${column} are ` +
      `${side} ${n(threshold)}, and at most ${n((exact ?? 0) + straddlerCount)}. ` +
      `The threshold falls inside a bucket spanning ${fmt(spanLo)} to ${fmt(spanHi)}, ` +
      `so I cannot narrow it further without the raw values.`,
    widget,
  };
}