import test from "node:test";
import assert from "node:assert/strict";

import { createGateway, type OmniRouteEvent, type SwarmAlert } from "./omniroute-gateway.ts";

/**
 * THE WRITE BOUNDARY, AS AN ORDERING.
 *
 * === WHY THESE TESTS EXIST AT ALL ===
 *
 * Because ADR-005 §5 rule 3 -- *the subscription is not the record* -- is a claim
 * about ORDER, and every other property here is a claim about values. A gate that
 * checks the verdict was written and separately checks the subscriber was called
 * has proved neither, because the dangerous version of this code is the one that
 * does both and does them in the wrong order: an alert on somebody's screen with
 * no verdict behind it, which §7.3 calls corruption.
 *
 * So each test below asserts **the interleaving**, by recording a shared trace of
 * what happened and WHEN, rather than by inspecting state afterwards.
 *
 * === THE BROKER IS ASYNCHRONOUS, AND THAT IS NOT A DETAIL ===
 *
 * The first version of this file pushed events with `gateway.push` and called
 * `evaluate` in the same tick. It produced no columns, no alerts, and five green
 * tests that had asserted nothing -- because a broker that has not drained holds
 * no records, and a verdict over no records is a clean verdict. A test suite can
 * pass by testing a pipeline that never ran.
 *
 * So these mirror the shape the gateway's own tests use: `broker.start()`, then a
 * stream, then `settle` until the records are actually in the snapshot. Every
 * assertion below therefore runs against a window that really holds the traffic.
 */

/** Wait for the broker to actually hold `target` records, or give up honestly. */
async function settle(broker: { snapshot(): { records: number } }, target: number): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (broker.snapshot().records < target && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(broker.snapshot().records >= target, "the broker never took the traffic; the rest of this test would be vacuous");
}

async function* feed(events: OmniRouteEvent[]): AsyncIterable<OmniRouteEvent> {
  for (const event of events) yield event;
}

const normal = (i: number): OmniRouteEvent => ({
  fields: {
    ts: `2026-09-30T${String(i % 24).padStart(2, "0")}:00:00Z`,
    service: i % 2 === 0 ? "checkout" : "search",
    latency_ms: String(100 + (i % 300)),
  },
});

interface Armed {
  readonly gateway: ReturnType<typeof createGateway>;
  readonly broker: { snapshot(): { records: number } };
}

/**
 * CLEAN TRAFFIC, THEN A BREACH, THEN NOTHING NEW.
 *
 * The shape matters: clean traffic first so the alert is about the CHANGE rather
 * than about the window filling, and then a single far-out value in a stream of
 * 900 so the outer fence is actually crossed. An earlier draft used 30 outliers
 * in a row, which widened the interquartile range enough that the fence rose
 * above the outliers -- a "breach" that breached nothing, and a test that would
 * have passed for the wrong reason had the assertions been weaker.
 */
async function armedWith(trace: string[], onDecision?: (alert: SwarmAlert) => void): Promise<{ armed: Armed; trace: string[] }> {
  const gateway = createGateway(onDecision === undefined ? {} : { onDecision });
  gateway.connect({ name: "app", keyColumn: "service", timeColumn: "ts" });
  const broker = gateway.brokerFor("app")!;
  broker.start();

  await (async () => {
    gateway.stream("app", feed(Array.from({ length: 400 }, (_, i) => normal(i))));
    await settle(broker, 400);
  })();
  return { armed: { gateway, broker }, trace };
}

/** Push a breach, evaluate, then evaluate again many times. */
async function breach(armed: Armed): Promise<SwarmAlert[]> {
  const events = Array.from({ length: 900 }, (_, i) => ({
    fields: { ...normal(i).fields, latency_ms: i === 500 ? 9_000_000 : String(100 + (i % 300)) },
  }));
  armed.gateway.stream("app", feed(events));
  await settle(armed.broker, 1_300);
  return armed.gateway.evaluate("app");
}

test("THE RECORD IS WRITTEN BEFORE ANY SUBSCRIBER RUNS", async () => {
  const trace: string[] = [];
  const { armed } = await armedWith(trace, () => {
    trace.push("record");
  });
  armed.gateway.subscribe(() => {
    trace.push("subscriber");
  });

  await breach(armed);

  const firstRecord = trace.indexOf("record");
  const firstSubscriber = trace.indexOf("subscriber");
  assert.notEqual(firstRecord, -1, "the record must be written at all");
  assert.notEqual(firstSubscriber, -1, "a subscriber must be told at all");
  // THE ASSERTION. `onAlert` is a subscriber called from the same loop, so this
  // ordering is not free -- it is exactly what `onDecision` existing separately
  // buys, and the dangerous version of this code is the one that gets it wrong.
  assert.ok(firstRecord < firstSubscriber, `the record must come first. trace was ${JSON.stringify(trace)}`);
});

test("A RECORD THAT THROWS PREVENTS THE DISPATCH", async () => {
  const trace: string[] = [];
  const { armed } = await armedWith(trace, () => {
    trace.push("record");
    throw new Error("the durable store is closed");
  });
  armed.gateway.subscribe(() => {
    trace.push("subscriber");
  });

  const alerts = await breach(armed);

  // THE ASSERTION WORTH THE MOST IN THIS FILE. Pushing anyway would put an
  // unactionable alert on a screen: something a person can act on, and nothing
  // behind it.
  assert.equal(trace.includes("subscriber"), false, "nobody may be told what could not be kept");
  assert.equal(trace.filter((entry) => entry === "record").length, 1, "the record was tried");
  // And it is not in the returned list either, so a caller counting what it was
  // told cannot find a breach that exists only in a window.
  assert.deepEqual(alerts, [], "an alert nobody can look up is not an alert");
});

test("THE FAILURE IS VISIBLE, not swallowed", async () => {
  const { armed } = await armedWith([], () => {
    throw new Error("the durable store is closed");
  });
  await breach(armed);

  const refused = armed.gateway.refusedDecisions();
  assert.equal(refused.length, 1, "the refusal must be readable by a caller");
  assert.match(refused[0]?.reason ?? "", /the durable store is closed/);
  assert.equal(refused[0]?.provider, "app");

  // ...and it does not grow without limit when the same state is polled again,
  // because the alert policy only offers a decision once per fingerprint.
  for (let i = 0; i < 50; i += 1) armed.gateway.evaluate("app");
  assert.equal(armed.gateway.refusedDecisions().length, 1, "one refused decision, not fifty");
});

test("A HEALTHY READING WRITES NOTHING", async () => {
  const trace: string[] = [];
  const gateway = createGateway({ onDecision: () => trace.push("record") });
  gateway.connect({ name: "app", keyColumn: "service", timeColumn: "ts" });
  const broker = gateway.brokerFor("app")!;
  broker.start();
  gateway.stream("app", feed(Array.from({ length: 400 }, (_, i) => normal(i))));
  await settle(broker, 400);

  gateway.evaluate("app");
  gateway.evaluate("app");

  // ADR-005 §7.1: the blocking cost is paid only for facts that change what a
  // person does next. A reading that breached nothing changed nothing, and
  // writing one per poll is the 120-rows-a-minute table §1.1 refuses.
  assert.deepEqual(trace, [], "a healthy verdict is not a fact that changes what anybody does next");
});

test("A REPEAT IS NOT A NEW DECISION", async () => {
  const trace: string[] = [];
  const { armed } = await armedWith(trace, () => {
    trace.push("record");
  });
  await breach(armed);
  // Same breach, same fingerprint, evaluated a hundred more times.
  for (let i = 0; i < 100; i += 1) armed.gateway.evaluate("app");

  assert.equal(trace.length, 1, "a breach that persists across a hundred snapshots is ONE incident");
});

test("WITH NO HOOK ATTACHED, THE DISPATCH BEHAVES EXACTLY AS BEFORE", async () => {
  // The change must be invisible to every existing caller. A gateway with no
  // record open alerts as it always did, which is what makes `--no-record` an
  // honest flag rather than a degraded mode.
  const gateway = createGateway();
  gateway.connect({ name: "app", keyColumn: "service", timeColumn: "ts" });
  const broker = gateway.brokerFor("app")!;
  broker.start();
  let told = 0;
  gateway.subscribe(() => {
    told += 1;
  });
  gateway.stream("app", feed(Array.from({ length: 400 }, (_, i) => normal(i))));
  await settle(broker, 400);
  await breach({ gateway, broker });

  assert.equal(told, 1, "one alert for one new breach, exactly as before");
  assert.deepEqual(gateway.refusedDecisions(), []);
});
