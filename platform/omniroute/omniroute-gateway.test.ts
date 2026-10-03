import test from "node:test";
import assert from "node:assert/strict";

import { createGateway, type OmniRouteEvent } from "../omniroute/omniroute-gateway.ts";

/**
 * THE GATEWAY: one door, many providers, one meaning.
 *
 * === THE FAILURE THIS PREVENTS ===
 *
 * Every previous integration re-solved three problems in its own way: which column
 * ranks the events, when to alert, and what to tell the operator. So the same
 * event was ranked differently by two doors, and two dashboards said "3 outliers"
 * meaning different things. The gateway exists so a provider supplies EVENTS and
 * a schema hint and gets all three answered identically.
 *
 * === THE ALERT POLICY IS THE INTERESTING PART ===
 *
 * The first version of the dedupe keyed on "this column is breached", which
 * silences a second column breaking while the first is still broken -- and a
 * second broken column is exactly what an operator most needs to hear about.
 * Keying on the SET of breached conditions fixes it, and the test below pins that
 * behaviour rather than leaving it to chance.
 */

async function settle(broker: { snapshot(): { records: number } }, target: number): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (broker.snapshot().records < target && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function* feed(events: OmniRouteEvent[]): AsyncIterable<OmniRouteEvent> {
  for (const event of events) {
    yield event;
    if (Math.random() < 0.02) await new Promise((resolve) => setImmediate(resolve));
  }
}

const normal = (i: number): OmniRouteEvent => ({
  fields: {
    ts: `2026-09-30T${String(i % 24).padStart(2, "0")}:00:00Z`,
    service: i % 2 === 0 ? "checkout" : "search",
    latency_ms: String(100 + (i % 300)),
  },
});

test("A PROVIDER PUSHES EVENTS AND IS JUDGED, with no adapter of its own", async (t) => {
  const gateway = createGateway();
  gateway.connect({ name: "webhook", keyColumn: "service", timeColumn: "ts" });
  const broker = gateway.brokerFor("webhook")!;
  broker.start();
  gateway.stream("webhook", feed(Array.from({ length: 1_500 }, (_, i) => normal(i))));
  await settle(broker, 1_500);

  const snapshot = gateway.snapshot("webhook")[0]!;
  assert.equal(snapshot.records, 1_500, "every event routed");
  // NOT asserted: that the provider is still open. This feed is FINITE, so by
  // the time it lands the channel has closed correctly -- liveness on an endless
  // source is asserted in the stream-broker tests, where a generator really does
  // never end. Asserting it here would pin a test to a race with its own fixture.
  assert.ok(snapshot.partitions[0]!.columns["latency_ms"] !== undefined,
    "and the declared columns are the ones the analysis used");
  t.diagnostic(`${snapshot.records} events via one provider`);
});

test("TWO PROVIDERS CARRYING THE SAME EVENTS GET THE SAME ANSWER", async () => {
  // The property the gateway exists for. If these diverge, two dashboards are
  // describing the same traffic two different ways, which is the failure this
  // whole product has spent five phases learning to avoid.
  const events = Array.from({ length: 900 }, (_, i) => normal(i));
  const gateway = createGateway();
  for (const name of ["kafka", "webhook"]) {
    gateway.connect({ name, keyColumn: "service", timeColumn: "ts" });
    const broker = gateway.brokerFor(name)!;
    broker.start();
    gateway.stream(name, feed(events));
    await settle(broker, 900);
  }
  const [a, b] = gateway.snapshot().map((snapshot) => evaluate(snapshot));
  assert.deepEqual(a, b, "identical events through two doors must produce identical verdicts");
});

function evaluate(snapshot: { partitions: { columns: Record<string, unknown> }[]; records: number }) {
  const columns = snapshot.partitions.flatMap((partition) => Object.entries(partition.columns))
    .map(([name, stats]) => `${name}:${(stats as { measured: number }).measured}`).sort();
  return { records: snapshot.records, columns };
}

test("AN ALERT FIRES ONCE FOR A PERSISTING BREACH, and again for a NEW one", async (t) => {
  const gateway = createGateway();
  const seen: string[] = [];
  gateway.subscribe((alert) => seen.push(`${alert.verdict.columns.filter((c) => c.breached).map((c) => c.column).join("+")}`));
  gateway.connect({ name: "app", keyColumn: "service", timeColumn: "ts" });
  const broker = gateway.brokerFor("app")!;
  broker.start();

  // Clean traffic first, so the alert is about the change rather than the start.
  gateway.stream("app", feed(Array.from({ length: 400 }, (_, i) => normal(i))));
  await settle(broker, 400);
  gateway.evaluate("app");
  assert.equal(seen.length, 0, "clean traffic raises nothing");

  // Now a breach, then a SECOND column breaching while the first persists.
  const breached: OmniRouteEvent[] = Array.from({ length: 900 }, (_, i) => ({
    fields: { ...normal(i).fields, latency_ms: i === 500 ? 9_000_000 : String(100 + (i % 300)) },
  }));
  gateway.stream("app", feed(breached));
  await settle(broker, 1_300);
  gateway.evaluate("app");
  const first = seen.length;

  gateway.evaluate("app");
  assert.equal(seen.length, first, "the SAME condition does not re-alert -- a monitor that repeats itself gets muted");

  // A second column crosses its fence.
  const twoColumns: OmniRouteEvent[] = Array.from({ length: 300 }, (_, i) => ({
    fields: {
      ...normal(i).fields,
      latency_ms: i === 100 ? 9_000_000 : String(100 + (i % 300)),
      queue_depth: i === 200 ? 40_000 : String(i % 50),
    },
  }));
  gateway.stream("app", feed(twoColumns));
  await settle(broker, 1_600);
  gateway.evaluate("app");
  assert.ok(seen.length > first,
    "a SECOND breached column alerts even while the first is still breached -- keying on 'is any column " +
    "breached' would have silenced exactly the thing an operator most needs to hear");
  t.diagnostic(`alerts: ${seen.join(" | ")}`);
});

test("AN UNCONNECTED PROVIDER IS A NAMED ERROR, not a silent drop", async () => {
  const gateway = createGateway();
  assert.throws(() => gateway.push("ghost", { fields: { a: "1" } }), /not connected/);
  gateway.connect({ name: "x" });
  assert.throws(() => gateway.connect({ name: "x" }), /already connected/,
    "two connections for one name would split the counters and make the ranking a lie");
  assert.equal(gateway.snapshot("ghost").length, 0);
});

test("PUSHING A SINGLE EVENT WORKS, because a webhook is not a stream", async () => {
  const gateway = createGateway();
  gateway.connect({ name: "webhook", keyColumn: "service" });
  const broker = gateway.brokerFor("webhook")!;
  broker.start();
  for (let i = 0; i < 40; i += 1) gateway.push("webhook", normal(i));
  await settle(broker, 40);
  const snapshot = gateway.snapshot("webhook")[0]!;
  assert.equal(snapshot.records, 40);
  assert.equal(snapshot.partitions.length, 1,
    "forty pushes must be ONE partition, not forty -- counters are per partition, so a push channel that " +
    "opened a new one per event would rank the same stream as forty unrelated series");
});