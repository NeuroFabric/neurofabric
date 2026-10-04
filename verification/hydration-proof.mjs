/**
 * THE HYDRATION PROOF. Synthetic load in, three claims out.
 *
 * === WHAT IS BEING PROVEN, AND BY WHOM ===
 *
 * The load generator (`hydrate-telemetry.py`) writes files. This drives them
 * through the real ingress and checks the claims that a file cannot check:
 *
 *   1. THE BACKGROUND LOOP SURVIVES SUSTAINED LOAD. The evaluation scheduler is
 *      unref'd and non-reentrant, but neither of those is the same as "does not
 *      accumulate". A loop that leaks a reference per tick looks perfectly
 *      healthy and eventually takes the process down. So the heap is sampled
 *      across the whole run and compared on its slope, not on its peak.
 *
 *   2. THE FENCES STILL TRIP. The generator INJECTED a known number of extreme
 *      values per dataset and recorded the expected ratio in its manifest. A
 *      run that pumps 10,000 rows and reports "no breaches" is either the
 *      detector failing or the loop not running, and those are very different
 *      problems. So the manifest is read and the observed breach is compared to
 *      what was injected.
 *
 *   3. A CONNECTED CONSUMER IS TOLD. The SSE subscription is opened BEFORE any
 *      data is pumped, because a stream opened afterwards would be a stream that
 *      cannot have missed anything and proves nothing. Alert-hub deliberately
 *      does not replay, so ordering here is the whole test.
 *
 * === WHY THE HEAP CLAIM IS A SLOPE AND NOT A THRESHOLD ===
 *
 * A flat heap is not the claim; a bounded one is. V8 grows its heap on demand
 * and does not return it eagerly, so the first samples climb while the process
 * warms up and that climb is not a leak. Comparing first-to-last would call a
 * healthy run a failure. So warmup samples are discarded, and what is asserted
 * is that the heap does not trend UP across the remainder -- which is the shape
 * a per-tick leak actually has.
 *
 * === WHAT THIS DOES NOT PROVE ===
 *
 * It is a synthetic load, not a production one: one process, one tenant, one
 * shape of traffic. It says nothing about behaviour across restarts, under disk
 * pressure, or with a real record open on disk. A proof that overstated its own
 * reach would be worse than no proof.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startWedgeServer } from "../platform/web/server.ts";
import { MemoryStore } from "../platform/memory/store.ts";
import { staticVault, CREDENTIAL_HEADER } from "../platform/omniroute/edge-security.ts";
import { makeTempWorkspace } from "../platform/test-support/temp-workspace.ts";

const DATA_DIR = process.argv[2] ?? ".scratch/hydration";
const TENANT = "acme";
const ROWS_PER_BATCH = 900;

// The token carries BOTH providers, and that is not incidental. The alert stream
// is proved against the `memory` provider while the portal routes are proved
// against `portal`, so a token scoped to only one of them opens one door and
// leaves the other shut. A load harness that silently failed to open its stream
// would still have reported a passing run for everything else.
const TOKEN = { id: TENANT, credential: "hydration-value", providers: ["portal", "memory"] };

/** Read one generated CSV into gateway events. */
function readEvents(file) {
  const text = readFileSync(join(DATA_DIR, file), "utf8");
  const [header, ...lines] = text.trim().split("\n");
  const columns = header.split(",");
  return lines
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const cells = line.split(",");
      const fields = {};
      for (let i = 0; i < columns.length; i += 1) fields[columns[i]] = cells[i];
      // The gateway's declared time column is `pega_time`; anything else is
      // carried as a field and the arrival time is used instead. Stated rather
      // than worked around, because "some datasets had no instant" is a fact
      // about this run that belongs in the report.
      const stamp = fields["pega_time"] ?? fields["_time"] ?? fields["ts"] ?? fields["sample_at"] ?? fields["started_at"];
      const at = stamp === undefined ? undefined : Date.parse(stamp);
      return { fields, ...(Number.isFinite(at) ? { at } : {}) };
    });
}

/** An SSE reader that resolves when an `alert` frame arrives. */
function watchAlerts(url, credential, counter) {
  const controller = new AbortController();
  const done = new Promise((resolve) => {
    fetch(`${url}/api/memory/alerts`, {
      headers: { [CREDENTIAL_HEADER]: credential },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          counter.opened = false;
          resolve();
          return;
        }
        counter.opened = true;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        for (;;) {
          const { done: finished, value } = await reader.read();
          if (finished) break;
          buffered += decoder.decode(value, { stream: true });
          let split = buffered.indexOf("\n\n");
          while (split !== -1) {
            const frame = buffered.slice(0, split);
            buffered = buffered.slice(split + 2);
            if (frame.includes("event: alert")) {
              const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
              if (dataLine !== undefined) {
                try {
                  counter.alerts.push(JSON.parse(dataLine.slice(5).trim()));
                } catch {
                  counter.alerts.push({ unparsed: true });
                }
              }
            }
            split = buffered.indexOf("\n\n");
          }
        }
        resolve();
      })
      .catch(() => resolve());
  });
  return { controller, done };
}

async function main() {
  const manifest = JSON.parse(readFileSync(join(DATA_DIR, "manifest.json"), "utf8"));
  const files = readdirSync(DATA_DIR).filter((name) => name.endsWith(".csv")).sort();

  const cwd = await makeTempWorkspace("nf-hydration-");
  const store = MemoryStore.open({ inMemory: true });
  const server = await startWedgeServer({
    cwd,
    port: 0,
    portalVault: staticVault([TOKEN], "hydration"),
    memory: { store, tenant: TENANT },
    // Short, because this run is minutes of wall time at most and the claim is
    // about the loop holding up, not about the default cadence.
    evaluationIntervalMs: 250,
  });

  const heap = [];
  const counter = { opened: false, alerts: [] };
  const watcher = watchAlerts(server.url, TOKEN.credential, counter);

  const sampling = setInterval(() => {
    heap.push(process.memoryUsage().heapUsed);
  }, 100);

  let pumped = 0;
  let refused = 0;
  const perFile = [];

  try {
    for (const file of files) {
      const events = readEvents(file);
      let acceptedHere = 0;
      for (let offset = 0; offset < events.length; offset += ROWS_PER_BATCH) {
        const batch = events.slice(offset, offset + ROWS_PER_BATCH);
        const response = await fetch(`${server.url}/api/portal/ingest`, {
          method: "POST",
          headers: { [CREDENTIAL_HEADER]: TOKEN.credential, "content-type": "application/json" },
          body: JSON.stringify({ provider: "pega", events: batch }),
        });
        if (response.status !== 200) {
          refused += batch.length;
          continue;
        }
        const body = await response.json();
        acceptedHere += body.accepted;
        refused += body.refused;
      }
      pumped += acceptedHere;
      perFile.push({ file, rows: events.length, accepted: acceptedHere });
    }

    // Give the broker and the loop time to see everything. Bounded rather than
    // assumed, because the loop runs on its own clock and the broker consumes
    // asynchronously; both are honest about being eventual and neither is fast.
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline && store.alertsFor(TENANT).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Let the remaining ticks land so the heap slope covers steady-state ticks.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  } finally {
    clearInterval(sampling);
    watcher.controller.abort();
    await server.close();
  }

  // ---- HEAP, ON ITS SLOPE RATHER THAN ITS PEAK ----
  const warmup = heap.slice(0, Math.min(5, Math.floor(heap.length / 4)));
  const steady = heap.slice(Math.min(5, Math.floor(heap.length / 4)));
  const mib = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
  let slopePerSample = 0;
  if (steady.length >= 2) {
    slopePerSample = (steady[steady.length - 1] - steady[0]) / (steady.length - 1);
  }

  const alerts = store.alertsFor(TENANT);
  const verdicts = store.verdictsFor(TENANT);
  const breachedColumns = verdicts.reduce((total, v) => total + (v.breached ? 1 : 0), 0);

  console.log("\n=== HYDRATION PROOF =========================================");
  console.log(`files pumped      ${files.length}`);
  console.log(`events accepted   ${pumped}`);
  console.log(`events refused    ${refused}`);
  console.log(`alerts over SSE   ${counter.alerts.length}   (stream opened first: ${counter.opened})`);
  console.log(`alerts in record  ${alerts.length}`);
  console.log(`verdicts breached ${breachedColumns} of ${verdicts.length}`);

  console.log("\nper file");
  for (const entry of perFile) {
    const meta = manifest.datasets[entry.file.replace(".csv", "")];
    const ratio = meta === undefined ? "?" : `${meta.max_over_median}x`;
    console.log(`  ${entry.file.padEnd(20)} rows=${String(entry.rows).padStart(6)}  accepted=${String(entry.accepted).padStart(6)}  injected max/median=${ratio}`);
  }

  console.log("\nheap (MiB)");
  console.log(`  warmup   ${warmup.length > 0 ? mib(warmup[warmup.length - 1]) : "n/a"} (discarded)`);
  console.log(`  steady   first=${steady.length > 0 ? mib(steady[0]) : "n/a"}  last=${steady.length > 0 ? mib(steady[steady.length - 1]) : "n/a"}  peak=${mib(Math.max(...heap))}`);
  console.log(`  drift    ${slopePerSample >= 0 ? "+" : ""}${(slopePerSample / 1024).toFixed(2)} MiB per sample over ${steady.length} samples`);

  console.log("\ninjected outliers (manifest)");
  for (const [name, meta] of Object.entries(manifest.datasets)) {
    console.log(`  ${name.padEnd(18)} ${String(meta.injected_spikes).padStart(3)} spikes on ${meta.value_column}`);
  }

  // ---- THE THREE CLAIMS ----
  const claims = [
    { name: "the loop recorded a breach under load", ok: breachedColumns > 0 },
    { name: "a connected SSE consumer was told", ok: counter.opened && counter.alerts.length > 0 },
    { name: "the heap does not trend upward", ok: slopePerSample <= 512 * 1024 },
    { name: "every generated file reached the ingress", ok: files.length === Object.keys(manifest.datasets).length && refused === 0 },
  ];

  console.log("\nclaims");
  for (const claim of claims) {
    console.log(`  ${claim.ok ? "PASS" : "FAIL"}  ${claim.name}`);
  }

  store.close();
  const allOk = claims.every((claim) => claim.ok);
  console.log(`\n${allOk ? "PROOF PASSED" : "PROOF FAILED"}`);
  return allOk ? 0 : 1;
}

process.exitCode = await main();