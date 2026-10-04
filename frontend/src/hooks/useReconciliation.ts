import { useCallback, useEffect, useRef, useState } from "react";

import type { ReconciliationDiff } from "../api/memory-contracts";

/**
 * THE DIFF, AS REACT SEES IT.
 *
 * === WHY THIS HOOK IS NOT THE LIVE POLLER, REWRITTEN SLOWER ===
 *
 * Because the two answer different questions and a reader treats them
 * differently.
 *
 * `useLiveTelemetry` polls at 500 ms because a rate is a number that goes stale
 * while you look at it; the whole point of the live panel is that it is not a
 * snapshot. **The diff is a comparison, and a comparison does not become truer
 * faster.** Half of it is a moving window, so it does change -- but at 500 ms it
 * changes faster than a person can read, which produces three failures that all
 * look like one:
 *
 *  1. **Jitter.** A row's text rewrites twice a second. Reading requires the
 *     text to hold still long enough to finish a sentence.
 *  2. **Acknowledgement that appears to bounce.** The operator presses a button,
 *     the acknowledgement lands, and the next tick re-renders the list with the
 *     row in a different position -- which reads as "did that work?"
 *  3. **A load nobody asked for.** A synchronous SQLite read per poll, per
 *     operator, against a panel almost nobody has open.
 *
 * So this has its own, much slower cadence, and the cadence is a CONSTANT with a
 * name rather than a number typed at a call site -- `DIFF_POLL_MS` is the thing a
 * reviewer argues with.
 *
 * === 5 SECONDS IS A JUDGEMENT AND HERE IS THE ARITHMETIC ===
 *
 * The fastest thing the diff can usefully report is a difference appearing or
 * disappearing as the live window fills, and nothing in it is worth acting on
 * inside five seconds: the differences are already labelled with what to do, and
 * the actions are migrations, schema edits and decisions about provenance. Twelve
 * reads a minute is well inside what a person can absorb from one panel, and it
 * keeps the endpoint cheap enough to leave on.
 *
 * Below about 2 seconds it becomes a live panel wearing a record panel's header,
 * which is the confusion ADR-005 §9 is about. Above ~30 seconds a returning
 * operator sees a comparison that has visibly stopped tracking. Five seconds is
 * the wide part of that valley.
 *
 * === AND A MANUAL REFRESH, BECAUSE A LOOP CANNOT BE THE ONLY WAY ===
 *
 * `refresh()` is exposed for the case the interval handles badly: an operator who
 * has just installed an agent and wants to see the diff react now, rather than
 * waiting up to five seconds. It is also what makes the hook testable without a
 * clock -- a test drives `refresh()` directly instead of waiting for a timer.
 */
export const DIFF_POLL_MS = 5_000;

/** What the hook needs from a transport. One method, and it is not optional. */
export interface ReconciliationSource {
  readonly fetchReconciliation: () => Promise<ReconciliationDiff>;
}

export interface ReconciliationSample {
  /**
   * `undefined` means NO TRANSPORT WAS ASKED. `null` means it was asked and
   * there is no record to compare against. The panel renders nothing for either,
   * and the distinction exists so a caller is not forced to lie about one of them.
   */
  readonly diff: ReconciliationDiff | null | undefined;
  /** The refusal, as a sentence. Null while healthy. */
  readonly error: string | null;
  /** True before the first answer arrives, and on every refresh after it. */
  readonly loading: boolean;
}

export function useReconciliation(source: ReconciliationSource | undefined, intervalMs: number = DIFF_POLL_MS): ReconciliationSample & {
  readonly refresh: () => void;
} {
  const [diff, setDiff] = useState<ReconciliationDiff | null | undefined>(source === undefined ? undefined : null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(source !== undefined);

  /**
   * THE REQUEST IN FLIGHT, so two refreshes cannot overlap.
   *
   * The live poller skips a tick rather than queueing one; the same rule applies
   * here for the same reason. A queued read behind a slow one is a read that
   * answers later than the operator asked, and on this endpoint a late answer is
   * a stale comparison wearing a fresh timestamp -- which is the specific
   * dishonesty this whole surface is built to avoid.
   */
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    if (source === undefined || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      const next = await source.fetchReconciliation();
      if (!mounted.current) return;
      setDiff(next);
      setError(null);
    } catch (caught) {
      if (!mounted.current) return;
      // THE PREVIOUS DIFF IS KEPT. Replacing a standing comparison with an error
      // message teaches an operator that the panel is the health indicator, and
      // it is not: it says what the record and the running system disagree about,
      // and a network blip is not a disagreement. The refusal is shown alongside
      // the last known state, dated by that state's own age.
      setError(caught instanceof Error ? caught.message : "the diff could not be read");
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [source]);

  useEffect(() => {
    if (source === undefined) {
      // No transport: the panel renders nothing at all. Not a rejected read, not
      // an empty diff -- an unasked question has no answer and inventing one is
      // how a record panel ends up claiming agreement it never checked.
      setDiff(undefined);
      setError(null);
      setLoading(false);
      return;
    }
    void read();
    const timer = setInterval(() => {
      void read();
    }, intervalMs);
    // Released on unmount, for the reason the whole hook file is shaped this
    // way: a timer that outlives its component keeps scheduling.
    return () => clearInterval(timer);
  }, [source, intervalMs, read]);

  const refresh = useCallback(() => {
    void read();
  }, [read]);

  return { diff, error, loading, refresh };
}
