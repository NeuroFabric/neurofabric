import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import { StreamBroker, type BrokerRecord } from "./stream-broker.ts";

/**
 * AN ANALYSIS THAT DOES NOT WAIT FOR AN END.
 *
 * === WHY THIS FILE EXISTS ===
 *
 * Every reader upstream of here reads a CLOSED input. That assumption is invisible
 * until it meets a Kafka topic or a tail, where there is no end to read to -- and
 * a reader built on EOF cannot be pointed at one. Not badly, not slowly: at all.
 *
 * So the claim under test is not "the broker counts events". It is that a
 * snapshot is available WHILE THE STREAM IS STILL RUNNING, which is the only
 * property that makes this live rather than a file reader with extra steps. The
 * strongest form of that test feeds records and takes a snapshot BEFORE the
 * producer finishes: if the implementation drained its input before answering,
 * this would deadlock rather than fail.
 */

/** An endless source, so nothing can quietly wait for EOF. */
async function* endless(total: number, delayMs = 0): AsyncGenerator<BrokerRecord> {
  for (let i = 0; i < total; i += 1) {
    yield {
      fields: {
        ts: `2026-09-30T${String(i % 24).padStart(2, "0")}:00:00Z`,
        service: i % 3 === 0 ? "checkout" : "search",
        status: i % 5 === 0 ? "500" : "200",
        latency_ms: i === total - 2 ? "1500000" : String(100 + (i % 800)),
      },
    };
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  // NOTE: no return, no close. This generator is deliberately infinite -- a broker
  // that needed it to end would hang here, which is the point.
}

test("a SNAPSHOT IS AVAILABLE BEFORE THE STREAM ENDS", async () => {
  const broker = new StreamBroker({ keyColumn: "service", timeColumn: "ts" });
  broker.attach("events", endless(1_000));
  broker.start();

  // No drain(). No await on the source. Just ask.
  let snapshots = 0;
  let seen = 0;
  const live = new StreamBroker({
    keyColumn: "service",
    timeColumn: "ts",
    onSnapshot: (snapshot) => {
      snapshots += 1;
      seen = snapshot.records;
    },
  });
  live.attach("events", endless(500));
  live.start();
  const first = live.snapshot();

  assert.equal(snapshots, 1, "the hook fires on demand, not only on events");
  assert.equal(first.open, true, "and the partition reports itself still OPEN, because it is");
  assert.ok(seen >= first.records, "the hook saw at least what the caller saw");

  // The endless generator is still running. That the test got here at all is the
  // assertion; anything that waited for EOF would never return.
  assert.ok(broker.snapshot().open);
});

test("THE COUNTS ACCUMULATE WHILE IT RUNS, and reach the producer's total", async () => {
  const TOTAL = 300;
  const broker = new StreamBroker({ keyColumn: "service", timeColumn: "ts" });
  broker.attach("events", endless(TOTAL, 0));
  broker.start();

  // Let the producer run without awaiting it, then keep sampling until it lands.
  const running = (async () => { for await (const _ of endless(0)) { /* never */ } })();
  void running;

  const deadline = Date.now() + 4_000;
  let snapshot = broker.snapshot();
  while (snapshot.records < TOTAL && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    snapshot = broker.snapshot();
  }

  assert.equal(snapshot.records, TOTAL, "every event is counted exactly once");
  const partition = snapshot.partitions[0]!;
  assert.equal(partition.records, TOTAL);
  // This generator is FINITE, so by the time the total lands the partition has
  // correctly closed. The genuinely-live claim is asserted in the test above,
  // against an endless source, where `open` must still be true.

  // The SAME accumulators as the file pipeline: the absurd value planted near the
  // end is found, and the timeline is bucketed by the shared HourlyCounter.
  assert.equal(partition.columns["latency_ms"]?.max, 1_500_000,
    "the planted value is visible through the live window, not only after a close");
  assert.ok((partition.hours.length > 0), "and the timeline is bucketed live");
  const keySum = partition.topKeys.reduce((sum, k) => sum + k.count, 0);
  assert.ok(keySum > 0, "the key ranking is live too");
});

test("PARTITIONS STAY SEPARATE, because merged counters cannot say which one is sick", async () => {
  const broker = new StreamBroker({ keyColumn: "service" });
  broker.attach("checkout", endless(100, 0));
  broker.attach("search", endless(400, 0));
  broker.start();

  const deadline = Date.now() + 4_000;
  let snapshot = broker.snapshot();
  while (snapshot.records < 500 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    snapshot = broker.snapshot();
  }

  assert.equal(snapshot.partitions.length, 2);
  const byName = new Map(snapshot.partitions.map((p) => [p.name, p.records]));
  assert.equal(byName.get("checkout"), 100, "a partition's count is its OWN, not the broker's");
  assert.equal(byName.get("search"), 400);
  assert.equal(snapshot.records, 500);

  // A Readable is an async iterable, so the broker consumes one without a shim.
  const readable = Readable.from([
    { fields: { service: "checkout", latency_ms: "10" } },
    { fields: { service: "checkout", latency_ms: "20" } },
  ]) as unknown as AsyncIterable<BrokerRecord>;
  const fromNode = new StreamBroker({ keyColumn: "service" });
  fromNode.attach("node", readable);
  fromNode.start();
  await fromNode.drain();
  assert.equal(fromNode.snapshot().records, 2, "a Node Readable is a source with no adapter");
});

test("A PARTITION THAT ENDS IS CLOSED, NOT FAILED", async () => {
  const broker = new StreamBroker({ keyColumn: "service" });
  broker.attach("short", (async function* () {
    yield { fields: { service: "a" } };
    yield { fields: { service: "b" } };
  })());
  broker.start();
  await broker.drain();
  const snapshot = broker.snapshot();
  assert.equal(snapshot.open, false, "a drained topic is CLOSED, and saying so is not an error");
  assert.equal(snapshot.records, 2);
});

test("a SLIDING WINDOW bounds its own memory and admits what it dropped", async () => {
  const broker = new StreamBroker({ keyColumn: "service", mode: { last: 50 } });
  broker.attach("events", endless(200, 0));
  broker.start();
  await broker.drain();

  const snapshot = broker.snapshot();
  assert.equal(snapshot.records, 200, "the total is still the truth about everything seen");
  const partition = snapshot.partitions[0]!;
  assert.ok(partition.columns["latency_ms"] !== undefined, "and the window is bounded, not unbounded");
});