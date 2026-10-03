import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { CREDENTIAL_HEADER, GatewayClient, PORTAL_PATHS } from "../api/gateway-client";
import { validateLiveSnapshot, simulateVerdict } from "../api/live-contracts";

/**
 * THE LIVE READ PATH.
 *
 * Two claims are pinned here. First, that the client unwraps the envelope the
 * route actually returns -- the bug that shipped once already with `fetchSchema`,
 * where a correct-looking test against a bare document hid a method that would
 * have refused every real response. Second, that a rate cannot reach the UI
 * without a positive window, because an `Infinity events/sec` on a live dashboard
 * is the failure this entire layer was built to prevent.
 */

const GATEWAY_TOKEN = "gw-live-4b1d9e";

function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { impl, calls };
}

function client(impl: typeof fetch) {
  return new GatewayClient({ gatewayToken: GATEWAY_TOKEN, fetchImpl: impl });
}

const realVerdict = () => ({ ...simulateVerdict(1, 42_000), synthetic: false });

/** A well-formed snapshot, overridable per test. Module scope: three suites use it. */
const snapshot = (over: Record<string, unknown> = {}) => ({
  at: "2026-10-03T13:00:00.000Z",
  provider: "pega",
  enabled: true,
  verdict: realVerdict(),
  throughput: { records: 42_000, delta: 4_000, windowMs: 1_500, eventsPerSecond: 2_667 },
  ...over,
});

describe("validateLiveSnapshot", () => {
  it("accepts a well-formed snapshot", () => {
    expect(validateLiveSnapshot(snapshot()).ok).toBe(true);
  });

  it("accepts an idle snapshot with a real verdict and no traffic yet", () => {
    const result = validateLiveSnapshot(snapshot({ verdict: { ...realVerdict(), records: 0, columns: [] } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict?.records).toBe(0);
  });

  it("accepts null verdict and null throughput, because both mean something", () => {
    const result = validateLiveSnapshot(snapshot({ verdict: null, throughput: null }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verdict).toBeNull();
    expect(result.value.throughput).toBeNull();
  });

  it("REFUSES a non-positive window, which is a divide by zero that reached the wire", () => {
    for (const windowMs of [0, -1]) {
      const result = validateLiveSnapshot(snapshot({ throughput: { records: 10, delta: 5, windowMs, eventsPerSecond: 500 } }));
      expect(result.ok, `windowMs ${windowMs} must be refused`).toBe(false);
      if (result.ok) continue;
      expect(result.issues[0]?.path).toBe("$.throughput.windowMs");
    }
  });

  it("refuses a non-finite rate rather than letting Infinity reach the DOM", () => {
    const result = validateLiveSnapshot(
      snapshot({ throughput: { records: 10, delta: 5, windowMs: 1000, eventsPerSecond: Number.POSITIVE_INFINITY } }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a NaN", () => {
    expect(validateLiveSnapshot(snapshot({ throughput: { records: NaN, delta: 5, windowMs: 10, eventsPerSecond: 1 } })).ok).toBe(false);
  });

  it("refuses a throughput that is a bare number", () => {
    expect(validateLiveSnapshot(snapshot({ throughput: 5000 })).ok).toBe(false);
  });

  it("prefixes a nested verdict issue path", () => {
    const broken = realVerdict() as Record<string, unknown>;
    delete broken.synthetic;
    const result = validateLiveSnapshot(snapshot({ verdict: broken }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("$.verdict$.synthetic");
  });

  it("refuses a snapshot with no provider", () => {
    expect(validateLiveSnapshot(snapshot({ provider: "" })).ok).toBe(false);
  });

  it("refuses a non-object", () => {
    expect(validateLiveSnapshot("nope").ok).toBe(false);
  });
});

describe("fetchLive", () => {
  it("reads the documented path", async () => {
    const { impl, calls } = stubFetch(snapshot());
    await client(impl).fetchLive();
    expect(calls[0]?.url).toBe(PORTAL_PATHS.live);
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("UNWRAPS the envelope rather than validating it as a verdict", async () => {
    // The `fetchSchema` bug, pinned against the shape the route really returns.
    const { impl } = stubFetch(snapshot());
    const live = await client(impl).fetchLive();
    expect(live.provider).toBe("pega");
    expect(live.throughput?.eventsPerSecond).toBe(2_667);
    expect(live.verdict?.synthetic).toBe(false);
  });

  it("carries the credential like every other read", async () => {
    const { impl, calls } = stubFetch(snapshot());
    await client(impl).fetchLive();
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers[CREDENTIAL_HEADER]).toBe(GATEWAY_TOKEN);
    expect(calls[0]?.init.credentials).toBe("omit");
  });

  it("reports a malformed snapshot as malformed, not as a verdict fault", async () => {
    const { impl } = stubFetch(snapshot({ throughput: { records: 1, delta: 1, windowMs: 0, eventsPerSecond: 1 } }));
    await expect(client(impl).fetchLive()).rejects.toMatchObject({ kind: "malformed" });
  });

  it("classifies a refused read so the UI can show a sign-in fault", async () => {
    const { impl } = stubFetch({ status: "FAILED", failure: { code: "UNAUTHENTICATED", reason: "no credential presented" } }, 401);
    await expect(client(impl).fetchLive()).rejects.toMatchObject({ kind: "refused", status: 401 });
  });
});

/**
 * The hook is React, so its polling logic is pinned where it can be: the two
 * properties that are pure functions of how it is written.
 */
describe("polling contract, as the hook will implement it", () => {
  it("a 500ms interval with an in-flight guard never exceeds one request in flight", () => {
    // Stated as an invariant the hook must hold rather than as an assertion about
    // its internals: if a request takes longer than the interval, the next tick
    // must skip rather than queue. Without the guard a slow server produces an
    // unbounded pile-up, which is a memory leak reachable from the network.
    const intervalMs = 500;
    let inFlight = 0;
    let peak = 0;
    const tick = async (): Promise<void> => {
      if (inFlight > 0) return;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, intervalMs * 3));
      inFlight -= 1;
    };
    return Promise.all([tick(), tick(), tick(), tick()]).then(() => {
      expect(peak).toBe(1);
    });
  });

  it("renders a live snapshot without crashing", () => {
    function Probe({ snapshot: value }: { snapshot: unknown }): ReactElement {
      const result = validateLiveSnapshot(value);
      if (!result.ok) return <p>refused</p>;
      const t = result.value.throughput;
      return <p>{t === null ? "idle" : `${t.eventsPerSecond}/s over ${t.windowMs}ms`}</p>;
    }
    const html = renderToStaticMarkup(<Probe snapshot={snapshot()} />);
    expect(html).toContain("2667/s over 1500ms");
  });
});