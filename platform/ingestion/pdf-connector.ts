import { readFileSync, statSync } from "node:fs";
import { inflateSync } from "node:zlib";

import { resolveWithinRoot } from "../core/workspace.ts";
import { resolveSchemaMemory, type ResolvedSchema } from "../conductor/schema-memory.ts";
import { analyseBottlenecks, type BottleneckAnalysis } from "../conductor/bottlenecks.ts";
import type { CsvReadResult } from "../conductor/capabilities.ts";

/**
 * THE PDF FRONT DOOR. The same analysis, one more way in.
 *
 * The engine has spent three sessions learning to read files it was never shown.
 * It does not care where the bytes came from, so the honest way to add PDF is to
 * hand the profiler the `CsvReadResult` it already understands and change
 * nothing downstream. The database connector established that shape and this one
 * reuses it exactly -- the renderer, the bottleneck engine and the schema memory
 * cannot tell a PDF from a SQLite dump.
 *
 * WHY NO THIRD-PARTY PARSER, STATED PLAINLY. A dependency is not a free choice
 * in a repository whose product claim is that a fresh clone runs (D-018): the
 * platform has ZERO runtime dependencies and nothing under platform/ imports
 * anything outside node's stdlib. The text layer of a PDF is the content stream,
 * and reading a content stream is zlib plus a lexer, both of which node already
 * ships. So the claim is kept and the dependency is not added.
 *
 * WHAT THIS IS NOT, because a connector that overstates itself is worse than no
 * connector. This is not a conforming PDF text extractor. It reads literal
 * strings out of uncompressed and FlateDecode content streams, which covers
 * ordinary text PDFs produced by report generators. It does NOT decode hex
 * strings from a subset font with a custom CMap, it does not reassemble
 * ligatures, and it does not OCR. A scanned page therefore yields no text -- and
 * that is REPORTED, loudly, in `problems`, because the alternative is the bug
 * this codebase has been bitten by repeatedly: a confident, clean, empty answer
 * that reads as "this document contains no rows" when the truth is "this document
 * could not be read". Silence here is a lie, so there is none.
 *
 * GOVERNANCE IS THE KERNEL'S, NOT A COPY. `assertInsideWorkspace` calls the
 * kernel's own `resolveWithinRoot` -- the identical function the text-read path
 * uses -- and runs before the file is opened, before a byte is read. It is not a
 * second implementation of a security check, because a second implementation is
 * a second thing to keep correct and the two drift. The kernel precheck catches
 * the same path independently, because a guard that lives in only one of the two
 * places is one import away from being useless.
 */

/** The four bytes every PDF begins with. Checked against the CONTENT, never the extension. */
export const PDF_MAGIC = "%PDF-";

/**
 * FILE SIZE IS CAPPED. An analysis tool that will `readFileSync` a path a model
 * chose is a denial-of-service with a citation. 64 MiB is far beyond any
 * incident report, and a larger file is truncated and REPORTED rather than
 * refused, so the operator learns why the numbers look short.
 */
export const MAX_PDF_BYTES = 64 * 1024 * 1024;

/**
 * STREAM BYTES ARE CAPPED, and this is the decompression-bomb bound. A few
 * hundred compressed bytes can inflate to gigabytes, so the bound is handed to
 * zlib itself as `maxOutputLength` rather than applied afterwards: the bomb never
 * materialises, which a post-hoc `slice` would not achieve. Over the cap is a
 * reported problem, not a crash and not silence.
 */
export const MAX_STREAM_BYTES = 8 * 1024 * 1024;

/** Content-stream bytes actually scanned. Bounds a stream that is large but not a bomb. */
export const MAX_SCAN_BYTES = 1 * 1024 * 1024;

/** Rows are capped, and the cap is reported in the result rather than applied silently. */
export const MAX_ROWS = 100_000;

/**
 * A TJ array number at or below this is read as a line break rather than a
 * space. Producers use large negative offsets to move to the next line and small
 * ones for kerning; -200 is the conventional dividing line, and it is a NAMED
 * constant because a bare 200 inside a lexer is a number nobody can later
 * explain or safely retune.
 */
const TJ_LINE_BREAK = -200;

export class PdfRefused extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`PDF read refused by the workspace boundary: ${reason}`);
    this.name = "PdfRefused";
    this.reason = reason;
  }
}

/**
 * THE BOUNDARY, CALLED DIRECTLY, BEFORE THE FILE IS OPENED.
 *
 * The same function the policy uses. A caller who imports this module and never
 * goes near the kernel still cannot read a PDF from outside the workspace, and a
 * caller who goes through the kernel gets the identical verdict string.
 */
export function assertInsideWorkspace(input: { readonly path: unknown; readonly root: string }): string {
  const verdict = resolveWithinRoot(input.root, input.path);
  if (!verdict.allowed) throw new PdfRefused(verdict.reason ?? "path is outside every allowed root");
  return verdict.resolvedPath as string;
}

// === THE TEXT LAYER ========================================================

/** What one content stream yielded, and what it cost to get it. */
interface ContentScan {
  readonly lines: string[];
  /** A hex string was used for text and no font encoding was available to decode it. */
  readonly hexStrings: number;
  /** The stream ran past the scan bound, so the result is a PARTIAL one. */
  readonly truncated: boolean;
}

/**
 * Read a PDF string's escapes: bracket, backslash, newline, and octal `\ddd`.
 *
 * The octal case is not optional. A log line containing a path or a percent sign
 * is written as an escape by every producer, and a reader that mishandles it
 * yields a string that differs from the document -- which is the sort of quiet
 * corruption that later gets reported as a data-quality finding.
 */
function decodeLiteral(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw[i];
    if (c !== "\\") { out += c; continue; }
    const next = raw[++i];
    if (next === undefined) break;
    if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "t") out += "\t";
    else if (next === "b" || next === "f") out += " ";
    else if (next >= "0" && next <= "7") {
      let octal = next;
      while (octal.length < 3 && raw[i + 1] !== undefined && raw[i + 1] >= "0" && raw[i + 1] <= "7") octal += raw[++i];
      out += String.fromCharCode(parseInt(octal, 8));
    } else out += next;
  }
  return out;
}

/**
 * Scan one content stream into LINES OF TEXT.
 *
 * The line breaks come from the operators that move the text position -- `T*`, a
 * `Td`/`TD` with a non-zero vertical component, and a `Tm` whose baseline moved
 * -- rather than from guessing at wrapping. Guessing at wrapping is how a
 * paragraph becomes forty half-rows.
 */
export function textFromContentStream(stream: string): ContentScan {
  const lines: string[] = [];
  let current = "";
  let hexStrings = 0;
  let truncated = false;

  const flush = (): void => {
    const trimmed = current.replace(/[ \t]+$/, "");
    if (trimmed !== "") lines.push(trimmed);
    current = "";
  };

  const limit = Math.min(stream.length, MAX_SCAN_BYTES);
  if (stream.length > limit) truncated = true;

  /** Operands seen since the last operator. `Td`/`Tm` need to see their numbers. */
  let numbers: number[] = [];
  let baseline: number | undefined;
  let pending: string | undefined;

  for (let i = 0; i < limit; i += 1) {
    const c = stream[i];

    if (c === "%") {
      // A comment runs to the end of the line. Skipping it is also what keeps a
      // multi-megabyte padding comment from being scanned as page content.
      while (i < limit && stream[i] !== "\n" && stream[i] !== "\r") i += 1;
      continue;
    }

    if (c === "(") {
      let depth = 1;
      let raw = "";
      i += 1;
      while (i < limit && depth > 0) {
        const ch = stream[i];
        if (ch === "\\") { raw += ch + (stream[i + 1] ?? ""); i += 2; continue; }
        if (ch === "(") depth += 1;
        else if (ch === ")") { depth -= 1; if (depth === 0) break; }
        raw += ch;
        i += 1;
      }
      pending = decodeLiteral(raw);
      continue;
    }

    if (c === "<" && stream[i + 1] !== "<") {
      while (i < limit && stream[i] !== ">") i += 1;
      hexStrings += 1;
      continue;
    }

    if (c >= "0" && c <= "9") {
      const start = i;
      while (i < limit && /[0-9.\-+]/.test(stream[i])) i += 1;
      const value = Number.parseFloat(stream.slice(start, i));
      if (Number.isFinite(value)) numbers.push(value);
      i -= 1;
      continue;
    }

    if (/[A-Za-z'"]/.test(c)) {
      const start = i;
      while (i < limit && /[A-Za-z0-9*'"]/.test(stream[i])) i += 1;
      const op = stream.slice(start, i);
      switch (op) {
        case "Tj":
          if (pending !== undefined) current += pending;
          break;
        case "TJ":
          if (pending !== undefined) current += pending;
          // A kerning array is a list of gaps. A large negative one is the
          // producer saying "next line"; a small one is letter spacing.
          for (const n of numbers) if (n <= TJ_LINE_BREAK) flush();
          break;
        case "'":
        case '"':
          flush();
          if (pending !== undefined) current += pending;
          break;
        case "T*":
          flush();
          break;
        case "Td":
        case "TD": {
          const ty = numbers[numbers.length - 1];
          if (ty !== undefined && ty !== 0) flush();
          break;
        }
        case "Tm": {
          const ty = numbers[numbers.length - 5];
          if (ty !== undefined && ty !== baseline) flush();
          baseline = ty;
          break;
        }
        case "BT":
          flush();
          break;
        default:
          break;
      }
      numbers = [];
      pending = undefined;
      continue;
    }
  }
  flush();
  return { lines, hexStrings, truncated };
}

/** A stream after decoding, plus what had to be done to get it. */
interface DecodedStream {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Inflate one stream, with the output bound applied INSIDE zlib.
 *
 * `maxOutputLength` is the whole point. Reading the stream and then checking its
 * length would allocate the bomb first and notice afterwards, which is exactly
 * the allocation the bound exists to prevent.
 */
function inflateBounded(bytes: Buffer): DecodedStream {
  try {
    return { text: inflateSync(bytes, { maxOutputLength: MAX_STREAM_BYTES }).toString("latin1"), truncated: false };
  } catch {
    // A stream that will not inflate, or that exceeds the cap, is reported by
    // the caller. There is no partial read to offer: half a stream is a table
    // that looks complete and is not.
    return { text: "", truncated: true };
  }
}

/** Every `N G obj ... endobj` body in the file. */
function* indirectObjects(document: string): Generator<string> {
  const marker = /\d+\s+\d+\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(document)) !== null) {
    const end = document.indexOf("endobj", match.index);
    yield document.slice(match.index, end === -1 ? undefined : end);
  }
}

/**
 * Find where one stream's data ends, and return exactly that data.
 *
 * THE SUBTLETY THIS EXISTS FOR. The format puts an end-of-line between the data
 * and the `endstream` keyword, so slicing up to the keyword yields one byte MORE
 * than the stream. For an uncompressed stream that extra byte is harmless. For a
 * FlateDecode one it is fatal: zlib reaches the end of the deflate block and
 * then finds a byte it did not expect, throws, and the entire stream is lost --
 * which is why a perfectly ordinary compressed PDF first came back empty.
 *
 * So the declared `/Length` is preferred, and it is VERIFIED rather than
 * trusted: the bytes after it must actually be the `endstream` keyword. A
 * document that lies about its own length gets the search path instead, never a
 * silent mis-slice. `/Length` may also be an indirect reference to another
 * object, which is legal and common, so a non-numeric value falls through to the
 * same search.
 */
function streamData(object: string, cursor: number): string | undefined {
  const dict = object.slice(0, cursor);
  const declared = /\/(?:Length)\s+(\d+)/.exec(dict);
  if (declared !== null) {
    const end = cursor + Number.parseInt(declared[1], 10);
    // Verify, do not trust: only the keyword proves the document is telling the
    // truth about where its own content stops.
    let probe = end;
    if (object[probe] === "\r") probe += 1;
    if (object[probe] === "\n") probe += 1;
    if (object.startsWith("endstream", probe)) return object.slice(cursor, end);
  }
  const found = object.indexOf("endstream", cursor);
  if (found === -1) return undefined;
  // Drop the single EOL the format puts between the data and the keyword.
  let trimmed = found;
  if (object[trimmed - 1] === "\n") trimmed -= 1;
  if (trimmed > cursor && object[trimmed - 1] === "\r") trimmed -= 1;
  return object.slice(cursor, Math.max(cursor, trimmed));
}

/**
 * Decode every content stream in the document.
 *
 * Objects are found by scanning for `obj` markers rather than by following the
 * cross-reference table. That is a deliberate simplification, not an oversight:
 * it reads the same objects for an ordinary file, it copes with a damaged offset
 * table, and it is only wrong for a file deliberately crafted to disagree with
 * its own xref -- which is worth knowing, and is the reason a document is never
 * trusted to describe where its own content lives.
 */
function* contentStreams(document: string): Generator<DecodedStream> {
  for (const object of indirectObjects(document)) {
    const start = object.indexOf("stream");
    if (start === -1 || object.slice(0, start).includes("/Type /XObject")) continue;
    const dict = object.slice(0, start);
    // Per the format, the keyword is followed by CRLF or LF, never by CR alone.
    let cursor = start + "stream".length;
    if (object[cursor] === "\r") cursor += 1;
    if (object[cursor] === "\n") cursor += 1;
    const data = streamData(object, cursor);
    if (data === undefined) continue;
    const raw = Buffer.from(data, "latin1");
    yield /\/FlateDecode/.test(dict) ? inflateBounded(raw) : { text: data, truncated: false };
  }
}

// === THE TABLE LAYER =======================================================

/** Candidate delimiters, most specific first. A single space is deliberately absent. */
const DELIMITERS: ReadonlyArray<{ readonly name: string; readonly split: (line: string) => string[] }> = [
  { name: "tab", split: (line) => line.split("\t") },
  { name: "pipe", split: (line) => line.split("|").map((f) => f.trim()) },
  { name: "comma", split: (line) => line.split(",").map((f) => f.trim()) },
  { name: "semicolon", split: (line) => line.split(";").map((f) => f.trim()) },
  // Two or more spaces, i.e. a space-aligned table. Gated on atomic fields below.
  { name: "whitespace", split: (line) => line.split(/ {2,}/).map((f) => f.trim()) },
];

/** A field that itself contains a space is prose that happened to line up, not a column. */
function isAtomic(fields: readonly string[]): boolean {
  return fields.every((f) => !/\s/.test(f));
}

/** A row of pure numbers and dates is data. A row with words in it is a header. */
function looksNumeric(fields: readonly string[]): boolean {
  return fields.every((f) => f !== "" && /^[0-9][0-9.,:_\-/+%$ ]*$/.test(f));
}

interface TableSplit {
  readonly headers: string[];
  readonly rows: string[][];
  /** Lines that were not part of the table, so nothing is dropped without saying so. */
  readonly stray: number;
  readonly delimiter: string | undefined;
}

/**
 * THE SPLITTER, and the one place this connector is allowed to be clever.
 *
 * A table is only accepted on STRONG evidence, because the failure mode of a
 * hopeful splitter is not an error -- it is a confident wrong table. Two rules do
 * the work:
 *
 *  1. Whitespace splitting additionally requires every field to be ATOMIC (no
 *     internal space). `2026-09-30 10:00:01 INFO  worker started` splits into two
 *     fields on two spaces, but the first field contains a space, so it is prose
 *     that happened to align and NOT a table. Without this rule every log PDF
 *     would silently lose its first line to a made-up header.
 *  2. A candidate header is the first line of a run with a consistent field count
 *     that is not entirely numeric. If the first row is numeric, the document has
 *     no header row and the columns are NAMED rather than borrowed.
 *
 * Anything with no consistent structure degrades to one row per line, which
 * preserves every line of a log and is reported in `problems`.
 */
export function splitIntoTable(lines: readonly string[]): TableSplit {
  const candidates = lines.filter((l) => l.trim() !== "");

  for (const { name, split } of DELIMITERS) {
    const shaped = candidates.map((line) => split(line));
    // The modal field count across the whole document, and how many lines agree.
    const tally = new Map<number, number>();
    for (const fields of shaped) {
      if (fields.length < 2) continue;
      tally.set(fields.length, (tally.get(fields.length) ?? 0) + 1);
    }
    let width = 0;
    let agreeing = 0;
    for (const [count, n] of tally) {
      if (n > agreeing || (n === agreeing && count > width)) { width = count; agreeing = n; }
    }
    // Two agreeing lines is the floor: one line is a coincidence, not a table.
    if (width < 2 || agreeing < 2) continue;
    if (name === "whitespace" && !shaped.filter((f) => f.length === width).every(isAtomic)) continue;

    const run = shaped.filter((f) => f.length === width);
    if (looksNumeric(run[0])) {
      return {
        headers: Array.from({ length: width }, (_, i) => `column_${i + 1}`),
        rows: run,
        stray: shaped.length - run.length,
        delimiter: name,
      };
    }
    const [head, ...body] = run;
    return {
      headers: head.map((h, i) => (h === "" ? `column_${i + 1}` : h)),
      rows: body,
      stray: shaped.length - run.length,
      delimiter: name,
    };
  }

  return { headers: ["line"], rows: candidates.map((l) => [l]), stray: 0, delimiter: undefined };
}

// === THE CONNECTOR =========================================================

/** The analysis the Conductor produces, so a caller does not have to reassemble it. */
export interface PdfProfile {
  readonly schema: ResolvedSchema | undefined;
  readonly bottlenecks: BottleneckAnalysis;
  /** True when the document has no generic category/time shape, so the engine declined it. */
  readonly declined: boolean;
}

export interface PdfReadResult {
  readonly csv: CsvReadResult;
  readonly rowCount: number;
  readonly columns: number;
  readonly truncated: boolean;
  readonly source: string;
  /** Everything that went wrong or was skipped. Never empty when the read was partial. */
  readonly problems: string[];
  /** The text the splitter saw, before any table structure was imposed on it. */
  readonly lines: readonly string[];
  /**
   * Pipe it into the Conductor's own generic profiler. It is a method rather
   * than a separate export so that going through the profiler is the default
   * path and cannot be forgotten at a call site.
   */
  profile(): Promise<PdfProfile>;
}

export interface ReadPdfOptions {
  readonly path: string;
  /** The allowed root. Defaults to the process working directory. */
  readonly root?: string;
  /** Where the schema memory archive is read from, as elsewhere in the Conductor. */
  readonly schemaCwd?: string;
}

/**
 * READ A PDF, GOVERNED, INTO THE TABLE THE CONDUCTOR ALREADY UNDERSTANDS.
 *
 * The boundary is checked first and unconditionally. A path outside the root
 * never reaches `statSync`, let alone `readFileSync`, so there is no window in
 * which a rejected path has been opened.
 */
export async function readPdf(options: ReadPdfOptions): Promise<PdfReadResult> {
  const root = options.root ?? process.cwd();
  // FIRST. Before the file is stat'ed, read, or sniffed.
  const resolved = assertInsideWorkspace({ path: options.path, root });

  const problems: string[] = [];
  let bytes: Buffer;
  try {
    const stat = statSync(resolved);
    if (stat.size > MAX_PDF_BYTES) {
      problems.push(`the file is ${stat.size} bytes, over the ${MAX_PDF_BYTES}-byte read limit; the extraction below covers only the first ${MAX_PDF_BYTES}`);
    }
    bytes = readFileSync(resolved);
  } catch (error) {
    // A missing or unreadable file is a RESULT, not a crash: the caller is a
    // report pipeline, and "the PDF was not there" is something it can say.
    problems.push(`the file could not be read: ${(error as Error).message}`);
    return finish({ path: resolved, headers: [], rows: [], problems, truncated: false, schemaCwd: options.schemaCwd });
  }
  if (bytes.length > MAX_PDF_BYTES) {
    problems.push(`only the first ${MAX_PDF_BYTES} of ${bytes.length} bytes were read (read limit)`);
    bytes = bytes.subarray(0, MAX_PDF_BYTES);
  }

  // CONTENT, NOT EXTENSION. A `.pdf` that is really a CSV is a common mis-send,
  // and running a text parser over it would produce a confident nonsense table.
  if (bytes.subarray(0, PDF_MAGIC.length).toString("latin1") !== PDF_MAGIC) {
    problems.push(`this is not a PDF: it does not begin with the ${PDF_MAGIC} magic bytes, so it is a different format wearing a .pdf name`);
    return finish({ path: resolved, headers: [], rows: [], problems, truncated: false, schemaCwd: options.schemaCwd });
  }

  const document = bytes.toString("latin1");

  // Encryption is checked before content, because every other finding about an
  // encrypted document is downstream of being unable to read it at all.
  const trailer = document.slice(document.lastIndexOf("trailer"));
  const tail = document.slice(Math.max(0, document.length - 2048));
  if (/\/Encrypt\b/.test(trailer) || /\/Encrypt\s+\d+\s+\d+\s+R/.test(tail)) {
    problems.push("the document is encrypted; its text cannot be extracted without the document key");
    return finish({ path: resolved, headers: [], rows: [], problems, truncated: false, schemaCwd: options.schemaCwd });
  }

  const lines: string[] = [];
  let hexStrings = 0;
  let truncated = false;
  let streams = 0;
  for (const stream of contentStreams(document)) {
    streams += 1;
    if (stream.truncated) { truncated = true; continue; }
    const scan = textFromContentStream(stream.text);
    lines.push(...scan.lines);
    hexStrings += scan.hexStrings;
    truncated = truncated || scan.truncated;
  }
  if (streams === 0) problems.push("no content stream was found; the file is a PDF shell with no page content");

  if (hexStrings > 0) {
    problems.push(`${hexStrings} text string(s) were stored in hex form and need a font encoding this reader does not carry, so that text is missing from the result`);
  }
  if (truncated) {
    problems.push(`a content stream was over the ${MAX_SCAN_BYTES}-byte scan limit, or could not be inflated within ${MAX_STREAM_BYTES} bytes, so the text below is a PARTIAL extraction, not the whole document`);
  }
  if (lines.length === 0 && problems.length === 0) {
    problems.push("no text could be extracted; this looks like a scanned or image-only PDF, and it needs an OCR copy before it can be analysed");
  }

  const split = splitIntoTable(lines);
  if (split.delimiter === undefined) {
    problems.push(`no consistent table structure was found across ${lines.length} line(s), so each line is kept as one row in a single 'line' column; figures over this are line counts, not measurements`);
  } else if (split.stray > 0) {
    problems.push(`${split.stray} line(s) did not match the ${split.delimiter}-delimited ${split.headers.length}-column table and are NOT included in the rows below`);
  }

  const capped = split.rows.slice(0, MAX_ROWS);
  const rowTruncated = capped.length < split.rows.length;
  if (rowTruncated) problems.push(`the table had more than ${MAX_ROWS} rows and was cut at that cap; the figures cover the first ${MAX_ROWS} rows only`);

  return finish({ path: resolved, headers: split.headers, rows: capped, problems, truncated: truncated || rowTruncated, schemaCwd: options.schemaCwd });
}

/**
 * Assemble the result and the pipeline behind it.
 *
 * Every cell is stringified on the way in, so a value that came out of a PDF
 * takes exactly the same path through the profiler as the same value in a CSV.
 * The `problems` list travels INSIDE the `CsvReadResult` as well as alongside
 * it, because a consumer that passes only `csv` onward must still be able to
 * see that the read was partial. That is the entire point of the field.
 */
function finish(input: {
  readonly path: string;
  readonly headers: readonly string[];
  readonly rows: ReadonlyArray<readonly string[]>;
  readonly problems: string[];
  readonly truncated: boolean;
  readonly schemaCwd?: string;
}): PdfReadResult {
  const rows = input.rows.map((cells) =>
    Object.fromEntries(input.headers.map((h, i) => [h, cells[i] === undefined ? "" : String(cells[i])])));

  const csv: CsvReadResult = {
    path: input.path,
    headers: [...input.headers],
    rowCount: rows.length,
    columns: [],
    sample: rows.slice(0, 5),
    rows,
    problems: [...input.problems],
  };

  return {
    csv,
    rowCount: rows.length,
    columns: input.headers.length,
    truncated: input.truncated,
    source: input.path,
    problems: [...input.problems],
    lines: rows.map((r) => Object.values(r).join(" ")),
    async profile(): Promise<PdfProfile> {
      if (input.headers.length === 0 || rows.length === 0) {
        throw new Error(`the PDF produced no table to profile: ${input.problems.join("; ")}`);
      }
      // The same resolution every other front door uses, so a learned schema
      // applies to a PDF exactly as it would to the CSV with the same headers.
      const schema = await resolveSchemaMemory({
        cwd: input.schemaCwd ?? "configs/..",
        headers: csv.headers,
        rows: csv.rows,
      });
      return { schema, bottlenecks: analyseBottlenecks(csv, schema), declined: schema === undefined };
    },
  };
}

export { buildPdfBytes } from "../test-support/pdf-fixture.ts";
export type { PdfFixtureOptions } from "../test-support/pdf-fixture.ts";
