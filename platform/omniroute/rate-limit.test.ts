import test from "node:test";
import assert from "node:assert/strict";

import { createGateway } from "./omniroute-gateway.ts";
import {
  guard,
  httpResponse,
  TokenBucket,
  CREDENTIAL_HEADER,
  type EdgeRequest,
  type GatewayToken,
} from "./edge-security.ts";

/**
 * THE LIMIT. What a proven caller may still not do.
 *
 * === WHY THE ORDER IS PROVEN-FIRST-THEN-THROTTLE ===
 *
 * The alternative is throttle first, and it hands an attacker a free tool: an
 * unauthenticated flood spends a legitimate caller's bucket, so the real caller is
 * locked out by rubbish they never sent. Authenticating first means the bucket is
 * only ever spent by someone who has paid for it.
 *
 * === WHY A BUCKET AND NOT A FIXED WINDOW ===
 *
 * A fixed window lets a caller spend its whole allowance in the last instant of
 * one window and its whole whole allowance in the first instant of the next --
 * twice the intended rate in a burst, which is exactly what a limit exists to
 * prevent. A bucket refills continuously.
 *
 * === WHY IT COUNTS EVENTS ===
 *
 * A caller allowed a thousand requests a second can put a million events in one of
 * them. The unit that costs the engine is the event.
 *
 * The clock is injected, so none of this waits on wall time.
 */

const KEY: GatewayToken = { id: "payments-token", credential: "value-1", providers: ["payments", "search"] };

const at = (headers: Record<string, string>, over: Partial<EdgeRequest> = {}): EdgeRequest => ({
  headers,
  provider: "payments",
  ...over,
});

const presented = (): Record<string, string> => ({ [CREDENTIAL_HEADER]: KEY.credential });

test("THE BUCKET ADMITS UP TO ITS CAPACITY, then refuses", () => {
  const limiter = new TokenBucket(10, 1);
  for (let i = 0; i < 10; i += 1) assert.equal(limiter.take("payments", 1), true, `call ${i + 1} fits`);
  assert.equal(limiter.take("payments", 1), false, "the eleventh does not");
});

test("IT REFILLS CONTINUOUSLY, so a caller is throttled for a moment, not for a window", () => {
  let clock = 1_000;
  const limiter = new TokenBucket(10, 10, () => clock);
  for (let i = 0; i < 10; i += 1) limiter.take("payments", 1);
  assert.equal(limiter.take("payments", 1), false);
  clock += 100;
  assert.equal(limiter.take("payments", 1), true, "a tenth of a second buys one event at 10/sec");
});

test("IT ACCOUNTS IN EVENTS, so one huge request cannot hide a flood", () => {
  // A request-per-second limit is trivially defeated by putting a million events
  // in one request. The unit that costs the engine is the event, so that is the
  // unit that is charged.
  const limiter = new TokenBucket(100, 1);
  assert.equal(limiter.take("payments", 60), true);
  assert.equal(limiter.take("payments", 60), false,
    "two requests of 60 each exceed a 100-event budget, even though that is only two requests");
});

test("THROTTLED CAPACITY IS RETAINED, not discarded", () => {
  // Zeroing the bucket would punish a throttled caller twice for one burst: once
  // for exceeding the rate, and again for whatever it had already earned.
  let clock = 0;
  const limiter = new TokenBucket(10, 10, () => clock);
  limiter.take("payments", 8);
  assert.equal(limiter.take("payments", 5), false);
  clock += 250;
  assert.equal(limiter.take("payments", 2), true,
    "the 2 remaining tokens survived the refusal; the caller's budget was not reset to zero");
});

test("THE BUCKET IS PER PROVIDER, so one noisy partner cannot spend another's", () => {
  const limiter = new TokenBucket(2, 1);
  limiter.take("payments", 2);
  assert.equal(limiter.take("payments", 1), false, "payments is exhausted");
  assert.equal(limiter.take("search", 1), true, "search is untouched -- the allowance is not shared");
});

test("429 CARRIES Retry-After, so a caller knows when to come back", () => {
  let clock = 0;
  const limiter = new TokenBucket(10, 2, () => clock);
  for (let i = 0; i < 10; i += 1) limiter.take("payments", 1);
  const decision = guard(at(presented(), { events: 4 }), [KEY], limiter);
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 429);
  assert.ok((decision.retryAfterSeconds ?? 0) >= 1, "and says how long to wait");
  assert.equal(httpResponse(decision).headers["retry-after"], String(decision.retryAfterSeconds));
  assert.equal(httpResponse(decision).body.failure?.code, "RATE_LIMITED");
});

test("AN UNPROVEN FLOOD NEVER TOUCHES THE BUCKET", () => {
  // The whole reason for the order. Throttling first would let a stranger spend a
  // real caller's allowance and lock them out with rubbish they never sent.
  let clock = 0;
  const limiter = new TokenBucket(10, 1, () => clock);
  for (let i = 0; i < 500; i += 1) {
    assert.equal(guard(at({ [CREDENTIAL_HEADER]: `wrong-${i}` }), [KEY], limiter).status, 401);
  }
  assert.equal(limiter.take("payments", 10), true,
    "a genuine caller still has its full allowance after five hundred forged requests");
});

test("A PROVEN CALLER OUT OF SCOPE IS 403, not 429 -- it never reached the bucket", () => {
  const limiter = new TokenBucket(1, 1);
  limiter.take("search", 1);
  const decision = guard(at(presented(), { provider: "telemetry" }), [KEY], limiter);
  assert.equal(decision.status, 403);
});

test("THE GATEWAY REFUSES A FLOOD, and the refused events never reach a broker", async () => {
  const limiter = new TokenBucket(5, 1);
  const gateway = createGateway({ tokens: [KEY], limiter });
  gateway.connect({ name: "payments", keyColumn: "service" });
  const broker = gateway.brokerFor("payments")!;
  broker.start();

  let admitted = 0;
  let throttled = 0;
  for (let i = 0; i < 20; i += 1) {
    const decision = gateway.pushAdmitted(at(presented()), { fields: { service: "checkout", latency_ms: "10" } });
    if (decision.ok) admitted += 1;
    if (decision.status === 429) throttled += 1;
  }
  const deadline = Date.now() + 2_000;
  while ((gateway.snapshot("payments")[0]?.records ?? 0) < admitted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(admitted, 5, "exactly the bucket's capacity got through");
  assert.equal(throttled, 15);
  assert.equal(gateway.snapshot("payments")[0]!.records, 5,
    "and the broker saw five events, not twenty -- a throttled push costs the engine nothing");
});

test("A GATEWAY WITH NO LIMITER IS NOT LIMITED, and says so", () => {
  // No silent default. A gateway that applied an arbitrary ceiling nobody
  // configured would be discovered by a customer rather than by an operator.
  const gateway = createGateway({ tokens: [KEY] });
  for (let i = 0; i < 500; i += 1) {
    assert.equal(gateway.admit(at(presented())).ok, true);
  }
});

test("THE LIMIT IS PER-REPLICA, and the docs say so where an operator will find it", async () => {
  // A limit whose scope is unknown looks like a control and is not one. The
  // statement is asserted here because documentation of a security control is
  // part of the control.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./edge-security.ts", import.meta.url), "utf8");
  assert.match(source, /PER REPLICA/);
  assert.match(source, /fleet of N replicas admits N times/,
    "and states the actual consequence, not merely the word. The phrase is split across source lines, " +
    "so the assertion matches a fragment that cannot be broken by rewrapping.");
});