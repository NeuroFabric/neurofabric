/**
 * THE PRODUCT ENTRY POINT.
 *
 *   node --experimental-strip-types platform/conductor/cli.mjs --file data/splunk_pega_alerts.csv
 *   node --experimental-strip-types platform/conductor/cli.mjs --file <csv> --out <report.html>
 *
 * Every path is taken from the command line and is therefore UNTRUSTED. Nothing
 * here resolves or validates a path itself: the file is handed to the kernel
 * through governedIngest, and a refusal is the kernel's, carrying its tier.
 *
 * Exit codes, chosen so a caller can tell the cases apart without parsing text:
 *   0  report written
 *   1  the kernel refused the path          (policy refusal, with tier)
 *   2  the file could not be read           (allowed, but absent or unreadable)
 *   3  the file parsed, but is structurally broken; no report written
 *   4  bad usage
 *
 * The distinction between 1 and 2 is deliberate. "You may not read that" and
 * "that file is not there" call for different next moves from the user, and a
 * tool that reports both as "error" teaches people to ignore it.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { governedIngest, projectPolicyConfig } from "./ingest.ts";
import { analyseBottlenecks, OWNER_RULINGS } from "./bottlenecks.ts";
import { renderBottleneckReport } from "./bottleneck-report.ts";
import { loadSchemaMemory, recallMapping, rememberMapping, schemaMemoryPath } from "./schema-memory.ts";

function usage() {
  console.error("usage: cli.mjs --file <path.csv> [--out <report.html>] [--root <workspace>]");
  return 4;
}

const args = process.argv.slice(2);
let file;
let out;
let root = process.cwd();

for (let i = 0; i < args.length; i += 1) {
  const flag = args[i];
  const value = args[i + 1];
  if (flag === "--file" && value !== undefined) { file = value; i += 1; }
  else if (flag === "--out" && value !== undefined) { out = value; i += 1; }
  else if (flag === "--root" && value !== undefined) { root = value; i += 1; }
  else if (flag === "--help" || flag === "-h") { usage(); process.exit(0); }
}
if (file === undefined) process.exit(usage());

// The project's own policy, when there is one, so the CLI runs under the same
// rules the repository is governed by rather than a default set.
let policyConfig;
try {
  policyConfig = projectPolicyConfig(await readFile(path.join(root, ".pi", "neurofebric-policy.json"), "utf8"));
} catch {
  policyConfig = undefined;
}

console.log(`file  ${file}`);
console.log(`root  ${root}`);

const ingest = await governedIngest({ cwd: root, requested: file, policyConfig });

if (ingest.refused) {
  if (ingest.kind === "policy") {
    console.error(`\nREFUSED by policy${ingest.tier === undefined ? "" : ` [${ingest.tier}]`}`);
  } else {
    console.error("\nCOULD NOT READ");
  }
  console.error(`  ${ingest.reason}`);
  if (ingest.kind === "policy") {
    console.error("\nThis is the workspace boundary, not a missing file. The file was never opened.");
  }
  process.exit(ingest.kind === "policy" ? 1 : 2);
}

console.log(`\nrows    ${ingest.rowCount.toLocaleString()}`);

// Consult the memory BEFORE profiling. A remembered mapping is a CANDIDATE:
// recallMapping drops any entry naming a column this file does not have, so a
// stale memory is rejected rather than obeyed.
const memoryFile = schemaMemoryPath(root);
const memory = await loadSchemaMemory(memoryFile);
if (memory.corrupt) {
  console.log("memory  UNREADABLE - proceeding without it (rulings carried in it are lost)");
}
const recalled = recallMapping(memory, ingest.csv.headers);
if (recalled !== null) {
  console.log(`memory  recalled schema learned from ${recalled.learnedFrom}`
    + `${recalled.confirmedByOwner === true ? " (owner-confirmed)" : " (unconfirmed)"}`);
  console.log(`        category=${recalled.roles.category ?? "?"} duration=${recalled.roles.duration ?? "?"} time=${recalled.roles.time ?? "?"}`);
} else {
  console.log("memory  no remembered schema for these columns");
}

const analysis = analyseBottlenecks(ingest.csv);
console.log(`leader  ${analysis.categoryColumn ?? "no credible category column"}`);

const destination = out ?? path.join(root, "bottlenecks.html");
const rendered = await renderBottleneckReport({ path: destination, title: "Bottleneck report", csv: ingest.csv });

if (!rendered.rendered) {
  console.error(`\nNO REPORT WRITTEN. ${rendered.problems.length} structural problem(s):`);
  for (const p of rendered.problems.slice(0, 10)) console.error(`  - ${p}`);
  console.error("\nA report drawn from a ragged file is a lie with a table on it.");
  process.exit(3);
}

console.log(`report  ${rendered.path} (${rendered.bytes.toLocaleString()} bytes)`);

// Learn this schema only from a run that actually produced a report. Remembering
// a mapping from a file that was refused or unreadable would teach the next run
// something that was never established.
if (analysis.categoryColumn !== null) {
  const roles = {};
  for (const m of analysis.mappings) roles[m.role] = m.column;
  await rememberMapping(memoryFile, {
    signature: ingest.csv.headers,
    marker: ingest.csv.headers.filter((h) => ["alertType", "alert_code", "elapsed_time", "_time", "pega_time", "logger_name"].includes(h)),
    roles,
    learnedFrom: path.relative(root, ingest.path) || path.basename(ingest.path),
    rulings: { durationUnit: OWNER_RULINGS.durationUnit, timeZone: OWNER_RULINGS.timeZone },
  });
  console.log(`memory  recorded this schema for next time`);
}

if (analysis.divergence !== null) {
  const d = analysis.divergence;
  console.log(`\nDIVERGENCE: ${d.byElapsed.label} carries ${d.byElapsed.count} alerts and ` +
    `${d.byElapsed.totalElapsed?.toLocaleString()} ms, against ${d.byFrequency.label} at ` +
    `${d.byFrequency.count} alerts and ${d.byFrequency.totalElapsed?.toLocaleString()} ms.`);
  console.log("Ranking by frequency alone would have buried it.");
}
process.exit(0);