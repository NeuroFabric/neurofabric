import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";

import { routeFile, detectFileType, UNSUPPORTED_FILE_TYPE, type RouteResult } from "./router.ts";
import { buildPdfBytes } from "../test-support/pdf-fixture.ts";

/**
 * THE ROUTER. The Conductor should not be told what a file is.
 *
 * THE ARGUMENT FOR MAGIC BYTES OVER EXTENSIONS is that a user's file is
 * routinely mis-named, and every front door added so far trusts the name it is
 * given. The PDF connector already found this the hard way -- it had to check
 * the magic bytes itself, because a CSV wearing a `.pdf` name would otherwise
 * have produced a confident nonsense table. The router is where that check
 * belongs once, so no front door has to remember it.
 *
 * THE ARGUMENT FOR ROUTING BY CONTENT RATHER THAN REFUSING ON MISMATCH: when
 * the extension and the bytes disagree, the bytes are what is actually going to
 * be parsed, so the bytes decide. The disagreement is reported rather than
 * swallowed, because "you handed me a CSV called incident.pdf" is information
 * the operator wants -- and refusing outright would mean a report the user could
 * easily have had.
 *
 * AN UNSUPPORTED FILE IS A RESULT, NOT AN EXCEPTION. A dropzone that receives
 * a screenshot, a spreadsheet or a tarball must produce a sentence the user can
 * act on. Throwing here would put an unhandled rejection between a browser and
 * an explanation, which is the same defect as a crash with a worse message.
 *
 * NOTE ON THE FIXTURES: every "binary" file below is written from an ARRAY OF
 * BYTE VALUES, never as a string. The first version of this file embedded real
 * control characters in string literals, which made the file itself binary to
 * `grep` and any other tool that reads it -- and which quietly meant a fixture
 * labelled "a spreadsheet" contained bytes nobody could see. `\x03\x04` in the
 * source is four visible characters; the same value typed literally is invisible
 * and unreadable in a diff.
 */

const CSV_TEXT = "_time,region,total\n2026-09-30,EMEA,10\n2026-09-30,AMER,20\n";

async function workspace(prefix = "nf-router-"): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Narrow a union result, with a message that says which branch actually came back. */
function expectOk(result: RouteResult, kind: string): Extract<RouteResult, { ok: true }> {
  assert.equal(result.ok, true, `expected the ${kind} route, got ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error("unreachable");
  assert.equal(result.kind, kind, `expected ${kind}, got ${result.kind}`);
  return result;
}

/** A real database, so the router is not identifying a file it never opens. */
async function buildSqlite(file: string): Promise<void> {
  const { DatabaseSync } = (await import("node:sqlite")) as {
    DatabaseSync: new (p: string) => { exec(sql: string): void; close(): void };
  };
  const handle = new DatabaseSync(file);
  handle.exec("CREATE TABLE orders (id INTEGER, total REAL); INSERT INTO orders VALUES (1, 9.5);");
  handle.close();
}

// === THE THREE ROUTES ======================================================

test("a .csv routes to the CSV profiler and yields a table", async () => {
  const dir = await workspace();
  await writeFile(path.join(dir, "orders.csv"), CSV_TEXT, "utf8");
  const result = expectOk(await routeFile({ path: path.join(dir, "orders.csv"), root: dir }), "csv");
  assert.deepEqual(result.csv.headers, ["_time", "region", "total"]);
  assert.equal(result.csv.rowCount, 2);
  assert.equal(result.detection.by, "content", "the bytes were read, and they said it was text");
});

test("a .pdf routes to the PDF connector and yields its table", async () => {
  const dir = await workspace();
  await writeFile(path.join(dir, "incident.pdf"), buildPdfBytes(["time,region,total", "2026-09-30,EMEA,10", "2026-10-01,APAC,40"]));
  const result = expectOk(await routeFile({ path: path.join(dir, "incident.pdf"), root: dir }), "pdf");
  assert.deepEqual(result.pdf.csv.headers, ["time", "region", "total"]);
  assert.equal(result.detection.by, "content", "the bytes confirmed the name");
  assert.equal(result.detection.magic, "pdf");
  assert.equal(result.detection.agrees, true);
});

test("a .db routes to the database connector, and asks for a query rather than inventing one", async () => {
  const dir = await workspace();
  await buildSqlite(path.join(dir, "orders.db"));
  const result = expectOk(await routeFile({ path: path.join(dir, "orders.db"), root: dir }), "sqlite");
  assert.equal(result.needs, "query",
    "a router cannot invent SQL; it identifies the front door and stops there");
  assert.equal(path.basename(result.file), "orders.db");
});

test("and .sqlite is the same route, because the two names are the same format", async () => {
  const dir = await workspace();
  await buildSqlite(path.join(dir, "orders.sqlite"));
  expectOk(await routeFile({ path: path.join(dir, "orders.sqlite"), root: dir }), "sqlite");
});

// === DETECTION IS BY CONTENT, NOT BY NAME ==================================

test("a PDF named .dat is still a PDF, because the bytes are what gets parsed", async () => {
  const dir = await workspace();
  await writeFile(path.join(dir, "mystery.dat"), buildPdfBytes(["a,b", "1,2"]));
  const result = expectOk(await routeFile({ path: path.join(dir, "mystery.dat"), root: dir }), "pdf");
  assert.equal(result.detection.agrees, false, "and the name/content disagreement is reported, not swallowed");
  assert.equal(result.detection.extension, "dat");
  assert.equal(result.detection.magic, "pdf");
});

test("a CSV wearing a .pdf name is routed as the CSV it actually is", async () => {
  const dir = await workspace();
  await writeFile(path.join(dir, "report.pdf"), CSV_TEXT, "utf8");
  const result = expectOk(await routeFile({ path: path.join(dir, "report.pdf"), root: dir }), "csv");
  assert.equal(result.detection.agrees, false, "the operator is told the name was wrong");
  assert.equal(result.detection.magic, "text", "the bytes are plainly text, which contradicts a PDF by name");
  assert.equal(result.csv.rowCount, 2);
  assert.ok(result.csv.problems.some((p) => /name claims/.test(p)),
    "and the mismatch travels with the rows, so a caller passing only `csv` onward still sees it");
});

// === UNSUPPORTED IS A RESULT, NOT A CRASH ==================================

test("an unsupported file type returns a structured UNSUPPORTED_FILE_TYPE, not a throw", async () => {
  const dir = await workspace();
  // REAL binary headers. The first version of these fixtures wrote words
  // DESCRIBING a spreadsheet, which is plain text -- so they tested nothing, and
  // they would have kept passing for the wrong reason the moment a text path
  // was added. A real .xlsx starts PK\x03\x04, and \x03 is a control character,
  // which is exactly what the text test rejects.
  const cases: ReadonlyArray<readonly [string, number[]]> = [
    ["sheet.xlsx", [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x00, 0x00]],
    ["screenshot.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]],
    ["archive.tar.gz", [0x1f, 0x8b, 0x08, 0x00, 0x00, 0x09, 0x6e, 0x88, 0x00, 0x03]],
  ];
  for (const [name, bytes] of cases) {
    await writeFile(path.join(dir, name), Buffer.from(bytes));
    const result = await routeFile({ path: path.join(dir, name), root: dir });
    assert.equal(result.ok, false, `${name} must not route anywhere`);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.error.code, UNSUPPORTED_FILE_TYPE, `${name} must carry the code a caller can branch on`);
    assert.ok(result.error.reason.length > 0, "and a sentence the user can act on");
    assert.ok(result.error.supported.includes("csv"), "and the list of what IS supported");
  }
});

test("plain text with no delimiters is degraded honestly, not presented as a table", async () => {
  // A .txt of prose is among the likeliest things to be handed over in practice,
  // alongside the logs. It is not thrown away, and it is not dressed up as a
  // measurement: the rows come back, and `problems` says the single column is an
  // artefact of the parser rather than a field name.
  const dir = await workspace();
  await writeFile(path.join(dir, "notes.txt"), "just some prose with no commas at all\n", "utf8");
  const result = expectOk(await routeFile({ path: path.join(dir, "notes.txt"), root: dir }), "csv");
  assert.equal(result.detection.magic, "text", "the bytes were read, not the name");
  assert.equal(result.detection.agrees, true,
    "an unrecognised name over plain text is not a disagreement -- there was no claim to contradict");
  assert.ok(result.csv.problems.some((p) => /no delimiter structure/.test(p)),
    "and the artefact must be declared, or the first sentence of the file reads as a column name");
});

test("an empty file is refused cleanly rather than routed to a parser that would find nothing", async () => {
  const dir = await workspace();
  await writeFile(path.join(dir, "empty.csv"), "", "utf8");
  const result = await routeFile({ path: path.join(dir, "empty.csv"), root: dir });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.error.code, "EMPTY_FILE");
});

// === THE ROUTER IS GOVERNED LIKE EVERY FRONT DOOR =========================

test("a path outside the workspace is refused by the kernel's own boundary", async () => {
  const dir = await workspace();
  const outside = await workspace("nf-router-outside-");
  await writeFile(path.join(outside, "orders.csv"), CSV_TEXT, "utf8");
  const result = await routeFile({ path: path.join(outside, "orders.csv"), root: dir });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.error.code, "PATH_OUTSIDE_WORKSPACE",
    "the router is a new front door and it inherits the same boundary as the old ones");
});

test("a file that does not exist is a clean result, not an unhandled rejection", async () => {
  const dir = await workspace();
  const result = await routeFile({ path: path.join(dir, "absent.csv"), root: dir });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unreachable");
  assert.equal(result.error.code, "FILE_UNREADABLE");
  assert.ok(result.error.reason.length > 0);
});

// === DETECTION IS USABLE ON ITS OWN =======================================

test("detection is a pure function of the bytes, so it can pre-screen a drop", () => {
  const pdf = detectFileType("anything", Buffer.from(buildPdfBytes(["a"])));
  assert.equal(pdf.kind, "pdf");
  const db = detectFileType("anything", Buffer.from("SQLite format 3", "latin1"));
  assert.equal(db.kind, "sqlite", "the SQLite header is recognised even under a nonsense name");
  const csv = detectFileType("x.csv", Buffer.from("a,b\n1,2\n", "utf8"));
  assert.equal(csv.kind, "csv");
  // `text`, not `none`: the bytes DID say something -- that this is not a binary
  // container. A CSV has no signature, but "no signature" and "no information"
  // are different claims, and only the first is true of CSV.
  assert.equal(csv.magic, "text");
  const zip = detectFileType("x.xlsx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
  assert.equal(zip.kind, "unsupported", "a real zip/xlsx header is binary and must not be mistaken for text");
  assert.equal(zip.magic, "none", "and the bytes genuinely said nothing this reader knows");
  const other = detectFileType("x.bin", Buffer.from([0x00, 0x01, 0x02, 0x03]));
  assert.equal(other.kind, "unsupported");
});
