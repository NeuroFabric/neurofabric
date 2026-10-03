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

/**
 * ONE PARTITION'S VIEW OF ONE COLUMN -- before consolidation.
 *
 * Distinct from the verdict because the two answer different questions. A standing
 * is a measurement; a verdict is a judgement across partitions. Collapsing them
 * into one type is how a consolidated alert ends up claiming a partition it did
 * not come from.
 */
export interface LiveColumnStanding {
  readonly column: string;
  /** Which partition this standing came from. Empty for a consolidated verdict. */
  readonly partition: string;
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

/**
 * ONE COLUMN, ACROSS EVERY PARTITION.
 *
 * The consolidated form: one sentence per column, carrying the worst standing and
 * enough provenance to know what was folded into it.
 */
export interface LiveColumnVerdict extends Omit<LiveColumnStanding, "partition"> {
  /**
   * How many partitions contributed to this standing.
   *
   * Present because a consolidated verdict necessarily hides something: it reports
   * ONE column standing when N partitions each have their own. An operator reading
   * "latency_ms is 4x past its fence" needs to know whether that is one sick
   * partition or all of them, and the answer changes what they do next -- restart a
   * replica, or page the fleet.
   */
  readonly partitions: number;
  /** Per-partition measured counts, so a consolidated alert can still be drilled into. */
  readonly partitionColumns: Readonly<Record<string, number>>;
  /** True when EVERY contributing partition breached, not merely one. */
  readonly breachedEverywhere: boolean;
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
  const columns: LiveColumnStanding[] = [];
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
      // Partition is carried so a column seen in several places can be
      // CONSOLIDATED below, rather than reported once per partition.
      columns.push({
        column: name,
        partition: partition.name,
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

  const consolidated = consolidateColumns(columns);
  return {
    at: snapshot.at,
    records: snapshot.records,
    open: snapshot.open,
    columns: consolidated.sort((a, b) => Number(b.breached) - Number(a.breached) || a.column.localeCompare(b.column)),
    breachedColumns: consolidated.filter((column) => column.breached).length,
    busiestHour: busiest === undefined ? null : { hour: busiest[0], count: busiest[1] },
    topKeys: [...topKeys].sort((a, b) => b.count - a.count).slice(0, 10),
  };
}

/**
 * ONE SENTENCE PER COLUMN, across every partition.
 *
 * === THE UX DEFECT THIS FIXES ===
 *
 * Columns are tracked PER PARTITION, so a stream split three ways reported
 * `latency_ms` three times -- once per partition. On screen that reads as three
 * independent problems, so an operator triages three things when there is one
 * column to investigate, and the third line is dismissed as a duplicate of the
 * first without ever being read.
 *
 * === WHICH STANDING SURVIVES, AND WHY IT IS NOT "THE FIRST" ===
 *
 * The WORST one, and "worst" is deliberately defined rather than picked:
 *
 *   - a breach outranks no breach. A column clean in two partitions and breached
 *     in the third is a problem, and averaging that into "mostly fine" is how a
 *     sick replica hides inside a healthy fleet;
 *   - among breaches, the one FURTHEST past its outer fence wins, because that is
 *     the one an operator should act on first;
 *   - among non-breaches, the TIGHTEST interquartile spread wins, because that is
 *     the partition most able to reveal the next anomaly -- the most sensitive
 *     detector, not the most comfortable one.
 *
 * And the consolidation reports its own SCOPE: how many partitions contributed,
 * their measured counts, and whether all of them breached. Collapsing three
 * columns into one would be tidier and worse, because the reader would no longer
 * be able to tell one sick replica from a sick fleet -- which is the difference
 * between restarting a pod and paging someone.
 */
function consolidateColumns(standings: readonly LiveColumnStanding[]): LiveColumnVerdict[] {
  const grouped = new Map<string, LiveColumnStanding[]>();
  for (const standing of standings) {
    const existing = grouped.get(standing.column);
    if (existing === undefined) grouped.set(standing.column, [standing]);
    else existing.push(standing);
  }

  const worse = (a: LiveColumnStanding, b: LiveColumnStanding): LiveColumnStanding => {
    if (a.breached !== b.breached) return a.breached ? a : b;
    if (a.breached) {
      // Both are breached: the further past its fence wins, and a null multiple
      // (a degenerate column whose spread is zero) never beats a real one.
      return (a.extremeMultiple ?? -1) >= (b.extremeMultiple ?? -1) ? a : b;
    }
    // Neither breached: the tighter spread is the more sensitive detector.
    const spreadA = (a.q3 ?? 0) - (a.q1 ?? 0);
    const spreadB = (b.q3 ?? 0) - (b.q1 ?? 0);
    return spreadA <= spreadB ? a : b;
  };

  const out: LiveColumnVerdict[] = [];
  for (const [column, group] of grouped) {
    const worst = group.reduce(worse);
    const partitionColumns: Record<string, number> = {};
    for (const standing of group) partitionColumns[standing.partition] = standing.measured;
    const { partition: _winner, ...rest } = worst;
    out.push({
      ...rest,
      partitions: group.length,
      partitionColumns,
      breachedEverywhere: group.every((standing) => standing.breached),
    });
  }
  return out;
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