import { describe, expect, it } from "vitest";

import { GatewayClient, GatewayError } from "./gateway-client";
import { CREDENTIAL_BACKOFF_FLOOR_MS } from "./credential-state";
import { TelemetryPoller, type LiveSource, type TelemetrySample } from "./telemetry-poller";
import { simulateVerdict } from "./live-contracts";

/**
 * THE POLLING LOOP, DRIVEN BY HAND.
 *
 * No DOM, no fake clock, no component. Timers are injected, so the delays
 * asserted below are the numbers the loop actually asked for rather than what a
 * clock library reported it did.
 *
 * === THE CASE THIS FILE EXISTS FOR ===
 *
 * 62 identical errors in 31 seconds. A wrong credential is not a transient fault,
 * so the loop must stop rather than retry, and a server or network fault -- which
 * a retry CAN clear -- must instead back off. Those two behaviours are opposite
 * and they used to be the same behaviour, which is a fixed interval.
 */

const TOKEN = "gw-poll-71c3ab";

/**
 * A hand-driven clock.
 *
 * `delays` is the whole assertion surface: what the loop asked to wait, in order.
 * `fire` runs the pending callback, which is how a poll is triggered at all --
 * there is no background timing in this environment.
 */
function manualClock() {
  const delays: number[] = [];
  let pending: (() => void) | undefined;
  return {
    delays,
    setTimer: (fn: () => void, ms: number): unknown => {
      delays.push(ms);
      pending = fn;
      return ms;
    },
    clearTimer: (handle: unknown): void => {
      if (handle === undefined) return;
      pending = undefined;
    },
    /** Run whatever is waiting. Returns false when nothing was. */
    fire: (): boolean => {
      const fn = pending;
      if (fn === undefined) return false;
      pending = undefined;
      fn();
      return true;
    },
    get armed(): boolean {
      return pending !== undefined;
    },
  };
}

/** A well-formed snapshot, so a success path is a success and not a parse error. */
const goodSnapshot = () => ({
  at: "2026-10-03T14:31:12.000Z",
  provider: "pega",
  enabled: true,
  verdict: { ...simulateVerdict(3, 262), synthetic: false },
  throughput: { records: 262, delta: 200, windowMs: 15_149, eventsPerSecond: 13 },
});

/** A client that always refuses with the edge's nested shape. */
function refusingSource(code: string, reason: string, status: number): LiveSource {
  const impl: typeof fetch = async () =>
    new Response(JSON.stringify({ status: "FAILED", failure: { code, reason } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  const client = new GatewayClient({ gatewayToken: TOKEN, fetchImpl: impl });
  return { fetchLive: () => client.fetchLive() };
}

/** A client that always succeeds. */
function healthySource(): LiveSource {
  const impl: typeof fetch = async () =>
    new Response(JSON.stringify(goodSnapshot()), { status: 200, headers: { "content-type": "application/json" } });
  const client = new GatewayClient({ gatewayToken: TOKEN, fetchImpl: impl });
  return { fetchLive: () => client.fetchLive() };
}

const NOT_RECOGNISED = refusingSource("UNAUTHENTICATED", "the credential presented is not recognised", 401);
const NOT_PRESENTED = refusingSource("UNAUTHENTICATED", "no credential presented: send the x-gateway-token header", 401);

/** Let queued microtasks drain, so an `await` inside the loop completes. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function harness(source: LiveSource, intervalMs = 500) {
  const clock = manualClock();
  const poller = new TelemetryPoller({ source, intervalMs, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const seen: TelemetrySample[] = [];
  poller.subscribe((sample) => seen.push(sample));
  return { clock, poller, seen, latest: () => seen[seen.length - 1] ?? poller.sample };
}

describe("TelemetryPoller", () => {
  it("polls at the healthy cadence and keeps the last good reading", async () => {
    const { clock, poller, latest } = harness(healthySource(), 500);
    poller.start();
    await settle();

    expect(clock.delays).toEqual([500]);
    expect(latest().snapshot?.verdict?.records).toBe(262);
    expect(latest().error).toBeNull();
    expect(latest().state).toBe("ok");
    expect(latest().loading).toBe(false);
  });

  it("STOPS after one refusal, and schedules nothing further", async () => {
    const { clock, poller, latest } = harness(NOT_RECOGNISED);
    poller.start();
    await settle();

    // One read, one classification, and no timer at all. `delays` is empty: this
    // is the whole 62-errors fix in one assertion.
    expect(clock.delays).toEqual([]);
    expect(clock.armed).toBe(false);
    expect(poller.halted).toBe(true);
    expect(latest().state).toBe("rejected");
    expect(latest().credentialRequired).toBe(true);
  });

  it("says so for a refusal where nothing was presented, in different words", async () => {
    const refused = harness(NOT_PRESENTED);
    refused.poller.start();
    await settle();

    const sent = harness(NOT_RECOGNISED);
    sent.poller.start();
    await settle();

    expect(refused.latest().state).toBe("required");
    expect(sent.latest().state).toBe("rejected");
    // Both halt, and both open the prompt -- but they are not the same screen, so
    // a test that only checked "it stopped" would have missed this entirely.
    expect(refused.latest().credentialRequired).toBe(true);
    expect(sent.latest().credentialRequired).toBe(true);
    expect(refused.latest().error).not.toBe(sent.latest().error);
  });

  it("backs off from the floor, not from the healthy cadence, on a fault a retry clears", async () => {
    const flaky = new GatewayError("server", "responded 503: no live gateway is attached to this process", { status: 503 });
    let attempt = 0;
    const source: LiveSource = {
      fetchLive: () => {
        attempt += 1;
        // Three faults, then a good reading.
        return attempt <= 3 ? Promise.reject(flaky) : Promise.resolve(goodSnapshot() as never);
      },
    };

    const { clock, poller, latest } = harness(source, 500);
    poller.start();
    await settle();

    // Not 1000ms (interval x 2) and not 500ms: the floor.
    expect(clock.delays).toEqual([CREDENTIAL_BACKOFF_FLOOR_MS]);
    // 503 is a server fault, so it must NOT be mistaken for a credential problem
    // and must not open the prompt.
    expect(latest().state).toBe("no-gateway");
    expect(latest().credentialRequired).toBe(false);

    clock.fire();
    await settle();
    expect(clock.delays).toEqual([CREDENTIAL_BACKOFF_FLOOR_MS, CREDENTIAL_BACKOFF_FLOOR_MS * 2]);

    clock.fire();
    await settle();
    expect(clock.delays).toEqual([
      CREDENTIAL_BACKOFF_FLOOR_MS,
      CREDENTIAL_BACKOFF_FLOOR_MS * 2,
      CREDENTIAL_BACKOFF_FLOOR_MS * 4,
    ]);

    // The fourth read succeeds, and the schedule returns to the healthy cadence.
    clock.fire();
    await settle();
    expect(latest().state).toBe("ok");
    expect(latest().snapshot?.verdict?.records).toBe(262);
    expect(clock.delays[clock.delays.length - 1]).toBe(500);
  });

  it("recovers when a new credential is configured, and polls at once", async () => {
    let calls = 0;
    const refused: LiveSource = {
      fetchLive: () => {
        calls += 1;
        return Promise.reject(new GatewayError("refused", "responded 401", { status: 401, reason: "the credential presented is not recognised" }));
      },
    };

    const { clock, poller, latest } = harness(refused);
    poller.start();
    await settle();

    expect(calls).toBe(1);
    expect(poller.halted).toBe(true);
    expect(clock.armed).toBe(false);

    // The operator enters the right value. Nothing polls between here and here,
    // because nothing was scheduled.
    poller.configure({ source: healthySource() });
    await settle();

    expect(latest().state).toBe("ok");
    expect(latest().credentialRequired).toBe(false);
    expect(latest().snapshot?.verdict?.records).toBe(262);
    expect(latest().error).toBeNull();
    expect(poller.halted).toBe(false);
    // And the healthy cadence is what it schedules, not a ceiling earned during
    // the refusal run.
    expect(clock.delays[clock.delays.length - 1]).toBe(500);

    // A later refusal still halts it. Recovery is not a one-way latch.
    poller.configure({ source: refused });
    await settle();
    expect(clock.armed).toBe(false);
  });

  it("keeps the last good snapshot through a later failure", async () => {
    let attempt = 0;
    const source: LiveSource = {
      fetchLive: () => {
        attempt += 1;
        return attempt === 1 ? Promise.resolve(goodSnapshot() as never) : Promise.reject(new GatewayError("timeout", "no response within 8000ms"));
      },
    };

    const { clock, poller, latest } = harness(source);
    poller.start();
    await settle();
    expect(latest().snapshot).not.toBeNull();

    clock.fire();
    await settle();

    expect(latest().state).toBe("other");
    // The panel still shows the last real reading. Losing it would turn a blip
    // into a blank panel, which is the failure this layer exists to prevent.
    expect(latest().snapshot?.verdict?.records).toBe(262);
    expect(latest().error).not.toBeNull();
    expect(latest().loading).toBe(false);
    // And a timeout still backs off rather than halting: it clears by itself.
    expect(clock.delays[clock.delays.length - 1]).toBe(CREDENTIAL_BACKOFF_FLOOR_MS);
  });

  it("skips a tick rather than queueing one behind an in-flight read", async () => {
    let inFlight = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const source: LiveSource = {
      fetchLive: () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        return new Promise((resolve) => {
          release = () => {
            inFlight -= 1;
            resolve(goodSnapshot() as never);
          };
        });
      },
    };

    const { clock, poller } = harness(source);
    poller.start();
    await settle();

    // The read has not resolved. Three healthy ticks arrive anyway.
    clock.fire();
    clock.fire();
    clock.fire();

    // One request, not four. Three overlapping requests against a slow server is
    // the pile-up the in-flight guard exists to prevent.
    expect(peak).toBe(1);
    expect(clock.armed).toBe(false);

    release?.();
    await settle();

    // Only now is the next read scheduled, and only one of them.
    expect(clock.delays).toHaveLength(1);
    expect(clock.armed).toBe(true);
  });

  it("does not schedule anything after stop, and tolerates a second stop", async () => {
    const { clock, poller } = harness(NOT_RECOGNISED);
    poller.start();
    await settle();

    poller.stop();
    poller.stop();

    expect(clock.armed).toBe(false);
    expect(clock.delays).toEqual([]);
  });

  it("discards a response that arrives after stop", async () => {
    let release: (() => void) | undefined;
    const source: LiveSource = {
      fetchLive: () =>
        new Promise((resolve) => {
          release = () => resolve(goodSnapshot() as never);
        }),
    };

    const { poller, latest } = harness(source);
    poller.start();
    await settle();

    poller.stop();
    release?.();
    await settle();

    // A response from a torn-down component must not schedule the next poll, or
    // the poller keeps running with nobody listening -- the exact leak this
    // repository has already been hung by once.
    expect(latest().snapshot).toBeNull();
  });

  it("notifies a subscriber immediately, and stops after unsubscribe", async () => {
    const poller = new TelemetryPoller({ source: healthySource() });
    const seen: TelemetrySample[] = [];
    const unsubscribe = poller.subscribe((sample) => seen.push(sample));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.loading).toBe(true);

    unsubscribe();
    poller.start();
    await settle();

    // No further pushes, which is what keeps a setState on an unmounted tree from
    // being reachable at all.
    expect(seen).toHaveLength(1);
  });
});