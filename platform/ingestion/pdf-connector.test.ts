import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import os from "node:os";
import path from "node:path";

import { KernelAdapter } from "../pi/kernel-adapter.ts";
import { buildPolicy } from "../pi/project-config.ts";
import { parsePolicyConfig, type PolicyConfig } from "../core/policy-config.ts";
import { resolveSchemaMemory } from "../conductor/schema-memory.ts";
import {
  readPdf,
  assertInsideWorkspace,
  PdfRefused,
  buildPdfBytes,
  PDF_MAGIC,
} from "./pdf-connector.ts";
import type { DenialTier, ToolDescriptor } from "../core/index.ts";

/**
 * THE PDF FRONT DOOR. GOVERNED EXACTLY LIKE THE OTHERS.
 *
 * Users do not hand this product CSVs. They hand it the log bundle the vendor
 * emailed, the incident report the postmortem meeting produced, the invoice a
 * system exported "as PDF because PDF is what auditors accept". The engine
 * reads files, so PDF is not a new capability -- it is a new FRONT DOOR onto the
 * profiler that already exists. That is the whole design, and it is the same
 * design as the database connector: extract, reshape into the CsvReadResult the
 * Conductor already understands, and change nothing downstream.
 *
 * WHY THERE IS NO pdf-parse. A dependency is not a free choice in a repository
 * whose product claim is that a fresh clone runs (docs/DECISIONS.md D-018): the
 * platform has ZERO runtime dependencies, and adding one for a text-extraction
 * routine that is a few hundred lines would trade the claim for a convenience.
 * So the text layer is read here, from the content stream, using zlib from
 * node's own stdlib. The limits of that choice are stated in pdf-connector.ts
 * and, more importantly, are REPORTED in `problems` rather than hidden: a
 * document whose text cannot be read produces a result that says so.
 *
 * THE BOUNDARY IS THE POINT OF THIS FILE. A PDF path is an ordinary string, and
 * an ordinary string is exactly what a prompt injection uses to ask the agent to
 * read `C:\Users\...\ .ssh\id_rsa` "for context". So the same
 * `WorkspaceBoundary` that governs a text read governs this one, at the same
 * tier, with the same verdict string -- and it runs in the kernel precheck AND
 * in the connector, because a guard that lives in only one of the two is one
 * import away from being useless.
 */

const RULES = {
  version: 1,
  deniedTools: [],
  allowedTools: [],
  fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
  destructiveCommandPatterns: [],
  destructiveCommandTokens: [],
  secretWritePatterns: [],
  limits: { maxToolCallsPerTask: 200, maxFileWritesPerTask: 30, maxBytesPerWrite: 2_000_000 },
  onViolation: "block",
} as const;

const DESCRIPTOR: ToolDescriptor = {
  name: "read_pdf",
  version: "phase3",
  description: "Extract the text of a PDF and return it as a table",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  outputSchema: { type: "object" },
  capabilities: ["file.read"],
  permissions: ["tool:read_pdf"],
  riskLevel: "READ_ONLY",
  timeoutMs: 10_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
  idempotency: "IDPIDENT",
  sideEffect: "PURE",
} as unknown as ToolDescriptor;

async function governed() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-pdf-"));
  const config: PolicyConfig = parsePolicyConfig({ ...RULES }, "pdf.json");
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy({ policyMode: "TRUSTED_PROJECT", allowedRoots: [dir] }, dir, config));
  adapter.registerTools([DESCRIPTOR]);
  await adapter.beginTask("read the incident report", "read the incident report");
  return { adapter, dir };
}

// === THE HEADLINE CASE ======================================================

test("a PDF path OUTSIDE the workspace is refused by the kernel, not read", async () => {
  const { adapter, dir } = await governed();
  // A path that is perfectly readable by this process, and outside the root.
  // The temptation is exactly the point: "it is just a log the user sent me".
  const outside = path.join(os.tmpdir(), "definitely-not-the-workspace", "incident.pdf");
  const { decision } = await adapter.precheckToolCall("read_pdf", "execute", { path: outside }, undefined, "pdf1");
  assert.equal(decision.decision, "DENY", "a path outside the root must be refused by the kernel precheck");
  const tier = (decision as { tier?: DenialTier }).tier;
  assert.ok(tier === "SOFT_REFUSE" || tier === "HARD_DENY", `tier must be a refusal, got ${String(tier)}`);
  assert.ok(dir, "and the workspace it must stay inside is the one configured above");
});

test("and so is every spelling of an escape", async () => {
  const { adapter, dir } = await governed();
  const escapes = [
    path.join(dir, "..", "..", "etc", "passwd.pdf"),
    path.join(dir, "sub", "..", "..", "outside.pdf"),
    `..${path.sep}..${path.sep}windows${path.sep}system32${path.sep}config.pdf`,
  ];
  for (const [i, p] of escapes.entries()) {
    const { decision } = await adapter.precheckToolCall("read_pdf", "execute", { path: p }, undefined, `pdf2-${i}`);
    assert.equal(decision.decision, "DENY", `${p} must be refused`);
  }
});

test("a path INSIDE the workspace is allowed, so the guard is a filter and not a wall", async () => {
  const { adapter, dir } = await governed();
  const { decision } = await adapter.precheckToolCall("read_pdf", "execute", { path: path.join(dir, "report.pdf") }, undefined, "pdf3");
  assert.equal(decision.decision, "ALLOW", "a legitimate read must pass");
});

// === THE CONNECTOR REFUSES INDEPENDENTLY ==================================

test("the connector itself refuses an out-of-workspace path, so a direct import is not a way around the kernel", async () => {
  // A SEPARATE directory, and this matters more than it looks. The first
  // version of this test used `os.tmpdir()` as the root and
  // `path.join(os.tmpdir(), "elsewhere", ...)` as the target -- and on a Windows
  // host those are the SAME directory, so the target was INSIDE the root. The
  // test passed, and proved nothing, which is the failure mode
  // test-support/temp-workspace.ts was written to warn about. A negative
  // assertion built on a root that does not actually exclude the target is
  // vacuous forever: it cannot fail, whatever the code does.
  const inside = await mkdtemp(path.join(os.tmpdir(), "nf-ws-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "nf-notws-"));
  await assert.rejects(
    () => readPdf({ path: path.join(outside, "incident.pdf"), root: inside }),
    PdfRefused,
    "the connector guard must run before the file is opened",
  );
  // The guard is the kernel's own function, not a second implementation of it.
  assert.doesNotThrow(() => assertInsideWorkspace({ path: "report.pdf", root: process.cwd() }));
});

test("the guard fires BEFORE the filesystem is touched, so there is no window to exploit", async () => {
  const inside = await mkdtemp(path.join(os.tmpdir(), "nf-ws2-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "nf-notws2-"));
  // The file deliberately does NOT exist. If the guard ran after the stat, the
  // caller would get a "could not be read" RESULT and the path would already
  // have been resolved and opened to find that out. Getting PdfRefused proves
  // the ordering, not merely the outcome.
  await assert.rejects(() => readPdf({ path: path.join(outside, "absent.pdf"), root: inside }), PdfRefused);
});

test("the refusal is explainable and names the boundary", async () => {
  const inside = await mkdtemp(path.join(os.tmpdir(), "nf-ws3-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "nf-notws3-"));
  try {
    await readPdf({ path: path.join(outside, "x.pdf"), root: inside });
    assert.fail("should have refused");
  } catch (e) {
    assert.ok(e instanceof PdfRefused);
    assert.match(e.reason, /escap|outside|root/i, "the reason says the path left the workspace");
  }
});

// === THE PIPELINE ACTUALLY WORKS ===========================================

test("a real PDF becomes the exact table shape the Conductor already understands", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-pdffile-"));
  const file = path.join(dir, "orders.pdf");
  await writeFile(file, buildPdfBytes([
    "time,region,total",
    "2026-09-30,EMEA,10.5",
    "2026-09-30,AMER,20.25",
    "2026-10-01,EMEA,30",
    "2026-10-01,APAC,40.75",
    "2026-10-01,EMEA,99.99",
  ]));
  const result = await readPdf({ path: file, root: dir });
  assert.equal(result.rowCount, 5);
  assert.deepEqual(result.csv.headers, ["time", "region", "total"]);
  assert.equal(typeof result.csv.rows[0].total, "string", "cells are strings, exactly as from a CSV");
  assert.equal(result.truncated, false);
});

test("a FlateDecode-compressed stream is inflated, because real PDFs are compressed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-pdfflate-"));
  const file = path.join(dir, "compressed.pdf");
  await writeFile(file, buildPdfBytes(["a,b", "1,2", "3,4"], { compress: true }));
  const result = await readPdf({ path: file, root: dir });
  assert.deepEqual(result.csv.headers, ["a", "b"], "a compressed content stream must inflate before it is read");
  assert.equal(result.rowCount, 2);
});

test("it flows straight into the Conductor's generic profiler, with no new code downstream", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-pdfpipe-"));
  const file = path.join(dir, "orders.pdf");
  await writeFile(file, buildPdfBytes([
    "time,region,total",
    "2026-09-30,EMEA,10.5",
    "2026-09-30,AMER,20.25",
    "2026-10-01,EMEA,30",
    "2026-10-01,APAC,40.75",
    "2026-10-01,EMEA,99.99",
  ]));
  const result = await readPdf({ path: file, root: dir });
  // The connector pipes it itself, rather than making every caller remember to.
  const analysis = await result.profile();
  assert.equal(analysis.schema?.source, "GENERIC", "a table of orders is not a Pega export, so it profiles generically");
  assert.equal(analysis.bottlenecks.categoryColumn, "region", "the category column was found through the normal profiler");
  assert.ok(analysis.bottlenecks.categories.length > 0, "and ranked");
  assert.equal(typeof result.csv.rows[0].total, "string");
});

// === HONESTY ABOUT WHAT CANNOT BE READ =====================================

test("a PDF with no extractable text REPORTS it, rather than returning an empty table", async () => {
  // This is the partial-answer bug wearing a different hat. A scanned invoice
  // yields no text; returning a clean, empty, successful result would tell the
  // caller "this document has no rows", which is a confident and false answer.
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-pdfscan-"));
  const file = path.join(dir, "scanned.pdf");
  await writeFile(file, buildPdfBytes([], { imageOnly: true }));
  const result = await readPdf({ path: file, root: dir });
  assert.equal(result.rowCount, 0);
  assert.ok(result.problems.length > 0, "an unreadable document must say so in problems");
  assert.match(result.problems.join(" | "), /no text|scanned|image/i,
    "and it must name the reason, so the operator knows to send an OCR copy");
});

test("a file that is not a PDF at all is refused by content, not by extension", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-pdffake-"));
  const file = path.join(dir, "not-really.pdf");
  await writeFile(file, "id,name\n1,alice\n");
  const result = await readPdf({ path: file, root: dir });
  assert.ok(result.problems.length > 0, "a .pdf that is not a PDF must be reported");
  assert.match(result.problems.join(" | "), new RegExp(PDF_MAGIC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "and the problem must name the magic bytes, so the operator can see what was expected");
  assert.equal(result.rowCount, 0, "and it must not invent rows out of a text file");
});

test("an encrypted PDF is reported, not silently empty", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-pdfenc-"));
  const file = path.join(dir, "locked.pdf");
  await writeFile(file, buildPdfBytes(["a,b"], { encrypt: true }));
  const result = await readPdf({ path: file, root: dir });
  assert.match(result.problems.join(" | "), /encrypt/i, "an encrypted document is a known, explainable failure");
});

test("an unstructured log PDF still yields every line, one row per line", async () => {
  // "Users receive logs as PDFs" is the actual requirement. A log has no table,
  // so the splitter must degrade to a single column and say that it did, rather
  // than dropping every line on the floor and reporting zero rows.
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-pdflog-"));
  const file = path.join(dir, "app.log.pdf");
  await writeFile(file, buildPdfBytes([
    "2026-09-30 10:00:01 INFO  worker started",
    "2026-09-30 10:00:02 WARN  retrying request",
    "2026-09-30 10:00:03 ERROR upstream timeout",
  ]));
  const result = await readPdf({ path: file, root: dir });
  assert.equal(result.rowCount, 3, "no line is silently discarded");
  assert.deepEqual(result.csv.headers, ["line"]);
  assert.match(result.csv.rows[2].line, /ERROR upstream timeout/);
  assert.ok(result.problems.length > 0, "and the fallback is declared, not disguised as a real table");
});

// === HYGIENE ==============================================================

test("extraction is bounded, so a crafted PDF cannot exhaust memory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-pdfbomb-"));
  const file = path.join(dir, "bomb.pdf");
  // A large stream with no text operators: the reader must cap the bytes it
  // will inflate rather than trusting the document's own /Length.
  await writeFile(file, buildPdfBytes([], { padTo: 4_000_000 }));
  const result = await readPdf({ path: file, root: dir });
  assert.equal(result.rowCount, 0);
  assert.match(result.problems.join(" | "), /truncat|limit|cap/i, "a truncated read is reported, never silent");
});

test("the same PDF extracted twice gives the same table", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-pdfdet-"));
  const file = path.join(dir, "orders.pdf");
  await writeFile(file, buildPdfBytes(["a,b", "1,2", "3,4"]));
  const first = await readPdf({ path: file, root: dir });
  const second = await readPdf({ path: file, root: dir });
  assert.deepEqual(first.csv, second.csv, "ingestion is IDEMPOTENT; a re-read is not a different answer");
});
