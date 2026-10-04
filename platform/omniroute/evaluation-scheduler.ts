/**
 * THE EVALUATION LOOP, OWNED BY THE DEPLOYMENT.
 *
 * === WHAT THIS REPLACES ===
 *
 * The live read route used to call `gateway.evaluate()` itself, inside the
 * request handler. The consequence was stated at that call site rather than left
 * to be discovered: **an alert was raised when somebody asked how the stream was
 * doing.** A deployment with no dashboard open raised no alerts, which is honest
 * and wrong for a monitoring product at the same time.
 *
 * So evaluation moved here. The route now only reports what it can read. What is
 * being decided, and how often, is a property of the deployment rather than of
 * who is looking.
 *
 * === WHY A TIMER AND NOT A WORKER THREAD ===
 *
 * A worker cannot help here, and choosing it would cost the feature. `evaluate()`
 * reads state this process owns and cannot give up: the brokers are in-memory
 * accumulators, and `announced` is the set that makes a persisting breach ONE
 * incident instead of ten thousand alerts. A worker would need every event
 * re-fed across a message port and a second copy of that state, which turns one
 * scheduled call into a distributed system with a consistency problem attached.
 * The blocking cost that makes isolation attractive -- the synchronous
 * `node:sqlite` write the record makes on a first observation -- is paid once per
 * breach rather than once per tick, because the alert policy already refuses to
 * write anything for a healthy reading.
 *
 * === WHY THE INTERVAL IS `unref`'D, AND THIS IS NOT A DETAIL ===
 *
 * A timer in the server factory was tried here before and removed: it became a
 * handle outliving the object that owns it in every test that builds a server,
 * and this repository was hung by exactly that shape. So this module does three
 * things that shape requires, and each is tested.
 *
 *   1. The timer is `unref`'d, so it can never be the reason a process stays up.
 *      A scheduler that keeps a finished test alive is worse than no scheduler.
 *   2. Nothing is constructed until `start()`, and `start()` is not called
 *      implicitly by any constructor or route. There is no path to a live timer
 *      that did not ask for one.
 *   3. The interval function is a parameter, so a test drives the clock by hand
 *      and never owns wall time.
 *
 * === WHY A TICK NEVER THROWS ===
 *
 * The loop is the thing that notices a breach. A loop that dies on the first
 * database lock is a monitor that is silently dead, and that is worse than one
 * that never started, because it looks healthy while it misses every breach. So
 * every failure -- a provider that throws, or a provider list that throws --
 * is caught, counted, reported through `onError`, and the next tick happens
 * anyway. Counting them matters as much as swallowing them: a failure the
 * operator cannot see is a failure that gets diagnosed as "alerts are
 * unreliable", which is a wrong answer rather than no answer.
 */

/** The part of the gateway this loop needs. Narrow on purpose. */
export interface EvaluableGateway {
  /** Judge now and alert on anything new. Synchronous, and blocking on a breach. */
  evaluate(provider?: string): unknown;
}

/** Where a failure happened, so a log line names the thing that failed. */
export interface EvaluationFailure {
  /** The provider being evaluated, or undefined if the list itself threw. */
  readonly provider: string | undefined;
  /** Epoch millis of the failure. */
  readonly at: number;
  readonly reason: string;
}

export interface EvaluationSchedulerOptions {
  readonly gateway: EvaluableGateway;
  /**
   * The providers to evaluate, resolved ON EACH TICK.
   *
   * A function, not an array, because a gateway is routinely wired after the
   * scheduler is built. Resolving once at construction is how a scheduler
   * quietly evaluates nothing: it captured an empty list at the wrong moment and
   * reports a healthy zero breaches for the life of the process.
   */
  readonly providers: () => readonly string[];
  /** Millis between ticks. */
  readonly intervalMs?: number;
  /** Told about every failure. A scheduler that swallows them silently is a lie. */
  readonly onError?: (error: unknown, context: { readonly provider: string | undefined }) => void;
  /** The clock. A parameter so tests drive time by hand instead of owning it. */
  readonly setIntervalFn?: (fn: () => void, ms: number) => EvaluationTimer;
  readonly clearIntervalFn?: (handle: EvaluationTimer) => void;
}

export interface EvaluationTimer {
  unref?(): void;
  ref?(): void;
}

export interface EvaluationStats {
  /** Ticks that ran to completion. A tick that was skipped does not count. */
  readonly ticks: number;
  /** Providers evaluated, across all ticks. */
  readonly evaluations: number;
  /** Failures caught. Non-zero means the loop is degraded, not dead. */
  readonly failures: number;
  /** Failures this scheduler refused to let stop it. */
  readonly lastFailureAt: number | undefined;
  /** Whether the loop is currently armed. */
  readonly running: boolean;
}

export interface EvaluationScheduler {
  /** Arm the loop. Calling it twice does not arm a second loop. */
  start(): void;
  /** Disarm and release the handle. Safe to call when never started. */
  stop(): void;
  /** Run one tick now, synchronously. Used by `start` and available to a test. */
  tick(): void;
  /** What the loop has done, and what it could not do. */
  stats(): EvaluationStats;
  /** Every failure, oldest first, so a degraded loop can be diagnosed after the fact. */
  failures(): readonly EvaluationFailure[];
}

const DEFAULT_INTERVAL_MS = 5_000;

export function createEvaluationScheduler(
  options: EvaluationSchedulerOptions,
): EvaluationScheduler {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const setIntervalFn =
    options.setIntervalFn ??
    ((fn: () => void, ms: number) =>
      setInterval(fn, ms) as unknown as EvaluationTimer);
  const clearIntervalFn =
    options.clearIntervalFn ??
    ((handle: EvaluationTimer) => clearInterval(handle as unknown as ReturnType<typeof setInterval>));

  let timer: EvaluationTimer | undefined;
  /**
   * Re-entry guard, and the reason it is here rather than left to the interval.
   *
   * `evaluate` blocks the event loop when it persists a breach, because
   * `node:sqlite` is synchronous. A blocking tick that outruns the interval
   * would otherwise queue behind itself, and a scheduler that evaluates five
   * times because the fifth had not finished is not more reliable -- it is
   * amplifying the exact load that made it slow.
   */
  let inFlight = false;
  let ticks = 0;
  let evaluations = 0;
  let lastFailureAt: number | undefined;
  const failures: EvaluationFailure[] = [];

  const report = (error: unknown, provider: string | undefined): void => {
    const reason = error instanceof Error ? error.message : String(error);
    failures.push({ provider, at: Date.now(), reason });
    lastFailureAt = Date.now();
    if (options.onError !== undefined) {
      try {
        options.onError(error, { provider });
      } catch {
        /**
         * A REPORTER THAT THROWS MUST NOT BECOME A DEAD LOOP.
         *
         * The reporter is usually a log line, and a log line that fails is rare
         * enough to be tempting to leave unhandled. It is wrapped anyway: this
         * is the one place where an exception escaping is unrecoverable, because
         * every other failure here is contained by design and this one would sit
         * above all of them.
         */
      }
    }
  };

  const tick = (): void => {
    if (inFlight) return;
    inFlight = true;
    try {
      const providers = options.providers();
      for (const provider of providers) {
        try {
          options.gateway.evaluate(provider);
          evaluations += 1;
        } catch (error) {
          report(error, provider);
        }
      }
      ticks += 1;
    } catch (error) {
      // The LIST failed, so no provider was reached this tick. Counted, not
      // swallowed silently: a resolver that throws every tick is a wiring fault.
      report(error, undefined);
    } finally {
      inFlight = false;
    }
  };

  return {
    start(): void {
      if (timer !== undefined) return;
      timer = setIntervalFn(tick, intervalMs);
      // The single line that makes this safe to construct anywhere. See the note
      // at the top of this file: this shape has hung this repository before.
      timer.unref?.();
    },
    stop(): void {
      if (timer === undefined) return;
      clearIntervalFn(timer);
      timer = undefined;
    },
    tick,
    stats(): EvaluationStats {
      return {
        ticks,
        evaluations,
        failures: failures.length,
        lastFailureAt,
        running: timer !== undefined,
      };
    },
    failures: () => [...failures],
  };
}