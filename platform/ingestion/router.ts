import { readFileSync, statSync } from "node:fs";

import { resolveWithinRoot } from "../core/workspace.ts";
import { parseCsv } from "../conductor/capabilities.ts";
import type { CsvReadResult } from "../conductor/capabilities.ts";
import { readPdf, type PdfReadResult } from "./pdf-connector.ts";

/**
 * THE OMNIVOROUS ROUTER. The Conductor should not be told what a file is.
 *
 * Three sessions have added three front doors -- CSV, databases, PDF -- and each
 * one was wired up by a caller who had to know in advance which one it wanted.
 * That is the wrong shape for a product whose claim is that you hand it a file
 * and it works out what the file is. So this is the piece that removes the
 * question, and it is deliberately thin: identify the format, then hand the file
 * to the front door that already exists. It adds no parsing of its own, because
 * a second CSV parser is a second thing to keep correct.
 *
 * CONTENT BEATS NAME, ALWAYS. A user's file is routinely mis-named, and every
 * front door added so far trusted the name it was handed -- which is why the PDF
 * connector grew its own magic-byte check to stop a CSV wearing a `.pdf` name
 * from producing a confident nonsense table. That check belongs here, once. The
 * bytes are what will actually be parsed, so the bytes decide, and the
 * disagreement between name and content is REPORTED rather than swallowed:
 * "you handed me a CSV called incident.pdf" is something the operator wants to
 * know, and refusing outright would deny a report they could easily have had.
 *
 * UNSUPPORTED IS A VALUE, NOT AN EXCEPTION. A dropzone receives screenshots,
 * spreadsheets and tarballs. Each of those has to produce a sentence the user
 * can act on, so the unsupported case is a member of the result union with a
 * code a caller can branch on. Throwing would put an unhandled rejection between
 * a browser and an explanation, which is a crash with a worse message.
 *
 * THE ROUTER IS A FRONT DOOR AND IS GOVERNED LIKE ONE. It calls the kernel's own
 * `resolveWithinRoot` before the file is opened -- the same function, and now the
 * same count as everywhere else. A new entry point is exactly where a missing
 * boundary hides, which is what the last security sweep found three times.
 */

/** The code a caller branches on. A named constant, so it is not a bare string at the call site. */
export const UNSUPPORTED_FILE_TYPE = "UNSUPPORTED_FILE_TYPE";

/** Bytes read to identify a file. Enough for every signature, and for a reliable text test. */
const SNIFF_BYTES = 64;

/** A file at or above this is not something a browser dropzone should hand to a parser. */
export const MAX_SNIFF_FILE_BYTES = 64 * 1024 * 1024;

export type FileKind = "csv" | "pdf" | "sqlite" | "unsupported";

/** What the file IS, as opposed to what it was CALLED. */
export interface Detection {
  readonly kind: FileKind;
  /** The lowercased extension, or "none". */
  readonly extension: string;
  /**
   * What the bytes said: a format signature, `text` for plainly-text content,
   * or `none` for a head this reader does not recognise. `none` is not the same
   * as `text` -- "the content confirmed this" and "the content was not
   * consulted" are different claims, and conflating them is how a wrong answer
   * gets reported as a right one.
   */
  readonly magic: "pdf" | "sqlite" | "text" | "none";
  /** `content` when the bytes decided, `extension` when they had nothing to say. */
  readonly by: "content" | "extension";
  /** False when the name and the content disagree. Reported, never hidden. */
  readonly agrees: boolean;
}

export interface RouterError {
  readonly code: typeof UNSUPPORTED_FILE_TYPE | "PATH_OUTSIDE_WORKSPACE" | "FILE_UNREADABLE" | "EMPTY_FILE";
  /** A sentence a person can act on. Never a stack trace, never a bare enum. */
  readonly reason: string;
  readonly path: string;
  /** What this router can route, so the message can be actionable. */
  readonly supported: readonly string[];
  /** What it thought the file was, when it is worth saying. */
  readonly detected?: string;
}

export type RouteResult =
  | { readonly ok: true; readonly kind: "csv"; readonly detection: Detection; readonly csv: CsvReadResult }
  | { readonly ok: true; readonly kind: "pdf"; readonly detection: Detection; readonly pdf: PdfReadResult }
  /** A database needs a query, and this router will not invent one. */
  | { readonly ok: true; readonly kind: "sqlite"; readonly detection: Detection; readonly file: string; readonly needs: "query" }
  | { readonly ok: false; readonly error: RouterError };

/**
 * Extensions this router recognises, kept next to the detection that uses them.
 *
 * DELIBERATELY SHORT. `.txt` and `.tsv` were here in an earlier draft and were
 * removed, because listing an extension is a claim that the engine reads that
 * format and this one had not been checked. A `.txt` of prose handed to a
 * delimiter parser produces a one-column table whose header is the first
 * sentence of the file, which is a confident wrong answer rather than a
 * useful one. Saying "not supported" costs the user a rename; quietly guessing
 * costs them a report they have to notice is wrong. If tab-separated input is
 * wanted, the honest way to add it is to check the parser handles tabs and
 * write the test -- not to type the extension here.
 */
const BY_EXTENSION: Readonly<Record<string, FileKind>> = {
  csv: "csv",
  pdf: "pdf",
  db: "sqlite",
  sqlite: "sqlite",
  sqlite3: "sqlite",
};

/** What a caller is told it can hand over. */
export const SUPPORTED_EXTENSIONS = Object.keys(BY_EXTENSION);

function extensionOf(file: string): string {
  const base = file.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "none";
}

/**
 * Is this head plainly text?
 *
 * The test is "no C0 control characters", NOT "no NUL byte". The NUL test was
 * the first version and it was quietly dangerous: a real `.xlsx` begins
 * `PK\x03\x04`, which contains no NUL in its first four bytes, so every
 * spreadsheet would have been classified as plain text and handed to the
 * delimiter parser. Control characters are what actually distinguish text from
 * a binary container, and this is the same reasoning the security rules in this
 * codebase use: test the property, not a proxy for it.
 *
 * Tab, newline and carriage return are allowed, because they are the characters
 * a delimited text file is made of. Bytes above 0x7F are allowed, because they
 * are how UTF-8 encodes anything non-ASCII.
 */
function looksText(head: Buffer): boolean {
  if (head.length === 0) return false;
  for (const byte of head) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    if (byte < 0x20 || byte === 0x7f) return false;
  }
  return true;
}

/**
 * Identify by the leading bytes.
 *
 * Three outcomes, and the difference between the last two is the whole point:
 *
 *   - `pdf` / `sqlite` -- the format has a signature and it matched.
 *   - `text` -- the bytes are plainly text, which IS something the content said,
 *     and is not the same as having said nothing.
 *   - `none` -- the bytes are binary and this reader does not recognise them.
 *
 * CSV HAS NO MAGIC BYTES, and that is a fact about the format rather than a gap
 * in this function: a CSV is a convention, so a file full of commas is not
 * distinguishable from a file of prose. But "no signature" is not the same as
 * "no information", and collapsing the two is what made a CSV named `report.pdf`
 * get handed to the PDF reader. The content was plainly text, which already
 * contradicts a name that claims a binary format.
 *
 * The two fixed-offset checks below are 5 and 15 bytes, and they are counted
 * rather than eyeballed: an earlier version compared a FOUR-byte slice against
 * a FIVE-character string, so the PDF check could never be true and every PDF
 * was identified by its name instead of its content. The signature test is
 * worthless if the offset is off by one, and nothing but a test with a real
 * file in it catches that.
 */
function magicKind(head: Buffer): Detection["magic"] {
  if (head.length >= 5 && head.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  // SQLite's header is a literal string, which is why a database identifies
  // itself correctly even when its name says nothing useful.
  if (head.length >= 15 && head.subarray(0, 15).toString("latin1") === "SQLite format 3") return "sqlite";
  return looksText(head) ? "text" : "none";
}

/**
 * DETECT. A pure function of (name, bytes), so it can pre-screen a drop zone
 * without touching the filesystem and be tested on its own.
 */
export function detectFileType(file: string, head: Buffer): Detection {
  const extension = extensionOf(file);
  const byName = BY_EXTENSION[extension] ?? "unsupported";
  const magic = magicKind(head);
  // `text` resolves to the csv family, which is the same place a `.csv` name
  // resolves to. What that buys is the mis-named case: bytes that are plainly
  // text cannot be a PDF or a database whatever the name claims.
  const kind: FileKind = magic === "none" ? byName : magic === "text" ? "csv" : magic;
  // A plain-text file under an unrecognised name is not a DISAGREEMENT -- there
  // was never a claim to contradict. A disagreement is a name that asserts a
  // binary format over content that plainly is not one, like a CSV called
  // `report.pdf`, and that is the case an operator needs told about.
  const agrees = magic === "none"
    ? true
    : magic === "text"
      ? byName === "csv" || byName === "unsupported"
      : byName === magic;
  return {
    kind,
    extension,
    // `magic` is carried explicitly and not derived by a caller. An earlier
    // draft of this function computed the field and then failed to include it in
    // the object it returned, so every consumer read `undefined` -- and the
    // tests caught it, because the tests asserted on the reported value rather
    // than on the route succeeding. A reported field that is quietly absent is
    // worse than a field that is absent, because the caller believes it.
    magic,
    by: magic === "none" ? "extension" : "content",
    agrees,
  };
}

function fail(code: RouterError["code"], reason: string, file: string, detected?: string): RouteResult {
  return { ok: false, error: { code, reason, path: file, supported: SUPPORTED_EXTENSIONS, detected } };
}

/**
 * ROUTE. Governed, then identified, then handed to the front door that exists.
 */
export async function routeFile(input: { readonly path: string; readonly root?: string }): Promise<RouteResult> {
  const root = input.root ?? process.cwd();
  // FIRST, exactly as the PDF connector does. A new front door is the most
  // likely place for a boundary to be forgotten.
  const resolved = resolveWithinRoot(root, input.path);
  if (!resolved.allowed) {
    return fail("PATH_OUTSIDE_WORKSPACE",
      `path boundary violation: ${resolved.reason ?? "the file is outside the workspace"}`, input.path);
  }
  const file = resolved.resolvedPath as string;

  let bytes: Buffer;
  try {
    const stat = statSync(file);
    if (stat.size === 0) {
      return fail("EMPTY_FILE", "the file is empty, so there is nothing to identify or read", file);
    }
    if (stat.size > MAX_SNIFF_FILE_BYTES) {
      return fail("FILE_UNREADABLE",
        `the file is ${stat.size} bytes, over the ${MAX_SNIFF_FILE_BYTES}-byte limit for automatic routing`, file);
    }
    bytes = readFileSync(file);
  } catch (error) {
    return fail("FILE_UNREADABLE", `the file could not be read: ${(error as Error).message}`, file);
  }

  const detection = detectFileType(file, bytes.subarray(0, SNIFF_BYTES));

  if (detection.kind === "unsupported") {
    return fail(UNSUPPORTED_FILE_TYPE,
      detection.extension === "none"
        ? `this file has no extension and its content is not a recognised format; supported: ${SUPPORTED_EXTENSIONS.join(", ")}`
        : `'.${detection.extension}' is not a format this engine can read; supported: ${SUPPORTED_EXTENSIONS.join(", ")}`,
      file, detection.extension);
  }

  // THE HANDOFF. Each branch calls the front door that already exists. The
  // router's whole contribution is the two lines above this point.
  if (detection.kind === "pdf") {
    return { ok: true, kind: "pdf", detection, pdf: await readPdf({ path: file, root }) };
  }
  if (detection.kind === "sqlite") {
    return { ok: true, kind: "sqlite", detection, file, needs: "query" };
  }

  // CSV. Parsed by the Conductor's own reader, and a malformed file stays a
  // RESULT with `problems` rather than becoming a routing failure -- the parser
  // is the thing that understands what "malformed" means for this format.
  const text = bytes.toString("utf8");
  const parsed = parseCsv(text);
  const rows = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));

  // PLAIN TEXT WITH NO DELIMITERS IS REPORTED, NOT PRESENTED AS A TABLE. A file
  // of prose handed to a delimiter parser yields a single column whose header is
  // the first sentence of the file, which looks like a finding and is really an
  // artefact of the parser. So the rows are still returned -- nothing is thrown
  // away, and a log file remains useful -- but the result says in `problems`
  // that the shape is an artefact. This is the same rule the PDF connector
  // follows when it keeps one row per line: degrade honestly, declare it.
  const singleColumn = parsed.headers.length <= 1;
  const problems = [...parsed.problems];
  if (singleColumn && text.trim() !== "") {
    problems.push("this file is plain text with no delimiter structure, so the single column below holds the first line of the file rather than a field name; figures over it are line counts, not measurements");
  }
  if (!detection.agrees) {
    problems.push(`the file's content is not the format its name claims ('.${detection.extension}'); it was read as the format the bytes indicated`);
  }

  const csv: CsvReadResult = {
    path: file,
    headers: parsed.headers,
    rowCount: rows.length,
    columns: [],
    sample: rows.slice(0, 5),
    rows,
    problems,
  };
  return { ok: true, kind: "csv", detection, csv };
}
