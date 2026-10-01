import type { CsvReadResult } from "./capabilities.ts";

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
}

const ERROR_STATUSES = new Set(["4", "5"]);

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
export function analyseBottlenecks(csv: CsvReadResult): BottleneckAnalysis {
  const column = (...names: string[]) => names.find((n) => csv.headers.includes(n));

  const timeCol = column("_time", "timestamp", "time");
  const sourceCol = column("source", "sourcetype", "host");
  const statusCol = column("status", "code", "http_status");
  const rawCol = column("_raw", "message", "msg");
  const latencyCol = column("duration_ms", "duration", "elapsed_ms");

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

  csv.sample.forEach((row, index) => {
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
      const instant = parseInstant(String(row[timeCol] ?? ""));
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
  });

  const total = csv.sample.length;
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
  };
}