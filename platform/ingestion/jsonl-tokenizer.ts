import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * JSONL: one JSON value per line, for DevSecOps telemetry.
 *
 * === WHY readline IS CORRECT HERE, AND WAS WRONG FOR CSV ===
 *
 * The CSV reader is a byte-level state machine, and deliberately so: a newline
 * inside a quoted field is not a record boundary, and a line-splitting reader
 * reports a real Pega export as ragged. JSONL is the opposite case. Its unit IS
 * the line -- the format is defined as one self-contained JSON value per line --
 * so there is no quoting to confuse and `readline` is exactly the right tool.
 *
 * Using the CSV machinery here would have been a category error dressed as
 * consistency, and it would have been slower.
 *
 * === WHAT COMES OUT ===
 *
 * Normalised RECORDS, keyed by field name, with every value a string. That is the
 * same shape `csvRead` produces for a delimited file, which is the point: one
 * profile pipeline, one set of accumulators, one set of fences. A JSONL feed and a
 * CSV export of the same events are profiled by the same code, so a dashboard
 * cannot disagree with itself about which one it is looking at.
 *
 * === THE HONEST PARTS ===
 *
 * A line that is not JSON does not stop the feed. Telemetry pipelines drop,
 * truncate and interleave lines, and a reader that refuses the file on the first
 * malformed record is a reader that turns a partial outage into no data at all.
 * So a bad line is counted and reported, up to a cap, and the rest of the file is
 * still read. That is a deliberate choice about WHICH failure hurts less, and it
 * is reported rather than swallowed.
 *
 * The field set is DISCOVERED, not declared -- JSONL has no header row. Columns
 * are added in first-seen order up to a budget, and anything beyond it is kept
 * intact inside a folded field rather than being dropped, because telemetry feeds
 * carry fields nobody predicted and a discarded one is a silent gap in the
 * analysis.
 */

/** Distinct fields kept as columns. Beyond this, the rest are folded into one. */
export const MAX_JSONL_FIELDS = 64;

/** Malformed lines reported before the list stops growing. */
export const MAX_JSONL_PROBLEMS = 50;

/** Where the fields beyond the budget go. Named, so it is visible rather than lost. */
export const OVERFLOW_FIELD = "__other_fields";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface JsonlOptions {
  /** Bounded retention, matching the CSV reader's window. */
  readonly retain?: number;
  readonly problems?: string[];
}

/**
 * FLATTEN A JSON VALUE TO THE STRING THE PROFILE SEES.
 *
 * Scalars become their own text; objects and arrays become compact JSON rather
 * than being dropped, so a nested `{"user":{"id":7}}` still contributes `id` to
 * the analysis rather than counting as one opaque cell.
 */
function flatten(value: JsonValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** The leaf fields of a JSON object, one level of nesting flattened away. */
function leaves(record: { [key: string]: JsonValue }): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value)) {
        out.push([`${key}.${inner}`, flatten(innerValue)]);
      }
      continue;
    }
    out.push([key, flatten(value)]);
  }
  return out;
}

export interface JsonlResult {
  /** Field names in first-seen order, plus `__other_fields` if the budget was hit. */
  readonly headers: string[];
  readonly rows: Record<string, string>[];
  readonly records: number;
  /** Lines that were not valid JSON objects. Counted, bounded, never thrown on. */
  readonly malformed: number;
}

/**
 * READ A JSONL FEED AS NORMALISED RECORDS.
 *
 * Streams line by line and stops retaining once the budget is reached, so a
 * gigabyte of telemetry costs a bounded window and a bounded column set -- the
 * same memory contract the CSV reader offers, which is what lets both formats go
 * through one pipeline.
 */
export async function readJsonl(file: string, options: JsonlOptions = {}): Promise<JsonlResult> {
  const problems = options.problems ?? [];
  const retain = options.retain ?? 10_000;
  const headers: string[] = [];
  const known = new Set<string>();
  const rows: Record<string, string>[] = [];
  let records = 0;
  let malformed = 0;
  let overflowed = false;

  const note = (message: string): void => {
    if (problems.length < MAX_JSONL_PROBLEMS) problems.push(message);
  };

  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024 });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  for await (const raw of lines) {
    const line = raw.trim();
    // A blank line is not a record, and the conventional trailing newline must
    // not manufacture one -- the same rule the CSV reader follows.
    if (line.length === 0) continue;

    let parsed: JsonValue;
    try {
      parsed = JSON.parse(line) as JsonValue;
    } catch {
      malformed += 1;
      if (malformed <= 5) note(`line ${records + malformed}: not valid JSON`);
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      malformed += 1;
      note(`line ${records + malformed}: not a JSON object`);
      continue;
    }

    records += 1;
    const row: Record<string, string> = {};
    const overflow: Record<string, string> = {};
    for (const [key, value] of leaves(parsed as { [key: string]: JsonValue })) {
      if (known.has(key)) {
        row[key] = value;
        continue;
      }
      // The budget is enforced with a placeholder, not a rejection: the field is
      // still carried, just not as a column of its own.
      if (headers.length < MAX_JSONL_FIELDS) {
        known.add(key);
        headers.push(key);
        row[key] = value;
        continue;
      }
      overflowed = true;
      overflow[key] = value;
    }
    if (Object.keys(overflow).length > 0) {
      if (!known.has(OVERFLOW_FIELD)) {
        known.add(OVERFLOW_FIELD);
        headers.push(OVERFLOW_FIELD);
      }
      row[OVERFLOW_FIELD] = JSON.stringify(overflow);
    }
    if (rows.length < retain) rows.push(row);
  }

  if (records === 0 && malformed === 0) note("the feed holds no records");
  if (overflowed) note(`more than ${MAX_JSONL_FIELDS} distinct fields; the rest are folded into ${OVERFLOW_FIELD}`);
  return { headers, rows, records, malformed };
}

/**
 * IS THIS FILE JSONL?
 *
 * Decided by CONTENT, not by the extension, because a `.log` file holding one
 * JSON object per line is a JSONL feed and treating it as text would throw away
 * every field. The extension is a hint; the first non-blank line decides.
 */
export function looksLikeJsonl(sample: string): boolean {
  for (const raw of sample.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (!line.startsWith("{")) return false;
    try {
      const parsed = JSON.parse(line) as JsonValue;
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    } catch {
      return false;
    }
  }
  return false;
}