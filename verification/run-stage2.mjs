/**
 * THE STAGE-2 LOOP, as one command.
 *
 *   node --experimental-strip-types verification/run-stage2.mjs <export.csv> <report.html>
 *
 * Reads the export, analyses it, and writes a one-page bottleneck report. The
 * report is one page regardless of input size: a large export is aggregated,
 * never truncated silently.
 *
 * WHAT IT REFUSES TO DO. If the reader reports structural problems, no report is
 * written. A ranking drawn from a file that is known to be ragged is a lie with
 * a table on it, and the whole point of the Stage-2 contract is that this tool
 * says so instead of producing something plausible. Exit code 1 means the input
 * was not analysable; exit code 3 means it was analysable but the renderer
 * declined.
 *
 * Raw log rows are never copied anywhere. This writes the report and nothing
 * else.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { csvRead } from "../platform/conductor/capabilities.ts";
import { analyseBottlenecks } from "../platform/conductor/bottlenecks.ts";
import { renderBottleneckReport } from "../platform/conductor/bottleneck-report.ts";
import { pathExists } from "../platform/test-support/temp-workspace.ts";

const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined) {
  console.error("usage: run-stage2.mjs <export.csv> <report.html>");
  process.exit(2);
}

console.log(`input   ${path.basename(input)}`);
console.log(`output  ${output}`);

let csv;
try {
  csv = await csvRead({ path: input });
} catch (error) {
  console.log(`\nREADER FAILED: ${error instanceof Error ? error.message : String(error)}`);
  console.log("The export could not be read at all. That is a finding, not a failure.");
  process.exit(1);
}

const analysis = analyseBottlenecks(csv);

console.log(`\nrows            ${analysis.totalRows.toLocaleString()}`);
console.log(`errors          ${analysis.errorRows.toLocaleString()} (${(analysis.errorRate * 100).toFixed(1)}%)`);
console.log(`ranked sources  ${analysis.bySource.length}`);
console.log(`signatures      ${analysis.recurring.length}`);
console.log(`hour buckets    ${analysis.byHour.length}`);
console.log(`latency bands   ${analysis.latency.length}`);
console.log(`unreadable time ${analysis.unreadableTimestamps.length}`);

// WHY THE RANKING IS EMPTY, when it is. An empty ranking is a legitimate
// output and the most likely explanation is a schema the analyser does not
// recognise -- which is worth saying out loud rather than shipping a blank table.
if (analysis.bySource.length === 0) console.log("\nNo source column the analyser recognises; the ranking is empty.");
if (analysis.recurring.length === 0) console.log("No message column the analyser recognises; no signatures can be derived.");
if (analysis.errorRows === 0) console.log("No status column the analyser recognises; zero errors were counted.");
if (analysis.byHour.length <= 1) console.log("Timestamps do not span more than one hour; there is no time distribution to show.");

const rendered = await renderBottleneckReport({ path: output, title: "Bottleneck report", csv });

if (!rendered.rendered) {
  console.log(`\nNO REPORT WRITTEN. The reader reported ${rendered.problems.length} structural problem(s):`);
  for (const p of rendered.problems.slice(0, 10)) console.log(`  - ${p}`);
  console.log("\nA report drawn from a ragged file is a lie with a table on it.");
  process.exit(3);
}

console.log(`\nreport written  ${output} (${rendered.bytes.toLocaleString()} bytes)`);
console.log(await pathExists(output) ? "confirmed on disk" : "WARNING: not found on disk");