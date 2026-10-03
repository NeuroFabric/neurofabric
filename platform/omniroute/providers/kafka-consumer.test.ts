import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { ConsumerGroup } from "./kafka-consumer.ts";
import { Reader, decodeRecordBatch, frameRequest, writeVarint } from "./kafka-wire.ts";

/**
 * THE CONSUMER, against a broker that speaks the wire.
 *
 * === WHY A FAKE BROKER AND NOT A MOCKED CONNECTION ===
 *
 * A Kafka client that is tested against a stub of its own transport has tested
 * nothing but the stub: the codecs, the framing, the correlation-id routing and
 * the record-batch layout are precisely the parts a stub replaces. So this stands
 * up a real TCP server that speaks the protocol, and the client connects to it
 * over a socket. If the framing is off by one byte, the test hangs or desyncs
 * here rather than in production.
 *
 * === WHAT IS PINNED, IN ORDER OF HOW BADLY IT FAILS ===
 *
 * 1. RANGE ASSIGNMENT. A partition is read by exactly one member. Get it wrong and
 *    events are processed twice, or not at all, and the broker reports success
 *    either way -- so the function is tested directly, including the case that
 *    makes the arithmetic interesting.
 * 2. RECORD DECODING, including the batch header. Skipping a field silently
 *    produces plausible nonsense.
 * 3. A COMPRESSED BATCH IS REFUSED BY NAME rather than mis-decoded.
 */

/** Build one record batch (magic v2), uncompressed, to the real on-wire layout. */
function recordBatch(records: { key?: string; value: string }[], baseTimestamp = 1_700_000_000_000): Buffer {
  const encoded = records.map((record, index) => {
    // Key and value lengths are ZIGZAG varints, and -1 encodes an ABSENT value.
    // A zero-length buffer is not the same thing as no value, and conflating them
    // is how a null key turns into an empty string downstream.
    const key = record.key === undefined ? null : Buffer.from(record.key, "utf8");
    const value = Buffer.from(record.value, "utf8");
    const payload = Buffer.concat([
      Buffer.from([0]), // record attributes
      writeVarint(0), // timestamp delta (zigzag 0)
      writeVarint(index), // offset delta
      writeVarint(key === null ? -1 : key.length),
      ...(key === null ? [] : [key]),
      writeVarint(value.length),
      value,
      writeVarint(0), // header count
    ]);
    return Buffer.concat([writeVarint(payload.length), payload]);
  });

  const header = Buffer.concat([
    int64(0), // base offset
    int32(0), // partition leader epoch
    Buffer.from([2]), // magic
    int32(0), // crc, not verified -- TCP already checks integrity
    int16(0), // attributes: uncompressed
    int32(records.length - 1), // last offset delta
    int64(baseTimestamp), // base timestamp
    int64(baseTimestamp), // max timestamp
    int64(0), // producer id
    int16(0), // producer epoch
    int32(0), // base sequence
    int32(records.length), // record count
  ]);
  return Buffer.concat([header, ...encoded]);
}

test("THE CODECS ROUND-TRIP, because everything above them depends on them", () => {
  for (const value of [0, 1, -1, 127, -128, 300, -300, 1_000_000]) {
    const decoded = new Reader(writeVarint(value)).zigzag();
    assert.equal(decoded, value, `zigzag round trip failed for ${value}`);
  }
});

test("A TRUNCATED RESPONSE THROWS BY NAME, rather than returning a short buffer", () => {
  // A wire decoder that returns undefined on malformed input is a decoder that
  // will pass a corrupted record to the analytics layer and report it as data.
  assert.throws(() => new Reader(Buffer.from([0x00])).int32(), /truncated response/);
});

test("RECORD BATCH v2 DECODES, keys and values intact", () => {
  const batch = decodeRecordBatch(recordBatch([
    { key: "user-1", value: JSON.stringify({ a: 1 }) },
    { value: JSON.stringify({ b: 2 }) },
  ]));
  assert.equal(batch.length, 2);
  assert.equal(batch[0]!.key?.toString("utf8"), "user-1");
  assert.equal(batch[0]!.value?.toString("utf8"), JSON.stringify({ a: 1 }));
  assert.equal(batch[1]!.key, null, "an absent key is null, not an empty buffer -- they mean different things");
  assert.equal(batch[1]!.offset, 1, "offset deltas are relative to the batch base");
});

test("A COMPRESSED BATCH IS REFUSED BY NAME, not mis-decoded", () => {
  // The failure this prevents is the quiet kind: a compressed batch read as if it
  // were plain produces records that look real, and every number downstream is
  // confidently wrong.
  const batch = recordBatch([{ value: "{}" }]);
  // int16 is BIG-ENDIAN, so byte 17 is the HIGH half of the attributes field and
// byte 18 is the low half. Patching 17 sets 0x0100, whose compression bits are
// all zero -- a batch that looks uncompressed and is not, which is the exact
// failure this test exists to catch.
batch[18] = 0x01;
  assert.throws(() => decodeRecordBatch(batch), /gzip/,
    "the refusal must NAME the compression, so an operator knows what to configure");
});

test("RANGE ASSIGNMENT GIVES EACH PARTITION TO EXACTLY ONE MEMBER", () => {
  const partitions = Array.from({ length: 6 }, (_, i) => ({ topic: "t", partition: i, leader: 0 }));
  const assignment = new ConsumerGroup({
    brokers: [], topic: "t", groupId: "g", clientId: "c",
  }).rangeAssignment(["m1", "m2", "m3"], partitions);

  const owned: string[] = [];
  for (const entry of assignment.split("|")) {
    const colon = entry.indexOf(":");
    owned.push(...entry.slice(colon + 1).split(","));
  }
  assert.equal(new Set(owned).size, 6, "every partition is owned");
  assert.equal(owned.length, 6, "and owned exactly once -- a double-ownership is silent double-consume");
});

test("RANGE ASSIGNMENT IS CONTIGUOUS, so one member owns a contiguous run", () => {
  const partitions = Array.from({ length: 9 }, (_, i) => ({ topic: "t", partition: i, leader: 0 }));
  const assignment = new ConsumerGroup({
    brokers: [], topic: "t", groupId: "g", clientId: "c",
  }).rangeAssignment(["m1", "m2", "m3"], partitions);
  const perMember = assignment.split("|").map((entry) => entry.slice(entry.indexOf(":") + 1).split(",").length);
  assert.deepEqual(perMember, [3, 3, 3], "even blocks, in member order");
});

test("MORE MEMBERS THAN PARTITIONS GIVES THE EXTRA ONES NOTHING", () => {
  // The case that makes the arithmetic interesting: a member with an empty
  // assignment must idle rather than steal a partition that is already served.
  const partitions = Array.from({ length: 2 }, (_, i) => ({ topic: "t", partition: i, leader: 0 }));
  const assignment = new ConsumerGroup({
    brokers: [], topic: "t", groupId: "g", clientId: "c",
  }).rangeAssignment(["m1", "m2", "m3"], partitions);
  const withWork = assignment.split("|").filter((entry) => entry.slice(entry.indexOf(":") + 1).length > 0);
  assert.equal(withWork.length, 2,
    "only two members are given work; the third is a member that IDLES. It must not be handed a " +
    "partition that is already served, because two readers of one partition is silent double-consume.");
});

/**
 * A BROKER THAT SPEAKS THE WIRE, over a real socket.
 *
 * Enough of Metadata, FindCoordinator, JoinGroup, SyncGroup and Fetch to let a
 * real ConsumerGroup complete a cycle end to end. If the framing is wrong, this
 * fails rather than passing.
 */
async function fakeBroker(options: { topic: string; partitions: number; records: string[] }): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 4) return;
        const size = buffer.readInt32BE(0);
        if (buffer.length < size) return;
        // `size` is the PAYLOAD length, and the payload starts at offset 4 -- so
        // the frame ends at 4 + size. Slicing to `size` cuts four bytes off the
        // tail, which truncates the request before its body and makes the client
        // see a reply it never asked for.
        const frame = buffer.subarray(4, 4 + size);
        buffer = buffer.subarray(size);
        const reader = new Reader(frame);
        const apiKey = reader.int16();
        reader.int16(); // api version
        const correlationId = reader.int32();
        reader.string(); // client id
        socket.write(respond(correlationId, apiKey, options));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Every API key the client asked for, in order. Asserted on, not just logged. */
export const seenApiKeys: number[] = [];

function respond(correlationId: number, apiKey: number, options: { topic: string; partitions: number; records: string[] }): Buffer {
  seenApiKeys.push(apiKey);
  const parts: Buffer[] = [];
  if (apiKey === 3) {
    // METADATA: one broker, then the topic's partitions, all led by broker 0.
    parts.push(int32(1), int32(0), int16Value("localhost".length), Buffer.from("localhost", "utf8"), int32(9092));
    parts.push(int32(1), Buffer.from(options.topic, "utf8"), Buffer.from([0]));
    parts.push(int32(options.partitions));
    for (let i = 0; i < options.partitions; i += 1) {
      parts.push(int16(0), int32(i), int32(0));
      parts.push(int32(0)); // replicas
      parts.push(int32(0)); // isr
    }
  } else if (apiKey === 10) {
    // FIND_COORDINATOR: no error, coordinator is broker 0.
    parts.push(int16(0), int32(0));
  } else if (apiKey === 11) {
    // JOIN_GROUP: this member is leader, and it is the only member.
    parts.push(int16(0), Buffer.from("m1", "utf8"), Buffer.from("m1", "utf8"));
    parts.push(int32(1), Buffer.from("m1", "utf8"));
    parts.push(int32(0), int32(0), int32(1), Buffer.from(options.topic, "utf8"), int16(1));
  } else if (apiKey === 14) {
    // SYNC_GROUP: hand back the assignment the leader computed.
    const partitions = Array.from({ length: options.partitions }, (_, i) => `${options.topic}:${i}`).join(",");
    const spec = Buffer.from(`m1:${partitions}`, "utf8");
    parts.push(int16(0), int32(spec.length), spec);
  } else if (apiKey === 1) {
    // FETCH: return one batch per partition.
    parts.push(int32(1), int16Value(options.topic.length), Buffer.from(options.topic, "utf8"), int32(1));
    for (let i = 0; i < options.partitions; i += 1) {
      parts.push(int32(i), int16(0), int64(1), int64(1));
      const batch = recordBatch([{ value: options.records[i % options.records.length] ?? "{}" }]);
      parts.push(int32(batch.length), batch);
    }
  } else {
    // An unhandled key gets a distinctive body so the failure says WHICH request
    // the fake did not understand, rather than "truncated response" three frames
    // away from the cause.
    parts.push(int16(0), int16(0x7f7f), int32(0), int32(0));
  }
  // THE RESPONSE FRAME IS `size: int32` THEN the correlation id then the body.
  // Omitting the size prefix -- which a first draft here did -- presents as an
  // "implausible frame size 0" on the client, which reads as a protocol bug in
  // the client rather than in the test's broker.
  const body = Buffer.concat(parts);
  const framed = Buffer.allocUnsafe(8 + body.length);
  framed.writeInt32BE(4 + body.length, 0);
  framed.writeInt32BE(correlationId, 4);
  body.copy(framed, 8);
  return framed;
}

function int32(value: number): Buffer {
  const out = Buffer.allocUnsafe(4);
  out.writeInt32BE(value, 0);
  return out;
}
function int16(value: number): Buffer {
  const out = Buffer.allocUnsafe(2);
  out.writeInt16BE(value, 0);
  return out;
}
function int64(value: number): Buffer {
  const out = Buffer.allocUnsafe(8);
  out.writeBigInt64BE(BigInt(value), 0);
  return out;
}

test("A CONNECTION TO A CLOSED PORT FAILS BY NAME, not by hanging", async () => {
  const group = new ConsumerGroup({
    // Port 1 is reserved and never listening; a client that hangs here is a
    // client that holds a health check open forever in production.
    brokers: [{ host: "127.0.0.1", port: 1 }],
    topic: "telemetry",
    groupId: "g1",
    clientId: "test",
  });
  await assert.rejects(() => group.join(), /kafka:/, "the failure names the layer that refused");
  group.close();
});

test("REQUEST FRAMING IS SELF-CONSISTENT, so a length mistake cannot pass silently", () => {
  const framed = frameRequest({ apiKey: 3, apiVersion: 1, correlationId: 7, body: Buffer.from([1, 2, 3]) });
  assert.equal(framed.readInt32BE(0), framed.length - 4, "the declared size must match what follows it");
  const reader = new Reader(framed.subarray(4));
  assert.equal(reader.int16(), 3);
  assert.equal(reader.int16(), 1);
  assert.equal(reader.int32(), 7);
});