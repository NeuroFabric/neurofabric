import test from "node:test";
import assert from "node:assert/strict";

import { createTelemetryConsumer, byteSource, DEFAULT_MAX_FRAME_BYTES, type DroppedFrame } from "./kafka-consumer.ts";
import { validateUniversalTelemetryEvent, type UniversalTelemetryEvent } from "./universal-envelope.ts";

/**
 * THE TELEMETRY CONSUMER.
 *
 * === THE TWO HALVES, AND WHY THE SECOND IS THE ONE THAT IS HARD ===
 *
 * "Rejects malformed input" is the half anybody writes and the half that breaks
 * nobody. The half that matters is the pair underneath it:
 *
 *   1. a bad frame does not stop the stream, because a firehose with one broken
 *      producer must not become a pipeline with no data at all; AND
 *   2. an invalid frame never reaches `onEvent`, because "drop what you cannot
 *      verify" is only a guarantee if the other half is true.
 *
 * A consumer that satisfies (1) by logging and continuing without validating, or
 * satisfies (2) by refusing to continue at all, passes a naive "does it reject bad
 * input" test and fails in production. So both are asserted here, repeatedly, and
 * the tests that assert them always put a VALID event after the malformed one --
 * because a consumer that drops the bad frame and then also drops everything after
 * it has passed every other assertion in this file.
 */

const VALID = {
  eventId: "evt-1",
  timestamp: "2026-10-04T12:00:00.000Z",
  metricName: "request.latency.p95",
  value: 42.5,
  metadata: { region: "eu-west-1", attempt: 1, cached: false, note: null },
};

function collector(): { events: UniversalTelemetryEvent[]; drops: DroppedFrame[] } {
  return { events: [], drops: [] };
}

async function run(
  frames: readonly unknown[],
  options: { maxFrameBytes?: number } = {},
): Promise<{ events: UniversalTelemetryEvent[]; drops: DroppedFrame[]; stats: Awaited<ReturnType<ReturnType<typeof createTelemetryConsumer>["consume"]>> }> {
  const { events, drops } = collector();
  const consumer = createTelemetryConsumer({
    onEvent: (event) => events.push(event),
    onInvalid: (drop) => drops.push(drop),
    ...options,
  });
  // NEWLINE-TERMINATED, ONE FRAME PER CHUNK.
  //
  // Both halves matter. The newline is what a real producer emits and what makes a
  // frame boundary a frame boundary -- without it, consecutive unterminated chunks
  // are ONE frame by definition, which is the module's contract and not a bug.
  // Emitting one frame per chunk additionally exercises the framing loop per frame
  // rather than letting a single concatenated chunk hide it.
  const chunks = frames.map((frame) =>
    Buffer.from(`${typeof frame === "string" ? frame : JSON.stringify(frame)}\n`),
  );
  const stats = await consumer.consume(byteSource(chunks));
  return { events, drops, stats };
}

/* -------------------------------------------------------------------------- */
/* THE SCHEMA                                                                  */
/* -------------------------------------------------------------------------- */

test("a well-formed event validates and comes back normalised", () => {
  const verdict = validateUniversalTelemetryEvent(VALID);
  assert.equal(verdict.ok, true);
  assert.ok(verdict.ok && verdict.event.metricName === "request.latency.p95");
  assert.ok(verdict.ok && verdict.event.value === 42.5);
});

test("the envelope refuses every shape that is not a complete event", () => {
  const cases: readonly [string, unknown][] = [
    ["a bare string", "not an object"],
    ["an array", [1, 2, 3]],
    ["null", null],
    ["a number", 7],
    // Every missing field in turn. Optionality is how envelope drift begins, so each
    // one is removed from a otherwise-valid event rather than from `{}`.
    ["no eventId", { ...VALID, eventId: undefined }],
    ["no timestamp", { ...VALID, timestamp: undefined }],
    ["no metricName", { ...VALID, metricName: undefined }],
    ["no value", { ...VALID, value: undefined }],
    ["no metadata", { ...VALID, metadata: undefined }],
    ["an empty eventId", { ...VALID, eventId: "" }],
    ["a numeric eventId", { ...VALID, eventId: 12345 }],
    // The single most common way a producer breaks: a local timestamp with no offset.
    ["a date-only timestamp", { ...VALID, timestamp: "2026-10-04" }],
    ["a local timestamp with no offset", { ...VALID, timestamp: "2026-10-04T12:00:00" }],
    ["an impossible timestamp", { ...VALID, timestamp: "2026-13-45T99:99:99Z" }],
    ["a string value", { ...VALID, value: "42.5" }],
    ["null metadata", { ...VALID, metadata: null }],
    ["array metadata", { ...VALID, metadata: [] }],
    ["a metric name with a newline", { ...VALID, metricName: "a\nb" }],
    ["an empty metric name", { ...VALID, metricName: "" }],
    ["a metric name with a space", { ...VALID, metricName: "request latency" }],
    // NOT an object literal. `{ __proto__: "x" }` sets the prototype and creates no
    // own key, so it would be inert here and the test would pass without testing
    // anything. JSON.parse is the realistic vector -- it creates a real own property
    // named `__proto__`, which is exactly what a hostile topic payload carries.
    ["a prototype-polluting metadata key", { ...VALID, metadata: JSON.parse('{"__proto__": {"polluted": true}}') }],
    ["an array inside metadata", { ...VALID, metadata: { tags: ["a", "b"] } }],
    ["a NaN inside metadata", { ...VALID, metadata: { ratio: Number.NaN } }],
    ["an Infinity inside metadata", { ...VALID, metadata: { ratio: Number.POSITIVE_INFINITY } }],
  ];

  for (const [label, payload] of cases) {
    const verdict = validateUniversalTelemetryEvent(payload);
    assert.equal(verdict.ok, false, `${label} was accepted`);
    assert.ok(!verdict.ok && verdict.reason.length > 0, `${label} was refused without a reason`);
  }
});

test("NaN and Infinity are refused as values", () => {
  // Not reachable through JSON.parse, which is exactly why they are asserted here:
  // they can only arrive from a bug upstream, and one NaN poisons an average
  // permanently and invisibly.
  assert.equal(validateUniversalTelemetryEvent({ ...VALID, value: Number.NaN }).ok, false);
  assert.equal(validateUniversalTelemetryEvent({ ...VALID, value: Number.POSITIVE_INFINITY }).ok, false);
});

test("an unknown top-level field is refused, so source detail stays in metadata", () => {
  const verdict = validateUniversalTelemetryEvent({ ...VALID, datadog_tags: ["prod"] });
  assert.equal(verdict.ok, false);
  assert.ok(!verdict.ok && verdict.code === "UNKNOWN_FIELD");
  // And the same detail inside metadata is fine, where it belongs. A scalar, not an
  // array -- arrays are refused inside metadata on purpose, since a list of numbers
  // is a metric and belongs in `value`.
  assert.equal(validateUniversalTelemetryEvent({ ...VALID, metadata: { datadog_env: "prod" } }).ok, true);
});

test("a __proto__ key survives JSON.parse and is refused rather than copied", () => {
  // The vector that an object-literal test cannot reach. `JSON.parse` creates an own
  // property called `__proto__`, so this payload really does carry one -- and
  // copying it into the rebuilt metadata object would have set that object's
  // prototype instead of adding a field.
  const payload = JSON.parse(`{"eventId":"evt-1","timestamp":"2026-10-04T12:00:00.000Z","metricName":"m","value":1,"metadata":{"__proto__":{"polluted":true}}}`);
  const verdict = validateUniversalTelemetryEvent(payload);

  assert.equal(verdict.ok, false);
  // And nothing leaked onto Object.prototype anywhere along the way.
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("metadata nesting is capped and the cap is a bound on work", () => {
  let deep: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < 12; i += 1) deep = { nested: deep };
  const verdict = validateUniversalTelemetryEvent({ ...VALID, metadata: deep });
  assert.equal(verdict.ok, false);
  assert.ok(!verdict.ok && verdict.code === "METADATA_TOO_DEEP");
});

test("metadata key count is capped", () => {
  const wide: Record<string, number> = {};
  for (let i = 0; i < 200; i += 1) wide[`k${i}`] = i;
  const verdict = validateUniversalTelemetryEvent({ ...VALID, metadata: wide });
  assert.equal(verdict.ok, false);
});

/* -------------------------------------------------------------------------- */
/* THE CONSUMER -- FAIL CLOSED                                                 */
/* -------------------------------------------------------------------------- */

test("a malformed frame is dropped and NEVER reaches onEvent", async () => {
  const { events, drops, stats } = await run([
    { ...VALID, value: "not-a-number" },
    { ...VALID, eventId: "evt-2" },
  ]);

  assert.equal(events.length, 1, "the invalid frame was emitted");
  assert.equal(events[0]?.eventId, "evt-2");
  assert.equal(drops.length, 1);
  assert.equal(drops[0]?.reason, "invalid-event");
  assert.equal(stats.rejected, 1);
  assert.equal(stats.accepted, 1);
});

test("undecodable bytes are dropped and the stream continues", async () => {
  const { events, drops, stats } = await run([
    "\u0000\u0001 not json at all",
    JSON.stringify({ ...VALID, eventId: "evt-after-garbage" }),
  ]);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.eventId, "evt-after-garbage");
  assert.equal(drops[0]?.reason, "not-json");
  assert.equal(stats.rejected, 0, "a transport problem is not a schema rejection");
});

test("a frame that is valid JSON but not an event is dropped, not passed through", async () => {
  const { events } = await run([{ hello: "world" }, [1, 2, 3], "a bare string", 42]);
  assert.equal(events.length, 0, "arbitrary JSON reached onEvent");
});

test("a stream of nothing but malformed frames ends without throwing", async () => {
  const { events, stats } = await run([
    "not json",
    { bad: true },
    { ...VALID, timestamp: "yesterday" },
    "",
  ]);
  assert.equal(events.length, 0);
  assert.ok(stats.rejected >= 2);
});

/* -------------------------------------------------------------------------- */
/* THE CONSUMER -- FAIL OPEN ON THE TRANSPORT                                  */
/* -------------------------------------------------------------------------- */

test("ONE bad frame does not stop the frames after it", async () => {
  // The assertion that the rest of this file would let pass. A consumer that
  // validated correctly and then refused to continue would satisfy every other
  // test here; this one is the reason the drop is a drop and not a stop.
  const frames = Array.from({ length: 50 }, (_, i) =>
    i % 2 === 0 ? { ...VALID, eventId: `good-${i}` } : { ...VALID, eventId: `bad-${i}`, value: null },
  );
  const { events, stats } = await run(frames);

  assert.equal(events.length, 25);
  assert.equal(stats.accepted, 25);
  assert.equal(stats.rejected, 25);
  assert.equal(events[24]?.eventId, "good-48", "the stream stopped before the last good frame");
});

test("a sink that throws is contained, and the stream continues", async () => {
  const drops: DroppedFrame[] = [];
  let calls = 0;
  const consumer = createTelemetryConsumer({
    onEvent: () => {
      calls += 1;
      if (calls === 2) throw new Error("downstream handler is broken");
    },
    onInvalid: (drop) => drops.push(drop),
  });
  const stats = await consumer.consume(
    byteSource(Array.from({ length: 5 }, () => Buffer.from(`${JSON.stringify(VALID)}\n`))),
  );

  assert.equal(calls, 5, "the throwing sink stopped the stream");
  assert.equal(stats.accepted, 4);
  assert.equal(drops[0]?.reason, "sink-threw");
});

/* -------------------------------------------------------------------------- */
/* FRAMING -- THE PART THAT BREAKS IN PRODUCTION AND NOT IN TESTS              */
/* -------------------------------------------------------------------------- */

test("a record split across three chunks is reassembled", async () => {
  const wire = Buffer.from(JSON.stringify(VALID));
  const { events, stats } = await run([]);
  void events;
  void stats;

  const collected: UniversalTelemetryEvent[] = [];
  const consumer = createTelemetryConsumer({ onEvent: (event) => collected.push(event) });
  const result = await consumer.consume(
    byteSource([wire.subarray(0, 10), wire.subarray(10, 25), wire.subarray(25)]),
  );

  assert.equal(collected.length, 1, "a record split across reads was lost");
  assert.equal(collected[0]?.eventId, "evt-1");
  assert.equal(result.accepted, 1);
});

test("several records in one chunk are all delivered", async () => {
  const wire = Buffer.from(
    `${JSON.stringify(VALID)}\n${JSON.stringify({ ...VALID, eventId: "evt-2" })}\n${JSON.stringify({ ...VALID, eventId: "evt-3" })}\n`,
  );
  const collected: UniversalTelemetryEvent[] = [];
  const consumer = createTelemetryConsumer({ onEvent: (event) => collected.push(event) });
  const result = await consumer.consume(byteSource([wire]));

  assert.equal(collected.length, 3);
  assert.equal(result.frames, 3);
  assert.deepEqual(collected.map((e) => e.eventId), ["evt-1", "evt-2", "evt-3"]);
});

test("one byte at a time is the worst case and still works", async () => {
  const wire = Buffer.from(JSON.stringify(VALID));
  const collected: UniversalTelemetryEvent[] = [];
  const consumer = createTelemetryConsumer({ onEvent: (event) => collected.push(event) });
  await consumer.consume(byteSource(Array.from(wire, (byte) => Buffer.from([byte]))));

  assert.equal(collected.length, 1);
});

test("a CRLF producer is not treated as a malformed one", async () => {
  const collected: UniversalTelemetryEvent[] = [];
  const consumer = createTelemetryConsumer({ onEvent: (event) => collected.push(event) });
  const result = await consumer.consume(byteSource([Buffer.from(`${JSON.stringify(VALID)}\r\n`)]));

  assert.equal(collected.length, 1);
  assert.equal(result.accepted, 1);
});

test("a trailing frame with no newline is delivered", async () => {
  const collected: UniversalTelemetryEvent[] = [];
  const consumer = createTelemetryConsumer({ onEvent: (event) => collected.push(event) });
  const result = await consumer.consume(byteSource([Buffer.from(JSON.stringify(VALID))]));

  assert.equal(collected.length, 1);
  assert.equal(result.accepted, 1);
});

test("blank lines are skipped and are not counted as rejections", async () => {
  const { stats, events } = await run(["", "   ", JSON.stringify(VALID), ""]);
  assert.equal(events.length, 1);
  assert.equal(stats.rejected, 0, "a blank line was treated as a malformed event");
  assert.ok(stats.empty >= 2);
});

/* -------------------------------------------------------------------------- */
/* THE FLOOD                                                                   */
/* -------------------------------------------------------------------------- */

test("an undelimited flood is bounded and does not exhaust memory", async () => {
  // No newline anywhere: the naive reader grows one buffer until the process dies,
  // and it takes every other producer's telemetry with it.
  const drops: DroppedFrame[] = [];
  const collected: UniversalTelemetryEvent[] = [];
  const consumer = createTelemetryConsumer({
    onEvent: (event) => collected.push(event),
    onInvalid: (drop) => drops.push(drop),
    maxFrameBytes: 1024,
  });

  const flood = Buffer.alloc(512 * 1024, 0x41); // 512 KiB, no newline
  const result = await consumer.consume(byteSource([flood]));

  assert.equal(result.oversized, 1, "the oversized frame was not detected");
  assert.equal(collected.length, 0);
  assert.ok(result.bytes >= flood.length, "the consumer stopped reading the flood");
});

test("an oversized frame resynchronises and later records still arrive", async () => {
  const collected: UniversalTelemetryEvent[] = [];
  const drops: DroppedFrame[] = [];
  const consumer = createTelemetryConsumer({
    onEvent: (event) => collected.push(event),
    onInvalid: (drop) => drops.push(drop),
    maxFrameBytes: 512,
  });

  // 4 KiB of junk with no newline, then a real record. The ceiling sits well above a
  // real event (about 100 bytes) and well below the junk, so it separates the two
  // rather than refusing both. An earlier version used 64, which is below a valid
  // envelope, and so refused the good record too -- a test that looked like it was
  // proving resynchronisation and was actually proving the ceiling was mis-set.
  const junk = Buffer.concat([Buffer.alloc(4096, 0x42), Buffer.from("\n")]);
  const good = Buffer.from(`${JSON.stringify({ ...VALID, eventId: "evt-after-flood" })}\n`);
  await consumer.consume(byteSource([junk, good]));

  assert.equal(collected.length, 1, "the consumer did not resynchronise after the flood");
  assert.equal(collected[0]?.eventId, "evt-after-flood");
  assert.equal(drops[0]?.reason, "oversized");
});

test("the default frame ceiling is a ceiling and not unlimited", () => {
  assert.ok(DEFAULT_MAX_FRAME_BYTES > 0 && Number.isFinite(DEFAULT_MAX_FRAME_BYTES));
  assert.ok(DEFAULT_MAX_FRAME_BYTES <= 1024 * 1024, "the default ceiling is large enough to be unbounded in practice");
});

/* -------------------------------------------------------------------------- */
/* WHAT GETS LOGGED                                                            */
/* -------------------------------------------------------------------------- */

test("a refusal names the field and never echoes the value", async () => {
  // The value has to be one the validator ACTUALLY rejects -- an earlier version of
  // this test used a string of letters and underscores, which is a perfectly legal
  // metric name, so the event was accepted and the whole assertion passed vacuously.
  // The embedded space is what makes it invalid.
  const secret = "tok_live_SHOULD_NOT_BE_LOGGED with spaces";
  const { drops, events } = await run([{ ...VALID, metricName: secret }]);

  assert.equal(events.length, 0, "an invalid metric name was accepted");
  assert.equal(drops.length, 1);
  assert.ok(drops[0]?.detail?.includes("metricName"), "the refusal does not name the offending field");
  assert.equal(
    drops[0]?.detail?.includes(secret),
    false,
    "the refusal echoed the value it refused",
  );
});

test("counters describe a mixed stream accurately", async () => {
  const { stats } = await run([
    { ...VALID, eventId: "a" },
    { ...VALID, eventId: "b", value: "nope" },
    "garbage",
    { ...VALID, eventId: "c" },
  ]);

  assert.equal(stats.accepted, 2);
  assert.equal(stats.rejected, 1);
  // Four newline-terminated frames: two good, one schema-invalid, one not-JSON.
  // `frames` counts what was framed; `rejected` counts what the schema refused.
  assert.equal(stats.frames, 4);
  assert.ok(stats.bytes > 0);
});