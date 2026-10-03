import { useEffect, useRef, useState } from "react";

import type { LiveSnapshot } from "../api/live-contracts";

/**
 * LIVE TELEMETRY, POLLED.
 *
 * === WHY A HOOK AND NOT A STORE SUBSCRIPTION ===
 *
 * The rest of this app reads state through `useSyncExternalStore` over a
 * `SchemaStore`, because that data changes on human action and must be
 * consistent with the rest of the UI. Telemetry is different in kind: it arrives
 * on a timer whether or not anyone is looking, it is never written to, and there
 * is exactly one consumer. Putting it in the main store would mean every poll
 * re-rendering the agent selector and the rules table for a number in the corner.
 *
 * So it is local state on a timer, and the rest of the tree is untouched by it.
 *
 * === THE IN-FLIGHT GUARD IS THE POINT OF THIS FILE ===
 *
 * A 500ms interval and an 8s client timeout are not compatible by accident: if a
 * request takes longer than the interval, the next tick fires anyway, and the
 * next. Against a slow or wedged server that produces an unbounded pile-up --
 * hundreds of concurrent requests, each holding a response and a promise, which
 * is a memory leak reachable from the network and a self-inflicted denial of
 * service.
 *
 * So a tick that arrives while a request is in flight is SKIPPED, not queued. The
 * cost is that the displayed rate is the last completed reading rather than the
 * freshest possible one, which is the right trade: a slightly stale number beats
 * a growing queue.
 *
 * === THE INTERVAL IS CLEARED ON UNMOUNT ===
 *
 * A `setInterval` that outlives its component holds a reference to a closure over
 * a component React has already torn down, and keeps the event loop alive. This
 * repository has been hung by exactly that shape once -- five red tests left five
 * listening sockets and the runner sat for 37 minutes with every result already
 * printed -- so the cleanup is written out rather than assumed.
 *
 * The first read fires IMMEDIATELY rather than after one interval, so the panel
 * says "connecting" for a frame instead of for half a second.
 */
export interface LiveTelemetry {
  /** The last good snapshot, or null before the first successful read. */
  readonly snapshot: LiveSnapshot | null;
  /** The last failure, or null. A failed poll does NOT clear a good snapshot. */
  readonly error: string | null;
  /** True before the first successful read. */
  readonly loading: boolean;
}

/** What the hook needs from the client. Structural, so a fake satisfies it. */
export interface LiveSource {
  fetchLive(): Promise<LiveSnapshot>;
}

export const DEFAULT_POLL_MS = 500;

export function useLiveTelemetry(source: LiveSource, intervalMs: number = DEFAULT_POLL_MS): LiveTelemetry {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Refs, not state: these must be readable by the interval callback without
  // making the callback itself a dependency, and a ref change must not trigger a
  // re-render. Re-creating the interval on every render would restart polling
  // and could starve it entirely.
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;

    const read = async (): Promise<void> => {
      // THE GUARD. Skip rather than queue; see the note above.
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const next = await source.fetchLive();
        if (!mounted.current) return;
        setSnapshot(next);
        // A successful read clears the fault. Otherwise one failed poll during a
        // restart would leave a permanent red banner over healthy data.
        setError(null);
        setLoading(false);
      } catch (cause) {
        if (!mounted.current) return;
        // The previous snapshot is KEPT. Losing the last good reading because one
        // poll timed out turns a blip into a blank panel.
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      } finally {
        inFlight.current = false;
      }
    };

    void read();
    const timer = setInterval(() => void read(), intervalMs);

    return () => {
      // Cleared here, in the one place a throw cannot reach past.
      mounted.current = false;
      clearInterval(timer);
    };
  }, [source, intervalMs]);

  return { snapshot, error, loading };
}