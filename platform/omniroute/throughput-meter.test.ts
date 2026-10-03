import test from "node:test";
import assert from "node:assert/strict";

import { ThroughputMeter } from "./throughput-meter.ts";

/**
 * THE RATE, MEASURED RATHER THAN DECLARED.
 *
 * Every earlier claim about throughput in this project was a guess, because
 * nothing held two instants. This file is the evidence that the thing which
 * finally does hold them computes honestly -- including in the cases where the
 * honest answer is "I cannot tell you yet" and "that was a gap, not a burst".
 */

test("the first observation yields no rate, because one point is not a rate", () => {
  const meter = new ThroughputMeter();
  assert.equal(meter.sample(1000, 1_000), null);
  // Critically NOT zero: a zero here would read as "the stream has stopped",
  // which is the opposite of the truth.
  assert.equal(meter.current, null);
  assert.equal(meter.warm, false);
});

test("two observations give a rate with its window attached", () => {
  const meter = new ThroughputMeter();
  meter.sample(1000, 1_000);
  const reading = meter.sample(2000, 2_000);
  assert.deepEqual(reading, { records: 2000, delta: 1000, windowMs: 1000, eventsPerSecond: 1000 });
});

test("scales a sub-second window to one second", () => {
  const meter = new ThroughputMeter();
  meter.sample(0, 0);
  // 250 events in 250ms is 1000/sec, not 250.
  const reading = meter.sample(250, 250);
  assert.equal(reading?.eventsPerSecond, 1000);
  assert.equal(reading?.windowMs, 250);
});

test("a stalled stream reports a rate of zero, which is a real answer", () => {
  const meter = new ThroughputMeter();
  meter.sample(5000, 0);
  const reading = meter.sample(5000, 1_000);
  assert.equal(reading?.delta, 0);
  assert.equal(reading?.eventsPerSecond, 0);
  // Zero with a live window is information. Zero with no window would not be.
  assert.equal(reading?.windowMs, 1_000);
});

test("refuses to divide by a non-advancing clock", () => {
  const meter = new ThroughputMeter();
  meter.sample(10, 5_000);
  // Two polls inside the same millisecond: no denominator, so no rate.
  assert.equal(meter.sample(99, 5_000), null);
});

test("clamps a negative delta rather than reporting negative throughput", () => {
  const meter = new ThroughputMeter();
  meter.sample(1_000, 0);
  // The broker truncated its window and now holds fewer records. The count did
  // not go backwards in reality.
  const reading = meter.sample(10, 1_000);
  assert.equal(reading?.delta, 0);
  assert.equal(reading?.eventsPerSecond, 0);
});

test("a stalled stream that restarts reads as a gap, not as one enormous burst", () => {
  // The single-pair failure this class exists to fix: nobody polled for ten
  // seconds, then one poll observed everything accumulated in that time. With
  // one pair that reads as "everything happened at once".
  const paired = new ThroughputMeter(2);
  paired.sample(0, 0);
  const afterGap = paired.sample(1_000_000, 10_000);
  assert.equal(afterGap?.eventsPerSecond, 100_000, "a bare pair misreads the gap as a burst");

  const windowed = new ThroughputMeter(4);
  windowed.sample(0, 0);
  const first = windowed.sample(1_000_000, 10_000);
  const second = windowed.sample(1_000_100, 10_100);
  // Once the gap has rolled out of the window, the rate reflects steady traffic.
  assert.equal(first?.eventsPerSecond, 100_000);
  assert.equal(second?.eventsPerSecond, 1_000);
});

test("holds only its window, so a long-lived server does not grow without bound", () => {
  // This lives in a server that is left running with a dashboard open.
  const meter = new ThroughputMeter(4);
  for (let i = 0; i < 10_000; i++) meter.sample(i, i * 100);
  // Still answering after ten thousand samples rather than degrading.
  const reading = meter.sample(10_000, 10_000 * 100);
  assert.equal(reading?.records, 10_000);
});

test("a window below two is raised, because a one-sample average is one pair", () => {
  const meter = new ThroughputMeter(1);
  meter.sample(0, 0);
  meter.sample(100, 100);
  const reading = meter.sample(200, 200);
  assert.equal(reading?.records, 200);
});

test("reports how stale the last observation is", () => {
  const meter = new ThroughputMeter();
  assert.equal(meter.ageMs, null);
  meter.sample(0, Date.now() - 5_000);
  const age = meter.ageMs;
  assert.ok(age !== null && age >= 5_000, `expected at least 5000ms of age, got ${age}`);
});