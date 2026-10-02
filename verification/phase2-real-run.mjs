/**
 * GENERATE THE BLIND-DATASET REPORT.
 *
 * Runs the engine over ui-workspace/random_data_with_issue.csv and writes the
 * Markdown to verification/phase2-real-run/random_data_report.md.
 *
 * The raw file is NOT committed: it is a 200x20 matrix of generated noise, it is
 * in the workspace rather than in the repository, and committing it would add
 * 40,000 numbers to version control to prove a point the committed report already
 * proves. The REPORT is committed, because the claim "this engine flags col_7's
 * type mismatch and col_15's outlier" is only worth anything if it can be
 * re-read later without re-running anything.
 *
 *   npx tsx verification/phase2-real-run.mjs
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { analyseBottlenecks } from "../platform/conductor/bottlenecks.ts";
import { toBottleneckMarkdown } from "../platform/conductor/bottleneck-report.ts";
import { parseCsv } from "../platform/conductor/capabilities.ts";

const SOURCE = "ui-workspace/random_data_with_issue.csv";
const TARGET = "verification/phase2-real-run/random_data_report.md";

const raw = await readFile(SOURCE, "utf8");
const parsed = parseCsv(raw);
if (parsed.problems.length > 0) {
  console.error("refusing to analyse a structurally broken file:", parsed.problems);
  process.exit(1);
}
const rows = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
const csv = { path: SOURCE, headers: parsed.headers, rowCount: rows.length, columns: [], sample: rows.slice(0, 5), rows, problems: parsed.problems };

const analysis = analyseBottlenecks(csv);
const markdown = toBottleneckMarkdown(analysis, "random_data_with_issue");

await mkdir(path.dirname(TARGET), { recursive: true });
await writeFile(TARGET, markdown, "utf8");

const h = analysis.health;
console.log(`wrote ${TARGET} (${Buffer.byteLength(markdown, "utf8")} bytes)`);
console.log(`health: ${h.dirtyCells} dirty, ${h.outlierCells} extreme outlier(s), ${h.emptyCells} empty, clean=${h.clean}`);
for (const c of h.columns) {
  console.log(`  ${c.column}: dirty=${c.dirty} extreme=${c.outliers} marginal=${c.marginalOutliers} empty=${c.empty}`);
}
