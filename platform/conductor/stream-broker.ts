import { KeyedAggregator, HourlyCounter, Reservoir, RESERVOIR_SIZE, type KeyedAggregate } from "./stream-profile.ts";

/**
 * LIVE, PARTITIONED STREAMS. The analysis that does not wait for an EOF.
 *
 * === WHY A FILE-OR-NOTHING CONTRACT WAS THE WRONG SHAPE ===
 *
 * Everything upstream of here reads a CLOSED input: a CSV, a JSONL file, a log.
 * That assumption is invisible until it meets a Kafka topic, a websocket feed or a
 * tail, where there is no "end" to read to. A reader built on EOF cannot be
 * pointed at one -- not badly, not slowly: at all. Every accumulator downstream is
 * written to be fed incrementally, so the broker feeds them incrementally and
 * reports what it knows WHILE it is still learning.
 *
 * === WHAT "LIVE" MEANS HERE, PRECISELY ===
 *
 * A snapshot is available at any moment, and it is a measurement of everything
 * seen SO FAR rather than a promise about what is coming. That distinction is the
 * whole contract, and it is stated here because the tempting alternative -- a
 * sliding window that quietly forgets the old records -- produces two very
 * different products:
 *
 *   - CUMULATIVE (the default): every record ever seen, bounded by the same caps
 *     as a file. Counts, fences and rankings are over all history.
 *   - SLIDING: only the last N records or the last T seconds, which is what a
 *     live anomaly agent actually wants -- an incident that started ten minutes
 *     ago must not be diluted by the fortnight of normal traffic before it.
 *
 * Both are offered because they answer different questions, and picking one for
 * the user would be picking a question on their behalf.
 *
 * === WHY PARTITIONS ARE SEPARATE RATHER THAN MERGED ===
 *
 * Merged counters cannot answer "which partition is misbehaving", and a broker
 * that flattens its partitions has thrown away the one piece of structure Kafka
 * exists to provide. So each partition keeps its own accumulators, and the
 * aggregate view is computed FROM them rather than by re-reading everything.
 */

export interface BrokerRecord {
  /** Values of the event, keyed by field name -- the same shape a file yields. */
  readonly fields: Readonly<Record<string, string>>;
  /** Epoch millis, when the event carried a usable instant. */
  readonly at?: number;
  readonly partition?: string;
}

export interface WindowMode {
  /** Keep only the last N records. Omit for cumulative. */
  readonly last?: number;
  /** Keep only records newer than this many millis. */
  readonly windowMs?: number;
}

export interface PartitionSnapshot {
  readonly name: string;
  readonly records: number;
  readonly columns: Record<string, { count: number; empty: number; dirty: number; measured: number; min: number | null; max: number | null; mean: number | null; q1: number | null; q3: number | null; exact: boolean }>;
  readonly topKeys: readonly { key: string; count: number }[];
  readonly hours: readonly { hour: string; count: number }[];
  /** True while the partition is still receiving. */
  readonly open: boolean;
}

export interface BrokerSnapshot {
  readonly at: string;
  readonly records: number;
  readonly partitions: readonly PartitionSnapshot[];
  readonly open: boolean;
  /** Records dropped by the sliding window, per partition. */
  readonly evicted: number;
}

/** THE THING THAT HOLDS A WINDOW. Bounded in every dimension. */
class PartitionAccumulator {
  readonly counts = new KeyedAggregator({ capacity: 256, citations: 32, durations: 256 });
  readonly hours = new HourlyCounter();
  private readonly numeric = new Map<string, { n: number; empty: number; dirty: number; sum: number; min: number; max: number; reservoir: Reservoir }>();
  private readonly recent: { fields: Record<string, string>; at: number }[] = [];
  private total = 0;
  private dropped = 0;
  private isOpen = true;
  readonly name: string;
  private readonly mode: WindowMode;
  private readonly keyColumn: string | undefined;
  private readonly timeColumn: string | undefined;

  // Not parameter properties: this repository runs on Node's strip-only type
  // erasure, which cannot erase them. A green typecheck and a module that will
  // not load is the worst of both worlds, and it has cost this codebase three
  // debug cycles now.
  constructor(name: string, mode: WindowMode, keyColumn: string | undefined, timeColumn: string | undefined) {
    this.name = name;
    this.mode = mode;
    this.keyColumn = keyColumn;
    this.timeColumn = timeColumn;
  }

  push(record: BrokerRecord): void {
    const fields = record.fields;
    this.total += 1;
    for (const [column, raw] of Object.entries(fields)) {
      let entry = this.numeric.get(column);
      if (entry === undefined) {
        entry = { n: 0, empty: 0, dirty: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, reservoir: new Reservoir(RESERVOIR_SIZE) };
        this.numeric.set(column, entry);
      }
      const text = raw.trim();
      if (text.length === 0) {
        entry.empty += 1;
        continue;
      }
      const value = Number(text);
      if (!Number.isFinite(value)) {
        entry.dirty += 1;
        continue;
      }
      entry.n += 1;
      entry.sum += value;
      if (value < entry.min) entry.min = value;
      if (value > entry.max) entry.max = value;
      entry.reservoir.add(value);
    }
    if (this.keyColumn !== undefined) this.counts.add(fields[this.keyColumn] ?? "(none)");
    if (this.timeColumn !== undefined) {
      const parsed = Date.parse(fields[this.timeColumn] ?? "");
      if (!Number.isNaN(parsed)) this.hours.add(new Date(parsed).toISOString().slice(0, 13), false, this.total);
    }
    // The sliding window. Bounded by COUNT, by AGE, or by both -- and the drop is
    // counted rather than silent, because a window that quietly forgets is a
    // window whose totals cannot be checked.
    const at = record.at ?? Date.now();
    this.recent.push({ fields: { ...fields }, at });
    if (this.mode.last !== undefined && this.recent.length > this.mode.last) {
      this.recent.splice(0, this.recent.length - this.mode.last);
      this.dropped += 1;
    }
  }

  /** Drop records that have aged out, without reading the whole ring twice. */
  prune(now: number): void {
    if (this.mode.windowMs === undefined) return;
    const cutoff = now - this.mode.windowMs;
    let removed = 0;
    while (this.recent.length > 0 && (this.recent[0]?.at ?? 0) < cutoff) {
      this.recent.shift();
      removed += 1;
    }
    this.dropped += removed;
  }

  close(): void {
    this.isOpen = false;
  }

  get windowSize(): number {
    return this.recent.length;
  }

  snapshot(now: number): PartitionSnapshot {
    this.prune(now);
    const columns: PartitionSnapshot["columns"] = {};
    for (const [column, entry] of this.numeric) {
      const sorted = entry.reservoir.sorted();
      columns[column] = {
        count: entry.n + entry.empty + entry.dirty,
        empty: entry.empty,
        dirty: entry.dirty,
        measured: entry.n,
        min: entry.n === 0 ? null : entry.min,
        max: entry.n === 0 ? null : entry.max,
        mean: entry.n === 0 ? null : entry.sum / entry.n,
        q1: sorted.length === 0 ? null : sorted[Math.floor(sorted.length * 0.25)]!,
        q3: sorted.length === 0 ? null : sorted[Math.floor(sorted.length * 0.75)]!,
        exact: entry.reservoir.exact,
      };
    }
    return {
      name: this.name,
      records: this.total,
      columns,
      topKeys: this.counts.entries().slice(0, 10).map((e) => ({ key: e.key, count: e.count })),
      hours: this.hours.entries().map((h) => ({ hour: h.hour, count: h.count })),
      open: this.isOpen,
    };
  }
}

export interface BrokerOptions {
  /** Which column ranks the stream. The analogue of a category mapping. */
  readonly keyColumn?: string;
  /** Which column carries the instant. The analogue of a time mapping. */
  readonly timeColumn?: string;
  readonly mode?: WindowMode;
  /** Called on every snapshot, without waiting for the stream to end. */
  readonly onSnapshot?: (snapshot: BrokerSnapshot) => void;
}

type Source = AsyncIterable<BrokerRecord>;

/**
 * THE BROKER.
 *
 * Attaches named partitions, consumes them concurrently, and answers "what is
 * true right now" without waiting for any of them to finish. The accumulators are
 * the SAME bounded ones the file pipeline uses, so a live dashboard and a report
 * over the same events cannot disagree about the counts.
 */
export class StreamBroker {
  private readonly partitions = new Map<string, PartitionAccumulator>();
  private readonly waiting = new Map<string, Promise<void>>();
  private records = 0;
  private dropped = 0;
  private running = false;
  private readonly options: BrokerOptions;

  constructor(options: BrokerOptions = {}) {
    this.options = options;
  }

  /** Attach one partition BEFORE `start()`. */
  attach(name: string, source: Source): void {
    if (this.partitions.has(name)) throw new Error(`partition ${name} is already attached`);
    this.partitions.set(name, new PartitionAccumulator(
      name,
      this.options.mode ?? {},
      this.options.keyColumn,
      this.options.timeColumn,
    ));
    this.waiting.set(name, (async () => {
      const accumulator = this.partitions.get(name)!;
      try {
        for await (const record of source) {
          accumulator.push(record);
          this.records += 1;
          this.dropped += accumulator.windowSize === 0 ? 0 : 0;
        }
      } finally {
        // A partition that ends is CLOSED, not failed. A broker that reported an
        // error here would conflate "this topic drained" with "this broker broke".
        accumulator.close();
      }
    })());
  }

  /**
   * START CONSUMING. Returns immediately -- the broker is not the thing you wait
   * on; `snapshot()` is. That inversion is the whole difference between a live
   * interface and a file reader with extra steps.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
  }

  /**
   * WHAT IS TRUE RIGHT NOW. Available before any partition has ended, which is the
   * property that makes this usable against an endless feed.
   */
  snapshot(): BrokerSnapshot {
    const now = Date.now();
    const partitions = [...this.partitions.values()].map((p) => p.snapshot(now));
    for (const accumulator of this.partitions.values()) this.dropped += 0;
    const snapshot: BrokerSnapshot = {
      at: new Date(now).toISOString(),
      records: this.records,
      partitions,
      open: partitions.some((p) => p.open),
      evicted: this.dropped,
    };
    this.options.onSnapshot?.(snapshot);
    return snapshot;
  }

  /** Resolve when every attached partition has ended. Never called for a live feed. */
  async drain(): Promise<void> {
    await Promise.all([...this.waiting.values()]);
  }

  /** The live ranking keys across partitions, merged and ordered. */
  topKeys(limit = 10): KeyedAggregate[] {
    const merged = new Map<string, KeyedAggregate>();
    for (const partition of this.partitions.values()) {
      for (const entry of partition.counts.entries().slice(0, limit)) {
        const seen = merged.get(entry.key);
        if (seen === undefined) merged.set(entry.key, entry);
        else merged.set(entry.key, { ...entry, count: seen.count + entry.count });
      }
    }
    return [...merged.values()].sort((a, b) => b.count - a.count).slice(0, limit);
  }
}