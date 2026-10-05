/**
 * THE TELEMETRY CONSUMER: BYTES IN, VALIDATED EVENTS OUT.
 *
 * === WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ===
 *
 * It is the framer and the validator. It is **not** a Kafka client and contains no
 * Kafka wire protocol, no broker discovery, no consumer group and no offset
 * bookkeeping. Those belong to a client library, and this repository has no runtime
 * dependencies by policy -- so this module takes the one thing it can be correct
 * about without a library: an `AsyncIterable<Uint8Array>`, which is what every
 * client library produces and what a file read produces.
 *
 * The consequence worth stating is that swapping the transport changes nothing
 * above this line. A topic, a file, a socket and a test fixture all arrive here as
 * the same bytes, so the validation being tested is the validation that runs in
 * production rather than a parallel implementation written for testability.
 *
 * === NEWLINE FRAMING, AND WHY THAT IS THE HARD PART ===
 *
 * A chunk boundary is not a message boundary. A producer's record can be split
 * across two TCP reads, three records can arrive in one, and a 4 MB flush can
 * interleave both. Any decoder that treats "what arrived" as "one message" will
 * work in a test where the test chose the chunk sizes and fail in production where
 * the network chose them.
 *
 * So frames are split on `\n` across an accumulating buffer, and the partial tail
 * is carried forward. This module is the reason the consumer works on real traffic.
 *
 * === A DROPPED FRAME MUST NOT STOP THE STREAM, AND A CORRUPT ONE MUST NOT FIT ===
 *
 * These pull in opposite directions and both matter.
 *
 * A malformed frame is **dropped and counted**. It does not throw, does not
 * reject the batch, and does not end the stream. Telemetry is lossy by nature --
 * producers crash mid-batch, versions skew during a rolling deploy, one bad
 * partition would otherwise take the pipeline down -- and a consumer that stops on
 * bad input turns a partial producer outage into total data loss. The cost of this
 * choice is that a broken producer is invisible unless someone counts; that is why
 * the counters below are part of the return value rather than a debug counter
 * nobody reads.
 *
 * What is emitted, though, is **fail-closed**: a frame that has not passed
 * `validateUniversalTelemetryEvent` never reaches `onEvent`. "Drop what you cannot
 * verify" and "accept the rest" -- the first is a loss, the second is a guarantee.
 *
 * === THE OVERSIZED FRAME IS ITS OWN CASE, BECAUSE IT IS AN ATTACK ===
 *
 * Unbounded accumulation is the failure mode of every line-oriented reader on an
 * untrusted stream: a producer that never sends a newline makes the buffer grow
 * until the process dies, and it takes every other tenant's telemetry with it. A
 * firehose is a firehose because someone else controls the byte rate.
 *
 * So there is a frame ceiling, and exceeding it enters a **resynchronisation**
 * rather than a crash: bytes are discarded up to the next newline, one oversized
 * frame is counted, and the stream carries on. The alternative -- allocating until
 * the heap gives out -- is not a stricter policy, it is a denial of service
 * handed to a publisher.
 *
 * === AND THE SINK'S OWN FAILURE IS CONTAINED ===
 *
 * `onEvent` is caller code on the hot path. If it throws, the frame has already
 * been validated, so letting the exception escape would stop the stream over a bug
 * downstream of every guarantee this module makes. It is counted and contained.
 */

import {
  validateUniversalTelemetryEvent,
  type UniversalTelemetryEvent,
} from "./universal-envelope.ts";

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/**
 * THE FRAME CEILING.
 *
 * 256 KiB. Large enough that a legitimate event with a reasonably detailed
 * metadata record is nowhere near it, small enough that a flood of undelimited
 * bytes is bounded rather than fatal. Exceeding it drops ONE frame and resynchronises.
 */
export const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;

/** Why a frame was dropped. Carries no payload -- see `DroppedFrame`. */
export type DropReason =
  | "not-json"
  | "invalid-event"
  | "oversized"
  | "sink-threw";

export interface DroppedFrame {
  readonly reason: DropReason;
  /** How many bytes went with it, so a flood is visible as a magnitude. */
  readonly bytes: number;
  /**
   * The validator's reason, when there is one.
   *
   * It NAMES A FIELD and never echoes a value, so it is safe to log: a
   * `metricName` can contain anything an upstream system put in it, and a log line
   * is a string that gets shipped, indexed and pasted into a ticket.
   */
  readonly detail?: string;
}

export interface ConsumerStats {
  /** Newline-terminated frames, plus a trailing unterminated one if the stream ended on it. */
  readonly frames: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly oversized: number;
  /** Whitespace-only frames. Silently skipped, never counted as rejections. */
  readonly empty: number;
  readonly bytes: number;
}

export interface TelemetryConsumerOptions {
  readonly onEvent: (event: UniversalTelemetryEvent) => void;
  /** The logging hook. Omit to drop quietly and count only. */
  readonly onInvalid?: (drop: DroppedFrame) => void;
  readonly maxFrameBytes?: number;
}

/**
 * THE CONSUMER.
 *
 * A class rather than a function because the framing state -- the partial tail and
 * the resynchronisation flag -- has to survive between chunks, and a closure with
 * two mutable variables across an async loop is the shape in which such state gets
 * reset on an early return.
 */
export class TelemetryStreamConsumer {
  private readonly onEvent: (event: UniversalTelemetryEvent) => void;
  private readonly onInvalid: ((drop: DroppedFrame) => void) | undefined;
  private readonly maxFrameBytes: number;

  /**
   * Frames assembled but not yet terminated by a newline, as a list of slices.
   *
   * A list rather than one growing buffer on purpose: concatenating on every chunk
   * is quadratic in the number of chunks for a large frame, and this is a path that
   * runs on every byte a firehose delivers. Concatenation happens exactly once, when
   * a frame is complete and about to be parsed anyway.
   */
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  /** True while discarding the tail of an oversized frame, up to the next newline. */
  private discarding = false;
  private discardingBytes = 0;

  private frames = 0;
  private accepted = 0;
  private rejected = 0;
  private oversized = 0;
  private empty = 0;
  private bytes = 0;

  constructor(options: TelemetryConsumerOptions) {
    this.onEvent = options.onEvent;
    this.onInvalid = options.onInvalid;
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  }

  /**
   * CONSUME A STREAM TO COMPLETION.
   *
   * Never rejects. If the stream itself faults, that is caught and turned into a
   * dropped frame plus the reason -- a consumer that rejects its promise on a
   * transport error hands the caller a choice between restarting a stream nobody
   * told it how to resume and dropping everything in flight.
   */
  async consume(stream: AsyncIterable<Uint8Array>): Promise<ConsumerStats> {
    try {
      for await (const chunk of stream) {
        this.absorb(chunk);
      }
      // A stream may legitimately end without a trailing newline -- a producer that
      // flushed once and exited. The tail is offered as a frame; if it is truncated
      // JSON it fails validation like anything else and is counted, so this costs
      // nothing and rescues the single-frame case.
      this.drainPending();
    } catch (error) {
      this.drop("not-json", this.pendingBytes, error instanceof Error ? error.name : "stream-fault");
      this.reset();
    }
    return this.stats();
  }

  /** Counters, for a snapshot without ending the stream. */
  stats(): ConsumerStats {
    return {
      frames: this.frames,
      accepted: this.accepted,
      rejected: this.rejected,
      oversized: this.oversized,
      empty: this.empty,
      bytes: this.bytes,
    };
  }

  private absorb(chunk: Uint8Array): void {
    this.bytes += chunk.length;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    let start = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] !== NEWLINE) continue;

      const slice = buffer.subarray(start, index);

      if (this.discarding) {
        // The newline ends the oversized frame we were throwing away. Counted once,
        // when it was detected -- not once per newline in the discarded run.
        this.discarding = false;
        this.discardingBytes = 0;
      } else if (slice.length > 0) {
        this.stage(slice);
        this.commit();
      } else {
        this.empty += 1;
      }
      start = index + 1;
    }

    const tail = buffer.subarray(start);
    if (tail.length > 0) {
      if (this.discarding) {
        this.discardingBytes += tail.length;
      } else {
        this.stage(tail);
        this.checkCeiling();
      }
    }
  }

  private stage(slice: Buffer): void {
    this.pending.push(slice);
    this.pendingBytes += slice.length;
  }

  /**
   * THE CEILING, CHECKED AS THE BYTES ARRIVE.
   *
   * Checked on accumulation rather than on commit, because by the time a frame is
   * complete it has already been allocated. This is the check that has to be early
   * to be any use at all.
   */
  private checkCeiling(): void {
    if (this.pendingBytes <= this.maxFrameBytes) return;
    this.oversized += 1;
    this.drop("oversized", this.pendingBytes, `over the ${this.maxFrameBytes} byte frame limit`);
    this.pending = [];
    this.pendingBytes = 0;
    this.discarding = true;
  }

  /** A trailing frame with no terminating newline, if there is one. */
  private drainPending(): void {
    if (this.discarding) {
      // The stream ended mid-oversized-frame. Nothing to resynchronise to.
      this.reset();
      return;
    }
    if (this.pendingBytes === 0) return;
    this.commit();
  }

  /** PARSE, VALIDATE, EMIT -- OR DROP. The only place a frame becomes an event. */
  private commit(): void {
    if (this.pendingBytes === 0) {
      this.reset();
      return;
    }

    /**
     * THE CEILING IS CHECKED HERE TOO, AND FOR A DIFFERENT REASON.
     *
     * `checkCeiling` bounds MEMORY while a frame is still arriving. This bounds what
     * gets PARSED, and it is what makes an over-limit frame report as `oversized`
     * rather than as `not-json` -- because a 4 KiB frame of ASCII is perfectly valid
     * input to `JSON.parse` that happens not to be JSON, and reporting it as a
     * transport fault would send an operator looking at the producer instead of at
     * the ceiling they set.
     *
     * No resynchronisation is needed here: a complete frame already ends at a
     * boundary, so there is nothing to discard to find the next one.
     */
    if (this.pendingBytes > this.maxFrameBytes) {
      const size = this.pendingBytes;
      this.oversized += 1;
      this.drop("oversized", size, `over the ${this.maxFrameBytes} byte frame limit`);
      this.reset();
      return;
    }

    const frame = this.pending.length === 1 ? this.pending[0]! : Buffer.concat(this.pending, this.pendingBytes);
    this.reset();

    // Trim a trailing CR so a CRLF producer is not treated as a malformed producer.
    const text = frame[frame.length - 1] === CARRIAGE_RETURN ? frame.subarray(0, frame.length - 1) : frame;
    // A whitespace-only frame is a keep-alive, not a malformed event. Counting it as
    // a rejection would make a producer's heartbeat look like a broken producer.
    if (text.toString("latin1").trim().length === 0) {
      this.empty += 1;
      return;
    }

    this.frames += 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text.toString("utf8"));
    } catch {
      // Undecodable bytes are a transport problem, not a schema problem, so they
      // get their own reason -- a reader debugging a broken producer needs to be
      // able to tell the two apart.
      this.drop("not-json", frame.length, "the frame is not UTF-8 JSON");
      return;
    }

    const verdict = validateUniversalTelemetryEvent(parsed);
    if (!verdict.ok) {
      this.rejected += 1;
      this.drop("invalid-event", frame.length, `${verdict.code}: ${verdict.reason}`);
      return;
    }

    try {
      this.onEvent(verdict.event);
      this.accepted += 1;
    } catch (error) {
      // The event was valid; the sink failed. Contained, because stopping here would
      // mean a bug in a downstream handler disables validation entirely for every
      // producer that follows it.
      this.drop("sink-threw", frame.length, error instanceof Error ? error.name : "sink-fault");
    }
  }

  private drop(reason: DropReason, bytes: number, detail?: string): void {
    this.onInvalid?.({ reason, bytes, ...(detail === undefined ? {} : { detail }) });
  }

  private reset(): void {
    this.pending = [];
    this.pendingBytes = 0;
    this.discarding = false;
    this.discardingBytes = 0;
  }
}

/**
 * THE PORTABLE CONSTRUCTOR.
 *
 * A consumer over an async iterable of bytes. Anything that can produce Kafka
 * records, a file read, or an in-memory fixture can be passed here unchanged, which
 * is the property that makes the validation testable without a broker and
 * unchangeable when one is added.
 */
export function createTelemetryConsumer(options: TelemetryConsumerOptions): TelemetryStreamConsumer {
  return new TelemetryStreamConsumer(options);
}

/**
 * THE SOURCE-AGNOSTIC BYTE SOURCE: an async generator over in-memory chunks.
 *
 * Present so a test -- and a replay tool -- can drive the exact consumer production
 * uses. It yields the chunks it is given without re-chunking, which is deliberate:
 * the point is to be able to hand the consumer an awkward split, like one record in
 * three pieces, and prove it reassembles.
 */
export async function* byteSource(chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}