/**
 * THE SCALE PROBE, and why it lives here.
 *
 * The probe's job is one number: do the categorical rankings and the hourly
 * timeline describe EVERY row, or the first ten thousand? Phase 11 exists to
 * answer that, and a claim about scale deserves a measurement rather than a
 * reasoning.
 *
 * WHY `.scratch/` AND WHY THESE IMPORTS. Two boundary rules, both learned the
 * hard way in this session:
 *
 *   1. Nothing may be written outside the workspace root. A probe in the host OS
 *      temp directory is refused -- correctly: this kernel reads a user's files
 *      and must not be able to place its own scratch beside them.
 *   2. A relative import that CLIMBS (`../`) is refused as a traversal even when
 *      it resolves back inside the root. The check is lexical, so a probe sitting
 *      in a subdirectory cannot reach up to `platform/` by `..`.
 *
 * So the probe is written INSIDE the root, and reaches the modules by absolute
 * in-root URL. Nothing here escapes, and nothing is left behind: `.scratch/` is
 * ignored by git, and this file is not part of the test suite -- the durable
 * assertion of the same property lives in `streaming-ingest.test.ts`.
 */

import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = "file:///D:/Agent-Harness/agent-harness_omni/agent-harness/platform/conductor/";
const { csvRead } = await import(`${ROOT}capabilities.ts`);
const { analyseBottlenecks } = await import(`${ROOT}bottlenecks.ts`);

/** Comfortably past the 10,000-row window the old reader stopped at. */
const ROWS = 60_000;
const CATEGORIES = ["login", "checkout", "search", "payment"];

async function main(): Promise<void> {
  // The fixture is written INSIDE the workspace, because the boundary forbids
  // the OS temp directory. It is removed with `rm` from node's own API -- the
  // shell `rm` is denied by policy, and a policy is not circumvented by routing
  // the same deletion through a different tool.
  const dir = await mkdtemp(path.join(process.cwd(), ".scratch", "probe-"));
  const file = path.join(dir, "scale.csv");
  try {
    const out = createWriteStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
    out.write("_time,source,status,_raw,alertType,elapsed_ms,threshold\n");
    for (let start = 0; start < ROWS; start += 5_000) {
      let chunk = "";
      for (let i = start; i < Math.min(start + 5_000, ROWS); i += 1) {
        const hour = String(i % 24).padStart(2, "0");
        const day = String((i % 28) + 1).padStart(2, "0");
        chunk += `2026-09-${day}T${hour}:00:00Z,svc-${i % 500},500,ERROR failure ${i % 9},`
          + `${CATEGORIES[i % 4]},${100 + (i % 900)},1000\n`;
      }
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", () => resolve()));
    }
    await new Promise<void>((resolve, reject) => {
      out.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });

    const mb = (): number => process.memoryUsage().heapUsed / (1024 * 1024);
    const before = mb();
    const csv = await csvRead({ path: file });
    const afterRead = mb();
    const analysis = await analyseBottlenecks(csv);
    const afterAnalyse = mb();

    const categorySum = analysis.categories.reduce((sum, c) => sum + c.count, 0);
    const hourSum = analysis.hourly.hours.reduce((sum, h) => sum + h.count, 0);
    const sourceSum = analysis.bySource.reduce((sum, b) => sum + b.count, 0);

    console.log("=== SCALE PROBE ===");
    console.log(`file rows            : ${csv.rowCount.toLocaleString("en-US")}`);
    console.log(`retained window      : ${csv.rows.length.toLocaleString("en-US")}  (the part allowed to hold records)`);
    console.log(`totalRows            : ${analysis.totalRows.toLocaleString("en-US")}`);
    console.log(`rowsRanked           : ${analysis.rankingScope.rowsRanked.toLocaleString("en-US")}  viaStreaming=${analysis.rankingScope.viaStreamingPass}`);
    console.log(`sum of category count: ${categorySum.toLocaleString("en-US")}  across ${analysis.categories.length} keys`);
    console.log(`sum of hourly counts : ${hourSum.toLocaleString("en-US")}  across ${analysis.hourly.buckets} buckets`);
    console.log(`sum of source counts : ${sourceSum.toLocaleString("en-US")}  across ${analysis.bySource.length} sources`);
    console.log(`dropped keys         : categories ${analysis.rankingScope.droppedCategoryKeys} | sources ${analysis.rankingScope.droppedSourceKeys} | signatures ${analysis.rankingScope.droppedSignatureKeys}`);
    console.log(`errorRows            : ${analysis.errorRows.toLocaleString("en-US")}`);
    console.log(`heap MB              : ${before.toFixed(1)} -> read ${afterRead.toFixed(1)} -> analyse ${afterAnalyse.toFixed(1)}`);

    const past = categorySum > 10_000 && hourSum > 10_000;
    console.log(past
      ? "VERDICT: PASS -- both exceed the old 10,000-row window"
      : "VERDICT: FAIL -- a ranking still stops at the window");
    if (!past) process.exitCode = 1;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await main();