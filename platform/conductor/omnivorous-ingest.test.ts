import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { csvRead, detectFormat } from "./capabilities.ts";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { makeTempWorkspace, writeFixture } from "../test-support/temp-workspace.ts";
import { parseLogLine } from "../ingestion/log-tokenizer.ts";
import { looksLikeJsonl } from "../ingestion/jsonl-tokenizer.ts";

/**
 * OMNIVOROUS: the same pipeline, three diets.
 *
 * === WHY THE FORMAT IS DETECTED RATHER THAN DECLARED ===
 *
 * A `.csv` was the only door into this product, which meant a team holding a
 * JSONL telemetry feed or a pile of server logs had nothing to point it at. The
 * obvious extension -- trust the file name -- fails on exactly the case that
 * matters most: a file called `service.log` holding one JSON object per line is a
 * JSONL feed, and reading it as text throws away every field it has. So the name is
 * a hint and the CONTENT decides.
 *
 * === WHAT IS ASSERTED HERE, AND WHY IT IS THE SAME ASSERTION FOR ALL THREE ===
 *
 * Not "the parser returns rows". That is a smoke test. Each test here drives a
 * real file through the REAL front door and asserts that the ANALYSIS is
 * meaningful -- because the promise is not that we can read a log, it is that the
 * anomaly agent answers the same questions about a log that it does about a CSV.
 */

const JSONL = `{"ts":"2026-09-30T09:00:00Z","level":"ERROR","service":"checkout","latency_ms":1200,"status":500}
{"ts":"2026-09-30T09:05:00Z","level":"INFO","service":"checkout","latency_ms":140,"status":200}
{"ts":"2026-09-30T10:00:00Z","level":"ERROR","service":"search","latency_ms":900,"status":500}
{"ts":"2026-09-30T10:30:00Z","level":"ERROR","service":"search","latency_ms":1500000,"status":500}
{"ts":"2026-09-30T11:00:00Z","level":"INFO","service":"search","latency_ms":120,"status":200}
{"ts":"2026-09-30T11:05:00Z","level":"INFO","service":"search","latency_ms":130,"status":200}
{"ts":"2026-09-30T11:10:00Z","level":"INFO","service":"search","latency_ms":150,"status":200}
{"ts":"2026-09-30T11:15:00Z","level":"INFO","service":"search","latency_ms":160,"status":200}
{"ts":"2026-09-30T11:20:00Z","level":"INFO","service":"search","latency_ms":170,"status":200}`;

const LOG = `203.0.113.7 - - [30/Sep/2026:09:00:00 +0000] "GET /checkout HTTP/1.1" 500 120
203.0.113.7 - - [30/Sep/2026:09:00:01 +0000] "GET /checkout HTTP/1.1" 200 80
203.0.113.9 - - [30/Sep/2026:10:00:00 +0000] "GET /search HTTP/1.1" 500 240
203.0.113.9 - - [30/Sep/2026:10:00:05 +0000] "GET /search HTTP/1.1" 500 999
time=2026-09-30T11:00:00Z level=ERROR service=payment latency_ms=1500000
2026-09-30 12:00:00 WARN disk pressure rising`;

const CSV = `_time,service,level,status,latency_ms
2026-09-30T09:00:00Z,checkout,ERROR,500,1200
2026-09-30T09:05:00Z,checkout,INFO,200,140
2026-09-30T10:30:00Z,search,ERROR,500,1500000
2026-09-30T11:00:00Z,search,INFO,200,120`;

async function feed(name: string, contents: string) {
  const cwd = await makeTempWorkspace("nf-omni-");
  const file = path.join(cwd, name);
  await writeFixture(cwd, name, contents);
  return { cwd, file, csv: await csvRead({ path: file }) };
}

test("THE FORMAT IS DECIDED BY CONTENT, and the name is only a hint", async () => {
  const { file: jsonl } = await feed("telemetry.jsonl", JSONL);
  assert.equal(await detectFormat(jsonl), "jsonl");

  // THE CASE THAT MATTERS: a JSON feed wearing a .log name. Trusting the
  // extension would read it as text and discard every field.
  const { file: disguised } = await feed("service.log", JSONL);
  assert.equal(await detectFormat(disguised), "jsonl",
    "a file named .log holding one JSON object per line is a JSONL feed, and reading it as text loses every field");

  const { file: log } = await feed("access.log", LOG);
  assert.equal(await detectFormat(log), "log");

  const { file: csv } = await feed("orders.csv", CSV);
  assert.equal(await detectFormat(csv), "csv");

  assert.equal(looksLikeJsonl("{"), false, "a truncated object is not a feed");
});

test("JSONL reaches the SAME analysis as a CSV, through the same door", async () => {
  const { csv } = await feed("telemetry.jsonl", JSONL);

  assert.equal(csv.rowCount, 9, "every record counted");
  for (const field of ["ts", "level", "service", "latency_ms", "status"]) {
    assert.ok(csv.headers.includes(field), `the discovered field set must include ${field}; got ${csv.headers.join(", ")}`);
  }

  const analysis = await analyseBottlenecks(csv);
  assert.equal(analysis.totalRows, 9);

  // THE PROMISE. Not "we parsed it" -- that the numeric analysis, the fences and
  // the timeline work identically on a feed that arrived as JSON.
  const latency = analysis.numerical.columns.find((column) => column.column === "latency_ms");
  assert.ok(latency !== undefined, "a numeric field in JSONL is profiled like a numeric column in a CSV");
  assert.equal(latency!.measured, 9);
  assert.equal(latency!.max, 1_500_000, "including the absurd value");
  assert.ok(latency!.outliers > 0, "and it is flagged as an outlier");

  // AND THE TIMELINE, which is the feature that needed the shared accumulators.
  const hours = analysis.hourly.hours.reduce((sum, h) => sum + h.count, 0);
  assert.equal(hours, 9, "the hourly buckets account for every record, from HourlyCounter");
});

test("a MALFORMED JSONL line costs one record, not the whole feed", async () => {
  // Telemetry pipelines truncate and interleave lines. A reader that refuses the
  // file on the first bad record turns a partial outage into no data at all.
  const { csv } = await feed("mixed.jsonl", `{"ts":"2026-09-30T09:00:00Z","service":"a","latency_ms":100}
{ this is not json
{"ts":"2026-09-30T10:00:00Z","service":"b","latency_ms":200}`);

  assert.equal(csv.rowCount, 2, "the two good records survive");
  assert.equal(csv.problems.length, 1, "and the bad one is reported");
  assert.match(csv.problems[0]!, /not valid JSON/);
});

test("a LOG is recognised in four formats, and an unrecognised line is KEPT", async () => {
  const { csv } = await feed("mixed.log", LOG);

  assert.equal(csv.rowCount, 6, "every line becomes a record, including the ones no pattern matched");
  for (const field of ["timestamp", "level", "host", "message"]) {
    assert.ok(csv.headers.includes(field), `the normalised schema must expose ${field}`);
  }

  const rows = csv.rows;
  const combined = rows.find((row) => row["status"] === "500" && row["path"] === "/checkout");
  assert.ok(combined !== undefined, "an Apache combined line yields path and status");
  assert.equal(combined!["host"], "203.0.113.7");
  assert.match(combined!["timestamp"], /^2026-09-30T09:00:00/, "and a timestamp the hourly buckets can use");

  const kv = rows.find((row) => row["level"] === "ERROR" && row["service"] === "payment");
  assert.ok(kv !== undefined, "a key=value line is recognised");
  assert.equal(kv!["latency_ms"], "1500000");

  const kept = rows.find((row) => row["message"] === "2026-09-30 12:00:00 WARN disk pressure rising");
  assert.ok(kept !== undefined, "an unrecognised line is kept WHOLE rather than dropped");
});

test("SYSLOG omits its year, and the timeline says so rather than inventing one", async () => {
  // `Sep 29 03:14:15` is ambiguous until a year is supplied. Guessing 1970 puts
  // traffic in the wrong bucket, and an hour that cannot be placed is not evidence.
  const parsed = parseLogLine("Sep 29 03:14:15 host sshd[1234]: Accepted publickey for root");
  assert.equal(parsed.format, "syslog");
  assert.equal(parsed.host, "host");
  assert.equal(parsed.timestamp, "", "no fabricated year, so the hour is simply absent");
});

test("EVERY diet reaches the same pipeline, with the same answer shape", async () => {
  // One assertion for all three formats, because the promise is uniform: whatever
  // arrives, it becomes a profile the agents can reason about.
  for (const [name, contents] of [["orders.csv", CSV], ["telemetry.jsonl", JSONL], ["access.log", LOG]] as const) {
    const { csv } = await feed(name, contents);
    const analysis = await analyseBottlenecks(csv);
    assert.ok(analysis.totalRows > 0, `${name}: rows`);
    assert.ok(csv.headers.length > 0, `${name}: headers`);
    assert.ok(csv.profile !== undefined, `${name}: profile`);
    assert.equal(csv.rows.length, csv.rowCount, `${name}: the window holds the whole file at this size`);
    // The absurd value survives in every diet, which is the end-to-end claim.
    const latency = analysis.numerical.columns.find((column) => column.column === "latency_ms");
    assert.equal(latency?.max, 1_500_000, `${name}: the planted value is found through the shared profiler`);
  }
});