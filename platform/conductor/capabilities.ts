import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ToolDescriptor } from "../core/types.ts";

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
   * What is wrong with the file, when something is. Never an exception: a
   * malformed file is a RESULT the Conductor has to reason about, because the
   * difference between "the file is broken" and "the tool broke" is the whole
   * difference between a good error message and a mystery.
   */
  problems: string[];
}

const MAX_ROWS_SCANNED = 10_000;
const SAMPLE_ROWS = 50;

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
  let sawContent = false;

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
      inQuotes = true; sawContent = true; i += 1; continue;
    }
    if (ch === ",") { row.push(field); field = ""; i += 1; continue; }
    if (ch === "\r") { i += 1; continue; }
    if (ch === "\n") {
      row.push(field); rows.push(row); row = []; field = ""; line += 1; i += 1; continue;
    }
    field += ch; sawContent = true; i += 1;
  }
  if (sawContent || field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
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

function columnKind(values: string[]): "number" | "text" | "empty" {
  const present = values.filter((v) => v.trim().length > 0);
  if (present.length === 0) return "empty";
  const numeric = present.filter((v) => Number.isFinite(Number(v)));
  return numeric.length === present.length ? "number" : "text";
}

export async function csvRead(input: { path: string }, boundary?: { boundary?: { check(p: string): { allowed: boolean } } }): Promise<CsvReadResult> {
  const target = String(input.path ?? "");
  if (boundary?.boundary) {
    const verdict = boundary.boundary.check(target);
    if (!verdict.allowed) throw new Error(`csv_read: the path is outside the workspace boundary (${verdict.allowed ? "" : "refused"})`);
  }
  const text = await readFile(target, "utf8");
  const { headers, rows, problems } = parseCsv(text);
  const sample = rows.slice(0, SAMPLE_ROWS).map((cells) =>
    Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])),
  );
  const columns = headers.map((name, index) => {
    const values = rows.map((cells) => cells[index] ?? "");
    const kind = columnKind(values);
    if (kind !== "number") return { name, kind };
    const numbers = values.map(Number).filter(Number.isFinite);
    return {
      name, kind,
      min: Math.min(...numbers), max: Math.max(...numbers),
      sum: numbers.reduce((a, b) => a + b, 0),
    };
  });
  return { path: target, headers, rowCount: rows.length, columns, sample, problems };
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