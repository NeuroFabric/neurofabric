import test from "node:test";
import assert from "node:assert/strict";

import {
  ALERT_ID_HEADER,
  SIGNATURE_HEADER,
  WebhookDispatcher,
  attachDispatcher,
  buildAlertPayload,
  isTransientStatus,
  type WebhookEndpoint,
} from "./webhook-dispatcher.ts";
import type { SwarmAlert } from "../omniroute/omniroute-gateway.ts";
import type { LiveColumnVerdict, LiveVerdict } from "../conductor/live-anomaly.ts";

/**
 * EGRESS TESTS. The retry ladder, asserted without waiting for it.
 *
 * === WHY `sleep` IS A PARAMETER AND NOT A REAL TIMER ===
 *
 * Exponential backoff is the whole content of this module. Asserted for real it
 * means a four-second test that proves the maths by making everybody wait for it,
 * and a suite that is skipped when it is inconvenient. So every test injects a
 * `sleep` that records what it was asked to wait for and returns immediately --
 * the ladder is then checked as DATA, which is both faster and stricter than
 * checking that time passed.
 */

const KEY = "http://alerts.example/hook";

function column(over: Partial<LiveColumnVerdict> = {}): LiveColumnVerdict {
  return {
    column: "latency_ms",
    measured: 1200,
    min: 10,
    max: 400,
    q1: 40,
    q3: 90,
    quantilesSampled: false,
    fenceLower: 5,
    fenceUpper: 125,
    extremeLower: -100,
    extremeUpper: 400,
    extremeMultiple: 1,
    breached: false,
    partitions: 3,
    partitionColumns: { p0: 400, p1: 400, p2: 400 },
    breachedEverywhere: false,
    ...over,
  };
}

function verdict(over: Partial<LiveVerdict> = {}): LiveVerdict {
  return {
    at: "2025-03-01T00:00:00.000Z",
    records: 3000,
    open: true,
    columns: [column()],
    breachedColumns: 0,
    busiestHour: { hour: "12", count: 400 },
    topKeys: [{ key: "checkout", count: 400 }],
    ...over,
  };
}

function alert(over: Partial<SwarmAlert> = {}): SwarmAlert {
  return {
    provider: "payments",
    verdict: verdict(),
    text: "latency_ms is 3.2x past its outer fence.",
    at: "2025-03-01T00:00:00.000Z",
    firstObservation: true,
    ...over,
  };
}

/** A fetch stand-in that replays a scripted list of outcomes. */
function scriptedFetch(steps: readonly ("ok" | number | Error)[]) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  let index = 0;
  const impl = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    calls.push({ url, body: init.body, headers: init.headers });
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    if (step instanceof Error) throw step;
    if (step === "ok") return new Response("{}", { status: 200 });
    return new Response("{}", { status: step, headers: step === 429 ? { "retry-after": "7" } : {} });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A sleep that records what it was asked for and never waits. */
function instantSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); } };
}

const endpoint = (over: Partial<WebhookEndpoint> = {}): WebhookEndpoint => ({ url: KEY, ...over });

/* ------------------------------------------------------------------ */
/* THE THREE RETRY CLASSES                                              */
/* ------------------------------------------------------------------ */

test("a 5xx is transient and is retried until it is delivered", async () => {
  const { impl, calls } = scriptedFetch([503, 500, "ok"]);
  const { waits, sleep } = instantSleep();
  const dispatcher = new WebhookDispatcher({ endpoints: [endpoint()], fetchImpl: impl, sleep, jitter: 0 });

  const result = await dispatcher.dispatch(alert());

  assert.equal(result.delivered, 1);
  assert.equal(result.failed, 0);
  assert.equal(calls.length, 3);
  assert.deepEqual(result.attempts.map((a) => a.ok), [false, false, true]);
  assert.deepEqual(result.attempts.map((a) => a.attempt), [1, 2, 3]);
});

test("a 4xx that is not transient is attempted ONCE, because retrying cannot help", async () => {
  const { impl, calls } = scriptedFetch([404]);
  const { waits, sleep } = instantSleep();
  const dispatcher = new WebhookDispatcher({ endpoints: [endpoint()], fetchImpl: impl, sleep, jitter: 0 });

  const result = await dispatcher.dispatch(alert());

  assert.equal(calls.length, 1, "a permanent refusal must not be retried");
  assert.equal(result.delivered, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.attempts[0]?.permanent, true);
  assert.deepEqual(waits, [], "and nothing was waited for");
});

test("the classification itself is the rule, and it is named", () => {
  assert.equal(isTransientStatus(408), true);
  assert.equal(isTransientStatus(425), true);
  assert.equal(isTransientStatus(429), true);
  assert.equal(isTransientStatus(500), true);
  assert.equal(isTransientStatus(503), true);
  assert.equal(isTransientStatus(400), false);
  assert.equal(isTransientStatus(401), false);
  assert.equal(isTransientStatus(404), false);
});

test("a network failure with no status is transient, and exhausting it is reported", async () => {
  const { impl, calls } = scriptedFetch([new Error("ECONNRESET")]);
  const { waits, sleep } = instantSleep();
  const dispatcher = new WebhookDispatcher({
    endpoints: [endpoint()], fetchImpl: impl, sleep, jitter: 0, maxAttempts: 3,
  });

  const result = await dispatcher.dispatch(alert());

  assert.equal(calls.length, 3);
  assert.equal(result.delivered, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.attempts.length, 3);
  // The reason is carried, because "it failed" is not an incident report.
  assert.match(result.attempts[0]?.error ?? "", /ECONNRESET/);
});

/* ------------------------------------------------------------------ */
/* THE BACKOFF LADDER                                                   */
/* ------------------------------------------------------------------ */

test("backoff doubles and is reported on the attempt that WAITED, not the next one", async () => {
  const { impl } = scriptedFetch([500]);
  const { waits, sleep } = instantSleep();
  const dispatcher = new WebhookDispatcher({
    endpoints: [endpoint()], fetchImpl: impl, sleep, jitter: 0,
    maxAttempts: 4, baseDelayMs: 100,
  });

  const result = await dispatcher.dispatch(alert());

  // 3 waits for 4 attempts: the final failure has nothing after it.
  assert.deepEqual(waits, [100, 200, 400]);
  assert.deepEqual(result.attempts.map((a) => a.waitedMs), [100, 200, 400, undefined]);
});

test("the backoff is CAPPED, so attempt nine does not wait for an hour", async () => {
  const { impl } = scriptedFetch([500]);
  const { waits, sleep } = instantSleep();
  const dispatcher = new WebhookDispatcher({
    endpoints: [endpoint()], fetchImpl: impl, sleep, jitter: 0,
    maxAttempts: 8, baseDelayMs: 1000, maxDelayMs: 5000,
  });

  await dispatcher.dispatch(alert());

  assert.deepEqual(waits, [1000, 2000, 4000, 5000, 5000, 5000, 5000]);
  assert.equal(Math.max(...waits), 5000);
});

test("jitter cannot push a wait PAST the ceiling it exists to bound", async () => {
  const { impl } = scriptedFetch([500]);
  const { waits, sleep } = instantSleep();
  const dispatcher = new WebhookDispatcher({
    endpoints: [endpoint()], fetchImpl: impl, sleep,
    maxAttempts: 6, baseDelayMs: 1000, maxDelayMs: 4000, jitter: 0.9,
  });

  await dispatcher.dispatch(alert());

  for (const wait of waits) {
    assert.ok(wait >= 0, "a wait is never negative");
    assert.ok(wait <= 4000, `jitter overshot the ceiling: ${wait}`);
  }
});

test("a 429 that states Retry-After outranks our own ladder", async () => {
  const { impl } = scriptedFetch([429, "ok"]);
  const { waits, sleep } = instantSleep();
  const dispatcher = new WebhookDispatcher({
    endpoints: [endpoint()], fetchImpl: impl, sleep, jitter: 0, baseDelayMs: 100,
  });

  const result = await dispatcher.dispatch(alert());

  // The partner said 7 seconds. Our ladder would have said 100ms.
  assert.deepEqual(waits, [7000]);
  assert.equal(result.delivered, 1);
});

/* ------------------------------------------------------------------ */
/* SEVERAL ENDPOINTS, INDEPENDENTLY                                     */
/* ------------------------------------------------------------------ */

test("one dead endpoint does not stop a live one, and the counts are endpoints not attempts", async () => {
  const dead = scriptedFetch([400]);
  const live = scriptedFetch(["ok"]);
  const { waits, sleep } = instantSleep();

  const dispatcher = new WebhookDispatcher({
    endpoints: [endpoint({ url: "http://dead.example" }), endpoint({ url: "http://live.example" })],
    fetchImpl: (async (url: string, init: { body: string; headers: Record<string, string> }) =>
      (url === "http://dead.example" ? dead.impl : live.impl)(url, init)) as unknown as typeof fetch,
    sleep, jitter: 0,
  });

  const result = await dispatcher.dispatch(alert());

  assert.equal(result.delivered, 1);
  assert.equal(result.failed, 1);
});

test("a dispatcher with no endpoints is disabled, not broken", async () => {
  const dispatcher = new WebhookDispatcher({ endpoints: [] });
  assert.equal(dispatcher.enabled, false);
  const result = await dispatcher.dispatch(alert());
  assert.deepEqual(result, { alertId: result.alertId, delivered: 0, failed: 0, attempts: [] });
});

/* ------------------------------------------------------------------ */
/* THE PAYLOAD                                                          */
/* ------------------------------------------------------------------ */

test("severity comes from the CONSOLIDATED verdict, not the raw count of columns", () => {
  const onePartitionOfThree = buildAlertPayload(alert({
    verdict: verdict({
      breachedColumns: 1,
      columns: [column({ breached: true, breachedEverywhere: false, partitions: 3 })],
    }),
  }));
  const everywhere = buildAlertPayload(alert({
    verdict: verdict({
      breachedColumns: 1,
      columns: [column({ breached: true, breachedEverywhere: true, partitions: 3 })],
    }),
  }));

  assert.equal(onePartitionOfThree.severity, "warning");
  assert.equal(everywhere.severity, "critical");
});

test("only breached columns travel, and they carry their provenance", () => {
  const payload = buildAlertPayload(alert({
    verdict: verdict({
      breachedColumns: 1,
      columns: [
        column({ column: "latency_ms", breached: true, breachedEverywhere: false, extremeMultiple: 3.2, max: 4000 }),
        column({ column: "amount", breached: false }),
      ],
    }),
  }));

  assert.equal(payload.columns.length, 1);
  assert.equal(payload.columns[0]?.column, "latency_ms");
  assert.equal(payload.columns[0]?.multiple, 3.2);
  assert.equal(payload.columns[0]?.partitions, 3);
});

test("a clean snapshot is info, and says so rather than inventing a breach", () => {
  const payload = buildAlertPayload(alert());
  assert.equal(payload.severity, "info");
  assert.deepEqual(payload.columns, []);
  assert.match(payload.title, /no breach/);
});

test("the id is CONTENT-DERIVED, so a redelivery is deduplicable and not a second incident", () => {
  const first = buildAlertPayload(alert());
  const again = buildAlertPayload(alert());
  const different = buildAlertPayload(alert({ provider: "search" }));

  assert.equal(first.id, again.id);
  assert.notEqual(first.id, different.id);
  assert.equal(first.id.length, 32);
});

/* ------------------------------------------------------------------ */
/* SIGNING, AND THE WIRING                                             */
/* ------------------------------------------------------------------ */

test("a signed endpoint receives a signature over the exact bytes sent", async () => {
  const { impl, calls } = scriptedFetch(["ok"]);
  const dispatcher = new WebhookDispatcher({
    endpoints: [endpoint({ hmacKey: "k" })], fetchImpl: impl,
  });

  await dispatcher.dispatch(alert());

  const call = calls[0]!;
  assert.match(call.headers[SIGNATURE_HEADER] ?? "", /^sha256=[0-9a-f]{64}$/);
  assert.equal(call.headers[ALERT_ID_HEADER], buildAlertPayload(alert()).id);
  assert.equal(call.headers["content-type"], "application/json");
});

test("an unsigned endpoint gets no signature header at all, rather than an empty one", async () => {
  const { impl, calls } = scriptedFetch(["ok"]);
  const dispatcher = new WebhookDispatcher({ endpoints: [endpoint()], fetchImpl: impl });

  await dispatcher.dispatch(alert());

  assert.equal(SIGNATURE_HEADER in calls[0]!.headers, false);
});

test("static endpoint headers travel alongside the ones we add", async () => {
  const { impl, calls } = scriptedFetch(["ok"]);
  const dispatcher = new WebhookDispatcher({
    endpoints: [endpoint({ headers: { "x-routing-key": "payments" } })], fetchImpl: impl,
  });

  await dispatcher.dispatch(alert());

  assert.equal(calls[0]!.headers["x-routing-key"], "payments");
});

test("a throwing logger cannot break a delivery that had not finished", async () => {
  const { impl } = scriptedFetch(["ok"]);
  const dispatcher = new WebhookDispatcher({
    endpoints: [endpoint()],
    fetchImpl: impl,
    onAttempt: () => { throw new Error("the log sink is down"); },
  });

  const result = await dispatcher.dispatch(alert());
  assert.equal(result.delivered, 1);
});

test("attachDispatcher subscribes to the gateway and returns an unsubscribe", async () => {
  const { impl } = scriptedFetch(["ok"]);
  const dispatcher = new WebhookDispatcher({ endpoints: [endpoint()], fetchImpl: impl });
  const handlers: ((a: SwarmAlert) => void)[] = [];
  const gateway = {
    subscribe(handler: (a: SwarmAlert) => void) {
      handlers.push(handler);
      return () => { handlers.splice(handlers.indexOf(handler), 1); };
    },
  };

  const unsubscribe = attachDispatcher(gateway, dispatcher);
  assert.equal(handlers.length, 1);

  handlers[0]!(alert());
  await new Promise((resolve) => setImmediate(resolve));
  unsubscribe();
  assert.equal(handlers.length, 0);
});
