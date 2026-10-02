import test from "node:test";
import assert from "node:assert/strict";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { toBottleneckMarkdown, renderBottleneckReport } from "./bottleneck-report.ts";
import { resolveSchemaMemory } from "./schema-memory.ts";
import { parseCsv, csvRead } from "./capabilities.ts";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempWorkspace, writeFixture } from "../test-support/temp-workspace.ts";
import type { CsvReadResult } from "./capabilities.ts";

/**
 * THE VOCABULARY LEAK, CLOSED.
 *
 * Last session I fixed Pega vocabulary for files the GENERIC profiler handled,
 * and flagged that files with NO resolvable schema at all still got it. The
 * Owner then ran a matrix of 20 anonymous numeric columns through the product and
 * got empty tables titled "Alert categories by frequency" -- so the flag was
 * right and the fix had stopped one layer short of the actual rule.
 *
 * THE RULE IS NOW ABSOLUTE: "alert" and "threshold" are earned by a VERIFIED
 * SCHEMA and by nothing else. Three states existed and only two were ever
 * legitimate:
 *
 *   DEFAULT / SESSION_ARCHIVE -- a mapping a person checked against a real
 *     export. Pega vocabulary is earned and correct.
 *   GENERIC -- inferred from column values. Never claimed alerts.
 *   undefined -- NOTHING WAS ESTABLISHED AT ALL, and this is the one that was
 *     quietly claiming alerts by default. Absence of evidence was being rendered
 *     as positive knowledge, which is the exact inversion this product exists
 *     to avoid.
 *
 * The load-bearing consequence: Pega vocabulary is now a CONSEQUENCE of
 * verification rather than a default that verification happens to confirm. A
 * Pega-shaped file with no verified schema is described in records, because
 * shaped like one is not the same as established as one.
 */

function csvOf(text: string, file = "in.csv"): CsvReadResult {
  const parsed = parseCsv(text);
  const keyed = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return { path: file, headers: parsed.headers, rowCount: keyed.length, columns: [], sample: keyed.slice(0, 5), rows: keyed, problems: parsed.problems };
}

const PEGA = `_time,source_host,alertType,alert_code,elapsed_time,threshold
2026-09-30 12:00:00.000,host-web,performance,PEGA0001,1200,1000
2026-09-30 12:01:00.000,host-bg,performance,PEGA0002,800,1000
2026-09-30 12:02:00.000,host-web,performance,PEGA0001,1300,1000
2026-09-30 12:03:00.000,host-api,performance,PEGA0011,300,1000`;

/** The Owner's file, in miniature: anonymous numeric columns and nothing else. */
const NUMERIC_ONLY = `col_1,col_2,col_3,col_4,col_5
1.5,2.25,-3.0,0.5,100
-2.5,4.0,1.25,-1.0,250
3.75,-0.5,2.0,2.5,175
0.0,1.0,-1.5,1.5,225`;

test("NO resolved schema means neutral vocabulary, not Pega", () => {
  // The leak itself. This file has an alert_code column and no verified mapping,
  // which is precisely the state that was asserting alerts it could not support.
  const analysis = analyseBottlenecks(csvOf(PEGA));
  assert.equal(analysis.schemaSource, undefined, "nothing was established about this file");
  assert.equal(analysis.vocabulary.unit, "record", "so it is described in records");
  assert.equal(analysis.vocabulary.unitPlural, "record(s)");
  assert.equal(analysis.vocabulary.headingUnit, "Record");

  const md = toBottleneckMarkdown(analysis, "Bottleneck report");
  // Scoped to the VOCABULARY, not to the file. This fixture's own columns are
  // named alert_code and alertType, and those names legitimately appear in the
  // provenance table -- a report that mangled or hid a real column name would be
  // telling its own lie. What must not appear is the report calling the ROWS
  // alerts.
  assert.ok(!md.includes("alert(s)"), "the rows are not called alerts");
  assert.ok(!md.includes("Alert categories"), "nor is the ranking");
  assert.ok(!md.includes("over threshold"), "nor is the limit called a threshold");
  assert.match(md, /Record categories by frequency/);
  // And the column names are still reported accurately, which is the other half
  // of the duty: neutral vocabulary must not become mangled vocabulary.
  assert.match(md, /alert\\_code/, "the real column name survives");
});

test("a numeric-only file never claims alerts either", () => {
  const analysis = analyseBottlenecks(csvOf(NUMERIC_ONLY));
  assert.equal(analysis.vocabulary.unit, "record");
  const md = toBottleneckMarkdown(analysis, "Numerical file");
  assert.ok(!/alert/i.test(md), "a file of numbers described as alerts is the reported bug, in miniature");
});

test("threshold language is reserved for a verified schema too", async () => {
  const csv = csvOf(PEGA);
  // Unverified: the column is NAMED threshold and that is not enough.
  assert.equal(analyseBottlenecks(csv).vocabulary.thresholdLabel, "over limit",
    "a guessed column is still a guess, so the wording is the neutral one");

  // Verified: now, and only now, it is a threshold.
  const schema = await resolveSchemaMemory({ cwd: "configs/..", headers: csv.headers, rows: csv.rows });
  assert.equal(schema?.source, "DEFAULT");
  const verified = analyseBottlenecks(csv, schema);
  assert.equal(verified.vocabulary.unit, "alert");
  assert.equal(verified.vocabulary.thresholdLabel, "over threshold");
  const md = toBottleneckMarkdown(verified, "Bottleneck report");
  assert.match(md, /Alert categories by frequency/);
  assert.match(md, /alert\(s\)/);
  assert.match(md, /over threshold/);
});

test("a per-checkout learned schema earns ESTABLISHED MAPPINGS but NOT Pega wording", async () => {
  // CORRECTED BY THE FEATURE THAT FOLLOWED IT, and the correction is the point.
  // This used to assert that SESSION_ARCHIVE earns "alert", on the argument that
  // a user correcting a mapping is a person checking it. That is true of the
  // ROLE and silent about the DOMAIN. Now that a browser can point the duration
  // role at a column called amount in a sales CSV, an archive entry can exist for
  // a file with no alerts in it -- and a file of orders is not an alert export,
  // whoever checked which column was which.
  //
  // So the archive earns established MAPPINGS, and the shipped Pega schema alone
  // earns the Pega NOUNS. A mapping somebody checked is still a mapping ABOUT
  // SOMETHING, and only the shipped schema says what.
  const cwd = await makeTempWorkspace("nf-archive-");
  await mkdir(path.join(cwd, ".session-archive"), { recursive: true });
  await writeFile(path.join(cwd, ".session-archive", "schema-memory.json"), JSON.stringify([
    { id: "my-own-pega", roles: { time: "_time", source: "source_host", category: "alert_code", duration: "elapsed_time", threshold: "threshold" } },
  ]), "utf8");

  const csv = csvOf(PEGA);
  const learned = await resolveSchemaMemory({ cwd, headers: csv.headers, rows: csv.rows, defaultsRoot: `${cwd}/none` });
  assert.equal(learned?.source, "SESSION_ARCHIVE", "the archive answers, not the profiler");
  const analysis = analyseBottlenecks(csv, learned);
  assert.equal(analysis.mappings.find((m) => m.role === "duration")?.hypothesis, false,
    "a checked mapping IS established -- that much the old ruling got right");
  assert.equal(analysis.vocabulary.unit, "record", "but it does not make the file an alert export");
  const md = toBottleneckMarkdown(analysis, "Bottleneck report");
  assert.match(md, /Record categories by frequency/);
  assert.ok(!md.includes("alert(s)"), "and no Pega noun leaks from a learned mapping");
});

test("the SHIPPED schema is what earns the Pega wording, and it still does", async () => {
  const csv = csvOf(PEGA);
  const shipped = await resolveSchemaMemory({ cwd: "configs/..", headers: csv.headers, rows: csv.rows });
  assert.equal(shipped?.source, "DEFAULT");
  const analysis = analyseBottlenecks(csv, shipped);
  assert.equal(analysis.vocabulary.unit, "alert", "a verified Pega export is an alert export");
  assert.equal(analysis.vocabulary.thresholdLabel, "over threshold");
  assert.match(toBottleneckMarkdown(analysis, "Bottleneck report"), /Alert categories by frequency/);
});

test("an empty memory is not a verified one -- the profiler's answer stays neutral", async () => {
  // The inverse, and the distinction that matters: no archive, no shipped
  // defaults, so nothing is verified and the profiler's inference takes over.
  // Inference is still inference, so still no alerts.
  const csv = csvOf(PEGA);
  const inferred = await resolveSchemaMemory({ cwd: "configs/..", headers: csv.headers, rows: csv.rows, defaultsRoot: "does-not-exist" });
  assert.equal(inferred?.source, "GENERIC");
  assert.equal(analyseBottlenecks(csv, inferred).vocabulary.unit, "record");
});

test("the html path is guarded the same way", async () => {
  const cwd = await makeTempWorkspace("nf-leak-");
  const file = await writeFixture(cwd, "numeric.csv", NUMERIC_ONLY);
  const csv = await csvRead({ path: file }, { boundary: { check: (p: string) => ({ allowed: true, reason: "t", resolved: p }), assert: (p: string) => p } } as never);
  // defaultsRoot points nowhere, so nothing can resolve and nothing is verified.
  const out = await renderBottleneckReport({ path: `${cwd}/r.html`, title: "Numeric", csv, workspaceCwd: cwd, defaultsRoot: `${cwd}/none` });
  const page = await import("node:fs/promises").then((fs) => fs.readFile(out.path, "utf8"));
  assert.ok(!/alert/i.test(page), "the page must not invent a domain it cannot support");
});