import { useEffect, useRef, useState } from "react";

import { DEFAULT_POLL_MS, TelemetryPoller, type LiveSource, type TelemetrySample } from "../api/telemetry-poller";
import type { CredentialState } from "../api/credential-state";

export { DEFAULT_POLL_MS };
export type { LiveSource, CredentialState };

/**
 * LIVE TELEMETRY, AS REACT SEES IT.
 *
 * === THE LOOP IS NOT IN THIS FILE, AND THAT IS THE POINT ===
 *
 * Every decision worth testing -- halt on a refusal, back off from the floor,
 * recover on a new credential -- lives in `TelemetryPoller`, which imports no
 * React and runs in the `node` test environment. This file turns a pollable into
 * React state and does nothing else.
 *
 * The version it replaced used `setInterval`, and that was the defect. An
 * interval cannot express "stop asking until a credential changes": its only
 * knob is how long to wait, and the only thing it can do about a failure is wait
 * the same again. Against a refused credential that produced 62 identical errors
 * in 31 seconds. A self-scheduling loop stops by not scheduling, which is
 * something a loop can do and an interval cannot.
 *
 * === WHY THE POLLER IS HELD IN A REF ===
 *
 * State would build a second one per render and restart polling on every change.
 * A ref builds exactly one, and `configure` is how a new credential reaches it.
 *
 * === EVERY TIMER IS RELEASED ON UNMOUNT ===
 *
 * A poller that outlives its component keeps scheduling. This repository has been
 * hung by exactly that shape once -- five red tests left five listening sockets
 * and the runner sat for 37 minutes with every result already printed.
 */
export interface LiveTelemetry extends TelemetrySample {
  /** True before the first successful read. Carried from the poller's sample. */
  readonly loading: boolean;
}

export function useLiveTelemetry(source: LiveSource, intervalMs: number = DEFAULT_POLL_MS): LiveTelemetry {
  const [sample, setSample] = useState<TelemetrySample>({
    snapshot: null,
    error: null,
    loading: true,
    state: "ok",
    credentialRequired: false,
  });

  const pollerRef = useRef<TelemetryPoller | null>(null);

  useEffect(() => {
    // Built once and reconfigured, so a credential change is a method call on a
    // live poller rather than a teardown of one and a fresh one -- which matters
    // because the teardown path is the one that drops the in-flight request.
    const poller = pollerRef.current ?? new TelemetryPoller({ source, intervalMs });
    pollerRef.current = poller;
    poller.configure({ source, intervalMs });
    const unsubscribe = poller.subscribe(setSample);
    poller.start();
    // Released in the one place a throw cannot reach past.
    return () => {
      unsubscribe();
      poller.stop();
    };
  }, [source, intervalMs]);

  return sample;
}