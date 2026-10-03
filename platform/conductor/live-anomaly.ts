import type { BrokerSnapshot } from "./stream-broker.ts";
import { OUTLIER_IQR_FACTOR, EXTREME_IQR_FACTOR } from "./stream-profile.ts";

/**
 * CONTINUOUS ANOMALY EVALUATION, over a snapshot rather than a finished file.
 *
 * === WHY THIS IS NOT THE FILE ANALYSIS, AND WHY IT MUST NOT BE ===
 *
 * The file pipeline counts outliers exactly, because it re-reads the file after
 * the fences are known. A live stream cannot: re-reading a topic to recount is
 * not something a broker can promise, and pretending otherwise is how a live
 * monitor reports a number it cannot stand behind.
 *
 * So this evaluates what a SNAPSHOT can honestly support, and says which is which:
 *
 *   - the FENCE is derived from the same quartiles and the same 1.5x and 3x
 *     factors the file path uses, so a live finding and a report over the same
 *     events cannot be built on different arithmetic;
 *   - the BREACH is a statement about the observed extreme, not a count: "the
 *     maximum is 14x beyond the 3x fence" is measurable now and remains true;
 *   - there is NO outlier count, because there is nothing to count against a
 *     window that has not closed.
 *
 * That last point is the discipline. A live panel that showed "3 bad cells" while
 * the stream was still running would be reporting a number about a file that does
 * not exist, and the number would change under the reader's feet.
 */

/** One column's live standing. */
export interface LiveColumnVerdict {
  readonly column: string;
  readonly measured: number;
  readonly min: number | null;
  readonly max: number | null;
  readonly q1: number | null;
  readonly q3: number | null;
  /** True when the quartiles came from a reservoir rather than the whole column. */
  readonly quantilesSampled: boolean;
  readonly fenceLower: number | null;
  readonly fenceUpper: number | null;
  readonly extremeLower: number | null;
  readonly extremeUpper: number | null;
  /** How far the observed extreme sits beyond the outer fence, or null. */
  readonly extremeMultiple: number | null;
  /** True when the observed maximum is beyond the OUTER (3x) fence. */
  readonly breached: boolean;
}

export interface LiveVerdict {
  readonly at: string;
  readonly records: number;
  readonly open: boolean;
  readonly columns: readonly LiveColumnVerdict[];
  /** How many columns are past their outer fence. */
  readonly breachedColumns: number;
  readonly busiestHour: { hour: string; count: number } | null;
  readonly topKeys: readonly { key: string; count: number }[];
}

/**
 * EVALUATE A SNAPSHOT. Pure: it reads the snapshot and returns a verdict, so it
 * can be called on a timer, per request, or in a test, and the three agree.
 */
export function evaluateLive(snapshot: BrokerSnapshot): LiveVerdict {
  const columns: LiveColumnVerdict[] = [];
  for (const partition of snapshot.partitions) {
    for (const [name, stats] of Object.entries(partition.columns)) {
      if (stats.measured < 2 || stats.q1 === null || stats.q3 === null) continue;
      const iqr = stats.q3 - stats.q1;
      const fenceUpper = stats.q3 + OUTLIER_IQR_FACTOR * iqr;
      const fenceLower = stats.q1 - OUTLIER_IQR_FACTOR * iqr;
      const extremeUpper = stats.q3 + EXTREME_IQR_FACTOR * iqr;
      const extremeLower = stats.q1 - EXTREME_IQR_FACTOR * iqr;
      const max = stats.max;
      const breached = max !== null && (max > extremeUpper || (stats.min !== null && stats.min < extremeLower));
      // "How far past", expressed as a multiple of the distance from the median
      // to the fence. A ratio against the fence itself is close to 1 for a
      // spectacular outlier, which reads as "barely past" on a gauge.
      const span = stats.q3 - stats.q1;
      const extremeMultiple = breached && max !== null && span > 0
        ? (max - extremeUpper) / span
        : null;
      columns.push({
        column: name,
        measured: stats.measured,
        min: stats.min,
        max,
        q1: stats.q1,
        q3: stats.q3,
        quantilesSampled: !stats.exact,
        fenceLower,
        fenceUpper,
        extremeLower,
        extremeUpper,
        extremeMultiple,
        breached,
      });
    }
  }
  const hours = snapshot.partitions.flatMap((partition) => partition.hours.map((hour) => ({ ...hour })));
  const byHour = new Map<string, number>();
  for (const hour of hours) byHour.set(hour.hour, (byHour.get(hour.hour) ?? 0) + hour.count);
  const busiest = [...byHour.entries()].sort((a, b) => b[1] - a[1])[0];
  const topKeys = [...snapshot.partitions.flatMap((partition) => partition.topKeys)]
    .reduce((all, entry) => {
      const seen = all.get(entry.key);
      if (seen === undefined) all.set(entry.key, { key: entry.key, count: entry.count });
      else all.set(entry.key, { key: entry.key, count: seen.count + entry.count });
      return all;
    }, new Map<string, { key: string; count: number }>())
    .values();

  return {
    at: snapshot.at,
    records: snapshot.records,
    open: snapshot.open,
    columns: columns.sort((a, b) => Number(b.breached) - Number(a.breached) || a.column.localeCompare(b.column)),
    breachedColumns: columns.filter((column) => column.breached).length,
    busiestHour: busiest === undefined ? null : { hour: busiest[0], count: busiest[1] },
    topKeys: [...topKeys].sort((a, b) => b.count - a.count).slice(0, 10),
  };
}

/**
 * THE VERDICT AS A SENTENCE, addressed to a person.
 *
 * Worded for a stream that is STILL RUNNING, which changes the grammar and the
 * claims. No "3 outliers were found" -- the stream has not finished finding
 * anything. It says what has been observed, how far past the fence it sits, and
 * that the window is open.
 */
export function liveFindings(verdict: LiveVerdict): string {
  if (verdict.records === 0) {
    return "Nothing has arrived on this stream yet, so there is nothing to judge.";
  }
  const breached = verdict.columns.filter((column) => column.breached);
  const scope = verdict.open
    ? `${verdict.records.toLocaleString("en-US")} event(s) so far, and the stream is still open`
    : `${verdict.records.toLocaleString("en-US")} event(s), stream closed`;

  if (breached.length === 0) {
    const busiest = verdict.busiestHour === null
      ? ""
      : ` The busiest hour so far is ${verdict.busiestHour.hour} with ${verdict.busiestHour.count.toLocaleString("en-US")}.`;
    return `Nothing is past its fence so far (${scope}).${busiest}`;
  }
  const lines = breached.map((column) => {
    const multiple = column.extremeMultiple === null ? null : column.extremeMultiple.toFixed(1);
    const side = column.max !== null && column.extremeUpper !== null && column.max > column.extremeUpper
      ? "above" : "below";
    return `${column.column}: ${side} its ${side === "above" ? "upper" : "lower"} outer fence`
      + `${multiple === null ? "" : ` by ${multiple}x the interquartile spread`}`
      + ` (max ${column.max?.toLocaleString("en-US")}, fence `
      + `${(side === "above" ? column.extremeUpper : column.extremeLower)?.toLocaleString("en-US")},`
      + ` from ${column.measured.toLocaleString("en-US")} measured value(s)`
      + `${column.quantilesSampled ? ", quartiles sampled" : ""}).`;
  });
  return `${breached.length} column(s) are past their fence so far (${scope}): ${lines.join(" ")} `
    + "Counts are deliberately not given: the stream has not finished, so a count would be a number about a file that does not exist.";
}