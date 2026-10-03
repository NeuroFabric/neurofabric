import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ToolDescriptor } from "../core/types.ts";
import { FileProfile, MAX_PROBLEMS, resolveOutliers, streamCsvRecords } from "./stream-profile.ts";
import { readJsonl, looksLikeJsonl } from "../ingestion/jsonl-tokenizer.ts";
import { readLog, looksLikeLog } from "../ingestion/log-tokenizer.ts";
import { open, readFile } from "node:fs/promises";

/**
 * The Stage 1 capability set: exactly two, because the acceptance scenario needs
 * exactly two. See `platform/conductor/DESIGN.md`.
 *
 * Both are ordinary kernel tools. A capability is a descriptor (which is what
 * policy evaluates) plus a function. Nothing here touches recovery, limits or
 * policy — a third capability would be a third descriptor, not a kernel change.
 */

/** Parsed rows plus the shape the acceptance run asserts on. */
export interface CsvReadResult {
  path: string;
  headers: string[];
  rowCount: number;
  /** A short numeric/date summary per column, for the renderer. */
  columns: { name: string; kind: "number" | "text" | "empty"; min?: number; max?: number; sum?: number }[];
  /** The first few rows, enough to chart and small enough to never blow a budget. */
  sample: Record<string, string>[];
  /**
   * EVERY row, for analysis rather than charting.
   *
   * Separate from `sample` on purpose. The sample is capped so a chart cannot
   * blow a budget; analysis is the opposite requirement, because an analysis
   * that silently reads only the first N rows reports a confident answer about
   * a fraction of the data. A real 101-row export was half-analysed before this
   * existed, and nothing on the page said so.
   */
  rows: Record<string, string>[];
  /**
   * What is wrong with the file, when something is. Never an exception: a
   * malformed file is a RESULT the Conductor has to reason about, because the
   * difference between "the file is broken" and "the tool broke" is the whole
   * difference between a good error message and a mystery.
   */
  problems: string[];
  /**
   * THE WHOLE-FILE PROFILE, or absent when the caller did not stream.
   *
   * Optional because the type is also built by hand in tests and by the web
   * layer, and an absent profile must mean "fall back to the rows you have"
   * rather than an exception at an analysis that was already going to work.
   */
  profile?: import("./stream-profile.ts").StreamProfile;
}

const MAX_ROWS_SCANNED = 10_000;
const SAMPLE_ROWS = 50;

/**
 * THE RETAINED WINDOW, and the honest name for it.
 *
 * Every stage of the old reader scaled with the FILE: the whole text, then an
 * array of cells per row, then an object per row. This is the one bounded piece
 * of row retention left, and it is what keeps the row-wise work -- cross-column
 * checks, the renderer's sample, the profile of a 200-row sample -- behaving
 * exactly as before.
 *
 * It is a CAP, not a sample: the first N rows, in order. Which is why the profile
 * beside it matters. The statistics now cover every row in the file while this
 * window keeps only what genuinely needs records.
 */
const RETAINED_ROWS = MAX_ROWS_SCANNED;

/**
 * THE FORMATS THIS READER ACCEPTS.
 *
 * A `.csv` was the only door into this product, which meant a DevSecOps team
 * holding a JSONL telemetry feed or a pile of server logs had nothing to point
 * it at. Omnivorosity is the fix, and the formats are recognised rather than
 * declared because a file's name is a convention and its contents are evidence.
 */
export type DocumentFormat = "csv" | "jsonl" | "log";

const FORMAT_BY_EXTENSION: Record<string, DocumentFormat> = {
  ".jsonl": "jsonl", ".ndjson": "jsonl", ".jsonlines": "jsonl",
  ".log": "log",
  ".csv": "csv", ".tsv": "csv",
};

/** The head of a file, which is all the sniff needs and never the whole file. */
async function sampleHead(target: string, bytes = 8 * 1024): Promise<string> {
  const handle = await open(target, "r");
  try {
    const buffer = Buffer.allocUnsafe(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * DECIDE WHAT A FILE IS.
 *
 * The extension is a HINT and the content decides, in that order. Content wins
 * because the case that matters is exactly the one where the name lies: a file
 * called `service.log` holding one JSON object per line is a JSONL feed, and
 * treating it as text throws away every field it has. Equally, a file called
 * `.jsonl` holding a CSV is read as the CSV it is.
 *
 * Falls back to CSV, because CSV is the format this product has always read and
 * the fallback that treats an unrecognised file as something has always worked is
 * safer than one that refuses.
 */
export async function detectFormat(target: string): Promise<DocumentFormat> {
  const extension = path.extname(target).toLowerCase();
  const hinted = FORMAT_BY_EXTENSION[extension];
  let sample: string;
  try {
    sample = await sampleHead(target);
  } catch {
    return hinted ?? "csv";
  }
  if (looksLikeJsonl(sample)) return "jsonl";
  // The extension decides between the remaining two, and the CONTENT is only
  // consulted for a file whose extension says nothing useful. That ordering is
  // deliberate: a structural log heuristic applied to a named CSV is how an
  // ordinary export gets handed to the wrong reader with total confidence.
  if (hinted === "log") return "log";
  if (hinted === "csv") return "csv";
  return looksLikeLog(sample) ? "log" : "csv";
}

/**
 * READ A DELIMITED FILE AS A STREAM.
 *
 * The replacement for `readFile(path, "utf8")`, and the change is not stylistic:
 * the old call put the entire export in memory as one string before a single row
 * was parsed, so a 60 MB file was a 60 MB string -- twice, once for the text and
 * once for the cells parsed out of it. Nothing downstream could undo that,
 * because by the time the parse finished the file was already resident.
 *
 * WHAT IS PRESERVED, because a reader is a PARSER first and a memory strategy
 * second: quoted fields, escaped quotes, a mid-field quote, CRLF, blank lines
 * that are not records, a final record without a terminator, a file that ends
 * inside a quoted field, empty and duplicated headers, ragged rows, and the
 * exact wording of every one of those problems. `reader-shape.test.ts` asserts
 * that wording against a real export, and a streaming reader that quietly changed
 * what counts as a record would trade a crash for a wrong number.
 *
 * WHAT CHANGED, and it is a fix rather than a loss: `rowCount` is now the number
 * of rows in the FILE rather than the number that survived the 10,000-row parse
 * cap. The old value made a 500,000-row export report "10,001 rows read", with
 * nothing on the page to say the other 489,999 were never looked at.
 */
async function streamCsvRead(target: string): Promise<CsvReadResult> {
  const problems: string[] = [];
  const note = (message: string): void => {
    if (problems.length < MAX_PROBLEMS) problems.push(message);
  };

  const profile = new FileProfile(target, { retain: RETAINED_ROWS });
  let headers: string[] = [];
  let sawHeader = false;
  let rowCount = 0;

  await streamCsvRecords(target, (cells, line) => {
    if (!sawHeader) {
      sawHeader = true;
      headers = cells.map((cell) => cell.trim());
      profile.setHeaders(cells);
      headers.forEach((header, index) => {
        if (header.length === 0) note(`column ${index + 1} has no header name`);
      });
      const duplicate = headers.find((header, index) => header.length > 0 && headers.indexOf(header) !== index);
      if (duplicate !== undefined) note(`the header "${duplicate}" appears more than once`);
      return;
    }
    rowCount += 1;
    // Raggedness is a property of the FILE, so it is checked over all of it. The
    // old parser stopped looking at row 10,001 and reported a tidy file for
    // everything past it. The message count is capped, because a file ragged on
    // every row must not produce half a million strings.
    if (cells.length !== headers.length) {
      note(`row ${line} has ${cells.length} value(s) but the header declares ${headers.length}`);
    }
    profile.push(cells);
  }, { problems });

  if (!sawHeader) {
    return { path: target, headers: [], rowCount: 0, columns: [], sample: [], rows: [], problems: [...problems, "the file has no rows"] };
  }

  const rows = profile.rows();
  const snapshot = profile.snapshot();
  // THE FENCES, resolved over the WHOLE file rather than the retained window.
  //
  // This is the one place the reader spends a second pass, and it is what makes
  // the per-column statistics mean something on an export larger than the
  // retention cap: the quartiles come from the reservoir, and the COUNTS are then
  // verified against every row so a figure the user reads as "how many bad cells
  // do I have" is a measurement of the file rather than of 4096 of its rows.
  snapshot.outliers = await resolveOutliers(target, snapshot);
  const columns = headers.map((name) => {
    const shot = snapshot.columns[name];
    // The same rule as the in-memory reader: numeric only when EVERY value
    // present in the column parses as a number. One "N/A" makes it a text column,
    // because that is a fact about the producer rather than a value to drop.
    const present = (shot?.seen ?? 0) - (shot?.empty ?? 0);
    if (present === 0) return { name, kind: "empty" as const };
    if ((shot?.measured ?? 0) !== present) return { name, kind: "text" as const };
    return {
      name, kind: "number" as const,
      min: shot?.min ?? undefined, max: shot?.max ?? undefined, sum: shot?.sum ?? undefined,
    };
  });

  return {
    path: target,
    headers,
    // THE TRUTH, not the size of the window this reader kept.
    rowCount,
    columns,
    sample: rows.slice(0, SAMPLE_ROWS),
    rows,
    problems,
    profile: snapshot,
  };
}

/**
 * A deliberately small CSV reader: quoted fields, escaped quotes, CRLF.
 *
 * Small is the point. The acceptance scenario is "make me a dashboard from a
 * sales file", and a parser that silently accepts a ragged row is how a real
 * customer ends up with a chart of the wrong numbers. Everything it cannot
 * account for becomes a `problems` entry rather than a thrown error.
 */
export function parseCsv(text: string): { headers: string[]; rows: string[][]; problems: string[] } {
  const problems: string[] = [];
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  let line = 1;

  while (i < text.length && rows.length <= MAX_ROWS_SCANNED) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      if (ch === "\n") line += 1;
      field += ch; i += 1; continue;
    }
    if (ch === '"') {
      if (field.length > 0) problems.push(`line ${line}: a quote appeared mid-field`);
      inQuotes = true; i += 1; continue;
    }
    if (ch === ",") { row.push(field); field = ""; i += 1; continue; }
    if (ch === "\r") { i += 1; continue; }
    if (ch === "\n") {
      // A blank line is not a record. The conventional final newline on a file
      // must not manufacture a row of one empty value against a twelve-column
      // header -- which is what a real export did, and which made the renderer
      // refuse a file that was not actually ragged.
      if (row.length > 0 || field.length > 0) { row.push(field); rows.push(row); }
      row = []; field = ""; line += 1; i += 1; continue;
    }
    field += ch; i += 1;
  }
  // Whatever is left over is a final record WITHOUT its terminator. A file that
  // ends on a newline has nothing left, and pushing an empty row here is what
  // made every conventionally-terminated CSV look ragged. `sawContent` used to
  // stand in for "there is something here", but it is true of the whole file,
  // not of this tail -- which is why the trailing-newline case slipped past it.
  if (row.length > 0 || field.length > 0) { row.push(field); rows.push(row); }
  if (inQuotes) problems.push("the file ends inside a quoted field");

  if (rows.length === 0) return { headers: [], rows: [], problems: [...problems, "the file has no rows"] };

  const headers = rows[0].map((h, index) => {
    const trimmed = h.trim();
    if (trimmed.length === 0) problems.push(`column ${index + 1} has no header name`);
    return trimmed;
  });
  const body = rows.slice(1);
  const duplicate = headers.find((h, index) => h.length > 0 && headers.indexOf(h) !== index);
  if (duplicate !== undefined) problems.push(`the header "${duplicate}" appears more than once`);
  for (const [offset, cells] of body.entries()) {
    if (cells.length !== headers.length) {
      problems.push(`row ${offset + 2} has ${cells.length} value(s) but the header declares ${headers.length}`);
    }
  }
  return { headers, rows: body, problems };
}

/**
 * A deliberately small CSV reader, over a STRING.
 *
 * It stays, and it is now the SECOND reader rather than the only one, because
 * two callers genuinely cannot stream: the browser upload path hands over text
 * it has already read, and the tests exercise the parser's rules directly. What
 * is important is that there is only ONE set of rules -- `streamCsvRecords`
 * implements these same rules byte for byte -- rather than one parser for files
 * and a different one for uploads, which is how a parser ends up with two
 * answers about the same file.
 */

export async function csvRead(input: { path: string }, boundary?: { boundary?: { check(p: string): { allowed: boolean } } }): Promise<CsvReadResult> {
  const target = String(input.path ?? "");
  if (boundary?.boundary) {
    const verdict = boundary.boundary.check(target);
    if (!verdict.allowed) throw new Error(`csv_read: the path is outside the workspace boundary (${verdict.allowed ? "" : "refused"})`);
  }

  // THE FRONT DOOR IS FORMAT-AGNOSTIC NOW. Each branch produces the same
  // normalised record shape, so everything downstream -- the profile, the fences,
  // the aggregators, the report, the dashboard -- is unchanged and format-blind.
  // That is what "omnivorous" has to mean: one pipeline, several diets.
  const format = await detectFormat(target);
  if (format === "csv") return streamCsvRead(target);

  const problems: string[] = [];
  const note = (message: string): void => {
    if (problems.length < MAX_PROBLEMS) problems.push(message);
  };
  const parsed = format === "jsonl"
    ? await readJsonl(target, { retain: RETAINED_ROWS, problems })
    : await readLog(target, { retain: RETAINED_ROWS, problems });

  if (parsed.headers.length === 0) {
    return { path: target, headers: [], rowCount: 0, columns: [], sample: [], rows: [], problems: [...problems, "the file has no rows"] };
  }

  // The same profile, built from the tokenised window. The accumulators downstream
  // cannot tell a JSONL feed from a CSV export, which is the point: the anomaly
  // agent answers the same questions about both.
  const profile = new FileProfile(target, { retain: RETAINED_ROWS });
  profile.setHeaders(parsed.headers);
  for (const row of parsed.rows) profile.push(parsed.headers.map((header) => row[header] ?? ""));
  const snapshot = profile.snapshot();
  snapshot.outliers = await resolveOutliers(target, snapshot);

  const columns = parsed.headers.map((name) => {
    const shot = snapshot.columns[name];
    const present = (shot?.seen ?? 0) - (shot?.empty ?? 0);
    if (present === 0) return { name, kind: "empty" as const };
    if ((shot?.measured ?? 0) !== present) return { name, kind: "text" as const };
    return {
      name, kind: "number" as const,
      min: shot?.min ?? undefined, max: shot?.max ?? undefined, sum: shot?.sum ?? undefined,
    };
  });

  return {
    path: target,
    headers: parsed.headers,
    rowCount: parsed.records,
    columns,
    sample: parsed.rows.slice(0, SAMPLE_ROWS),
    rows: parsed.rows,
    problems,
    profile: snapshot,
  };
}

/**
 * A single self-contained HTML page: one chart, no network, no script from
 * anywhere else. A dashboard that phones home is not a dashboard the kernel
 * governed, it is a dashboard that exfiltrated the CSV.
 */
export async function renderPage(input: {
  path: string;
  title?: string;
  columns: CsvReadResult["columns"];
  sample: Record<string, string>[];
  rowCount: number;
}): Promise<{ path: string; bytes: number }> {
  const out = String(input.path);
  const title = String(input.title ?? "Dashboard");
  const category = input.columns.find((c) => c.kind === "text") ?? input.columns[0];
  const value = [...input.columns].reverse().find((c) => c.kind === "number" && c.name !== category?.name)
    ?? input.columns.find((c) => c.kind === "number");

  const labels: string[] = [];
  const values: number[] = [];
  if (category && value) {
    for (const row of input.sample) {
      const raw = row[category.name];
      const numeric = Number(row[value.name]);
      if (raw !== undefined && raw.trim().length > 0 && Number.isFinite(numeric)) {
        labels.push(raw.trim());
        values.push(numeric);
      }
    }
  }

  const max = Math.max(1, ...values.map(Math.abs));
  const bars = labels.map((label, index) => {
    const height = Math.max(1, Math.round((Math.abs(values[index]) / max) * 180));
    return `    <div class="bar" title="${escapeHtml(label)}: ${values[index]}">
      <div class="fill" style="height:${height}px"></div>
      <div class="label">${escapeHtml(label)}</div>
    </div>`;
  }).join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem; color: #16181d; background: #fff; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .meta { color: #5b616e; margin-bottom: 1.5rem; }
  .chart { display: flex; align-items: flex-end; gap: 10px; border-bottom: 1px solid #16181d; padding-bottom: 2px; }
  .bar { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; }
  .fill { background: #16181d; width: 26px; }
  .label { font-size: 11px; color: #5b616e; margin-top: 4px; max-width: 70px; overflow: hidden; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="meta">${input.rowCount} row(s)${value ? ` &middot; ${escapeHtml(value.name)} by ${escapeHtml(category?.name ?? "row")}` : ""}</p>
<div class="chart">
${bars}
</div>
</body>
</html>
`;
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, html, "utf8");
  return { path: out, bytes: Buffer.byteLength(html, "utf8") };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

export const CSV_READ: ToolDescriptor = {
  name: "csv_read",
  version: "stage1",
  description: "Read a CSV file inside the workspace and summarise its shape",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  outputSchema: { type: "object" },
  capabilities: ["csv.read"],
  permissions: ["tool:csv_read"],
  riskLevel: "READ_ONLY",
  idempotency: "IDEMPOTENT",
  sideEffect: "PURE",
  timeoutMs: 10_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
};

export const RENDER_PAGE: ToolDescriptor = {
  name: "render_page",
  version: "stage1",
  description: "Render a self-contained one-page HTML dashboard from CSV data",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" }, title: { type: "string" },
      columns: { type: "array" }, sample: { type: "array" }, rowCount: { type: "number" },
    },
    required: ["path", "columns", "sample", "rowCount"],
  },
  outputSchema: { type: "object" },
  capabilities: ["artifact.page"],
  permissions: ["tool:render_page"],
  riskLevel: "WRITE",
  idempotency: "IDEMPOTENT",
  sideEffect: "SIDE_EFFECTING",
  timeoutMs: 10_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
};

export const STAGE1_CAPABILITIES: ToolDescriptor[] = [CSV_READ, RENDER_PAGE];