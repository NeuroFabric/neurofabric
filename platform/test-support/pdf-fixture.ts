import { deflateSync } from "node:zlib";

/**
 * A MINIMAL PDF WRITER, for tests.
 *
 * This lives in test-support and not in pdf-connector.ts on purpose. The
 * connector reads PDFs; a builder that produces them is test scaffolding, and
 * shipping one inside the production module would mean the thing under test and
 * the thing that makes its input were written by the same hand in the same file.
 * The database connector keeps the same line: `csvLikeResult` exists so a host
 * can prove the pipeline, but nothing that fabricates a database.
 *
 * It is a real PDF, not a mock: correct object numbering, a real cross-reference
 * table with real byte offsets, and a real Helvetica Type1 font reference. A
 * fixture that merely *looked* like a PDF would let the extractor pass against
 * bytes no real reader could produce, which is the classic way a parser test
 * becomes decorative.
 *
 * Written as latin1 so every character is exactly one byte and the xref offsets
 * are the byte offsets rather than the code-unit offsets. UTF-8 would put
 * multi-byte sequences in the stream, the lengths would still be written in
 * bytes, and the cross-reference table would point into the middle of a
 * character.
 */

export interface PdfFixtureOptions {
  /** FlateDecode the content stream, which is what most real producers do. */
  readonly compress?: boolean;
  /** A stream with no text operators at all -- i.e. a scan. */
  readonly imageOnly?: boolean;
  /** Put an /Encrypt reference in the trailer, as an encrypted file has. */
  readonly encrypt?: boolean;
  /** Grow the content stream to roughly this many bytes, for bound tests. */
  readonly padTo?: number;
}

/** Escape a string for a PDF literal string. */
function literal(value: string): string {
  return `(${value.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

/**
 * The content stream for `lines`, one text line each.
 *
 * `T*` is used between lines rather than a fresh `Td` because it is the shorter
 * of the two and is what most producers emit for a simple text block; the
 * extractor handles both.
 */
function contentStream(lines: readonly string[], options: PdfFixtureOptions): string {
  if (options.imageOnly) {
    // A page whose content is a single placed image. There is no BT/ET here at
    // all, which is the whole point: there is no text to find, and a reader that
    // invents rows here is fabricating data.
    return "q 1000 0 0 1000 0 0 cm /Im0 Do Q\n";
  }
  const body = lines.map((line) => `${literal(line)} Tj\nT*\n`).join("");
  // The pad is a PDF comment, because a comment is the one thing a content
  // stream may contain at unbounded length. It also gives the tokenizer a very
  // large comment to skip, which is a fair test of the byte cap.
  const padding = options.padTo === undefined
    ? ""
    : `%${" ".repeat(Math.max(0, options.padTo - body.length))}\n`;
  return `BT\n/F1 11 Tf\n14 TL\n72 720 Td\n${body}ET\n${padding}`;
}

export function buildPdfBytes(lines: readonly string[], options: PdfFixtureOptions = {}): Buffer {
  const stream = contentStream(lines, options);
  const payload = options.compress === true ? Buffer.from(deflateSync(Buffer.from(stream, "latin1"))) : Buffer.from(stream, "latin1");
  const filter = options.compress === true ? " /Filter /FlateDecode" : "";

  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${payload.length}${filter} >>\nstream\n${payload.toString("latin1")}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  if (options.encrypt === true) objects.push("<< /Filter /Standard /V 2 /R 3 /Length 128 >>");

  let pdf = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  // A real cross-reference table, with the 20-bytes-per-entry rule the format
  // actually specifies. An extractor that scans for `obj` markers does not need
  // it, but a fixture that omits it is not a file any PDF reader would open, and
  // then the test proves only that the extractor is more forgiving than a reader.
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  const encryptRef = options.encrypt === true ? " /Encrypt 6 0 R" : "";
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryptRef} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}
