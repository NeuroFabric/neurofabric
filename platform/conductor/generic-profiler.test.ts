import test from "node:test";
import assert from "node:assert/strict";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { resolveSchemaMemory, profileGenericColumns, inferGenericRoles } from "./schema-memory.ts";
import { parseCsv } from "./capabilities.ts";
import type { CsvReadResult } from "./capabilities.ts";

/**
 * THE GENERIC PROFILER. Anything tabular, not just Pega.
 *
 * Until now a file that matched no stored schema produced NO mapping at all,
 * and the report said so: "every column reading below is inferred from the
 * column NAME alone". For a Splunk alert export there is a verified schema, so
 * that was survivable -- we knew what the shape was. Hand the product a web
 * access log and it produced a near-empty report and a list of roles it could
 * not fill, which is not a neutral outcome: it reads as "this file says
 * nothing" when in fact it says plenty and nobody was looking.
 *
 * So the fallback READS THE VALUES. It samples the rows, classifies every column
 * as temporal / numeric / categorical, and proposes roles from what it finds.
 *
 * AND EVERY PROPOSAL IS A HYPOTHESIS. This is the line the whole feature must
 * not cross. A stored schema is established because a person checked it against
 * a real export; inferring from a column's values is exactly as much of a guess
 * as inferring from its name, only better informed. If a generic profile were
 * allowed to mark its own mappings ESTABLISHED, the report would gain a green
 * "established" badge on the strength of a regex, and the reader would have no
 * way to tell a checked mapping from a lucky guess. The first test below pins
 * that: source GENERIC, every role hypothesis, always.
 */

function csvOf(text: string, file = "in.csv"): CsvReadResult {
  const parsed = parseCsv(text);
  const keyed = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  return { path: file, headers: parsed.headers, rowCount: keyed.length, columns: [], sample: keyed.slice(0, 5), rows: keyed, problems: parsed.problems };
}

/** A web server access log. Nothing about it is Pega, and nothing is foreign. */
const ACCESS_LOG = `timestamp,client_ip,method,path,status,response_bytes,duration_ms,user_agent
2026-09-30 12:00:00,10.0.0.1,GET,/home,200,4096,120,Mozilla/5.0
2026-09-30 12:00:01,10.0.0.2,GET,/api/orders,200,8192,45,Mozilla/5.0
2026-09-30 12:00:02,10.0.0.1,POST,/api/orders,500,128,9800,curl/8.0
2026-09-30 12:00:03,10.0.0.3,GET,/home,200,4096,88,Mozilla/5.0
2026-09-30 12:00:04,10.0.0.4,GET,/login,302,0,31,Mozilla/5.0
2026-09-30 12:00:05,10.0.0.5,PUT,/api/orders,500,128,12400,curl/8.0
2026-09-30 12:00:06,10.0.0.6,GET,/health,200,15,4,Prometheus/2.0`;

/** Generic sales data. No timestamps in a log shape, no alert codes at all. */
const SALES = `order_date,region,product,units,unit_price,revenue
2026-01-04,EMEA,Widget,12,9.99,119.88
2026-01-05,AMER,Gadget,3,249.00,747.00
2026-01-06,APAC,Widget,40,9.99,399.60
2026-01-07,EMEA,Gadget,1,249.00,249.00`;

test("a file matching no known schema is profiled rather than rejected", async () => {
  const csv = csvOf(ACCESS_LOG);
  const schema = await resolveSchemaMemory({ cwd: ".", headers: csv.headers, rows: csv.rows });
  assert.ok(schema !== undefined, "a generic file still gets a mapping");
  assert.equal(schema.source, "GENERIC", "and says plainly that it was inferred, not verified");
});

test("the profiler classifies columns as temporal, numeric or categorical from their VALUES", () => {
  const csv = csvOf(ACCESS_LOG);
  const columns = profileGenericColumns(csv.headers, csv.rows);
  const kindOf = (name: string): string => columns.find((c) => c.column === name)?.kind ?? "absent";
  assert.equal(kindOf("timestamp"), "temporal", "a date parses as a date");
  assert.equal(kindOf("duration_ms"), "numeric", "and a millisecond count parses as a number");
  assert.equal(kindOf("response_bytes"), "numeric", "even a zero-valued one");
  assert.equal(kindOf("client_ip"), "categorical", "10.0.0.1 is not a number, and must not be read as one");
  assert.equal(kindOf("method"), "categorical", "GET is not a date");
  assert.equal(kindOf("path"), "categorical");
  // 10.0.0.1 -> 10, 10.0.0.2 -> 10 if you were careless. Assert the ratio so a
  // future loosening of the numeric test is caught here rather than in a report
  // that silently ranks IP addresses by size.
  const ip = columns.find((c) => c.column === "client_ip")!;
  assert.equal(ip.numericRatio, 0, "an address that LOOKS partly numeric is not a number");
});

test("the profiler infers roles for a file it has never seen", () => {
  const csv = csvOf(ACCESS_LOG);
  const roles = inferGenericRoles(profileGenericColumns(csv.headers, csv.rows));
  assert.equal(roles.time, "timestamp", "the temporal column becomes the time role");
  assert.equal(roles.duration, "duration_ms", "a _ms column becomes the duration role");
  // category: prefer a name like status/code/endpoint, else the lowest-cardinality
  // categorical. Either is defensible as long as it is LABELLED a guess.
  assert.ok(roles.category !== undefined, "some categorical column becomes the category");
});

test("EVERY generic role is a HYPOTHESIS, never established", async () => {
  const csv = csvOf(ACCESS_LOG);
  const schema = await resolveSchemaMemory({ cwd: ".", headers: csv.headers, rows: csv.rows });
  const analysis = analyseBottlenecks(csv, schema);
  assert.equal(analysis.schemaSource, "GENERIC");
  assert.deepEqual(analysis.verifiedRoles ?? [], [], "nothing is verified, because nothing was checked by a person");

  const inferred = analysis.mappings.filter((m) => m.column !== undefined && m.column !== "");
  assert.ok(inferred.length > 0, "there ARE mappings, or there would be nothing to test");
  for (const m of analysis.mappings) {
    assert.equal(m.hypothesis, true, `${m.role} was inferred from values, so it is a hypothesis`);
  }
  // And the note must not claim verification it does not have.
  for (const m of analysis.mappings) {
    assert.ok(!/verified schema/.test(m.note), `${m.role} must not claim to be a verified schema`);
  }
});

test("a generic file produces a real statistical profile, not an empty report", async () => {
  const csv = csvOf(ACCESS_LOG);
  // Through the resolver, because that is the path the renderer takes. Called
  // bare, `analyseBottlenecks` only has column NAMES, and none of its category
  // candidates ("alert_code", "alertType", "event_type"...) is "status" or
  // "path" -- which is precisely the gap the profiler exists to close.
  const schema = await resolveSchemaMemory({ cwd: ".", headers: csv.headers, rows: csv.rows });
  const a = analyseBottlenecks(csv, schema);
  assert.notEqual(a.categoryColumn, null, "a category was found, so this file is not rejected");
  assert.ok(a.categories.length > 0, "and it is ranked");
  // The headline capability: durations are measured on a file the product has
  // never seen, with the same three statistics.
  const slowest = [...a.categories].sort((x, y) => (y.totalElapsed ?? 0) - (x.totalElapsed ?? 0))[0];
  assert.ok(slowest.totalElapsed !== null && slowest.totalElapsed > 0, "cost is measured");
  assert.notEqual(slowest.meanElapsed, null, "mean is measured");
  assert.notEqual(slowest.medianElapsed, null, "median is measured");
  assert.notEqual(slowest.p95Elapsed, null, "p95 is measured");
});

test("sales data profiles too -- and is not mistaken for a log", async () => {
  const csv = csvOf(SALES);
  const columns = profileGenericColumns(csv.headers, csv.rows);
  const kindOf = (n: string): string => columns.find((c) => c.column === n)?.kind ?? "absent";
  assert.equal(kindOf("order_date"), "temporal");
  assert.equal(kindOf("revenue"), "numeric");
  assert.equal(kindOf("region"), "categorical");
  const schema = await resolveSchemaMemory({ cwd: ".", headers: csv.headers, rows: csv.rows });
  assert.equal(schema?.source, "GENERIC");
  // There is no duration column here, so the report must decline rather than
  // invent one. revenue is a NUMBER but it is not a TIME.
  const analysis = analyseBottlenecks(csv, schema);
  assert.equal(analysis.categories[0]?.totalElapsed, null, "money is not milliseconds");
});

test("the Pega schema still wins, and nothing regressed to GENERIC", async () => {
  const csv = csvOf(`_time,source_host,alertType,alert_code,elapsed_time,threshold
2026-09-30 12:00:00.000,host-web,performance,PEGA0001,1200,1000
2026-09-30 12:01:00.000,host-bg,performance,PEGA0002,800,1000`);
  const schema = await resolveSchemaMemory({ cwd: "configs/..", headers: csv.headers, rows: csv.rows });
  assert.equal(schema?.id, "pega-alert-export");
  assert.notEqual(schema?.source, "GENERIC", "a known shape is never downgraded to a guess");
});

test("the profiler degrades safely when there is nothing to sample", async () => {
  // Header-only file. Every column has no evidence, so nothing can be inferred.
  const csv = csvOf("timestamp,path,duration_ms\n");
  const schema = await resolveSchemaMemory({ cwd: ".", headers: csv.headers, rows: csv.rows });
  assert.equal(schema, undefined, "no rows means no evidence means no profile -- and no invented one");
});