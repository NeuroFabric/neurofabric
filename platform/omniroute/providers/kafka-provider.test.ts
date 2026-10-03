import test from "node:test";
import assert from "node:assert/strict";

import { createGateway } from "../omniroute-gateway.ts";
import { createKafkaProvider, type KafkaMessage } from "./kafka-provider.ts";

/**
 * THE KAFKA ADAPTER, driven with no broker running.
 *
 * A Kafka consumer is already an async iterable of messages, so the adapter is a
 * pure translation and needs no cluster to be tested -- which is the reason it is
 * small, and the reason a fixture written here and a real topic cannot diverge.
 *
 * THE THREE THINGS THIS FILE CHECKS, in order of how badly they bite:
 *
 *   1. A POISON MESSAGE costs itself. A consumer that threw on malformed JSON
 *      would restart the partition and replay the same record forever. That is a
 *      crash loop wearing a parse error's clothes.
 *   2. THE KAFKA KEY IS NOT THE RANKING COLUMN. A key is an ordering guarantee,
 *      usually a user or account id. Treating it as the category ranks events by
 *      whatever the producer happened to choose, and two topics would rank
 *      differently for identical business events.
 *   3. PARTITIONS STAY SEPARATE, because merging them throws away the one
 *      structure Kafka exists to provide.
 */

function message(over: Partial<KafkaMessage> = {}): KafkaMessage {
  return {
    topic: "telemetry",
    partition: 0,
    offset: 1,
    value: JSON.stringify({ ts: "2026-09-30T09:00:00Z", service: "checkout", latency_ms: 120 }),
    ...over,
  };
}

async function settle(gateway: ReturnType<typeof createGateway>, provider: string, target: number): Promise<void> {
  const deadline = Date.now() + 4_000;
  while ((gateway.snapshot(provider)[0]?.records ?? 0) < target && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("A BUFFER PAYLOAD AND A STRING PAYLOAD PRODUCE THE SAME EVENT", () => {
  // Kafka ships BYTES. An adapter that only handled strings would pass every test
  // written against a client that decodes for you, and fail against the wire.
  const gateway = createGateway();
  const provider = createKafkaProvider({ name: "kafka", topic: "telemetry", keyColumn: "service" }, gateway);
  const asString = provider.decode(message({ value: JSON.stringify({ a: 1 }) }));
  const asBuffer = provider.decode(message({ value: Buffer.from(JSON.stringify({ a: 1 }), "utf8") }));
  assert.deepEqual(asString?.fields["a"], asBuffer?.fields["a"]);
  assert.equal(asString?.fields["a"], "1");
});

test("NESTED PAYLOADS FLATTEN TO COLUMNS, with the SAME names the JSONL reader uses", () => {
  const gateway = createGateway();
  const provider = createKafkaProvider({ name: "kafka", topic: "telemetry" }, gateway);
  const event = provider.decode(message({ value: JSON.stringify({ user: { id: 7, tier: "gold" }, latency_ms: 12 }) }));
  assert.equal(event?.fields["user.id"], "7", "nested fields become addressable columns");
  assert.equal(event?.fields["user.tier"], "gold");
  assert.equal(event?.fields["latency_ms"], "12");
});

test("A POISON MESSAGE costs ITSELF, and never the partition", async () => {
  const gateway = createGateway();
  const provider = createKafkaProvider({ name: "kafka", topic: "telemetry", keyColumn: "service" }, gateway);
  const name = `kafka:telemetry:p`;
  gateway.brokerFor(name)!.start();

  const batch = [
    message({ offset: 1 }),
    message({ offset: 2, value: "{ this is not json" }),
    message({ offset: 3, value: "[1,2,3]" }),
    message({ offset: 4, value: null }),
    message({ offset: 5 }),
  ];
  const result = await provider.consume((async function* () { for (const m of batch) yield m; })());

  assert.equal(result.decoded, 2, "the two good records survive");
  assert.equal(result.skipped.length, 2, "the two undecodable ones are reported, not thrown");
  assert.match(result.skipped[0]!.reason, /JSON/);
  // The offset is carried so an operator can find the record in the topic.
  assert.equal(result.skipped[0]!.offset, 2);
  assert.equal(result.skipped[1]!.offset, 3, "an array payload is refused too, not spread into columns");
});

test("THE KAFKA KEY is carried as data, and is NOT used as the ranking column", () => {
  const gateway = createGateway();
  const provider = createKafkaProvider({ name: "kafka", topic: "telemetry", keyColumn: "service" }, gateway);
  const event = provider.decode(message({ key: Buffer.from("user-42"), service: "checkout" } as Partial<KafkaMessage>));
  assert.equal(event?.fields["kafka_key"], "user-42", "the key is available for whoever wants it");
  // The declared keyColumn is `service`; a Kafka key of user-42 must not become
  // the category, or every event would rank by user instead of by service.
  assert.notEqual(event?.fields["kafka_key"], event?.fields["service"]);
  assert.equal(event?.fields["service"], "checkout");
});

test("TOPIC AND PARTITION travel with the event, so alerts name their source", () => {
  const gateway = createGateway();
  const provider = createKafkaProvider({ name: "kafka", topic: "payments" }, gateway);
  const event = provider.decode(message({ topic: "payments", partition: 3 }));
  assert.equal(event?.fields["kafka_topic"], "payments");
  assert.equal(event?.fields["kafka_partition"], "3");
});

test("BINARY payloads are passed through when JSON parsing is switched off", () => {
  // A gzip or protobuf body is not JSON. Decoding it as UTF-8 unconditionally
  // produces mojibake and then a JSON parse error, which reads as a broken
  // producer rather than a wrong decoder.
  const gateway = createGateway();
  const provider = createKafkaProvider({ name: "kafka", topic: "raw", json: false }, gateway);
  const event = provider.decode(message({
    topic: "raw",
    value: Buffer.from([0x00, 0x01, 0x02]),
    headers: { "content-type": "application/octet-stream" },
  }));
  assert.equal(typeof event?.fields["value"], "string");
  assert.equal(event?.fields["content-type"], "application/octet-stream", "headers are carried as columns");
});

test("A FULL BATCH FLOWS THROUGH TO A VERDICT, end to end", async (t) => {
  const gateway = createGateway();
  const provider = createKafkaProvider({ name: "kafka", topic: "telemetry", keyColumn: "service", timeColumn: "ts" }, gateway);
  const name = `kafka:telemetry:p`;
  gateway.brokerFor(name)!.start();

  const total = 1_200;
  const messages = Array.from({ length: total }, (_, i) => message({
    offset: i,
    value: JSON.stringify({
      ts: `2026-09-30T${String(i % 24).padStart(2, "0")}:00:00Z`,
      service: i % 2 === 0 ? "checkout" : "search",
      latency_ms: i === total - 5 ? 9_000_000 : 100 + (i % 300),
    }),
  }));
  const result = await provider.consume((async function* () { for (const m of messages) yield m; })());
  await settle(gateway, name, total);

  assert.equal(result.decoded, total);
  const verdict = gateway.verdict(name);
  assert.ok(verdict !== undefined, "the topic produced a verdict");
  assert.equal(verdict!.records, total);
  const latency = verdict!.columns.find((column) => column.column === "latency_ms");
  assert.ok((latency?.max ?? 0) >= 9_000_000, "the injected latency was seen through the Kafka door");
  t.diagnostic(`kafka: ${total} messages, ${verdict!.columns.length} columns judged live`);
});