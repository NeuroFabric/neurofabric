/**
 * PROFILE a CSV export before analysing it.
 *
 * Run this FIRST on any export, real or synthetic. The Stage-2 reader was built
 * against a hand-authored fixture, and a hand-authored fixture can only contain
 * assumptions its author already held. Profiling a real export is what turns
 * those assumptions into findings.
 *
 * Reports: byte-level shape (BOM, encoding, line endings), the column set, per
 * column type and fill, timestamp parseability under every format the analyser
 * accepts, ragged rows, and what the Stage-2 reader itself reports.
 *
 * Prints only shape and samples. It never prints whole rows of a real log.
 *
 * Run: node --experimental-strip-types verification/profile-export.mjs <path>
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { csvRead } from "../platform/conductor/capabilities.ts";
import { parseInstant } from "../platform/conductor/bottlenecks.ts";

const target = process.argv[2];
if (target === undefined) {
  console.error("usage: profile-export.mjs <path-to-csv>");
  process.exit(2);
}

const bytes = await readFile(target);
const text = bytes.toString("utf8");

const line = (s = "") => console.log(s);
const section = (s) => { line(); line(`== ${s} ${"=".repeat(Math.max(0, 60 - s.length))}`); };

section("FILE");
line(`path            ${path.basename(target)}`);
line(`bytes           ${bytes.length.toLocaleString()}`);

const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
line(`utf-8 BOM       ${bom ? "PRESENT" : "absent"}`);

const crlf = (text.match(/\r\n/g) ?? []).length;
const bareLf = (text.match(/\n/g) ?? []).length - crlf;
line(`line endings    ${crlf > 0 ? `CRLF x${crlf.toLocaleString()}` : ""}${crlf > 0 && bareLf > 0 ? " + " : ""}${bareLf > 0 ? `LF x${bareLf.toLocaleString()}` : ""}`);

// A strict UTF-8 round trip catches bytes the decoder replaced rather than threw.
const replacement = (text.match(/�/g) ?? []).length;
line(`undecodable     ${replacement === 0 ? "none" : `${replacement} U+FFFD replacement char(s)`}`);

const naiveLines = text.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
line(`non-empty lines ${naiveLines.toLocaleString()}`);

section("PARSE");
let csv;
try {
  csv = await csvRead({ path: target });
  line(`parsed rows     ${csv.rowCount.toLocaleString()}`);
  line(`columns         ${csv.headers.length}`);
  line(`problems        ${csv.problems.length === 0 ? "none" : `${csv.problems.length}`}`);
  for (const p of csv.problems.slice(0, 10)) line(`  - ${p}`);
  if (csv.problems.length > 10) line(`  ... and ${csv.problems.length - 10} more`);
} catch (error) {
  line(`READER FAILED   ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

section("COLUMNS");
const width = Math.max(...csv.headers.map((h) => h.length), 8);
for (const column of csv.columns) {
  const values = csv.sample.map((r) => String(r[column.name] ?? ""));
  const present = values.filter((v) => v.trim().length > 0);
  const fill = csv.sample.length === 0 ? 0 : present.length / csv.sample.length;
  const sample = present[0] ?? "";
  line(`${column.name.padEnd(width)}  ${column.kind.padEnd(7)} fill ${(fill * 100).toFixed(1).padStart(5)}%  ${JSON.stringify(sample.slice(0, 46))}`);
}

section("TIMESTAMPS");
const timeColumn = csv.headers.find((h) => ["_time", "timestamp", "time"].includes(h));
if (timeColumn === undefined) {
  line("no recognised timestamp column -- the hourly view cannot be produced");
} else {
  const values = csv.sample.map((r) => String(r[timeColumn] ?? ""));
  const epoch = values.filter((v) => /^\d+(\.\d+)?$/.test(v.trim()));
  const iso = values.filter((v) => !/^\d+(\.\d+)?$/.test(v.trim()) && !Number.isNaN(Date.parse(v.trim())));
  const broken = values.filter((v) => parseInstant(v) === undefined);
  line(`column          ${timeColumn}`);
  line(`epoch seconds   ${epoch.length.toLocaleString()}`);
  line(`ISO-8601        ${iso.length.toLocaleString()}`);
  line(`UNPARSEABLE     ${broken.length.toLocaleString()}`);
  if (broken.length > 0) line(`  e.g. ${JSON.stringify(broken.slice(0, 3))}`);

  // Span tells us whether the export is one window or several, which is what
  // the hourly buckets are actually claiming to show.
  const instants = values.map(parseInstant).filter((v) => v !== undefined);
  if (instants.length > 1) {
    const lo = Math.min(...instants);
    const hi = Math.max(...instants);
    line(`span            ${new Date(lo).toISOString()} -> ${new Date(hi).toISOString()}`);
    line(`duration        ${((hi - lo) / 3_600_000).toFixed(2)} hour(s)`);
  }
}

section("SAMPLE SHAPE");
const key = csv.headers.find((h) => ["_raw", "message", "msg"].includes(h));
if (key !== undefined) {
  const withComma = csv.sample.filter((r) => String(r[key] ?? "").includes(",")).length;
  line(`"${key}" containing a comma   ${withComma}/${csv.sample.length}`);
  const statuses = csv.headers.find((h) => ["status", "code", "http_status"].includes(h));
  if (statuses !== undefined) {
    const counts = new Map();
    for (const r of csv.sample) {
      const s = String(r[statuses] ?? "(blank)");
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    line(`status distribution           ${[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  ")}`);
  }
}

line();
line("Nothing above is a verdict. It is what the file IS; the report says what");
line("it concludes, and those are different claims.");
line();