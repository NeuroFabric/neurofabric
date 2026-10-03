import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import path from "node:path";

import { csvRead } from "./capabilities.ts";
import { analyseBottlenecks } from "./bottlenecks.ts";
import { makeTempWorkspace } from "../test-support/temp-workspace.ts";
import { RESERVOIR_SIZE } from "./stream-profile.ts";

/**
 * PARITY: every format, one memory contract, one answer scope.
 *
 * === THE DEFECT THIS EXISTS TO CATCH ===
 *
 * When JSONL and logs were first added, their tokenisers built a bounded row
 * window and the profile was assembled from that window afterwards. A delimited
 * file was always profiled over the WHOLE file, so the same 500,000 events
 * produced two different answers depending on how they arrived: a CSV gave
 * statistics for 500,000 rows and a JSONL feed of the identical events gave
 * statistics for the first 10,000.
 *
 * Nothing said so. Both reported a row count, both drew a chart, and a user
 * comparing the dashboard for an export against the dashboard for the live feed
 * of that same export would have seen two different numbers and no explanation.
 *
 * === WHY A WINDOW AND A SCOPE ARE DIFFERENT THINGS ===
 *
 * The retained ROWS stay capped, deliberately: a profile must not need a million
 * records resident, and nothing downstream reads records it does not ask for.
 * What must NOT be capped is the SCOPE of the statistics -- how many rows were
 * measured. So these tests plant a value far outside the window and assert it is
 * found, which is the property the window cannot provide.
 */

const ROWS = 30_000;
const WINDOW = 10_000;

async function writeLines(dir: string, name: string, render: (i: number) => string): Promise<string> {
  const file = path.join(dir, name);
  const out = createWriteStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  for (let start = 0; start < ROWS; start += 5_000) {
    let chunk = "";
    for (let i = start; i < Math.min(start + 5_000, ROWS); i += 1) chunk += render(i) + "\n";
    if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
  }
  await new Promise<void>((resolve, reject) => {
    out.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });
  return file;
}

test("JSONL IS PROFILED OVER THE WHOLE FILE, not the retained window", async (t) => {
  const cwd = await makeTempWorkspace("nf-parity-jsonl-");
  // The absurd value sits at row 29,000 -- three times past the window, so an
  // analysis reading the window cannot see it.
  const file = await writeLines(cwd, "events.jsonl", (i) => JSON.stringify({
    ts: `2026-09-30T${String(i % 24).padStart(2, "0")}:00:00Z`,
    service: `svc-${i % 5}`,
    latency_ms: i === ROWS - 100 ? 15_000_000 : String(100 + (i % 800)),
  }));

  const csv = await csvRead({ path: file });
  assert.equal(csv.rowCount, ROWS, "every event counted");
  assert.ok(csv.rows.length <= WINDOW, "but only a bounded window is RETAINED");

  const latency = csv.profile!.columns["latency_ms"]!;
  assert.equal(latency.measured, ROWS,
    `the profile must cover all ${ROWS} events, not the ${WINDOW} retained; got ${latency.measured}`);
  assert.equal(latency.max, 15_000_000, "and must find the value planted past the window");
  assert.equal(latency.exact, false, "the quantiles are a sample, and say so");

  const analysis = await analyseBottlenecks(csv);
  const stat = analysis.numerical.columns.find((column) => column.column === "latency_ms");
  assert.equal(stat?.measured, ROWS, "and the ANALYSIS sees the same whole file");
  assert.equal(stat?.max, 15_000_000, "so the planted value reaches the analysis, not just the profile");
  // NOT asserted: that the outlier count is 1. The fences come from a 4096-value
  // reservoir, and a single value in 30,000 has roughly a one-in-eight chance of
  // being IN that reservoir -- so whether it lands beyond the fence is a property
  // of the sample, not of the file. What must hold is that the claim is LABELLED:
  assert.equal(stat?.quantilesSampled, true,
    "and the quartiles that placed the fence are stated as sampled, so a reader can tell an estimate " +
    "from a measurement. Asserting the count instead would pin the test to a random draw.");
  t.diagnostic(`jsonl: ${latency.measured} measured, max ${latency.max}, outliers ${stat?.outliers}`);
});

test("A LOG IS PROFILED OVER THE WHOLE FILE too", async (t) => {
  const cwd = await makeTempWorkspace("nf-parity-log-");
  const file = await writeLines(cwd, "access.log", (i) => `203.0.113.${i % 251} - - `
    + `[30/Sep/2026:${String(i % 24).padStart(2, "0")}:00:00 +0000] "GET /p${i % 9} HTTP/1.1" `
    + `${i === ROWS - 100 ? "503" : "200"} ${100 + (i % 800)}`);

  const csv = await csvRead({ path: file });
  assert.equal(csv.rowCount, ROWS);
  assert.ok(csv.rows.length <= WINDOW, "the row window is still bounded");

  const bytes = csv.profile!.columns["bytes"]!;
  assert.equal(bytes.measured, ROWS, "the log profile covers every line, not the window");
  assert.ok(csv.profile!.columns["timestamp"] !== undefined, "and the Apache date is a real instant");

  const analysis = await analyseBottlenecks(csv);
  const hours = analysis.hourly.hours.reduce((sum, h) => sum + h.count, 0);
  assert.equal(hours, ROWS,
    `the timeline must account for every line; it accounts for ${hours}. A log with a quarter of its traffic ` +
    "missing from the chart is a chart of the sampling policy, not of the file.");
  t.diagnostic(`log: ${bytes.measured} measured across ${analysis.hourly.buckets} hourly buckets`);
});

test("MEMORY IS THE SAME FOR ALL THREE FORMATS, because the caps are the caps", async (t) => {
  const cwd = await makeTempWorkspace("nf-parity-mem-");
  const jsonl = await writeLines(cwd, "e.jsonl", (i) => JSON.stringify({ a: String(i), b: `x${i % 40}` }));
  const csv = await writeLines(cwd, "e.csv", (i) => `${i},x${i % 40}`);

  const heap = (): number => process.memoryUsage().heapUsed / (1024 * 1024);
  const before = heap();
  const viaCsv = await csvRead({ path: csv });
  const afterCsv = heap();
  const viaJsonl = await csvRead({ path: jsonl });
  const afterJsonl = heap();

  // The retained rows are the dominant term and they are capped identically.
  assert.ok(viaCsv.rows.length <= WINDOW && viaJsonl.rows.length <= WINDOW, "both windows capped");
  const growth = afterJsonl - afterCsv;
  assert.ok(Math.abs(growth) < 25,
    `the JSONL path grew the heap ${growth.toFixed(1)} MB more than the CSV path. Parity means parity in ` +
    "MEMORY as well as in scope; a format that is accurate but unbounded is not a format, it is a delay.");
  t.diagnostic(`heap ${before.toFixed(1)} -> csv ${afterCsv.toFixed(1)} -> jsonl ${afterJsonl.toFixed(1)} MB`);
});

test("A FIELD THAT APPEARS LATE does not RESET the profile", async () => {
  // JSONL has no header row, so the field set is LEARNED. A profile that re-ran
  // its header setup on a new field would discard every accumulator and report
  // statistics for the events since that field's arrival -- while looking
  // complete. The early field's count would collapse; this asserts it does not.
  const cwd = await makeTempWorkspace("nf-parity-late-");
  const file = await writeLines(cwd, "late.jsonl", (i) => JSON.stringify({
    stable: String(i),
    ...(i >= 12_000 ? { appeared_late: String(i % 50) } : {}),
  }));

  const csv = await csvRead({ path: file });
  const stable = csv.profile!.columns["stable"]!;
  const late = csv.profile!.columns["appeared_late"]!;
  assert.ok(stable !== undefined && late !== undefined, "both fields are columns");
  assert.equal(stable.measured, ROWS, "the field present from the first event counts all of them");
  assert.equal(late.measured, ROWS - 12_000, "and the late field counts only its own events");
  assert.equal(stable.max, ROWS - 1, "with its statistics intact, not reset by the newcomer");
});

test("the RESERVOIR bound is the SAME bound the CSV path uses", async () => {
  // The point of a single set of caps: a reader that quietly allocated more per
  // format would make the memory ceiling a function of which file arrived.
  const cwd = await makeTempWorkspace("nf-parity-cap-");
  const file = await writeLines(cwd, "cap.jsonl", (i) => JSON.stringify({ v: String(i) }));
  const csv = await csvRead({ path: file });
  assert.equal(csv.profile!.columns["v"]!.sample.length, Math.min(RESERVOIR_SIZE, ROWS),
    "the sample is bounded exactly as the CSV reader bounds it");
});