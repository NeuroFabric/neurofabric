import { PollPolicy, credentialStateOf, isCredentialFault, type CredentialState } from "./credential-state";
import type { LiveSnapshot } from "./live-contracts";

/**
 * THE POLLING LOOP, WITH NO REACT IN IT.
 *
 * === WHY THIS IS NOT A HOOK ===
 *
 * The decisions worth testing -- halt on a refusal, back off from the floor,
 * recover when a credential changes -- happen inside a timer callback, and timer
 * callbacks only run inside an effect, and effects only run inside a DOM. So as a
 * hook, "the floor is five seconds" would have been a comment, or a test needing
 * a DOM implementation this workspace deliberately does not install.
 *
 * Extracting the loop makes it arithmetic plus a scheduling decision, and both
 * are injectable. The test drives the timers by hand and asserts the exact delay
 * requested, without mounting anything.
 *
 * === TIMERS ARE INJECTED, NOT IMPORTED ===
 *
 * `setTimeout` and `clearTimeout` are constructor options defaulting to the
 * globals. That is the only way to assert "it asked for 5000ms, then 10000ms"
 * without a fake clock -- and a fake clock would have to be trusted to be as
 * correct as the loop it measures. Here the test sees the number the loop passed.
 */
export interface LiveSource {
  fetchLive(): Promise<LiveSnapshot>;
}

export const DEFAULT_POLL_MS = 500;

/** Everything the tree needs to render one frame of the live panel. */
export interface TelemetrySample {
  readonly snapshot: LiveSnapshot | null;
  readonly error: string | null;
  readonly loading: boolean;
  readonly state: CredentialState;
  readonly credentialRequired: boolean;
}

export type TelemetryListener = (sample: TelemetrySample) => void;

export interface TelemetryPollerOptions {
  readonly source: LiveSource;
  readonly intervalMs?: number;
  /** Injected so a test can assert the exact schedule. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

const IDLE: TelemetrySample = { snapshot: null, error: null, loading: true, state: "ok", credentialRequired: false };

export class TelemetryPoller {
  #source: LiveSource;
  #intervalMs: number;
  readonly #policy = new PollPolicy();
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;

  #sample: TelemetrySample = IDLE;
  readonly #listeners = new Set<TelemetryListener>();
  #timer: unknown;
  #inFlight = false;
  #running = false;

  constructor(options: TelemetryPollerOptions) {
    this.#source = options.source;
    this.#intervalMs = options.intervalMs ?? DEFAULT_POLL_MS;
    this.#setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** The current frame. A replaced object, so a render is never a mutation. */
  get sample(): TelemetrySample {
    return this.#sample;
  }

  /** Whether polling has stopped pending a credential change. */
  get halted(): boolean {
    return this.#policy.halted;
  }

  subscribe(listener: TelemetryListener): () => void {
    this.#listeners.add(listener);
    // Immediately, so a subscriber never renders a frame of stale state.
    listener(this.#sample);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  start(): void {
    this.#running = true;
    void this.#poll();
  }

  /**
   * Stop, without throwing if already stopped.
   *
   * React's `StrictMode` mounts, unmounts and remounts every effect in
   * development, and a `stop` that threw on an already-stopped poller would turn
   * that correctness check into a crash on the second render.
   *
   * The in-flight request is NOT cancelled. A response arriving after a stop is
   * discarded by the `#running` check, and cancelling would mean threading an
   * abort handle through the interface for no benefit: the timeout already lives
   * in the client.
   */
  stop(): void {
    this.#running = false;
    this.#disarm();
  }

  /**
   * A NEW CREDENTIAL. The one event that clears a halt.
   *
   * Resumed BEFORE the first read, not after it. A poller that had stopped
   * asking must not spend one more cycle still stopped, waiting for permission
   * from the very request that was refused.
   */
  configure(next: { readonly source: LiveSource; readonly intervalMs?: number }): void {
    this.#source = next.source;
    if (next.intervalMs !== undefined) this.#intervalMs = next.intervalMs;
    this.#policy.resume();
    this.#disarm();
    if (this.#running) void this.#poll();
  }

  #emit(patch: Partial<TelemetrySample>): void {
    this.#sample = { ...this.#sample, ...patch };
    for (const listener of this.#listeners) listener(this.#sample);
  }

  /**
   * One read, then whatever the policy says comes next.
   *
   * The in-flight guard SKIPS rather than queues. A request slower than the
   * healthy interval must not accumulate: the cost is a slightly stale reading,
   * and the alternative is an unbounded pile-up of held responses.
   */
  async #poll(): Promise<void> {
    if (!this.#running || this.#inFlight) return;
    this.#inFlight = true;
    try {
      const next = await this.#source.fetchLive();
      if (!this.#running) return;
      this.#policy.succeed();
      this.#emit({ snapshot: next, error: null, loading: false, state: "ok", credentialRequired: false });
      this.#schedule(this.#intervalMs);
    } catch (cause) {
      if (!this.#running) return;
      const state = credentialStateOf(cause);
      // The previous snapshot is KEPT. Losing the last good reading because one
      // poll failed turns a blip into a blank panel.
      this.#emit({
        error: cause instanceof Error ? cause.message : String(cause),
        loading: false,
        state,
        credentialRequired: isCredentialFault(state),
      });
      const delay = this.#policy.fail(state);
      // `null` means a credential refusal, and nothing is scheduled at all. A
      // refused credential is refused on the next request too, so a timer here
      // would only produce failures nobody asked for and nobody can act on.
      if (delay !== null) this.#schedule(delay);
    } finally {
      this.#inFlight = false;
    }
  }

  #schedule(ms: number): void {
    this.#disarm();
    this.#timer = this.#setTimer(() => void this.#poll(), ms);
  }

  /**
   * Drop any pending timer.
   *
   * Guarded rather than unconditional because `stop` runs on an unmount that may
   * never have scheduled anything, and handing `undefined` to a `clearTimeout` is
   * safe in the platform and a crash in a test double. One guard here rather
   * than a caveat in three places.
   */
  #disarm(): void {
    if (this.#timer === undefined) return;
    this.#clearTimer(this.#timer);
    this.#timer = undefined;
  }
}