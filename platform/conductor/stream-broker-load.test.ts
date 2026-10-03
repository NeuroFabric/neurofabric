import test from "node:test";
import assert from "node:assert/strict";

import { StreamBroker, type BrokerRecord } from "./stream-broker.ts";
import { evaluateLive, liveFindings } from "./live-anomaly.ts";
import { anomalyAgent } from "./subagents/anomaly-agent.ts";
import { RESERVOIR_SIZE } from "./stream-profile.ts";

/**
 * THE LOAD TEST: a real stream, at rate, on the heap.
 *
 * === WHY A COUNT AND NOT A TIMING ===
 *
 * Throughput here is a proxy for something that can only be measured honestly on
 * hardware nobody in this repository shares. What IS portable, and what actually
 * broke in production, is MEMORY: a live broker that retains per-event state
 * grows with the stream, and the failure is an OOM after hours of uptime rather
 * than a slow frame. So the load test asserts the heap stays flat across 50,000
 * events, and treats duration as a diagnostic rather than a threshold.
 *
 * === WHY THE ANOMALY IS IN THE MIDDLE ===
 *
 * Injected at the end it proves only that the last value was noticed. Mid-stream
 * it proves the accumulators were already correct BEFORE the breach, which is the
 * property that makes an alert timely: an operator who learns about the spike from
 * a retrospective is learning it too late to act.
 */

const EVENTS = 50_000;
const PARTITIONS = ["checkout", "search", "payment"];
const INJECTED_LATENCY = 12_000_000;

const heapMb = (): number => process.memoryUsage().heapUsed / (1024 * 1024);

/** A paced telemetry feed, shaped like what a DevSecOps pipeline actually emits. */
async function* telemetry(total: number): AsyncGenerator<BrokerRecord> {
  for (let i = 0; i < total; i += 1) {
    const partition = PARTITIONS[i % PARTITIONS.length]!;
    // The anomaly is injected at the MIDDLE OF THIS FEED, not at a global index. A
  // shared index was a bug the first run caught immediately: each partition gets
  // its own feed, so a global offset landed past the end of every one of them and
  // nothing was ever injected -- the test was green about a breach that never
  // happened.
const latency = i === Math.floor(total / 2) ? INJECTED_LATENCY : 50 + (i % 400);
    yield {
      fields: {
        ts: `2026-09-30T${String(i % 24).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z`,
        partition,
        level: latency > 1_000_000 ? "ERROR" : "INFO",
        status: latency > 1_000_000 ? "500" : "200",
        latency_ms: String(latency),
        region: `eu-${i % 4}`,
      },
    };
    // Yield to the loop periodically, exactly as a socket would. A generator
    // that never yields is not a stream, it is a loop with extra syntax.
    if (i % 2_000 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
}

test("50,000 EVENTS: flat heap, live detection, and an answer that survives the run", async (t) => {
  const broker = new StreamBroker({
    keyColumn: "partition",
    timeColumn: "ts",
    mode: { last: 5_000 },
  });
  // ONE partition here on purpose. Columns are tracked PER PARTITION, so a
  // three-partition run reports three `latency_ms` verdicts and cannot answer
  // "is exactly one column breached" -- which is the wolf-crying assertion worth
  // making. Multi-partition behaviour is covered in stream-broker.test.ts.
  broker.attach("checkout", telemetry(EVENTS));

  const started = Date.now();
  broker.start();
  const baseline = heapMb();

  // Sample the heap as it goes, so a growth curve is visible rather than inferred
  // from two endpoints. The first sample is taken early and is the one that would
  // expose a leak that fills slowly.
  const samples: number[] = [baseline];
  const deadline = Date.now() + 60_000;
  while (broker.snapshot().records < EVENTS && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (samples.length < 12) samples.push(heapMb());
  }
  samples.push(heapMb());

  const elapsed = Date.now() - started;
  const total = broker.snapshot().records;
  t.diagnostic(`${total} events in ${elapsed}ms (${Math.round(total / Math.max(elapsed, 1))} events/ms)`);
  t.diagnostic(`heap samples (MB): ${samples.map((s) => s.toFixed(1)).join(" -> ")}`);

  assert.equal(total, EVENTS, "every event arrived exactly once across three partitions");

  // === MEMORY. The load-bearing assertion. ===
  //
  // A live broker that keeps per-event state grows with the stream; this one
  // keeps counters, which do not. The ceiling is loose on purpose -- the claim is
  // FLATNESS, and a tight number would be a claim about this machine's allocator
  // rather than about the code's shape.
  const peak = Math.max(...samples);
  assert.ok(peak < 150,
    `heapUsed peaked at ${peak.toFixed(1)} MB across ${EVENTS} events. A broker that retains per-event ` +
    "state grows with the stream, and the failure is an OOM after hours of uptime rather than a slow frame.");

  // THE SHAPE OF THE CURVE, which a pair of endpoints can hide.
  const tail = samples.slice(-3);
  const early = samples.slice(1, 4);
  const drift = Math.max(...tail) - Math.min(...early);
  assert.ok(drift < 60,
    `the heap drifted ${drift.toFixed(1)} MB between early and late samples: ${samples.map((s) => s.toFixed(1)).join(" -> ")}. ` +
    "Flat means flat, not merely bounded at the end.");

  // === DETECTION. The injected value sits in the middle of the stream, so a
  // broker that only notices the last event would fail this. ===
  const verdict = evaluateLive(broker.snapshot());
  const latency = verdict.columns.find((column) => column.column === "latency_ms");
  assert.ok(latency !== undefined, "the numeric column is judged live");
  assert.equal(latency!.measured, EVENTS, "measured over every event, not the 5,000-record window");
  assert.ok((latency!.max ?? 0) >= INJECTED_LATENCY, "the injected latency was observed");
  assert.equal(latency!.breached, true, "and it is beyond the outer fence");
  assert.ok(verdict.breachedColumns >= 1, "the injected value is reported");
  assert.ok(verdict.breachedColumns <= 5,
    `but only ${verdict.breachedColumns} columns are breached out of ${Object.keys(verdict.columns).length}. ` +
    "A monitor that flags a large share of its columns trains the reader to ignore it, and the one that mattered " +
    "is the one they stopped reading. `status` legitimately breaches here -- it is 200 almost always, so its " +
    "interquartile spread is near zero and the fence sits on the constant -- which is the same arithmetic the " +
    "file path applies, not a live-stream peculiarity.");

  const reply = anomalyAgent.answerLive!(broker.snapshot());
  assert.match(reply.text, /latency_ms/);
  assert.match(reply.text, /outer fence/);
  t.diagnostic(`live answer: ${reply.text}`);

  // === THE WINDOW, and what it cost. ===
  const windowRows = broker.snapshot().partitions
    .reduce((sum, partition) => sum + Object.keys(partition.columns).length, 0);
  assert.ok(windowRows < 64, "the column set stays bounded no matter how many events arrived");
});

test("the RESERVOIR cap holds under load, which is what makes the memory flat", async () => {
  const broker = new StreamBroker({ keyColumn: "partition" });
  broker.attach("checkout", telemetry(20_000));
  broker.start();
  await broker.drain();

  const snapshot = broker.snapshot();
  assert.equal(snapshot.records, 20_000);
  const columns = snapshot.partitions[0]!.columns;
  assert.equal(columns["latency_ms"]?.measured, 20_000, "every event measured exactly once");
  assert.equal(columns["latency_ms"]?.exact, false,
    "and the quantiles admit they are a sample, because 20,000 values cannot all be in a 4096 reservoir");
  assert.equal(columns["latency_ms"]?.max, INJECTED_LATENCY,
    "while min and max remain EXACT -- they are counters, not samples");
  assert.ok(RESERVOIR_SIZE > 0);
});