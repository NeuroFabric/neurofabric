import test from "node:test";
import assert from "node:assert/strict";

import { createGateway, type OmniRouteEvent } from "../omniroute/omniroute-gateway.ts";
import { createKafkaProvider, type KafkaMessage } from "../omniroute/providers/kafka-provider.ts";
import { route, routeWith } from "../conductor/agent-router.ts";
import { buildAnalysis } from "../web/react-report.test-support.ts";
import { csvRead } from "../conductor/capabilities.ts";
import { analyseBottlenecks } from "../conductor/bottlenecks.ts";
import { resolveSchemaMemory } from "../conductor/schema-memory.ts";
import { parseCsv } from "../conductor/capabilities.ts";

/**
 * END TO END: an external provider pushes, the Conductor answers, a human reads.
 *
 * THE CHAIN THIS CLOSES. Omniroute ingests, the Kafka adapter translates, the
 * broker accumulates, and the anomaly agent can judge a snapshot -- but until now
 * nothing connected the broker to the ROUTER. An operator asking "is anything
 * wrong right now" through the normal question path would have reached a
 * file-shaped agent, found no rows in a stream that has no rows, and been told
 * nothing is wrong. On a dashboard that sentence is indistinguishable from a
 * healthy service, which makes it the most expensive silence in the product.
 *
 * So this test walks the whole road with a Kafka-shaped source and no broker,
 * which is the same discipline the provider tests use: a fixture written against
 * the real client library's shape is the only kind that cannot drift from it.
 */

const analysis = await buildAnalysis();

async function settle(gateway: ReturnType<typeof createGateway>, provider: string, target: number): Promise<void> {
  const deadline = Date.now() + 4_000;
  while ((gateway.snapshot(provider)[0]?.records ?? 0) < target && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function telemetry(over: { offset: number; latency_ms: number }): KafkaMessage {
  const payload: Record<string, unknown> = {
    ts: "2026-09-30T" + String(over.offset % 24).padStart(2, "0") + ":00:00Z",
    service: over.offset % 2 === 0 ? "checkout" : "search",
    latency_ms: over.latency_ms,
  };
  return { topic: "telemetry", partition: 0, offset: over.offset, value: JSON.stringify(payload) };
}

test("A PROVIDER PUSHES THROUGH OMNIROUTE, THE CONDUCTOR ANSWERS LIVE", async (t) => {
  const gateway = createGateway();
  const provider = createKafkaProvider(
    { name: "kafka", topic: "telemetry", keyColumn: "service", timeColumn: "ts" },
    gateway,
  );
  const channel = "kafka:telemetry:p";
  gateway.brokerFor(channel)!.start();

  const TOTAL = 900;
  const messages = Array.from({ length: TOTAL }, (_, i) => telemetry({
    offset: i,
    latency_ms: i === TOTAL - 3 ? 9_000_000 : 100 + (i % 300),
  }));
  const consumed = await provider.consume((async function* () { for (const m of messages) yield m; })());
  await settle(gateway, channel, TOTAL);
  assert.equal(consumed.decoded, TOTAL);

  // THE ROUTER, with the live stream attached.
  const snapshot = gateway.snapshot(channel)[0]!;
  const live = routeWith("what is wrong right now?", {} as never, snapshot);
  t.diagnostic(live.reply?.text ?? "");
  assert.equal(live.agent, "anomaly");
  assert.equal(live.live, true, "and the caller is told the answer came from a stream");
  assert.match(live.reply!.text, /latency_ms/, "the injected latency is named");
  assert.match(live.reply!.text, /outer fence/);
});

test("A CLEAN STREAM SAYS NOTHING IS WRONG -- and says the stream is still open", async (t) => {
  const gateway = createGateway();
  const provider = createKafkaProvider({ name: "kafka", topic: "telemetry", keyColumn: "service" }, gateway);
  const channel = "kafka:telemetry:p";
  gateway.brokerFor(channel)!.start();
  const messages = Array.from({ length: 400 }, (_, i) => telemetry({ offset: i, latency_ms: 100 + (i % 300) }));
  await provider.consume((async function* () { for (const m of messages) yield m; })());
  await settle(gateway, channel, 400);

  const live = routeWith("anything wrong now?", {} as never, gateway.snapshot(channel)[0]!);
  t.diagnostic(live.reply?.text ?? "");
  assert.match(live.reply!.text, /Nothing is past its fence/);
  assert.equal(live.live, true);
});

test("THE FILE ROUTER IS UNCHANGED when no stream is attached", () => {
  // The most important regression this file can catch: adding a live path must
  // not perturb the static one. Every existing question in this repository was
  // asked against files, and a router that answered them differently to
  // accommodate a stream would be a worse bug than the silence it fixed.
  const csv = {
    path: "operations.csv",
    headers: analysis.headers ?? [],
    rowCount: 40,
    columns: [],
    sample: [],
    problems: [],
    rows: [],
  };
  void csv;
  const empty = { agent: null };
  assert.deepEqual(route("", {} as never), empty, "an empty prompt routes nowhere, as before");
  assert.deepEqual(routeWith("", {} as never, undefined), empty);
  // With no snapshot the two are the same function, so they must agree exactly.
  const prompt = "what is wrong with this file?";
  const viaFile = route(prompt, {} as never);
  const viaFileWithNoStream = routeWith(prompt, {} as never, undefined);
  assert.equal(viaFileWithNoStream.agent, viaFile.agent);
  assert.equal(viaFileWithNoStream.reply?.text, viaFile.reply?.text);
  assert.equal(viaFileWithNoStream.live, undefined, "and nothing claims to be live");
});

test("A LIVE QUESTION THE STREAM CANNOT ANSWER SAYS SO, rather than guessing", async () => {
  const gateway = createGateway();
  const provider = createKafkaProvider({ name: "kafka", topic: "telemetry", keyColumn: "service" }, gateway);
  const channel = "kafka:telemetry:p";
  gateway.brokerFor(channel)!.start();
  await provider.consume((async function* () {
    for (let i = 0; i < 50; i += 1) yield telemetry({ offset: i, latency_ms: 100 });
  })());
  await settle(gateway, channel, 50);

  // "what is the weather" matches no live agent. The fallback must not fall
  // through to the file agents, because their answer would be about a file -- and
  // the caller asked about now.
  const result = routeWith("what is the weather in real time?", {} as never, gateway.snapshot(channel)[0]!);
  assert.equal(result.live, true);
  assert.match(result.reply!.text, /past its fence|no live agent/i,
    "it points at the question the stream CAN answer rather than declining vaguely");
});

test("A STATIC QUESTION asked while a stream runs is still answered from the file", async () => {
  // The other direction, and the one that keeps the two paths from cannibalising
  // each other. A stream being attached must not swallow questions it has no
  // business answering.
  const gateway = createGateway();
  const provider = createKafkaProvider({ name: "kafka", topic: "telemetry", keyColumn: "service" }, gateway);
  const channel = "kafka:telemetry:p";
  gateway.brokerFor(channel)!.start();
  await provider.consume((async function* () {
    for (let i = 0; i < 50; i += 1) yield telemetry({ offset: i, latency_ms: 100 });
  })());
  await settle(gateway, channel, 50);

  const parsed = parseCsv("_time,alert_code,elapsed_time,threshold\n2026-09-30 09:00:00,PEGA0001,1200,1000\n");
  const rows = parsed.rows.map((cells) => Object.fromEntries(parsed.headers.map((h, i) => [h, cells[i] ?? ""])));
  const schema = await resolveSchemaMemory({ cwd: "configs/..", headers: parsed.headers, rows });
  const fileAnalysis = analyseBottlenecks({
    path: "operations.csv", headers: parsed.headers, rowCount: rows.length,
    columns: [], sample: [], problems: [], rows,
  }, schema);

  const result = routeWith("what is wrong with this file?", fileAnalysis, gateway.snapshot(channel)[0]!);
  assert.equal(result.live, undefined,
    "answered from the file, not the stream. This is the regression that mattered: the anomaly agent's " +
    "`handles` matches 'wrong', which is also how a FILE is described, so attaching any stream turned every " +
    "static question into a live one.");
  void csvRead;
});