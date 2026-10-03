/**
 * A THROUGHPUT READING, DERIVED FROM TWO OBSERVATIONS AND NEVER FROM ONE.
 *
 * === WHY THIS EXISTS AT ALL ===
 *
 * `LiveVerdict` carries `records`, which is a COUNT from one snapshot. A count
 * is not a rate: "257,000 records" and "257 records" are the same number of
 * words and say nothing about speed. A rate needs two instants and a numerator,
 * and nothing in the platform supplied either -- which is why every earlier
 * statement about throughput in this project was a guess, and why the UI refused
 * to print one.
 *
 * So the rate is measured here, from consecutive readings, at a place that
 * actually holds both instants: the server.
 *
 * === WHY THE WINDOW IS PUBLISHED ALONGSIDE THE RATE ===
 *
 * Because a rate without its window is not a measurement, it is a vibe. Sampled
 * over 40ms and sampled over 10s are both "events/sec" and can differ by orders
 * of magnitude around a burst. A UI that prints the rate and hides the window is
 * choosing to look authoritative while being uninterpretable, so the window
 * travels with every reading and the UI renders both.
 */
export interface ThroughputReading {
  /** Total records in the snapshot this reading was taken from. */
  readonly records: number;
  /** Records added since the previous reading. */
  readonly delta: number;
  /** Wall-clock milliseconds between the two observations. */
  readonly windowMs: number;
  /** `delta` scaled to one second. Rounded, because a fractional event is not a thing. */
  readonly eventsPerSecond: number;
}

/**
 * A ROLLING RATE over the last few samples.
 *
 * More than one sample because a single pair is dominated by whatever happened to
 * land inside that window: the very first reading after a gap between polls
 * reports the whole gap as a burst. Averaging a short window of recent pairs
 * makes the number steadier without making it sluggish, and -- the important
 * part -- makes it insensitive to one poll arriving late.
 *
 * Bounded, because this lives in a long-running server. An unbounded sample list
 * here would be a leak reachable by simply leaving the dashboard open.
 */
export class ThroughputMeter {
  readonly #window: number;
  #samples: { at: number; records: number }[] = [];
  #lastAt: number | null = null;
  #previous: ThroughputReading | null = null;

  /**
   * @param window How many recent samples to average over. Clamped to at least 2,
   *   because a one-sample average is just the single pair it holds.
   */
  constructor(window = 4) {
    this.#window = Math.max(2, Math.floor(window));
  }

  /**
   * Record an observation and return the current rate.
   *
   * Returns null on the FIRST sample, and that is not a gap in the data -- it is
   * the honest answer. One observation cannot produce a rate, and returning a
   * zero here would be indistinguishable from "the stream has stopped", which is
   * the opposite of the truth.
   */
  sample(records: number, at: number = Date.now()): ThroughputReading | null {
    this.#samples.push({ at, records });
    while (this.#samples.length > this.#window) this.#samples.shift();

    const previous = this.#samples[this.#samples.length - 2];
    if (previous === undefined) {
      this.#lastAt = at;
      return null;
    }

    const windowMs = at - previous.at;
    // A clock that went backwards, or two polls inside the same millisecond,
    // yields a zero or negative denominator. Refuse rather than divide.
    if (windowMs <= 0) return this.#previous;

    const delta = Math.max(0, records - previous.records);
    // A broker that TRUNCATES its window reports fewer records than before. The
    // count is not going backwards in reality, so the delta is clamped at zero
    // rather than reported as negative throughput.
    this.#lastAt = at;
    this.#previous = {
      records,
      delta,
      windowMs,
      eventsPerSecond: Math.round((delta * 1000) / windowMs),
    };
    return this.#previous;
  }

  /** The last reading, without observing. Null until two samples have been taken. */
  get current(): ThroughputReading | null {
    return this.#previous;
  }

  /** True once enough samples exist for the reading to mean anything. */
  get warm(): boolean {
    return this.#previous !== null;
  }

  /** How long ago the last observation was, or null if there has never been one. */
  get ageMs(): number | null {
    return this.#lastAt === null ? null : Date.now() - this.#lastAt;
  }
}