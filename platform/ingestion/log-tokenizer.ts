import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * RAW SERVER LOGS, which are not one format but four wearing the same coat.
 *
 * A `.log` file from a real estate is Apache combined beside syslog beside a
 * JSON logger's output beside a bare `key=value` dump, usually concatenated. There
 * is no header row, no delimiter and no schema, so the reader has to RECOGNISE
 * rather than parse -- and the recogniser has to be honest when it fails.
 *
 * === WHY THE FIELDS ARE NAMED THE SAME ONES THE PIPELINE EXPECTS ===
 *
 * The output is normalised to `{timestamp, level, host, message, ...}`, which are
 * the same names `resolveMappings` looks for when it decides which column is the
 * time, the source, the severity and the text. A log line therefore flows into the
 * existing KeyedAggregator and HourlyCounter accumulators with no new code
 * downstream at all, and the "what is wrong with this file" agent answers the same
 * questions about a log that it does about a CSV.
 *
 * === WHAT UNRECOGNISED IS ===
 *
 * Never discarded. A line that matches no pattern still becomes a record whose
 * `message` is the whole line, so it is counted, ranked and searchable. Dropping
 * it would be the worst possible failure here: an operator's log is exactly the
 * thing they cannot afford to have holes in, and a parser that silently loses
 * lines is how an incident review concludes that nothing happened.
 *
 * The confidence is recorded too. `format: "unstructured"` is a fact about the
 * data that the report can show, rather than a shrug buried in a helper.
 */

export type LogFormat = "combined" | "syslog" | "json" | "keyvalue" | "unstructured";

/** Extra key=value columns kept beyond the normalised schema. */
export const MAX_EXTRA_LOG_FIELDS = 16;

export interface LogLine {
  readonly timestamp: string;
  readonly level: string;
  readonly host: string;
  readonly message: string;
  readonly method: string;
  readonly path: string;
  readonly status: string;
  readonly bytes: string;
  readonly format: LogFormat;
  /**
   * The key=value pairs BEYOND the normalised schema.
   *
   * Promoted to real columns by the reader, because the alternative was worse:
   * an application logger's most interesting fields (`latency_ms`, `service`,
   * `trace_id`) are exactly the ones the eight normalised names do not cover, so a
   * profile of a log would have found no numbers in it at all. A log is the diet
   * this product is worst at serving, and that is a fixable reason.
   */
  readonly extra: Readonly<Record<string, string>>;
}

/** Apache/nginx combined: `host - - [ts] "GET /p HTTP/1.1" 200 1234`. */
const COMBINED = /^(?<host>\S+)\s+\S+\s+\S+\s+\[(?<ts>[^\]]+)\]\s+"(?<method>[A-Z]+)\s+(?<path>\S+)[^"]*"\s+(?<status>\d{3})\s+(?<bytes>\S+)/;

/** RFC 3164 syslog: `Sep 29 03:14:15 host app[123]: message`. */
const SYSLOG = /^(?<ts>[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(?<host>\S+)\s+(?<app>[^\s:\[]+)(\[\d+\])?:\s*(?<message>.*)$/;

/** `key=value` pairs, the shape most application loggers actually emit. */
const KEY_VALUE = /(?:^|\s)(?<key>[A-Za-z_][\w.-]*)=(?:"(?<quoted>[^"]*)"|(?<bare>\S+))/g;

const LEVEL = /\b(TRACE|DEBUG|INFO|NOTICE|WARN(?:ING)?|ERROR|ERR|FATAL|CRITICAL|SEVERE)\b/i;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Apache's bracket date: `30/Sep/2026:09:00:00 +0000`. NOT readable by Date. */
const APACHE_DATE = /^(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?$/;

/**
 * NORMALISE A TIMESTAMP.
 *
 * Syslog omits the year, which is the format's oldest wart: `Sep 29 03:14:15`
 * is ambiguous until you supply a year. Rather than guess one and report a spike
 * in January 1970, the year is left empty and the row's timestamp is simply
 * absent from the timeline -- an hour that cannot be placed is not evidence, and
 * counting it under a fabricated year would put traffic in the wrong bucket.
 *
 * Apache's date is handled explicitly because `Date.parse` cannot read
 * `30/Sep/2026:09:00:00 +0000` and silently returns NaN for it. That matters
 * more than it looks: it is the single most common timestamp in an access log,
 * and returning NaN means every request line lands outside the timeline, which
 * reads as "this log has no traffic pattern" rather than as "we could not read
 * the date" -- the silent-partial-answer failure in its purest form.
 */
function normaliseTimestamp(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
  }
  const apache = APACHE_DATE.exec(trimmed);
  if (apache !== null) {
    const [, day, month, year, hour, minute, second, zone] = apache;
    const monthIndex = MONTHS.indexOf(month ?? "");
    if (monthIndex < 0) return "";
    const offset = zone === undefined ? "+0000" : zone;
    const iso = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${day}T${hour}:${minute}:${second}${offset.slice(0, 3)}:${offset.slice(3)}`;
    const parsed = Date.parse(iso);
    return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString();
  }
  return "";
}

/** Recognise one line. Never throws, never returns nothing. */
export function parseLogLine(raw: string): LogLine {
  const line = raw.replace(/\r$/, "");
  const empty: LogLine = {
    timestamp: "", level: "", host: "", message: line,
    method: "", path: "", status: "", bytes: "", format: "unstructured",
    extra: {},
  };
  if (line.trim().length === 0) return empty;

  const combined = COMBINED.exec(line);
  if (combined?.groups !== undefined) {
    const g = combined.groups as Record<string, string>;
    return {
      ...empty,
      timestamp: normaliseTimestamp(g["ts"] ?? ""),
      host: g["host"] ?? "",
      method: g["method"] ?? "",
      path: g["path"] ?? "",
      status: g["status"] ?? "",
      bytes: g["bytes"] ?? "",
      message: line,
      format: "combined",
      extra: {},
    };
  }

  const syslog = SYSLOG.exec(line);
  if (syslog?.groups !== undefined) {
    const g = syslog.groups as Record<string, string>;
    const message = g["message"] ?? "";
    const level = LEVEL.exec(message)?.[1] ?? "";
    return {
      ...empty,
      // Deliberately empty for syslog: see `normaliseTimestamp`.
      timestamp: normaliseTimestamp(g["ts"] ?? ""),
      host: g["host"] ?? "",
      level: level.toUpperCase(),
      message,
      format: "syslog",
      extra: {},
    };
  }

  // key=value pairs, with the leftover prose kept as the message.
  KEY_VALUE.lastIndex = 0;
  const pairs: Record<string, string> = {};
  let consumed = 0;
  for (const match of line.matchAll(KEY_VALUE)) {
    const key = match.groups?.["key"];
    if (key === undefined) continue;
    pairs[key] = match.groups?.["quoted"] ?? match.groups?.["bare"] ?? "";
    consumed += (match[0] ?? "").length;
  }
  if (Object.keys(pairs).length >= 2) {
    const message = line.replace(KEY_VALUE, "").replace(/\s{2,}/g, " ").trim();
    // The normalised names claim their own fields; everything else the logger
    // emitted is promoted to a column, which is what makes a log profileable.
    const NORMALISED = new Set([...LOG_COLUMNS, "time", "timestamp", "ts", "lvl", "severity", "hostname", "server", "uri", "url", "code", "size"]);
    const extra: Record<string, string> = {};
    for (const [key, value] of Object.entries(pairs)) {
      if (NORMALISED.has(key)) continue;
      extra[key] = value;
    }
    return {
      ...empty,
      timestamp: normaliseTimestamp(pairs["time"] ?? pairs["timestamp"] ?? pairs["ts"] ?? ""),
      level: (pairs["level"] ?? pairs["lvl"] ?? pairs["severity"] ?? "").toUpperCase(),
      host: pairs["host"] ?? pairs["hostname"] ?? pairs["server"] ?? "",
      message: message.length > 0 ? message : line,
      method: pairs["method"] ?? "",
      path: pairs["path"] ?? pairs["uri"] ?? pairs["url"] ?? "",
      status: pairs["status"] ?? pairs["code"] ?? "",
      bytes: pairs["bytes"] ?? pairs["size"] ?? "",
      format: "keyvalue",
      extra,
    };
  }

  // Nothing matched. Kept whole, because an operator's log is the last place
  // where dropping lines is acceptable.
  const bare = LEVEL.exec(line)?.[1] ?? "";
  return { ...empty, level: bare.toUpperCase(), format: "unstructured" };
}

export interface LogReadOptions {
  readonly retain?: number;
  readonly problems?: string[];
}

export interface LogReadResult {
  readonly headers: string[];
  readonly rows: Record<string, string>[];
  readonly records: number;
  /** How many lines matched no known format. Reported, never hidden. */
  readonly unstructured: number;
  readonly byFormat: Readonly<Record<string, number>>;
}

/** The columns a log is normalised into, in the order the pipeline expects them. */
export const LOG_COLUMNS = ["timestamp", "level", "host", "method", "path", "status", "bytes", "message"] as const;

/**
 * READ A LOG FILE AS NORMALISED RECORDS.
 *
 * One pass, one line at a time, with a bounded retention window and a bounded
 * field set -- so a multi-gigabyte log costs the same as a small one, which is
 * the whole reason this reader exists rather than `split("\n")`.
 */
export async function readLog(file: string, options: LogReadOptions = {}): Promise<LogReadResult> {
  const problems = options.problems ?? [];
  const retain = options.retain ?? 10_000;
  const rows: Record<string, string>[] = [];
  const byFormat: Record<string, number> = {};
  const extraHeaders: string[] = [];
  let records = 0;
  let unstructured = 0;

  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024 });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const raw of lines) {
    if (raw.trim().length === 0) continue;
    const parsed = parseLogLine(raw);
    records += 1;
    byFormat[parsed.format] = (byFormat[parsed.format] ?? 0) + 1;
    if (parsed.format === "unstructured") unstructured += 1;
    for (const key of Object.keys(parsed.extra)) {
      if (!extraHeaders.includes(key) && extraHeaders.length < MAX_EXTRA_LOG_FIELDS) extraHeaders.push(key);
    }
    // Extras are FLATTENED onto the record rather than nested, because the
    // pipeline reads columns by name and a nested object would be one opaque cell.
    if (rows.length < retain) {
      const { extra, ...rest } = parsed;
      rows.push({ ...rest, ...extra });
    }
  }

  if (records === 0 && problems.length < 5) problems.push("the log holds no lines");
  if (unstructured > 0 && problems.length < 5) {
    problems.push(`${unstructured} line(s) matched no known log format and were kept whole`);
  }
  return { headers: [...LOG_COLUMNS, ...extraHeaders], rows, records, unstructured, byFormat };
}

/**
 * IS THIS A LOG?
 *
 * STRUCTURAL SIGNATURES ONLY, and that restriction was learned from a bug. An
 * earlier version also accepted "the line mentions a level word", which matched
 * every CSV row that contained the literal `ERROR` in a status column -- so a
 * perfectly ordinary export was announced as a log file and handed to the log
 * reader, which kept every line whole and found no columns in it.
 *
 * A heuristic that matches data is worse than no heuristic, because it is
 * confident. So the level word on its own is not evidence; a bracket-delimited
 * timestamp, a syslog prefix or a leading `key=` is.
 */
export function looksLikeLog(sample: string): boolean {
  for (const raw of sample.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (COMBINED.test(line) || SYSLOG.test(line)) return true;
    if (/^\w+=/.test(line)) return true;
    return false;
  }
  return false;
}