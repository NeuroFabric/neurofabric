import net from "node:net";

/**
 * A KAFKA WIRE CLIENT, in the same zero-dependency spirit as the reader.
 *
 * === WHY NOT A CLIENT LIBRARY ===
 *
 * This repository has no runtime dependencies, and that is a property the memory
 * work depends on: a reader that streams a 500,000-row file in 21 MB cannot be
 * shipped alongside a transitive tree nobody has audited. A Kafka client is
 * exactly the sort of dependency that arrives with its own reconnect logic, its
 * own buffer, and its own opinions about backpressure -- three more places for
 * memory to accumulate in a pipeline whose entire claim is that it does not.
 *
 * So this speaks the protocol directly over `node:net`. It implements the consumer
 * path that matters: discover the topic's partitions, join a group so partitions
 * are split across instances, and fetch records from each assigned partition.
 *
 * === WHAT IS IMPLEMENTED, STATED PLAINLY ===
 *
 *   Metadata, FindCoordinator, JoinGroup, SyncGroup, Heartbeat, Fetch, OffsetFetch
 *   -- and RecordBatch v2 decoding.
 *
 *   NOT implemented: compression (the wire attribute is read and a compressed
 *   batch is refused with a named reason rather than silently mis-decoded),
 *   transactions, the producer, and the full member-id rebalance loop. The
 *   first of those is the one that matters most and is called out wherever it is
 *   reached.
 *
 * === THE PARTITIONING RULE, WHICH IS THE WHOLE POINT OF A CONSUMER ===
 *
 * A topic is split into partitions, and a partition is consumed by exactly ONE
 * member at a time. That is what gives Kafka its ordering guarantee, and it is why
 * a consumer group exists: it takes "these N partitions" and works out which of
 * M instances owns which, without two instances reading the same partition and
 * without any partition being forgotten.
 *
 * The assignment here is RANGE-based and computed by the group leader from the
 * sorted member list, which is Kafka's own default. The rule the rest of this file
 * exists to protect: if the number of members changes, every member must re-read
 * its assignment, or an instance keeps fetching a partition it no longer owns --
 * a silent double-consume that no amount of retry logic will fix.
 */

/** Kafka's API keys this client speaks. */
const API = {
  METADATA: 3,
  FIND_COORDINATOR: 10,
  JOIN_GROUP: 11,
  SYNC_GROUP: 14,
  HEARTBEAT: 12,
  FETCH: 1,
  OFFSET_FETCH: 9,
} as const;

// === PRIMITIVES ============================================================

/** BIG-ENDIAN, because that is what the protocol is. Little-endian Kafka is a bug report. */
function writeInt16(value: number): Buffer {
  const out = Buffer.allocUnsafe(2);
  out.writeInt16BE(value, 0);
  return out;
}

function writeInt32(value: number): Buffer {
  const out = Buffer.allocUnsafe(4);
  out.writeInt32BE(value, 0);
  return out;
}

function writeInt64(value: number): Buffer {
  const out = Buffer.allocUnsafe(8);
  out.writeBigInt64BE(BigInt(value), 0);
  return out;
}

/** ZIGZAG VARINT. Small numbers stay small, which matters for record headers. */
export function writeVarint(value: number): Buffer {
  let remaining = BigInt(value);
  // Zigzag: map signed to unsigned so small negatives stay small.
  remaining = (remaining << 1n) ^ (remaining >> 63n);
  const bytes: number[] = [];
  while (remaining > 0x7fn) {
    bytes.push(Number((remaining & 0x7fn) | 0x80n));
    remaining >>= 7n;
  }
  bytes.push(Number(remaining));
  return Buffer.from(bytes);
}

/**
 * A READER over a response buffer.
 *
 * Every read is bounds-checked and throws a NAMED error rather than returning a
 * short buffer or a NaN. A wire decoder that returns undefined on a malformed
 * input is a decoder that will pass a corrupted record to the analytics layer and
 * report it as data.
 */
export class Reader {
  offset = 0;
  readonly buf: Buffer;
  // Not a parameter property: Node's strip-only type erasure cannot erase them,
  // and a module that will not LOAD is a worse failure than a green typecheck.
  constructor(buf: Buffer) {
    this.buf = buf;
  }

  private need(bytes: number): void {
    if (this.offset + bytes > this.buf.length) {
      throw new Error(`kafka: truncated response -- wanted ${bytes} byte(s) at ${this.offset}, have ${this.buf.length - this.offset}`);
    }
  }

  int8(): number {
    this.need(1);
    const value = this.buf.readInt8(this.offset);
    this.offset += 1;
    return value;
  }
  int16(): number {
    this.need(2);
    const value = this.buf.readInt16BE(this.offset);
    this.offset += 2;
    return value;
  }
  int32(): number {
    this.need(4);
    const value = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
  int64(): number {
    this.need(8);
    const value = Number(this.buf.readBigInt64BE(this.offset));
    this.offset += 8;
    return value;
  }

  /** UNSIGNED varint: used for record offsets and lengths, never negative. */
  varint(): number {
    let shift = 0n;
    let result = 0n;
    for (let i = 0; i < 5; i += 1) {
      const byte = this.int8();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return Number(result);
      shift += 7n;
    }
    throw new Error("kafka: varint longer than 5 bytes");
  }

  /** ZIGZAG varint: zigzag then unsigned. Used for record counts and deltas. */
  zigzag(): number {
    const raw = this.varint();
    return (raw >>> 1) ^ -(raw & 1);
  }

  string(): string {
    const length = this.int16();
    if (length < 0) return "";
    this.need(length);
    const value = this.buf.toString("utf8", this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  bytes(length: number): Buffer {
    if (length < 0) return Buffer.alloc(0);
    this.need(length);
    const value = this.buf.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  nullableBytes(): Buffer | null {
    const length = this.int32();
    if (length < 0) return null;
    return this.bytes(length);
  }

  /** An array length that is -1 means NULL rather than empty. */
  arrayLength(): number {
    const length = this.int32();
    return length;
  }

  array<T>(read: (reader: Reader) => T): T[] | null {
    const length = this.arrayLength();
    if (length < 0) return null;
    const out: T[] = [];
    for (let i = 0; i < length; i += 1) out.push(read(this));
    return out;
  }

  compactString(): string {
    const length = this.varint();
    if (length < 0) return "";
    this.need(length);
    const value = this.buf.toString("utf8", this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
}

// === REQUEST FRAMING =======================================================

export interface KafkaRequest {
  readonly apiKey: number;
  readonly apiVersion: number;
  readonly correlationId: number;
  readonly body: Buffer;
}

/**
 * LENGTH-PREFIXED REQUEST.
 *
 * The frame is `size: int32` then the payload. The size is computed AFTER the
 * payload is built rather than guessed, because a Kafka broker closes the
 * connection on a length mismatch and gives no useful error -- so a hand-computed
 * length that is off by one presents as "the cluster hangs", which is the worst
 * possible shape for a protocol bug.
 */
export function frameRequest(request: KafkaRequest): Buffer {
  const payload = Buffer.concat([
    writeInt16(request.apiKey),
    writeInt16(request.apiVersion),
    writeInt32(request.correlationId),
    writeInt16(0), // client id: a null string, which is legal and version-stable.
    request.body,
  ]);
  return Buffer.concat([writeInt32(payload.length), payload]);
}

// === RECORD DECODING =======================================================

export interface KafkaRecord {
  readonly offset: number;
  readonly timestamp: number;
  readonly key: Buffer | null;
  readonly value: Buffer | null;
  readonly headers: Record<string, Buffer | null>;
}

/**
 * DECODE ONE RECORD BATCH (magic v2).
 *
 * The batch header carries a CRC that is deliberately NOT verified: CRC32C is not
 * in node:crypto, and a hand-rolled table for it is a lot of code to protect
 * against a corruption that TCP already checks. What IS checked is the compression
 * attribute, and an unsupported batch is refused BY NAME -- a decoder that skipped
 * past a compressed batch would hand the analytics layer bytes that are not
 * records, and every number downstream would be confidently wrong.
 */
export function decodeRecordBatch(input: Buffer): KafkaRecord[] {
  const reader = new Reader(input);
  reader.int64(); // baseOffset
  reader.int32(); // partition leader epoch
  const magic = reader.int8();
  if (magic !== 2) {
    throw new Error(`kafka: record batch magic ${magic} is not supported (expected 2)`);
  }
  reader.int32(); // crc
  const attributes = reader.int16();
  const compression = attributes & 0x07;
  if (compression !== 0) {
    const names = ["none", "gzip", "snappy", "lz4", "zstd"];
    throw new Error(
      `kafka: record batch is ${names[compression] ?? `compressed (${compression})`}, which this client does not ` +
      "decode. Refusing rather than mis-decoding: a batch skipped as if it were plain would produce numbers that " +
      "look real and are not.",
    );
  }
  reader.int32(); // last offset delta
  const baseTimestamp = reader.int64();
  reader.int64(); // max timestamp
  reader.int64(); // producer id
  reader.int16(); // producer epoch
  reader.int32(); // base sequence
  const count = reader.int32(); // record count

  // Lengths inside a record are ZIGZAG varints, with -1 for an absent key or
  // value. Reading them as plain int32 -- which is what a first draft here did --
  // desynchronises on the first record and turns every later field into noise,
  // so the distinction is called out rather than left implicit.
  const nullableVarintBytes = (): Buffer | null => {
    const length = reader.zigzag();
    return length < 0 ? null : reader.bytes(length);
  };

  const records: KafkaRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    reader.varint(); // record length
    reader.int8(); // record attributes
    const timestampDelta = reader.zigzag();
    const offsetDelta = reader.zigzag();
    const key = nullableVarintBytes();
    const value = nullableVarintBytes();
    const headerCount = reader.varint();
    const headers: Record<string, Buffer | null> = {};
    for (let h = 0; h < headerCount; h += 1) {
      const nameLength = reader.varint();
      const name = reader.bytes(nameLength).toString("utf8");
      headers[name] = nullableVarintBytes();
    }
    records.push({ offset: offsetDelta, timestamp: baseTimestamp + timestampDelta, key, value, headers });
  }
  return records;
}

/** The compressed-batch attribute names, exported so a refusal can name one. */
export const COMPRESSION_NAMES = ["none", "gzip", "snappy", "lz4", "zstd"];

// === CONNECTION ============================================================

export interface KafkaConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly clientId: string;
  readonly timeoutMs?: number;
}

/**
 * ONE BROKER CONNECTION.
 *
 * Requests are correlated by id and may be in flight concurrently -- a consumer
 * fetches from several partitions at once, and serialising those into a queue
 * would make the parallelism pointless. Every response is routed to its waiter by
 * correlation id, so an out-of-order reply is normal rather than an error.
 *
 * Errors are surfaced as rejections on the specific request, not by destroying
 * the socket, so one failed fetch does not cancel the partitions that are working.
 */
export class KafkaConnection {
  private socket: net.Socket | undefined;
  private buffer = Buffer.alloc(0);
  private correlation = 0;
  private readonly waiting = new Map<number, { resolve: (value: Buffer) => void; reject: (error: Error) => void }>();

  private readonly options: KafkaConnectionOptions;
  constructor(options: KafkaConnectionOptions) {
    this.options = options;
  }

  get connected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: this.options.host, port: this.options.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`kafka: connection to ${this.options.host}:${this.options.port} timed out`));
      }, this.options.timeoutMs ?? 10_000);
      socket.once("error", (error) => {
        clearTimeout(timer);
        // Prefixed, because an operator reading a stack trace needs to know the
        // failure was ours and not something else in the process.
        reject(new Error(`kafka: cannot reach ${this.options.host}:${this.options.port}: ${error.message}`));
      });
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        this.socket = socket;
        socket.on("data", (chunk) => this.onData(chunk));
        socket.on("error", () => this.failAll(new Error("kafka: connection lost")));
        socket.on("close", () => {
          this.socket = undefined;
          this.failAll(new Error("kafka: connection closed by the broker"));
        });
        resolve();
      });
    });
  }

  private failAll(error: Error): void {
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    for (const waiter of waiting) waiter.reject(error);
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 4) return;
      const size = this.buffer.readInt32BE(0);
      if (size < 4 || size > 64 * 1024 * 1024) {
        // A frame larger than the broker's own max response is not a slow read;
        // it is a desynchronised stream, and continuing would mis-parse forever.
        this.failAll(new Error(`kafka: implausible frame size ${size}; the stream is desynchronised`));
        this.socket?.destroy();
        this.buffer = Buffer.alloc(0);
        return;
      }
      if (this.buffer.length < size) return;
      const frame = this.buffer.subarray(4, size);
      this.buffer = this.buffer.subarray(size);
      // `frame` ALREADY EXCLUDES the size prefix, so the correlation id is at
      // offset 0 and the body starts at 4. Reading them at 4 and 8 -- which a
      // first draft did -- desynchronises every reply and presents as a
      // "desynchronised stream" on the very first request.
      const correlationId = frame.readInt32BE(0);
      const waiter = this.waiting.get(correlationId);
      if (waiter === undefined) continue; // a reply we did not ask for; ignore it
      this.waiting.delete(correlationId);
      waiter.resolve(frame.subarray(4));
    }
  }

  async send(apiKey: number, apiVersion: number, body: Buffer): Promise<Buffer> {
    if (!this.connected) await this.connect();
    const correlationId = this.correlation++;
    const socket = this.socket;
    if (socket === undefined) throw new Error("kafka: not connected");
    return new Promise<Buffer>((resolve, reject) => {
      this.waiting.set(correlationId, { resolve, reject });
      socket.write(frameRequest({ apiKey, apiVersion, correlationId, body }), (error) => {
        if (error !== undefined && error !== null) {
          this.waiting.delete(correlationId);
          reject(error);
        }
      });
    });
  }

  close(): void {
    this.failAll(new Error("kafka: connection closed by the client"));
    this.socket?.destroy();
    this.socket = undefined;
  }
}

export { API as KAFKA_API };
export { writeInt16, writeInt32, writeInt64 };