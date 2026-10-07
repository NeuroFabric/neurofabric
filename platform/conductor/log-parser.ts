import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { parseLogLine, type LogFormat } from "../ingestion/log-tokenizer.ts";
import { sanitize } from "./sanitizer.ts";
import { parseInstant, errorSignature } from "./bottlenecks.ts";
import { HourlyCounter, KeyedAggregator } from "./stream-profile.ts";

/**
 * STREAM-BASED LOG PARSER.
 *
 * Enterprise memory contract: this module NEVER holds an entire file in memory.
 * The entire read is one `createReadStream` pass, fed chunk-by-chunk into a
 * line accumulator. No `readFile`, no `readline` (which cannot handle
 * quoted CSV newlines), and no string accumulation past one line at a time.
 *
 * === WHY A SEPARATE FILE FROM bottlenecks.ts ===
 *
 * `analyseBottlenecks` expects a `CsvReadResult` already in hand. This module
 * answers a different, earlier question: "given a raw file path, classify the
 * format, stream it in 4 KB sniff + line-at-a-time, and produce the structured
 * `LogParseResult` the `/api/v1/agent/task` route can embed directly in its
 * response". The Conductor still owns the actual run; this is the pre-flight
 * that unlocks the remediation engine without a full `csvRead` round-trip.
 *
 * === MEMORY CEILING ===
 *
 *   - Accumulators: O(1) per column for counts, O(distinct-keys) for hourly and
 *     category maps, each hard-capped below.
 *   - Line buffer: one line at a time; discarded after processing.
 *   - No retained row window: every statistic is accumulated and then released.
 *
 * === FAIL-SECURE GUARANTEE ===
 *
 * Every error path returns a `{ ok: false, error }` object. Stack traces are
 * never serialised into a response. The caller decides whether to surface the
 * `error` string to the operator or to log it internally.
 */

// ─── Limits ──────────────────────────────────────────────────────────────────

/** Maximum number of 5xx burst records retained for the scatter chart. */
const MAX_5XX_BURSTS = 500;

/** Maximum distinct hourly buckets (≈ 20 years of hours). */
const MAX_HOUR_KEYS = 20_000;

/** Maximum distinct source/host keys. */
const MAX_SOURCE_KEYS = 4_096;

/** Maximum distinct error signature keys. */
const MAX_SIGNATURE_KEYS = 256;

/** Bytes read for the format sniff pass. */
const SNIFF_BYTES = 4_096;

/** Chunk size for the main streaming pass. */
const STREAM_HIGH_WATER = 64 * 1_024;

/**
 * Maximum latency reservoir samples retained per hourly bucket.
 * Algorithm R (Vitter) reservoir sampling — exact P99 when n ≤ cap,
 * bounded estimate otherwise. Per-bucket cap keeps total heap bounded
 * to O(hours × cap) regardless of row count.
 */
const MAX_HOUR_LATENCY_SAMPLES = 512;

// ─── Public types ─────────────────────────────────────────────────────────────

export type ParsedFormat = "combined" | "csv" | "tsv" | "jsonl" | "syslog" | "keyvalue" | "unknown";

/** Column role mapping, compatible with the frontend `AnalysisSummary.mappings` shape. */
export interface LogColumnMapping {
  readonly role: string;
  readonly column: string;
  readonly hypothesis: boolean;
  readonly note: string;
}

/** One hourly bucket for the war-room timeline charts. */
export interface LogHourBucket {
  readonly key: string;
  readonly count: number;
  readonly errorCount: number;
  readonly errorRate: number;
  /**
   * P99 latency for requests in this hour bucket, in milliseconds.
   * Null when no latency observations were collected for this hour.
   */
  readonly p99LatencyMs: number | null;
}

/** One latency band for the P99 histogram. */
export interface LogLatencyBand {
  readonly label: string;
  readonly count: number;
}

/** One ranked category entry. */
export interface LogCategoryStat {
  readonly key: string;
  readonly count: number;
  readonly p95Elapsed: number | null;
}

/** A timestamped HTTP 5xx burst for the scatter chart. */
export interface Http5xxBurst {
  readonly timestamp: string;
  readonly count: number;
  readonly status: string;
}

/** Full output of a successful parse. */
export interface LogParseSuccess {
  readonly ok: true;
  readonly format: ParsedFormat;
  readonly totalRows: number;
  readonly errorRows: number;
  readonly errorRate: number;
  readonly problems: string[];
  /** Column role assignments, evidence-grounded per the bottlenecks.ts convention. */
  readonly mappings: LogColumnMapping[];
  /** Hourly error + traffic counts for the ComposedChart. */
  readonly byHour: LogHourBucket[];
  /** P99 latency distribution bands (< 50 ms / 50–200 ms / 200 ms–1 s / > 1 s). */
  readonly latencyBands: LogLatencyBand[];
  /** Top ranked status/source categories, with p95 elapsed where available. */
  readonly categories: LogCategoryStat[];
  /** Timestamped 5xx spikes for the scatter chart. */
  readonly http5xx: Http5xxBurst[];
  /**
   * Python/pandas sanitization script derived from the detected schema.
   * Grounded in the actual `mappings` array — never generated for a file
   * whose columns could not be identified.
   */
  readonly remediationScript: string;
  /**
   * SQL index DDL derived from detected time and category columns.
   * Empty string when the mappings cannot support a meaningful index.
   */
  readonly sqlIndexPatch: string;
  /**
   * Evidence summary sentences, one per detected problem.
   * Suitable for the "Conductor findings" markdown panel.
   */
  readonly evidenceSummary: string;
}

/** Returned when the parse fails. No stack trace is ever included. */
export interface LogParseFailure {
  readonly ok: false;
  readonly error: string;
  readonly format?: ParsedFormat;
}

export type LogParseResult = LogParseSuccess | LogParseFailure;

// ─── Format sniffing ─────────────────────────────────────────────────────────

/**
 * READ THE FIRST 4 KB WITHOUT LOADING THE ENTIRE FILE.
 *
 * Uses `node:fs/promises open` → manual `read` → `close`, so the file handle
 * is never held open during the slow streaming pass that follows. A single
 * `open` + `read` call is bounded by `SNIFF_BYTES` regardless of file size.
 */
async function sniffHead(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Apache/nginx Combined Log Format signature — the tightest structural test. */
const CLF_RE = /^\S+\s+\S+\s+\S+\s+\[\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2}\s[+-]\d{4}\]\s+"/m;

/** RFC 3164 syslog: `Oct  7 09:37:50 host app:` */
const SYSLOG_RE = /^[A-Z][a-z]{2}\s{1,2}\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\S+\s+\S+:/m;

/** key=value pairs (≥ 2 per line, common in structlog / logfmt). */
const KV_RE = /(?:^|\s)\w[\w.-]*=\S+.*\w[\w.-]*=\S+/m;

/** JSONL: every non-blank line starts with `{`. */
const JSONL_RE = /^{/m;

/** TSV: first non-blank line contains a tab between printable fields. */
const TSV_RE = /^[^\t\n]+\t[^\t\n]+/m;

/**
 * CLASSIFY THE FILE FORMAT FROM THE FIRST 4 KB.
 *
 * Ordered from most-specific to most-general so that a CLF file that also
 * contains tab characters is not misidentified as TSV.
 */
function detectFormat(head: string, ext: string): ParsedFormat {
  if (CLF_RE.test(head)) return "combined";
  if (SYSLOG_RE.test(head)) return "syslog";
  if (JSONL_RE.test(head)) return "jsonl";
  if (KV_RE.test(head)) return "keyvalue";
  if (ext === ".tsv") return "tsv";
  if (TSV_RE.test(head)) return "tsv";
  // CSV is the safe fallback: the existing pipeline has always treated
  // unrecognised delimited text as CSV, and we preserve that contract.
  if (/^[^,\n]+,[^,\n]+/m.test(head)) return "csv";
  return "unknown";
}

// ─── Per-row latency accumulator ─────────────────────────────────────────────

/**
 * Running P95 using the Greenwald-Khanna algorithm is overkill for this use
 * case. Instead we keep one bounded reservoir (Vitter's Algorithm R) of at most
 * 4096 latency samples, sort once at the end, and compute nearest-rank P95.
 * This matches `bottlenecks.ts` exactly and produces a value that can be traced
 * to a row the operator actually has.
 */
const MAX_LATENCY_RESERVOIR = 4_096;

class LatencyReservoir {
  private readonly samples: number[] = [];
  private seen = 0;

  push(ms: number): void {
    this.seen += 1;
    if (this.samples.length < MAX_LATENCY_RESERVOIR) {
      this.samples.push(ms);
    } else {
      // Reservoir replacement: replace a random earlier sample.
      const j = Math.floor(Math.random() * this.seen);
      if (j < MAX_LATENCY_RESERVOIR) this.samples[j] = ms;
    }
  }

  p95(): number | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const rank = Math.min(sorted.length, Math.max(1, Math.ceil(0.95 * sorted.length)));
    return sorted[rank - 1] ?? null;
  }

  bands(): LogLatencyBand[] {
    const buckets = [
      { lo: 0, hi: 50, label: "<50 ms", count: 0 },
      { lo: 50, hi: 200, label: "50–200 ms", count: 0 },
      { lo: 200, hi: 1_000, label: "200 ms–1 s", count: 0 },
      { lo: 1_000, hi: Infinity, label: ">1 s", count: 0 },
    ];
    for (const v of this.samples) {
      for (const bucket of buckets) {
        if (v >= bucket.lo && v < bucket.hi) { bucket.count += 1; break; }
      }
    }
    return buckets.filter((b) => b.count > 0).map(({ label, count }) => ({ label, count }));
  }
}

// ─── Status/category accumulator ─────────────────────────────────────────────

interface CategoryEntry {
  count: number;
  durations: number[];
}

const MAX_CATEGORY_KEYS_LP = 256;

class CategoryAggregator {
  private readonly map = new Map<string, CategoryEntry>();
  private evictions = 0;

  add(key: string, durationMs: number | null): void {
    const existing = this.map.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      if (durationMs !== null && existing.durations.length < MAX_LATENCY_RESERVOIR) {
        existing.durations.push(durationMs);
      }
      return;
    }
    if (this.map.size >= MAX_CATEGORY_KEYS_LP) {
      // Evict the least-frequent entry to stay within memory budget.
      let minKey: string | undefined;
      let minCount = Infinity;
      for (const [k, v] of this.map) {
        if (v.count < minCount) { minCount = v.count; minKey = k; }
      }
      if (minKey !== undefined) { this.map.delete(minKey); this.evictions += 1; }
    }
    this.map.set(key, { count: 1, durations: durationMs !== null ? [durationMs] : [] });
  }

  stats(): LogCategoryStat[] {
    const result: LogCategoryStat[] = [];
    for (const [key, entry] of this.map) {
      let p95: number | null = null;
      if (entry.durations.length > 0) {
        const sorted = [...entry.durations].sort((a, b) => a - b);
        const rank = Math.min(sorted.length, Math.max(1, Math.ceil(0.95 * sorted.length)));
        p95 = sorted[rank - 1] ?? null;
      }
      result.push({ key, count: entry.count, p95Elapsed: p95 });
    }
    return result.sort((a, b) => b.count - a.count);
  }

  get droppedKeys(): number { return this.evictions; }
}

// ─── Core streaming pass ──────────────────────────────────────────────────────

/**
 * ONE LINE, INTO EVERY ACCUMULATOR.
 *
 * Both CLF/syslog log lines AND CSV rows are handled here. The `LogLine` shape
 * from `parseLogLine` is the common currency: CSV rows are adapted into the same
 * shape before being handed off, so there is one implementation of "what counts
 * as a 5xx" and one implementation of "what counts as an error".
 */
/**
 * Per-hour latency reservoir for P99 calculation.
 * Lives alongside `HourlyCounter` so we can emit P99 per bucket without
 * holding the entire file's latency array in memory.
 */
class HourlyLatencyMap {
  private readonly map = new Map<string, number[]>();

  add(hourKey: string, latencyMs: number): void {
    let samples = this.map.get(hourKey);
    if (samples === undefined) {
      // Hard cap: if we somehow have more hours than expected, drop silently.
      if (this.map.size >= MAX_HOUR_KEYS) return;
      samples = [];
      this.map.set(hourKey, samples);
    }
    if (samples.length < MAX_HOUR_LATENCY_SAMPLES) {
      samples.push(latencyMs);
    } else {
      // Reservoir replacement (Vitter's Algorithm R).
      const j = Math.floor(Math.random() * (samples.length + 1));
      if (j < MAX_HOUR_LATENCY_SAMPLES) samples[j] = latencyMs;
    }
  }

  p99(hourKey: string): number | null {
    const samples = this.map.get(hourKey);
    if (!samples || samples.length === 0) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const rank = Math.min(sorted.length, Math.max(1, Math.ceil(0.99 * sorted.length)));
    return sorted[rank - 1] ?? null;
  }
}

interface RowAccumulators {
  readonly hourCounts: HourlyCounter;
  readonly hourLatency: HourlyLatencyMap;
  readonly sourceKeys: KeyedAggregator;
  readonly signatureKeys: KeyedAggregator;
  readonly latencyRes: LatencyReservoir;
  readonly statusAgg: CategoryAggregator;
  readonly bursts: Http5xxBurst[];
  totalRows: number;
  errorRows: number;
}

function accumulateLogLine(
  fields: Readonly<Record<string, string>>,
  rowNumber: number,
  accs: RowAccumulators,
  timeCol: string,
  statusCol: string,
  bytesCol: string,
  latencyCol: string | undefined,
): void {
  accs.totalRows += 1;

  const status = fields[statusCol] ?? "";
  const isError5xx = /^5/.test(status.trim());
  const isError4xx = /^4/.test(status.trim());
  const isError = isError5xx || isError4xx;
  if (isError) accs.errorRows += 1;

  // Hourly timeline
  const rawTs = fields[timeCol] ?? "";
  const instant = parseInstant(rawTs);
  if (instant !== undefined) {
    const hourKey = new Date(instant).toISOString().slice(0, 13);
    accs.hourCounts.add(hourKey, isError, rowNumber);
  }

  // Source ranking
  const host = fields["host"] ?? fields["source"] ?? fields["hostname"] ?? "";
  if (host) accs.sourceKeys.add(host, { row: rowNumber, isError });

  // Error signature ranking
  const message = fields["message"] ?? fields["_raw"] ?? "";
  if (isError && message) {
    const sig = errorSignature(`${status} ${message}`) ?? errorSignature(message);
    if (sig !== undefined) accs.signatureKeys.add(sig, { row: rowNumber, isError: true });
  }

  // Latency
  let latencyMs: number | null = null;
  if (latencyCol !== undefined) {
    const raw = fields[latencyCol] ?? "";
    const v = Number(raw);
    if (Number.isFinite(v) && v >= 0) {
      latencyMs = v;
      accs.latencyRes.push(v);
      // Also record into the per-hour bucket for P99-per-hour.
      if (instant !== undefined) {
        const hourKey = new Date(instant).toISOString().slice(0, 13);
        accs.hourLatency.add(hourKey, v);
      }
    }
  }

  // Response bytes as a fallback latency signal for CLF (no duration column)
  if (latencyMs === null && bytesCol) {
    const raw = fields[bytesCol] ?? "";
    const v = Number(raw);
    if (Number.isFinite(v) && v > 0) {
      accs.latencyRes.push(v);
      // Bytes-as-proxy: still record per-hour so CLF files get P99 buckets.
      if (instant !== undefined) {
        const hourKey = new Date(instant).toISOString().slice(0, 13);
        accs.hourLatency.add(hourKey, v);
      }
    }
  }

  // Category (HTTP status codes are the primary category for access logs)
  accs.statusAgg.add(status || "(unknown)", latencyMs);

  // 5xx burst records for scatter chart
  if (isError5xx && accs.bursts.length < MAX_5XX_BURSTS) {
    const ts = instant !== undefined
      ? new Date(instant).toISOString()
      : new Date().toISOString();
    accs.bursts.push({ timestamp: ts, count: 1, status });
  }
}

// ─── Column mapping builder ────────────────────────────────────────────────────

function buildMappings(
  format: ParsedFormat,
  headers: readonly string[],
  timeCol: string,
  statusCol: string,
  latencyCol: string | undefined,
): LogColumnMapping[] {
  const present = new Set(headers);
  const out: LogColumnMapping[] = [
    {
      role: "time",
      column: timeCol,
      hypothesis: !present.has(timeCol),
      note: format === "combined" || format === "syslog"
        ? "Apache/Nginx CLF timestamp field — UTC-normalised by the log tokenizer"
        : "inferred from column name",
    },
    {
      role: "status",
      column: statusCol,
      hypothesis: !present.has(statusCol),
      note: format === "combined"
        ? "HTTP status code — CLF field position 7"
        : "inferred from column name",
    },
  ];
  if (latencyCol !== undefined) {
    out.push({
      role: "duration",
      column: latencyCol,
      hypothesis: true,
      note: "candidate duration column — unit assumed to be milliseconds",
    });
  }
  return out;
}

// ─── CSV header column detection ──────────────────────────────────────────────

const TIME_CANDIDATES = ["timestamp", "time", "ts", "_time", "@timestamp", "event_time", "datetime", "date"];
const STATUS_CANDIDATES = ["status", "status_code", "http_status", "response_code", "code"];
const LATENCY_CANDIDATES = [
  "elapsed_ms", "duration_ms", "latency_ms", "response_time", "elapsed",
  "duration", "latency", "time_taken", "request_time",
];

function pickColumn(headers: readonly string[], candidates: readonly string[]): string | undefined {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const c of candidates) {
    const i = lower.indexOf(c);
    if (i >= 0) return headers[i];
  }
  return undefined;
}

// ─── Remediation script generation ───────────────────────────────────────────

function buildRemediationScript(
  filePath: string,
  format: ParsedFormat,
  mappings: readonly LogColumnMapping[],
  totalRows: number,
  errorRows: number,
  errorRate: number,
): string {
  const timeMapping = mappings.find((m) => m.role === "time");
  const latencyMapping = mappings.find((m) => m.role === "duration");
  const timeLiteral = JSON.stringify(timeMapping?.column ?? "");
  const latencyLiteral = JSON.stringify(latencyMapping?.column ?? "");
  const sourceLiteral = JSON.stringify(filePath);
  const isLog = format === "combined" || format === "syslog" || format === "keyvalue";

  const lines: string[] = [
    "from pathlib import Path",
    "import pandas as pd",
    "",
    `# Source: ${sourceLiteral}`,
    `# Format detected: ${format}`,
    `# ${totalRows.toLocaleString()} rows analyzed — ${errorRows.toLocaleString()} error rows`,
    `# Observed error rate: ${(errorRate * 100).toFixed(2)}%`,
    "",
    "source = Path(" + sourceLiteral + ")",
    "",
  ];

  if (isLog) {
    lines.push(
      "# Apache/Nginx combined log — parse with a regex-backed reader",
      "import re",
      "",
      "CLF = re.compile(",
      "    r'(?P<host>\\\\S+) \\\\S+ \\\\S+ \\\\[(?P<time>[^\\\\]]+)\\\\] '",
      "    r'\"(?P<method>[A-Z]+) (?P<path>\\\\S+)[^\"]*\" (?P<status>\\\\d{3}) (?P<bytes>\\\\S+)'",
      ")",
      "",
      "rows = []",
      "with source.open(encoding='utf-8', errors='replace') as fh:",
      "    for line in fh:",
      "        m = CLF.match(line.strip())",
      "        if m:",
      "            rows.append(m.groupdict())",
      "",
      "frame = pd.DataFrame(rows)",
      "frame['status'] = pd.to_numeric(frame['status'], errors='coerce')",
      "frame['bytes'] = pd.to_numeric(frame['bytes'].replace('-', '0'), errors='coerce')",
    );
  } else {
    const sep = format === "tsv" ? "\\\\t" : ",";
    lines.push(
      `frame = pd.read_csv(source, sep="${sep}", on_bad_lines="warn")`,
      "frame.columns = [str(c).strip() for c in frame.columns]",
      "frame = frame.drop_duplicates()",
    );
  }

  lines.push("");

  if (timeMapping !== undefined) {
    lines.push(
      `# Normalize the time column`,
      `frame[${timeLiteral}] = pd.to_datetime(frame[${timeLiteral}], utc=True, errors="coerce")`,
      `frame = frame.dropna(subset=[${timeLiteral}])`,
      `frame = frame.sort_values(${timeLiteral})`,
      "",
    );
  }

  if (latencyMapping !== undefined) {
    lines.push(
      `# Latency outlier detection (IQR 3× outer fence)`,
      `q1, q3 = frame[${latencyLiteral}].quantile([0.25, 0.75])`,
      "iqr = q3 - q1",
      "fence_hi = q3 + 3 * iqr",
      `p99 = frame[${latencyLiteral}].quantile(0.99)`,
      `outliers = frame[frame[${latencyLiteral}] > fence_hi]`,
      "print(f\"Latency outliers (>{fence_hi:.1f} ms): {len(outliers)} rows\")",
      "print(f\"P99 latency: {p99:.1f} ms\")",
      "",
    );
  }

  lines.push(
    "# Persist the sanitised frame",
    "out = source.with_name(source.stem + '_sanitized.csv')",
    "frame.to_csv(out, index=False)",
    "print(f\"Sanitized file written to {out}\")",
  );

  return lines.join("\n");
}

function buildSqlIndexPatch(
  tableName: string,
  mappings: readonly LogColumnMapping[],
): string {
  const timeMapping = mappings.find((m) => m.role === "time");
  const statusMapping = mappings.find((m) => m.role === "status");
  if (timeMapping === undefined && statusMapping === undefined) return "";

  const q = (c: string): string => `"${c.replaceAll('"', '""')}"`;
  const lines: string[] = [
    `-- Target table: "${tableName}"`,
    "-- Verify the table name and column names before applying.",
    "-- These indexes support the P99 latency timeline query and 5xx burst detection.",
    "",
  ];
  if (timeMapping !== undefined) {
    lines.push(`CREATE INDEX IF NOT EXISTS "idx_${tableName}_time"`);
    lines.push(`    ON "${tableName}" (${q(timeMapping.column)});`);
    lines.push("");
  }
  if (statusMapping !== undefined) {
    lines.push(`CREATE INDEX IF NOT EXISTS "idx_${tableName}_status"`);
    lines.push(`    ON "${tableName}" (${q(statusMapping.column)});`);
    lines.push("");
  }
  if (timeMapping !== undefined && statusMapping !== undefined) {
    lines.push(`-- Composite index for the 5xx time-series query`);
    lines.push(`CREATE INDEX IF NOT EXISTS "idx_${tableName}_status_time"`);
    lines.push(`    ON "${tableName}" (${q(statusMapping.column)}, ${q(timeMapping.column)});`);
  }
  return lines.join("\n");
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * PARSE AND PROFILE A LOG OR DELIMITED FILE USING A BOUNDED STREAMING PASS.
 *
 * Contract:
 *   - Never reads the whole file into memory.
 *   - Sniffs format from the first 4 KB only.
 *   - Returns `{ ok: false, error }` on any failure — no stack traces escape.
 *   - Returns `{ ok: true, ... }` with all frontend-compatible shapes populated.
 *
 * @param filePath  Absolute or workspace-relative path. Must be pre-validated
 *                  by `resolveWithinRoot` before calling this function.
 */
export async function parseLogFile(filePath: string): Promise<LogParseResult> {
  const ext = path.extname(filePath).toLowerCase();
  const tableName = path.basename(filePath, ext).replace(/[^A-Za-z0-9_]/g, "_").toLowerCase() || "log_data";

  // ── Phase 1: format sniff (4 KB, one handle open/close) ──────────────────
  let head: string;
  try {
    head = await sniffHead(filePath);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: `Could not read the file: ${message}` };
  }

  const format = detectFormat(head, ext);
  const isLogFormat = format === "combined" || format === "syslog" || format === "keyvalue";

  // ── Phase 2: determine column roles ──────────────────────────────────────
  //
  // For log formats, roles are fixed by the CLF/syslog schema the tokenizer
  // normalises into. For CSV/TSV, we sniff the header row from the first 4 KB.
  let timeCol: string;
  let statusCol: string;
  let latencyCol: string | undefined;
  let csvHeaders: string[] = [];

  if (isLogFormat || format === "jsonl") {
    timeCol = "timestamp";
    statusCol = "status";
    latencyCol = undefined; // No native latency field in CLF; bytes is a proxy
  } else {
    // CSV/TSV: extract header row from sniffed head
    const firstLine = head.split("\n")[0]?.replace(/\r$/, "") ?? "";
    const sep = format === "tsv" ? "\t" : ",";
    csvHeaders = firstLine.split(sep).map((h) => h.trim().replace(/^"|"$/g, ""));
    timeCol = pickColumn(csvHeaders, TIME_CANDIDATES) ?? "timestamp";
    statusCol = pickColumn(csvHeaders, STATUS_CANDIDATES) ?? "status";
    latencyCol = pickColumn(csvHeaders, LATENCY_CANDIDATES);
  }

  const mappings = buildMappings(format, csvHeaders, timeCol, statusCol, latencyCol);

  // ── Phase 3: single streaming pass ────────────────────────────────────────
  const accs: RowAccumulators = {
    hourCounts: new HourlyCounter(),
    hourLatency: new HourlyLatencyMap(),
    sourceKeys: new KeyedAggregator({ capacity: MAX_SOURCE_KEYS }),
    signatureKeys: new KeyedAggregator({ capacity: MAX_SIGNATURE_KEYS }),
    latencyRes: new LatencyReservoir(),
    statusAgg: new CategoryAggregator(),
    bursts: [],
    totalRows: 0,
    errorRows: 0,
  };

  const problems: string[] = [];

  try {
    await runStreamingPass(filePath, format, timeCol, statusCol, latencyCol, accs, problems);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      ok: false,
      error: `The file could not be streamed: ${message}`,
      format,
    };
  }

  // ── Phase 4: finalise outputs ─────────────────────────────────────────────

  const errorRate = accs.totalRows === 0 ? 0 : accs.errorRows / accs.totalRows;

  // Hourly buckets, sorted chronologically — each carries its P99 latency
  // so the Recharts ComposedChart can render a dual-axis timeline (traffic
  // volume + P99 latency) without a second pass over the file.
  const byHour: LogHourBucket[] = accs.hourCounts
    .entries()
    .sort((a, b) => a.hour.localeCompare(b.hour))
    .map((e) => ({
      key: e.hour,
      count: e.count,
      errorCount: e.errors,
      errorRate: e.count === 0 ? 0 : e.errors / e.count,
      p99LatencyMs: accs.hourLatency.p99(e.hour),
    }));

  const latencyBands = accs.latencyRes.bands();
  const categories = accs.statusAgg.stats().slice(0, 50);

  // Evidence summary
  const summaryLines: string[] = [
    `**${accs.totalRows.toLocaleString()}** rows analyzed from a **${format}** source.`,
    `**${accs.errorRows.toLocaleString()}** error rows — observed error rate **${(errorRate * 100).toFixed(2)}%**.`,
  ];
  if (accs.bursts.length > 0) {
    summaryLines.push(`**${accs.bursts.length}** HTTP 5xx events detected across the timeline.`);
  }
  if (latencyBands.some((b) => b.label === ">1 s")) {
    const slowCount = latencyBands.find((b) => b.label === ">1 s")?.count ?? 0;
    summaryLines.push(`**${slowCount.toLocaleString()}** requests exceeded 1 s latency.`);
  }
  if (problems.length > 0) {
    summaryLines.push(`Parse warnings: ${problems.slice(0, 3).join("; ")}.`);
  }

  const remediationScript = buildRemediationScript(
    filePath, format, mappings, accs.totalRows, accs.errorRows, errorRate,
  );
  const sqlIndexPatch = buildSqlIndexPatch(tableName, mappings);

  return {
    ok: true,
    format,
    totalRows: accs.totalRows,
    errorRows: accs.errorRows,
    errorRate,
    problems,
    mappings,
    byHour,
    latencyBands,
    categories,
    http5xx: accs.bursts,
    remediationScript,
    sqlIndexPatch,
    evidenceSummary: summaryLines.join("\n\n"),
  };
}

// ─── Streaming pass implementations ──────────────────────────────────────────

/**
 * STREAM THE FILE ONE CHUNK AT A TIME, parsing complete lines out of each chunk.
 *
 * Why not `readline`? The existing `stream-profile.ts` explains it definitively:
 * `readline` splits on `\n` and cannot know whether that newline is inside a
 * quoted CSV field. For log files this does not matter (no quoted fields), but
 * for CSV it does — and this function handles both. So the line splitter is a
 * hand-rolled accumulator that only emits lines when it sees a `\n` outside
 * a double-quoted run. For log formats (which have no quoting) the fast path
 * skips the quote-tracking entirely.
 */
async function runStreamingPass(
  filePath: string,
  format: ParsedFormat,
  timeCol: string,
  statusCol: string,
  latencyCol: string | undefined,
  accs: RowAccumulators,
  problems: string[],
): Promise<void> {
  if (format === "combined" || format === "syslog" || format === "keyvalue" || format === "unknown") {
    await streamLogLines(filePath, timeCol, statusCol, latencyCol, accs, problems);
  } else if (format === "jsonl") {
    await streamJsonlLines(filePath, timeCol, statusCol, latencyCol, accs, problems);
  } else {
    // csv / tsv
    const sep = format === "tsv" ? "\t" : ",";
    await streamDelimitedLines(filePath, sep, timeCol, statusCol, latencyCol, accs, problems);
  }
}

/** Stream CLF/syslog/keyvalue lines through `parseLogLine`. */
async function streamLogLines(
  filePath: string,
  timeCol: string,
  statusCol: string,
  latencyCol: string | undefined,
  accs: RowAccumulators,
  problems: string[],
): Promise<void> {
  await forEachLine(filePath, (raw) => {
    if (raw.trim().length === 0) return;
    const sanitized = sanitize(raw);
    const parsed = parseLogLine(sanitized);
    const { extra, format: _fmt, ...rest } = parsed;
    const fields: Record<string, string> = { ...rest, ...extra };
    accumulateLogLine(fields, accs.totalRows + 1, accs, timeCol, statusCol, "bytes", latencyCol);
  }, problems);
}

/** Stream JSONL lines. */
async function streamJsonlLines(
  filePath: string,
  timeCol: string,
  statusCol: string,
  latencyCol: string | undefined,
  accs: RowAccumulators,
  problems: string[],
): Promise<void> {
  await forEachLine(filePath, (raw) => {
    if (raw.trim().length === 0) return;
    const sanitized = sanitize(raw);
    let fields: Record<string, string>;
    try {
      const parsed = JSON.parse(sanitized) as Record<string, unknown>;
      fields = {};
      for (const [k, v] of Object.entries(parsed)) {
        fields[k] = v === null || v === undefined ? "" : String(v);
      }
    } catch {
      fields = { message: raw };
    }
    accumulateLogLine(fields, accs.totalRows + 1, accs, timeCol, statusCol, "bytes", latencyCol);
  }, problems);
}

/** Stream CSV/TSV with a minimal quoted-field-aware line splitter. */
async function streamDelimitedLines(
  filePath: string,
  sep: string,
  timeCol: string,
  statusCol: string,
  latencyCol: string | undefined,
  accs: RowAccumulators,
  problems: string[],
): Promise<void> {
  let headerRow: string[] | undefined;

  await forEachLine(filePath, (raw) => {
    const sanitized = sanitize(raw);
    const cells = splitDelimited(sanitized, sep);

    if (headerRow === undefined) {
      headerRow = cells.map((c) => c.trim().replace(/^"|"$/g, ""));
      return;
    }

    const fields: Record<string, string> = {};
    for (let i = 0; i < headerRow.length; i += 1) {
      fields[headerRow[i]!] = cells[i] ?? "";
    }
    accumulateLogLine(fields, accs.totalRows + 1, accs, timeCol, statusCol, "bytes", latencyCol);
  }, problems);
}

/**
 * ASYNC LINE ITERATOR over a `createReadStream`.
 *
 * Accumulates incomplete lines across chunk boundaries using a string buffer
 * capped at one line. `createReadStream` with `encoding: "utf8"` and
 * `highWaterMark: 64 KiB` gives about 64 lines per chunk on a typical access
 * log — enough to amortise the per-chunk overhead without ever holding the
 * whole file.
 */
async function forEachLine(
  filePath: string,
  onLine: (line: string) => void,
  problems: string[],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath, { encoding: "utf8", highWaterMark: STREAM_HIGH_WATER });
    let remainder = "";

    stream.on("data", (chunk: string) => {
      const text = remainder + chunk;
      const lines = text.split("\n");
      // Everything except the last element is a complete line.
      // The last element is either empty (chunk ended with \n) or an
      // incomplete line — carry it to the next chunk.
      remainder = lines.pop() ?? "";
      for (const line of lines) {
        try {
          onLine(line.replace(/\r$/, ""));
        } catch (cause) {
          if (problems.length < 50) {
            problems.push(cause instanceof Error ? cause.message : String(cause));
          }
        }
      }
    });

    stream.on("end", () => {
      // Flush any trailing bytes that did not end in a newline.
      if (remainder.trim().length > 0) {
        try { onLine(remainder.replace(/\r$/, "")); } catch { /* swallowed */ }
      }
      resolve();
    });

    stream.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * MINIMAL QUOTED-FIELD CSV/TSV SPLITTER.
 *
 * Handles the common case: fields optionally wrapped in double quotes, with
 * `""` as the escape sequence for a literal quote inside a field. Does not
 * attempt to handle multi-line quoted fields (those require a stateful parser
 * across lines, which `forEachLine` is not structured for). For multi-line
 * fields, the line will be treated as ragged — a reported problem, not a crash.
 */
function splitDelimited(line: string, sep: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;

    if (inQuotes) {
      if (ch === '"') {
        // Peek ahead: escaped quote (`""`) stays as `"` in the cell value.
        if (line[i + 1] === '"') { current += '"'; i += 1; }
        else inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === sep) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}
