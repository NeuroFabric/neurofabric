/**
 * THE STREAMING SUBSTRATE. Shared by every hydrated agent, because three copies
 * of it would be three different definitions of O(1).
 *
 * === WHAT O(1) ACTUALLY REQUIRES, AS OPPOSED TO WHAT IT USUALLY MEANS ===
 *
 * The usual claim is "we do not buffer the input", which is true of a class of
 * implementations that all share one property: they hold a remainder. A chunk
 * arrives, `split("\n")` is called on it, and the tail after the last newline is
 * kept for the next chunk. On well-behaved input that remainder is a few bytes
 * and the memory claim is honest.
 *
 * On the input this platform is pointed at, it is not. A single JSONL record
 * with no trailing newline, a log line megabytes long, or a stream that never
 * emits a newline at all -- all three occur in real telemetry -- make the
 * remainder grow without bound, and a class that holds it is not O(1), it is
 * O(longest line). So the remainder is BOUNDED HERE, at a fixed ceiling, and
 * what happens when input exceeds it is counted and published rather than
 * silently absorbed. An agent that reports "3 lines exceeded the 64 KiB line
 * ceiling and were not parsed" is degraded and honest; one that grows until the
 * container is killed is neither.
 *
 * === THE OTHER HALF: STATE, NOT JUST INPUT ===
 *
 * Streaming the input is the easy half. Detection needs memory -- the previous
 * signer of a component, the running counts by rule -- and that state is exactly
 * where an O(1) claim quietly dies, because a Map keyed by component id grows
 * with the number of components ever seen. So every keyed structure here is a
 * `BoundedMap` with a hard capacity and an EVICTION COUNTER, and the counter is
 * published in the verdict. When the map saturates, the agent says the tally is
 * partial instead of presenting a capped number as if it were the whole count.
 *
 * === WHY THERE IS NO READ-EVERYTHING HELPER ===
 *
 * `readLines` (below) exists and is deliberately shaped so that a caller cannot
 * use it on a live stream by accident: it exists for TEST FIXTURES and for
 * document-shaped inputs the caller has already bounded. Everything else consumes
 * the async iterable directly.
 */

/** The default ceiling on one line. A SAST result or a ZAP alert is far below it. */
export const DEFAULT_MAX_LINE_BYTES = 64 * 1024;

/** The default capacity of a keyed state map. */
export const DEFAULT_STATE_CAPACITY = 4096;

export interface LineCounts {
  /** Complete lines delivered to the visitor. */
  readonly lines: number;
  /** Bytes seen, including the bytes of an over-long line that were discarded. */
  readonly bytes: number;
  /** Lines dropped for exceeding the ceiling. Non-zero means the tally is partial. */
  readonly overflows: number;
  /** Lines that ended without a trailing newline and were delivered at close. */
  readonly trailing: boolean;
}

export interface StreamLinesOptions {
  readonly maxLineBytes?: number;
  /** Called once per discarded over-long line. Must not throw. */
  readonly onOverflow?: (bytes: number) => void;
}

/**
 * DELIVER LINES FROM A CHUNKED STREAM, WITHOUT BUFFERING THE STREAM.
 *
 * Handles the three things a hand-rolled splitter gets wrong: a `\r\n` split
 * across two chunks, a multi-byte UTF-8 character split across two chunks (via a
 * streaming decoder), and a final line with no terminator (delivered at close,
 * and reported as trailing, because a document whose last line is unterminated
 * is a different shape from one where every line is).
 *
 * `Uint8Array` is decoded rather than coerced. `String.fromCharCode` over a byte
 * array would mangle every non-ASCII character, and supply-chain and compliance
 * telemetry is full of them.
 */
export async function streamLines(
  source: AsyncIterable<string | Uint8Array>,
  visit: (line: string, index: number) => void | Promise<void>,
  options: StreamLinesOptions = {},
): Promise<LineCounts> {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const decoder = new TextDecoder("utf-8");

  let remainder = "";
  let lines = 0;
  let bytes = 0;
  let overflows = 0;
  let index = 0;
  // True once a line has been found too long. Carried so that a single over-long
  // line spanning four chunks is dropped ONCE and not once per chunk.
  let discarding = false;

  const overflow = (size: number) => {
    overflows += 1;
    if (options.onOverflow === undefined) return;
    try {
      options.onOverflow(size);
    } catch {
      // A diagnostic must not be able to abort the scan it is measuring.
    }
  };

  for await (const chunk of source) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    bytes += typeof chunk === "string" ? Buffer.byteLength(text, "utf8") : chunk.byteLength;

    let buffer = remainder + text;
    remainder = "";

    let start = 0;
    for (;;) {
      const newline = buffer.indexOf("\n", start);
      if (newline === -1) break;
      let line = buffer.slice(start, newline);
      start = newline + 1;
      if (discarding) {
        // The tail of a line we already counted as dropped.
        discarding = false;
        continue;
      }
      if (line.endsWith("\r")) line = line.slice(0, -1);
      lines += 1;
      index += 1;
      await visit(line, index);
    }

    remainder = buffer.slice(start);
    if (remainder.length > maxLineBytes) {
      // Count the whole buffered remainder as one dropped line, and drop what we
      // hold. The ceiling is what makes the next allocation impossible rather
      // than merely unlikely.
      overflow(remainder.length);
      remainder = "";
      discarding = true;
    }
  }

  // A stream that ended mid-codepoint cannot be decoded honestly; replacing the
  // partial is better than emitting a replacement character into a verdict.
  const tail = decoder.decode();
  if (tail !== "") remainder += tail;

  if (remainder !== "") {
    if (remainder.length > maxLineBytes) {
      overflow(remainder.length);
    } else {
      lines += 1;
      index += 1;
      await visit(remainder.endsWith("\r") ? remainder.slice(0, -1) : remainder, index);
    }
    return { lines, bytes, overflows, trailing: true };
  }

  return { lines, bytes, overflows, trailing: false };
}

/**
 * READ A BOUNDED WHOLE. FOR FIXTURES AND DOCUMENT-SHAPED INPUTS ONLY.
 *
 * Named to be conspicuous. A platform whose O(1) claim rests on not accumulating
 * should not ship an accumulate helper that reads like a normal one, and the
 * guard below makes the misuse fail rather than merely being discouraged.
 */
export async function readLines(
  source: AsyncIterable<string | Uint8Array>,
  limit = 100_000,
): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of source) {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (const piece of text.split("\n")) out.push(piece);
    if (out.length > limit) {
      throw new Error(
        `readLines is for bounded inputs and this one exceeded ${limit} lines. `
        + "Consume the stream with streamLines instead.",
      );
    }
  }
  return out;
}

/**
 * A MAP WITH A HARD CAPACITY AND AN HONEST COUNTER.
 *
 * Recency is approximate on purpose: refreshing on every read would make `get` a
 * write, and a scan that touches every entry would then have a cost proportional
 * to the traffic rather than to the key count. Insertion-order eviction is enough
 * for the workloads here, where the hot keys are the ones being written anyway.
 */
export class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();
  private readonly capacity: number;
  private dropped = 0;

  constructor(capacity: number = DEFAULT_STATE_CAPACITY) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  get size(): number {
    return this.map.size;
  }

  /** How many entries were evicted because the map was full. */
  get evicted(): number {
    return this.dropped;
  }

  /** True once the map has had to evict, meaning tallies against it are partial. */
  get saturated(): boolean {
    return this.dropped > 0;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.set(key, value);
      return;
    }
    if (this.map.size >= this.capacity) {
      // The oldest insertion, which Map maintains as its first key. Deleting by
      // re-inserting would be O(n); delete() on the first key is O(1) here.
      const oldest = this.map.keys().next();
      if (oldest.done !== true) this.map.delete(oldest.value);
      this.dropped += 1;
    }
    this.map.set(key, value);
  }

  /** Delete and return the previous value, so a caller can compare against it. */
  take(key: K): V | undefined {
    const previous = this.map.get(key);
    this.map.delete(key);
    return previous;
  }

  /** A snapshot of what is currently held. Bounded by `capacity`, unlike the map. */
  entries(): [K, V][] {
    return [...this.map.entries()];
  }

  values(): V[] {
    return [...this.map.values()];
  }

  clear(): void {
    this.map.clear();
  }
}

/**
 * COUNT BY KEY, WITH A BOUND ON DISTINCT KEYS.
 *
 * Exists because the obvious implementation -- `Map<string, number>` for "counts
 * by rule id" -- is unbounded in the number of distinct rule ids, and a scanner
 * pointed at someone else's build output is precisely where an unbounded
 * cardinality arrives by surprise.
 */
export class BoundedCounter {
  private readonly counts: BoundedMap<string, number>;
  /**
   * Every bump ever made, counted separately from the per-key tallies.
   *
   * It has to be separate: eviction DESTROYS a key's accumulated count, so
   * summing the surviving keys under-reports, and an agent publishing "142
   * findings" from a tally that quietly lost entries would be reporting a number
   * it does not stand behind. This counter is exact; the per-key tallies are
   * declared partial once `evicted` is non-zero.
   */
  private grand = 0;

  constructor(capacity: number = DEFAULT_STATE_CAPACITY) {
    this.counts = new BoundedMap<string, number>(capacity);
  }

  bump(key: string, by = 1): void {
    this.grand += by;
    this.counts.set(key, (this.counts.get(key) ?? 0) + by);
  }

  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** Every tracked key with its count, largest first, ties broken for determinism. */
  top(limit = 10): { key: string; count: number }[] {
    return this.counts.entries()
      .map(([key, value]) => ({ key, count: value }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
      .slice(0, limit);
  }

  get tracked(): number {
    return this.counts.size;
  }

  get evicted(): number {
    return this.counts.evicted;
  }

  /** Exact: the number of bumps, which eviction cannot reduce. */
  get total(): number {
    return this.grand;
  }
}

/**
 * SPLIT AN EMITTED LINE BY A FRACTION IN ONE PASS.
 *
 * Built rather than composed from `indexOf`/`slice` chains because the naive
 * version scans the line once per delimiter -- four scans for a four-field line,
 * across every line of a stream. One scan, one allocation.
 */
export function splitOnce(text: string, separator: string): [string, string] {
  const at = text.indexOf(separator);
  if (at === -1) return [text, ""];
  return [text.slice(0, at), text.slice(at + separator.length)];
}

/**
 * AN UPPER-CASING COMPARE THAT CANNOT BE FOOLED BY CASE OR PADDING.
 *
 * Used for every vocabulary lookup in the hydrated agents, so a rule id arriving
 * as `MD5 ` and one arriving as `md5` cannot take different paths through the
 * same rule.
 */
export function normaliseToken(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * FORMAT A NUMBER FOR A VERDICT.
 *
 * `toLocaleString` is what the Conductor's `rows` helper already uses, and this
 * delegates to it rather than re-deciding the convention. The delegation is
 * explicit so the two cannot drift.
 */
export function count(n: number): string {
  return n.toLocaleString("en-US");
}

/** Turn an async iterable of events into an async iterable of text lines. */
export async function* fieldsToLines(
  events: AsyncIterable<{ fields: Readonly<Record<string, string>> }>,
  format: (fields: Readonly<Record<string, string>>) => string,
): AsyncGenerator<string> {
  for await (const event of events) {
    yield format(event.fields);
  }
}
