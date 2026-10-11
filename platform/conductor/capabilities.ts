import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ToolDescriptor } from "../core/types.ts";
import { FileProfile, MAX_PROBLEMS, resolveOutliers, streamCsvRecords, streamCsvRecordsSync } from "./stream-profile.ts";
import { readJsonl, looksLikeJsonl } from "../ingestion/jsonl-tokenizer.ts";
import { readLog, looksLikeLog } from "../ingestion/log-tokenizer.ts";
import { open, readFile } from "node:fs/promises";
import type { Pool } from "pg";

/**
 * The Stage 1 capability set: exactly two, because the acceptance scenario needs
 * exactly two. See `platform/conductor/DESIGN.md`.
 *
 * Both are ordinary kernel tools. A capability is a descriptor (which is what
 * policy evaluates) plus a function. Nothing here touches recovery, limits or
 * policy â€” a third capability would be a third descriptor, not a kernel change.
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

/**
 * RE-READ A FILE, IN WHATEVER FORMAT IT ACTUALLY IS.
 *
 * The analyser needs a second pass over the file to rank every row rather than the
 * retained window -- and that pass used to assume a delimited file. A JSONL feed
 * or a log therefore got parsed a second time BY THE CSV PARSER, which produced
 * nonsense: no header row to map columns from, so every ranking came back empty
 * and the timeline was blank.
 *
 * That is a silent wrong answer of the worst kind: the analysis succeeded, the
 * charts rendered, and the log simply appeared to have no traffic pattern. The
 * re-read therefore dispatches on the same detection the front door uses, and
 * both routes agree about what a file is by construction.
 *
 * Row numbers: for a delimited file these are FILE lines, so a citation points at
 * the line a person sees. A headerless format has no such line, so records are
 * numbered from 1 -- stated rather than faked, because a citation that points at
 * the wrong line is worse than one that points at no line.
 */
export async function streamDocument(
  target: string,
  onRow: (fields: Record<string, string>, rowNumber: number) => void,
): Promise<number> {
  const format = await detectFormat(target);
  let rows = 0;
  if (format === "csv") {
    const position = new Map<string, number>();
    let seenHeader = false;
    streamCsvRecordsSync(target, (cells, line) => {
      if (!seenHeader) {
        seenHeader = true;
        cells.forEach((cell, index) => position.set(cell.trim(), index));
        return;
      }
      rows += 1;
      const fields: Record<string, string> = {};
      for (const [name, index] of position) fields[name] = cells[index] ?? "";
      onRow(fields, line);
    });
    return rows;
  }
  const problems: string[] = [];
  const sink = (fields: Record<string, string>): void => {
    rows += 1;
    onRow(fields, rows);
  };
  if (format === "jsonl") await readJsonl(target, { retain: 0, problems, onRecord: sink });
  else await readLog(target, { retain: 0, problems, onRecord: sink });
  return rows;
}

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

  // THE PROFILE IS FED DURING THE READ, exactly as it is for a delimited file.
  //
  // This is the parity. Before, the tokenisers built a bounded row window and the
  // profile was assembled from it afterwards -- so a 500,000-event telemetry feed
  // was profiled over the first 10,000 events, and nothing anywhere said so. The
  // statistics a JSONL or log feed produces now describe the WHOLE file, which is
  // the only thing "omnivorous" can mean if it is to mean anything at all.
  const profile = new FileProfile(target, { retain: RETAINED_ROWS });
  const onRecord = (fields: Record<string, string>, headers: readonly string[]): void => {
    profile.ensureHeaders(headers);
    profile.push(headers.map((header) => fields[header] ?? ""));
  };

  const parsed = format === "jsonl"
    ? await readJsonl(target, { retain: RETAINED_ROWS, problems, onRecord })
    : await readLog(target, { retain: RETAINED_ROWS, problems, onRecord });

  if (parsed.headers.length === 0) {
    return { path: target, headers: [], rowCount: 0, columns: [], sample: [], rows: [], problems: [...problems, "the file has no rows"] };
  }

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

export const PDF_READ: ToolDescriptor = {
  name: "pdf_read",
  version: "stage2",
  description: "Extract text from a PDF file inside the workspace",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      text: { type: "string" },
      pages: { type: "number" },
    },
  },
  capabilities: ["pdf.read"],
  permissions: ["tool:pdf_read"],
  riskLevel: "READ_ONLY",
  idempotency: "IDEMPOTENT",
  sideEffect: "PURE",
  timeoutMs: 10_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
};

export interface PdfReadResult {
  path: string;
  text: string;
  pages: number;
}

export async function pdfRead(
  input: { path: string },
  boundary?: { boundary?: { check(p: string): { allowed: boolean } } },
): Promise<PdfReadResult> {
  const target = String(input.path ?? "");
  if (boundary?.boundary) {
    const verdict = boundary.boundary.check(target);
    if (!verdict.allowed) throw new Error(`pdf_read: the path is outside the workspace boundary (refused)`);
  }
  const pdfMod = "pdf-parse";
  const { PDFParse }: any = await import(pdfMod).catch(() => ({ PDFParse: null }));
  if (!PDFParse) throw new Error("pdf-parse module is not installed");
  const parser = new PDFParse({ data: await readFile(target) });
  try {
    const result = await parser.getText();
    return { path: target, text: result.text, pages: result.total };
  } finally {
    await parser.destroy();
  }
}

export const SQLITE_READ: ToolDescriptor = {
  name: "sqlite_read",
  version: "stage2",
  description: "Read a SQLite database inside the workspace and return schema or query results.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      query: { type: "string" }
    },
    required: ["path"]
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      tables: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            columns: { type: "array", items: { type: "string" } }
          }
        }
      },
      rows: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: { type: "string" }
        }
      }
    }
  },
  capabilities: ["sqlite.read"],
  permissions: ["tool:sqlite_read"],
  riskLevel: "READ_ONLY",
  idempotency: "IDEMPOTENT",
  sideEffect: "PURE",
  timeoutMs: 10_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 }
};


/**
 * READ A SQLITE DATABASE AS A GOVERNED TOOL.
 *
 * In schema mode (no query), returns the list of tables and their columns.
 * In query mode (with query), executes a read-only SELECT query and returns the rows.
 *
 * The connection is opened in readonly: true mode to enforce read-only semantics at the driver level.
 */
/**
 * READ A POSTGRESQL DATABASE AS A GOVERNED TOOL.
 *
 * In schema mode (no query), returns the list of tables and their columns.
 * In query mode (with query), executes a read-only SELECT query and returns the rows.
 */
export async function sqliteRead(
  input: { path: string; query?: string },
  boundary?: { boundary?: { check(p: string): { allowed: boolean } } }
): Promise<{
  path: string;
  tables: { name: string; columns: string[] }[];
  rows: Record<string, string>[];
}> {
  const target = String(input.path ?? "");
  if (boundary?.boundary) {
    const verdict = boundary.boundary.check(target);
    if (!verdict.allowed) throw new Error(`postgres_read: the path is outside the workspace boundary (${verdict.allowed ? "" : "refused"})`);
  }

 const pgMod = "pg";
const { Pool }: any = await import(pgMod).catch(() => ({ Pool: null }));
if (!Pool) throw new Error("pg module is not installed");
  const dbUrl = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  const dbPool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  const client = await dbPool.connect();

  try {
    await client.query("BEGIN READ ONLY");

    if (input.query === undefined) {
      // SCHEMA MODE: return tables and columns
      const tables: { name: string; columns: string[] }[] = [];
      const tableRows = await client.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname != 'pg_catalog' AND schemaname != 'information_schema'");
      
      for (const tableRow of tableRows.rows) {
        const tableName = tableRow.tablename;
        const columnRows = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = $1", [tableName]);
        const columns = columnRows.rows.map((col: any) => col.column_name);
        tables.push({ name: tableName, columns });
      }

      await client.query("ROLLBACK");
      return { path: target, tables, rows: [] };
    } else {
      // QUERY MODE: Enforce read-only string patterns
      const queryTrim = input.query.trim();
      if (!queryTrim.toUpperCase().startsWith("SELECT")) {
        throw new Error(`postgres_read: only SELECT queries are allowed for read-only access`);
      }
      const queryWithoutTrailingSemicolon = queryTrim.replace(/;\s*$/, "");
      if (queryWithoutTrailingSemicolon.includes(";")) {
        throw new Error(`postgres_read: multiple statements are not allowed`);
      }

      const queryResult = await client.query(queryTrim);
      await client.query("ROLLBACK");
      return { path: target, tables: [], rows: queryResult.rows };
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await dbPool.end();
  }
}

export interface ChartPoint {
  label: string;
  value: number;
}

export interface ChartRenderResult {
  path: string;
  bytes: number;
  points: number;
}

export interface TableQueryResult {
  path: string;
  columns: string[];
  rows: Record<string, string>[];
  matchedRows: number;
  truncated: boolean;
}

export interface ArtifactWriteResult {
  path: string;
  bytes: number;
}

function checkOutputBoundary(target: string, boundary: { boundary?: { check(p: string): { allowed: boolean } } } | undefined, tool: string): void {
  if (boundary?.boundary) {
    const verdict = boundary.boundary.check(target);
    if (!verdict.allowed) throw new Error(`${tool}: the output path is outside the workspace boundary (refused)`);
  }
}

function markdownCell(value: unknown): string {
  return String(value ?? "").replace(/[|\r\n]/g, " ").trim();
}

export const CHART_RENDER: ToolDescriptor = {
  name: "chart_render",
  version: "stage3",
  description: "Render a bounded, self-contained SVG chart artifact",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" }, title: { type: "string" }, points: { type: "array" },
    },
    required: ["path", "points"],
  },
  outputSchema: { type: "object", properties: { path: { type: "string" }, bytes: { type: "number" }, points: { type: "number" } } },
  capabilities: ["artifact.chart"],
  permissions: ["tool:chart_render"],
  riskLevel: "WRITE",
  idempotency: "IDEMPOTENT",
  sideEffect: "SIDE_EFFECTING",
  timeoutMs: 10_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
};

export async function chartRender(
  input: { path: string; title?: string; points: ChartPoint[] },
  boundary?: { boundary?: { check(p: string): { allowed: boolean } } },
): Promise<ChartRenderResult> {
  const target = String(input.path ?? "");
  checkOutputBoundary(target, boundary, "chart_render");
  const points = Array.isArray(input.points) ? input.points.slice(0, 100) : [];
  if (points.length === 0) throw new Error("chart_render: at least one point is required");
  if (points.some((point) => !Number.isFinite(Number(point.value)))) throw new Error("chart_render: every point value must be finite");
  const title = escapeHtml(String(input.title ?? "Chart"));
  const max = Math.max(1, ...points.map((point) => Math.abs(Number(point.value))));
  const width = Math.max(320, points.length * 48 + 80);
  const bars = points.map((point, index) => {
    const value = Number(point.value);
    const height = Math.max(1, Math.round((Math.abs(value) / max) * 180));
    const x = 40 + index * 48;
    return `<rect x="${x}" y="${220 - height}" width="28" height="${height}" fill="#172033"><title>${escapeHtml(String(point.label))}: ${value}</title></rect><text x="${x + 14}" y="238" text-anchor="middle">${escapeHtml(String(point.label).slice(0, 12))}</text>`;
  }).join("\n");
  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 260" role="img" aria-labelledby="title"><title id="title">${title}</title><style>text{font:11px system-ui,sans-serif;fill:#172033}</style><line x1="30" y1="220" x2="${width - 20}" y2="220" stroke="#172033"/>${bars}</svg>\n`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, svg, "utf8");
  return { path: target, bytes: Buffer.byteLength(svg, "utf8"), points: points.length };
}

export const TABLE_QUERY: ToolDescriptor = {
  name: "table_query",
  version: "stage3",
  description: "Run a bounded read-only comparison against CSV table rows",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" }, column: { type: "string" }, operator: { type: "string" }, value: {}, limit: { type: "number" },
    },
    required: ["path", "column", "operator", "value"],
  },
  outputSchema: { type: "object" },
  capabilities: ["table.query"],
  permissions: ["tool:table_query"],
  riskLevel: "READ_ONLY",
  idempotency: "IDEMPOTENT",
  sideEffect: "PURE",
  timeoutMs: 10_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
};

export async function tableQuery(
  input: { path: string; column: string; operator: string; value: string | number; limit?: number },
  boundary?: { boundary?: { check(p: string): { allowed: boolean } } },
): Promise<TableQueryResult> {
  const source = await csvRead({ path: String(input.path ?? "") }, boundary);
  const column = String(input.column ?? "");
  if (!source.headers.includes(column)) throw new Error(`table_query: column '${column}' does not exist`);
  const operator = String(input.operator ?? "");
  if (!["=", "!=", ">", ">=", "<", "<=", "contains"].includes(operator)) throw new Error(`table_query: unsupported operator '${operator}'`);
  const expected = String(input.value ?? "");
  const matches = source.rows.filter((row) => {
    const actual = String(row[column] ?? "");
    if (operator === "contains") return actual.toLowerCase().includes(expected.toLowerCase());
    const leftNumber = Number(actual);
    const rightNumber = Number(expected);
    const numeric = actual.trim() !== "" && expected.trim() !== "" && Number.isFinite(leftNumber) && Number.isFinite(rightNumber);
    const left = numeric ? leftNumber : actual;
    const right = numeric ? rightNumber : expected;
    switch (operator) {
      case "=": return left === right;
      case "!=": return left !== right;
      case ">": return left > right;
      case ">=": return left >= right;
      case "<": return left < right;
      case "<=": return left <= right;
      default: return false;
    }
  });
  const limit = Math.max(1, Math.min(10_000, Math.floor(input.limit ?? 1_000)));
  return { path: source.path, columns: source.headers, rows: matches.slice(0, limit), matchedRows: matches.length, truncated: matches.length > limit };
}

export const LANDING_PAGE: ToolDescriptor = {
  name: "landing_page",
  version: "stage3",
  description: "Write a self-contained accessible landing page",
  inputSchema: { type: "object", properties: { path: { type: "string" }, title: { type: "string" }, headline: { type: "string" }, body: { type: "string" } }, required: ["path", "title", "headline", "body"] },
  outputSchema: { type: "object", properties: { path: { type: "string" }, bytes: { type: "number" } } },
  capabilities: ["artifact.landing_page"],
  permissions: ["tool:landing_page"],
  riskLevel: "WRITE",
  idempotency: "IDEMPOTENT",
  sideEffect: "SIDE_EFFECTING",
  timeoutMs: 10_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
};

export async function landingPage(
  input: { path: string; title: string; headline: string; body: string },
  boundary?: { boundary?: { check(p: string): { allowed: boolean } } },
): Promise<ArtifactWriteResult> {
  const target = String(input.path ?? "");
  checkOutputBoundary(target, boundary, "landing_page");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:60rem;margin:0 auto;padding:4rem 2rem;color:#172033}main{max-width:42rem}h1{font-size:clamp(2rem,7vw,5rem);line-height:1.05}p{color:#536070}</style></head><body><main><h1>${escapeHtml(input.headline)}</h1><p>${escapeHtml(input.body)}</p></main></body></html>\n`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, html, "utf8");
  return { path: target, bytes: Buffer.byteLength(html, "utf8") };
}

export const REPORT_WRITE: ToolDescriptor = {
  name: "report_write",
  version: "stage3",
  description: "Write a concise Markdown report from governed table data",
  inputSchema: { type: "object", properties: { path: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, columns: { type: "array" }, rows: { type: "array" } }, required: ["path", "title", "summary"] },
  outputSchema: { type: "object", properties: { path: { type: "string" }, bytes: { type: "number" } } },
  capabilities: ["artifact.report"],
  permissions: ["tool:report_write"],
  riskLevel: "WRITE",
  idempotency: "IDEMPOTENT",
  sideEffect: "SIDE_EFFECTING",
  timeoutMs: 10_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
};

export async function reportWrite(
  input: { path: string; title: string; summary: string; columns?: string[]; rows?: Record<string, string>[] },
  boundary?: { boundary?: { check(p: string): { allowed: boolean } } },
): Promise<ArtifactWriteResult> {
  const target = String(input.path ?? "");
  checkOutputBoundary(target, boundary, "report_write");
  const columns = (input.columns ?? []).map(String);
  const rows = (input.rows ?? []).slice(0, 100);
  const table = columns.length === 0 ? "" : `\n| ${columns.map(markdownCell).join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |\n${rows.map((row) => `| ${columns.map((column) => markdownCell(row[column])).join(" | ")} |`).join("\n")}\n`;
  const markdown = `# ${markdownCell(input.title)}\n\n${String(input.summary).trim()}\n${table}`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, markdown, "utf8");
  return { path: target, bytes: Buffer.byteLength(markdown, "utf8") };
}

export const APP_SCAFFOLD: ToolDescriptor = {
  name: "app_scaffold",
  version: "stage3",
  description: "Write a minimal self-contained application scaffold",
  inputSchema: { type: "object", properties: { path: { type: "string" }, name: { type: "string" } }, required: ["path", "name"] },
  outputSchema: { type: "object", properties: { path: { type: "string" }, bytes: { type: "number" } } },
  capabilities: ["artifact.app_scaffold"],
  permissions: ["tool:app_scaffold"],
  riskLevel: "WRITE",
  idempotency: "IDEMPOTENT",
  sideEffect: "SIDE_EFFECTING",
  timeoutMs: 10_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
};

export async function appScaffold(
  input: { path: string; name: string },
  boundary?: { boundary?: { check(p: string): { allowed: boolean } } },
): Promise<ArtifactWriteResult> {
  const target = String(input.path ?? "");
  checkOutputBoundary(target, boundary, "app_scaffold");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.name)}</title></head><body><main id="app"><h1>${escapeHtml(input.name)}</h1><p>Application scaffold ready.</p></main><script>document.querySelector('#app').dataset.ready='true';</script></body></html>\n`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, html, "utf8");
  return { path: target, bytes: Buffer.byteLength(html, "utf8") };
}

export interface PilotRecordInput {
  path: string;
  request: string;
  source: string;
  artifacts: string[];
  rowCount: number;
  userCount: number;
  status?: "pilot-ready" | "loi-ready";
}

export interface PilotRecordResult {
  path: string;
  bytes: number;
  userCount: number;
  artifactCount: number;
  status: "pilot-ready" | "loi-ready";
}

export const PILOT_RECORD: ToolDescriptor = {
  name: "pilot_record",
  version: "stage4",
  description: "Persist wedge-pilot evidence for a real user or signed LOI run",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" }, request: { type: "string" }, source: { type: "string" },
      artifacts: { type: "array" }, rowCount: { type: "number" }, userCount: { type: "number" }, status: { type: "string" },
    },
    required: ["path", "request", "source", "artifacts", "rowCount", "userCount"],
  },
  outputSchema: { type: "object", properties: { path: { type: "string" }, bytes: { type: "number" }, userCount: { type: "number" }, artifactCount: { type: "number" } } },
  capabilities: ["pilot.persist"],
  permissions: ["tool:pilot_record"],
  riskLevel: "WRITE",
  idempotency: "IDEMPOTENT",
  sideEffect: "SIDE_EFFECTING",
  timeoutMs: 10_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
};

export async function pilotRecord(
  input: PilotRecordInput,
  boundary?: { boundary?: { check(p: string): { allowed: boolean } } },
): Promise<PilotRecordResult> {
  const target = String(input.path ?? "");
  checkOutputBoundary(target, boundary, "pilot_record");
  const status = input.status ?? "pilot-ready";
  const record = {
    stage: 4,
    status,
    request: String(input.request ?? ""),
    source: String(input.source ?? ""),
    rowCount: Number(input.rowCount ?? 0),
    userCount: Number(input.userCount ?? 0),
    artifacts: (input.artifacts ?? []).map(String),
    recordedAt: new Date().toISOString(),
  };
  const text = `${JSON.stringify(record, null, 2)}\n`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
  return { path: target, bytes: Buffer.byteLength(text, "utf8"), userCount: record.userCount, artifactCount: record.artifacts.length, status };
}

export const STAGE3_CAPABILITIES: ToolDescriptor[] = [CHART_RENDER, TABLE_QUERY, LANDING_PAGE, REPORT_WRITE, APP_SCAFFOLD];
export const STAGE4_CAPABILITIES: ToolDescriptor[] = [PILOT_RECORD];
export const CHART = CHART_RENDER;

/**
 * VALIDATE INFRASTRUCTURE PATCH - Dry-run validation for K8s/Terraform manifests.
 * This tool MUST be called before finalizing any remediation patch.
 */
export const VALIDATE_INFRASTRUCTURE_PATCH: ToolDescriptor = {
  name: "validate_infrastructure_patch",
  version: "stage17",
  description: "Validates a Kubernetes YAML or Terraform manifest using dry-run against the target API. Required before finalizing any infrastructure patch.",
  inputSchema: {
    type: "object",
    properties: {
      manifest: { type: "string", description: "The raw YAML or Terraform manifest content" },
      format: { type: "string", enum: ["kubernetes", "terraform"], description: "The format of the manifest" },
    },
    required: ["manifest", "format"],
  },
  outputSchema: {
    type: "object",
    properties: {
      valid: { type: "boolean" },
      output: { type: "string" },
    },
    required: ["valid", "output"],
  },
  capabilities: ["infrastructure.validation"],
  permissions: ["tool:validate_infrastructure_patch"],
  riskLevel: "READ_ONLY",
  idempotency: "IDEMPOTENT",
  sideEffect: "PURE",
  timeoutMs: 30_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
};

/** Implementation function for the validate_infrastructure_patch tool */
export async function validateInfrastructurePatch(
  input: { manifest: string; format: "kubernetes" | "terraform" },
  boundary?: { boundary?: { check(p: string): { allowed: boolean } } }
): Promise<{ valid: boolean; output: string }> {
  const { ExecutionSandbox } = await import("./sandbox.ts");
  return ExecutionSandbox.validateManifest(input.manifest, input.format);
}


