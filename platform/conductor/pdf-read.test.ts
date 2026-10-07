import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceBoundary } from "../core/workspace.ts";
import { pdfRead } from "./capabilities.ts";

function makePdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(`BT\n/F1 18 Tf\n20 100 Td\n(${text}) Tj\nET\n`, "ascii")} >>\nstream\nBT\n/F1 18 Tf\n20 100 Td\n(${text}) Tj\nET\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

describe("pdfRead", () => {
  it("rejects paths outside the workspace boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "pdf-boundary-"));
    try {
      const boundary = new WorkspaceBoundary([root]);
      await assert.rejects(pdfRead({ path: join(root, "..", "outside.pdf") }, { boundary }), /outside the workspace boundary/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extracts text from a PDF inside the workspace boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "pdf-read-"));
    const pdfPath = join(root, "example.pdf");
    try {
      writeFileSync(pdfPath, makePdf("Governed PDF text"));
      const result = await pdfRead({ path: pdfPath }, { boundary: new WorkspaceBoundary([root]) });
      assert.strictEqual(result.path, pdfPath);
      assert.strictEqual(result.pages, 1);
      assert.ok(result.text.includes("Governed PDF text"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
