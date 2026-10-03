import test from "node:test";
import assert from "node:assert/strict";

import { StreamBroker, type BrokerRecord } from "./stream-broker.ts";
import { evaluateLive, liveFindings } from "./live-anomaly.ts";

/**
 * ONE SENTENCE PER COLUMN, ACROSS EVERY PARTITION.
 *
 * === THE DEFECT ===
 *
 * Columns are tracked per partition, so a stream split three ways reported
 * `latency_ms` three times. On screen that reads as three independent problems, so
 * an operator triages three things when there is one column to investigate -- and
 * the third line gets dismissed as a duplicate of the first without being read.
 * It was flagged in review rather than found by a test, which is how a UX defect
 * like this usually arrives.
 *
 * === WHAT "WORST" MEANS, AND WHY IT IS NOT "FIRST" OR "AVERAGE" ===
 *
 * A column clean in two partitions and breached in the third is a PROBLEM.
 * Averaging that into "mostly fine" is how a sick replica hides inside a healthy
 * fleet, and picking the first partition that happens to answer is how the
 * breach hides behind whichever replica was enumerated first.
 */

/** A partition feeding `latency_ms` values drawn from `values`. */
function partitionOf(name: string, values: readonly number[]): AsyncGenerator<BrokerRecord> {
  return (async function* () {
    for (const value of values) {
      yield { fields: { latency_ms: String(value), status: "200", service: name } };
    }
  })();
}

const CLEAN = Array.from({ length: 300 }, (_, i) => 100 + (i % 40));
const BREACHED = [...CLEAN.slice(0, 290), 9_000_000];

async function brokerOf(parts: [string, readonly number[]][]) {
  const broker = new StreamBroker({ keyColumn: "service" });
  for (const [name, values] of parts) broker.attach(name, partitionOf(name, values));
  broker.start();
  await broker.drain();
  return broker;
}

test("A COLUMN IN THREE PARTITIONS IS REPORTED ONCE, not three times", async (t) => {
  const broker = await brokerOf([["p0", BREACHED], ["p1", CLEAN], ["p2", CLEAN]]);
  const verdict = evaluateLive(broker.snapshot());

  const latency = verdict.columns.filter((column) => column.column === "latency_ms");
  assert.equal(latency.length, 1,
    `one column must produce one verdict; got ${latency.length}. Three lines about the same column is three ` +
    "problems to triage when there is one column to investigate.");
  assert.equal(latency[0]!.partitions, 3, "and the verdict says how many partitions it folded together");
  assert.equal(Object.keys(latency[0]!.partitionColumns).length, 3,
    "with each partition's measured count, so the alert can still be drilled into");
  t.diagnostic(`1 verdict across ${latency[0]!.partitions} partitions`);
});

test("THE WORST STANDING WINS, so a sick replica cannot hide in a healthy fleet", async (t) => {
  // Three partitions, one of them breached. Taking the first, or averaging, or
  // taking the max would all be defensible -- and only "the breach wins" is
  // correct, because the alternative is a fleet that looks fine.
  const broker = await brokerOf([["p0", CLEAN], ["p1", BREACHED], ["p2", CLEAN]]);
  const latency = evaluateLive(broker.snapshot()).columns.find((c) => c.column === "latency_ms")!;

  assert.equal(latency.breached, true, "a breach in ONE partition is a breach");
  assert.equal(latency.max, 9_000_000, "and the reported extreme is the breached partition's");
  assert.equal(latency.breachedEverywhere, false,
    "while `breachedEverywhere` stays false -- this is one sick replica, not a sick fleet, and an operator " +
    "restarting a pod needs to be able to tell those apart");
});

test("AMONG BREACHES, THE FURTHEST PAST ITS FENCE WINS", async () => {
  const mild = [...CLEAN.slice(0, 295), 2_000_000];
  const severe = [...CLEAN.slice(0, 295), 50_000_000];
  const broker = await brokerOf([["p0", mild], ["p1", severe]]);
  const latency = evaluateLive(broker.snapshot()).columns.find((c) => c.column === "latency_ms")!;
  assert.equal(latency.max, 50_000_000, "the operator should be shown the worst partition first");
  assert.equal(latency.breachedEverywhere, true, "and both really are breached");
});

test("AMONG NON-BREACHES, the TIGHTEST SPREAD wins -- the more sensitive detector", async () => {
  const narrow = Array.from({ length: 300 }, (_, i) => 100 + (i % 4));
  const wide = Array.from({ length: 300 }, (_, i) => 100 + (i % 400));
  const broker = await brokerOf([["p0", wide], ["p1", narrow]]);
  const latency = evaluateLive(broker.snapshot()).columns.find((c) => c.column === "latency_ms")!;
  assert.equal(latency.breached, false, "neither is a breach here");
  const spread = (latency.q3 ?? 0) - (latency.q1 ?? 0);
  assert.ok(spread < 10,
    `the tightest spread must survive consolidation, not the most comfortable one; spread=${spread.toFixed(2)}`);
});

test("THE SENTENCE NAMES THE COLUMN ONCE, and says how far it spread", async (t) => {
  const broker = await brokerOf([["p0", BREACHED], ["p1", CLEAN], ["p2", CLEAN]]);
  const text = liveFindings(evaluateLive(broker.snapshot()));
  t.diagnostic(text);
  const occurrences = text.split("latency_ms").length - 1;
  assert.equal(occurrences, 1, `the column is named once, not once per partition (saw ${occurrences})`);
  assert.match(text, /outer fence/);
});

test("A SINGLE-PARTITION stream is unchanged -- consolidation must be a no-op there", async () => {
  // The regression that matters most: the common case must not change at all.
  const broker = await brokerOf([["only", BREACHED]]);
  const latency = evaluateLive(broker.snapshot()).columns.find((c) => c.column === "latency_ms")!;
  assert.equal(latency.partitions, 1);
  assert.equal(latency.breachedEverywhere, true);
  assert.equal(latency.max, 9_000_000);
});