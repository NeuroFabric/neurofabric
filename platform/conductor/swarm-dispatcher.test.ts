import test from "node:test";
import assert from "node:assert/strict";

import {
  SwarmDispatcher,
  type DeadLetterEntry,
  type DispatchOutcome,
} from "./swarm-dispatcher.ts";
import type { UniversalTelemetryEvent } from "../ingestion/universal-envelope.ts";

/**
 * THE SWARM DISPATCHER.
 *
 * === WHAT IS ACTUALLY BEING PINNED ===
 *
 * Not "it routes". The things a router gets wrong, in the order they cost the most:
 *
 *   1. **An unmatched event is dead-lettered, not thrown.** A firehose carries metric
 *      names no registered agent covers on day one. A dispatcher that throws on those
 *      stops processing the stream; one that drops them silently stops covering a
 *      domain without anyone noticing.
 *   2. **One agent's throw costs that agent, not the swarm.** The handler is
 *      untrusted code and there will be many.
 *   3. **Prefix matching is anchored.** `auth.` must not match `oauth.`, or the
 *      FinOps agent ends up summarising authentication traffic confidently and wrongly.
 *   4. **Delivery is bounded.** Registry capped, dead letters capped, hops capped.
 *      The untrusted-input failure mode for a router is unbounded work per event.
 */

function event(overrides: Partial<UniversalTelemetryEvent> = {}): UniversalTelemetryEvent {
  return {
    eventId: "evt-1",
    timestamp: "2026-10-04T12:00:00.000Z",
    metricName: "auth.login.failed",
    value: 12,
    metadata: { env: "prod", service: "gateway" },
    ...overrides,
  };
}

interface Recorder {
  dispatcher: SwarmDispatcher;
  seen: string[];
  dead: DeadLetterEntry[];
}

function build(options: { maxDeadLetters?: number; maxHops?: number; maxAgents?: number } = {}): Recorder {
  const seen: string[] = [];
  const dead: DeadLetterEntry[] = [];
  const dispatcher = new SwarmDispatcher({
    onDeadLetter: (entry) => dead.push(entry),
    ...options,
  });
  return { dispatcher, seen, dead };
}

/** An agent that records what it received. */
function agent(dispatcher: SwarmDispatcher, seen: string[], name: string, metricPrefixes: string[], tags?: Record<string, string>) {
  return dispatcher.register(name, {
    metricPrefixes,
    ...(tags === undefined ? {} : { tags }),
    handle: (received) => {
      seen.push(`${name}:${received.eventId}`);
    },
  });
}

/* -------------------------------------------------------------------------- */
/* ROUTING                                                                     */
/* -------------------------------------------------------------------------- */

test("a registered prefix receives its events and nothing else", async () => {
  const { dispatcher, seen } = build();
  assert.ok(agent(dispatcher, seen, "secops", ["auth."]).ok);

  await dispatcher.dispatch(event());
  assert.deepEqual(seen, ["secops:evt-1"], "the matching agent did not receive the event");

  await dispatcher.dispatch(event({ eventId: "evt-2", metricName: "infra.pod.restart" }));
  assert.deepEqual(seen, ["secops:evt-1"], "an agent received an event outside its prefix");
});

test("prefixes are ANCHORED: auth. does not match oauth.", async () => {
  // The failure this test exists for: `oauth.token.refresh` begins with the letters
  // a-f-t-h but is not authentication traffic, and a FinOps agent summarising it as
  // such is worse than not routing it at all.
  const { dispatcher, seen } = build();
  agent(dispatcher, seen, "secops", ["auth."]);

  await dispatcher.dispatch(event({ metricName: "oauth.token.refresh" }));
  assert.deepEqual(seen, [], "'auth.' matched 'oauth.token.refresh'");
});

test("an exact prefix does match a longer name", async () => {
  const { dispatcher, seen } = build();
  agent(dispatcher, seen, "secops", ["auth."]);
  await dispatcher.dispatch(event({ metricName: "auth.login.failed.by_ip" }));
  assert.deepEqual(seen, ["secops:evt-1"]);
});

test("metadata tags route by EXACT equality, all of them", async () => {
  const { dispatcher, seen } = build();
  agent(dispatcher, seen, "finops", [], { env: "prod", team: "payments" });

  await dispatcher.dispatch(event({ metadata: { env: "prod", team: "payments" } }));
  assert.deepEqual(seen, ["finops:evt-1"], "matching tags did not route");

  // One missing tag is enough to fail the match. "All of them" is the contract.
  await dispatcher.dispatch(event({ eventId: "evt-2", metadata: { env: "prod" } }));
  assert.deepEqual(seen, ["finops:evt-1"], "a partial tag match routed");

  // And a prefix must not satisfy a tag: prod does not capture production.
  await dispatcher.dispatch(event({ eventId: "evt-3", metadata: { env: "production", team: "payments" } }));
  assert.deepEqual(seen, ["finops:evt-1"], "'prod' matched 'production'");
});

test("tags NARROW a prefix match: both must hold", async () => {
  // The OR this replaced let one registration match an unbounded slice of the
  // firehose -- a tag like `env:prod` is true for most production traffic, so the
  // agent silently became the consumer of everything rather than of what it asked
  // for. Under AND a tag can only ever REDUCE what the prefix selected.
  const { dispatcher, seen } = build();
  agent(dispatcher, seen, "secops", ["auth."], { severity: "high" });

  await dispatcher.dispatch(event({ metricName: "auth.login.failed", metadata: { severity: "high" } }));
  assert.deepEqual(seen, ["secops:evt-1"], "the both-matching event was not delivered");

  // Right prefix, wrong tag: NARROWED OUT.
  await dispatcher.dispatch(event({ eventId: "evt-2", metricName: "auth.login.failed", metadata: { severity: "low" } }));
  assert.deepEqual(seen, ["secops:evt-1"], "the wrong tag still routed");

  // Right tag, wrong prefix: NARROWED OUT.
  await dispatcher.dispatch(event({ eventId: "evt-3", metricName: "billing.charge.failed", metadata: { severity: "high" } }));
  assert.deepEqual(seen, ["secops:evt-1"], "the right tag alone routed, so the tag did not narrow the prefix");

  // And an event missing the tag entirely is narrowed out too.
  await dispatcher.dispatch(event({ eventId: "evt-4", metricName: "auth.login.failed", metadata: { env: "prod" } }));
  assert.deepEqual(seen, ["secops:evt-1"], "a missing tag routed");
});

test("no tags falls back to prefix-only", async () => {
  const { dispatcher, seen } = build();
  agent(dispatcher, seen, "sre", ["infra.pod."]);

  await dispatcher.dispatch(event({ eventId: "evt-1", metricName: "infra.pod.restart", metadata: {} }));
  assert.deepEqual(seen, ["sre:evt-1"], "prefix-only did not fall back");

  await dispatcher.dispatch(event({ eventId: "evt-2", metricName: "infra.pod.crash", metadata: { anything: "at-all" } }));
  assert.deepEqual(seen, ["sre:evt-1", "sre:evt-2"], "extra metadata on a prefix-only agent stopped it matching");
});

test("tags with no prefixes match on tags alone", async () => {
  const { dispatcher, seen } = build();
  agent(dispatcher, seen, "finops", [], { env: "prod" });

  await dispatcher.dispatch(event({ metricName: "billing.charge.failed", metadata: { env: "prod" } }));
  assert.deepEqual(seen, ["finops:evt-1"]);

  await dispatcher.dispatch(event({ eventId: "evt-2", metricName: "billing.charge.failed", metadata: { env: "staging" } }));
  assert.deepEqual(seen, ["finops:evt-1"], "a tags-only agent matched the wrong tag");
});

test("an event matching two agents goes to BOTH", async () => {
  // An auth outage with a cost is genuinely two domains' business. Picking a winner
  // would be a claim about which mattered more, and this module is not entitled to
  // make it. Fan-out is still possible -- it just now takes two registrations that
  // each independently match, rather than one registration matching two ways.
  const { dispatcher, seen } = build();
  agent(dispatcher, seen, "secops", ["auth."]);
  agent(dispatcher, seen, "finops", [], { env: "prod" });

  const outcome = await dispatcher.dispatch(event());
  assert.ok(outcome.delivered.includes("secops") && outcome.delivered.includes("finops"));
  assert.equal(seen.length, 2);
});

test("an agent with no criteria matches NOTHING, not everything", async () => {
  const { dispatcher, seen, dead } = build();
  agent(dispatcher, seen, "typo", []);

  await dispatcher.dispatch(event());
  assert.deepEqual(seen, [], "an agent that registered no criteria received everything");
  assert.equal(dead[0]?.reason, "no-match", "and the event was not dead-lettered");
});

/* -------------------------------------------------------------------------- */
/* FAIL CLOSED                                                                 */
/* -------------------------------------------------------------------------- */

test("an unmatched event is DEAD-LETTERED and the dispatcher survives", async () => {
  const { dispatcher, seen, dead } = build();
  agent(dispatcher, seen, "secops", ["auth."]);

  const outcome = await dispatcher.dispatch(event({ eventId: "orphan", metricName: "nobody.knows.this" }));

  assert.equal(outcome.deadLettered, true);
  assert.equal(outcome.reason, "no-match");
  assert.deepEqual(seen, []);
  assert.equal(dead.length, 1);
  assert.equal(dead[0]?.event.eventId, "orphan", "the DLQ dropped the payload, so it cannot be replayed from");

  // And the stream continues: the next matching event still arrives.
  await dispatcher.dispatch(event({ eventId: "evt-2" }));
  assert.deepEqual(seen, ["secops:evt-2"]);
});

test("a thousand unmatched events neither throw nor crash", async () => {
  const { dispatcher, dead } = build();
  for (let i = 0; i < 1000; i += 1) {
    const outcome = await dispatcher.dispatch(event({ eventId: `orphan-${i}`, metricName: "unknown.metric" }));
    assert.equal(outcome.deadLettered, true);
  }
  assert.equal(dead.length, 1000);
  assert.equal(dispatcher.stats().unmatched, 1000);
});

test("a handler that throws costs ITSELF and not the swarm", async () => {
  const { dispatcher, dead } = build();
  const delivered: string[] = [];

  dispatcher.register("broken", { metricPrefixes: ["auth."], handle: () => { throw new Error("agent is on fire"); } });
  dispatcher.register("healthy", { metricPrefixes: ["auth."], handle: () => { delivered.push("ok"); } });

  const outcome = await dispatcher.dispatch(event());

  assert.deepEqual(outcome.delivered, ["healthy"], "one agent's fault cost the others their events");
  assert.deepEqual(outcome.failed, ["broken"]);
  assert.equal(dead[0]?.reason, "handler-threw");
  // Attributable by name, because an unnamed failure is an unattributable one.
  assert.equal(dead[0]?.agent, "broken");
  // No stack in the DLQ: it gets serialised into logs nobody can read past.
  assert.equal(JSON.stringify(dead[0]).includes("at Object."), false);
  assert.equal(dispatcher.stats().handlerFailures, 1);
});

test("an ASYNC handler that rejects is contained the same way", async () => {
  const { dispatcher, dead } = build();
  const delivered: string[] = [];
  dispatcher.register("broken", { metricPrefixes: ["auth."], handle: async () => { throw new Error("async failure"); } });
  dispatcher.register("healthy", { metricPrefixes: ["auth."], handle: async () => { delivered.push("ok"); } });

  const outcome = await dispatcher.dispatch(event());
  assert.deepEqual(outcome.delivered, ["healthy"]);
  assert.equal(dead[0]?.reason, "handler-threw");
});

test("an invalid event never reaches an agent and never throws", async () => {
  const { dispatcher, seen } = build();
  agent(dispatcher, seen, "secops", ["auth."]);

  // Not a valid envelope. The dispatcher re-validates, so a caller that built one
  // by hand cannot smuggle it past the schema by skipping the consumer.
  for (const bad of [null, 42, "a string", [], {}, { eventId: "x" }]) {
    const outcome = await dispatcher.dispatch(bad);
    assert.equal(outcome.deadLettered, true, `accepted ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(seen, [], "an invalid event reached an agent");
});

test("a stopped dispatcher refuses work instead of running it", async () => {
  const { dispatcher, seen, dead } = build();
  agent(dispatcher, seen, "secops", ["auth."]);
  dispatcher.stop();

  const outcome = await dispatcher.dispatch(event());
  assert.equal(outcome.reason, "stopped");
  assert.deepEqual(seen, []);
  assert.equal(dead[0]?.reason, "stopped");
});

/* -------------------------------------------------------------------------- */
/* BOUNDS                                                                      */
/* -------------------------------------------------------------------------- */

test("a re-dispatching agent is stopped by the hop limit", async () => {
  // Two agents that feed each other is an infinite loop with no stack overflow,
  // because every hop is a fresh call. The bound is the only thing that ends it.
  //
  // This test exists because the first version of the limit did NOT work: `hop` was
  // a defaulted parameter on `dispatch`, so `dispatcher.dispatch(event)` from inside
  // a handler reset it to zero and the loop ran 2366 times. The count is now carried
  // by `context.redispatch`, which a handler cannot reset.
  const { dispatcher, dead } = build({ maxHops: 2 });
  let hops = 0;

  dispatcher.register("a", {
    metricPrefixes: ["auth."],
    handle: async (_received, context) => {
      hops += 1;
      await context.redispatch();
    },
  });

  await dispatcher.dispatch(event({ eventId: "root" }));

  assert.ok(hops <= 3, `the loop ran ${hops} times, which is not bounded by maxHops=2`);
  assert.ok(dead.some((entry) => entry.reason === "hop-limit"), "the loop was never stopped by the hop limit");
  assert.equal(dispatcher.stats().hopLimitExceeded > 0, true);
});

test("redispatch cannot be used to reset the hop count", async () => {
  // The exact bypass the old signature allowed, asserted directly.
  const { dispatcher } = build({ maxHops: 1 });
  const depths: number[] = [];

  dispatcher.register("a", {
    metricPrefixes: ["auth."],
    handle: async (_received, context) => {
      depths.push(context.hop);
      await context.redispatch();
    },
  });

  await dispatcher.dispatch(event());
  assert.deepEqual(depths, [0, 1], "the hop count did not advance, or was reset mid-chain");
});

test("the registry is capped and a duplicate is refused rather than added twice", () => {
  const { dispatcher } = build({ maxAgents: 2 });

  assert.ok(agent(dispatcher, [], "a", ["x."]).ok);
  assert.ok(agent(dispatcher, [], "b", ["y."]).ok);
  // A full registry is refused, not grown: the registry is walked per event, so an
  // unbounded one is a latency bomb that only detonates under load.
  assert.equal(agent(dispatcher, [], "c", ["z."]).ok, false);
  assert.equal(dispatcher.stats().registered, 2);

  // A duplicate name would double-deliver every event to the same agent.
  assert.equal(agent(dispatcher, [], "a", ["x."]).ok, false);
  assert.equal(dispatcher.stats().registered, 2);

  assert.equal(dispatcher.unregister("a"), true);
  assert.ok(agent(dispatcher, [], "c", ["z."]).ok);
});

test("the dead-letter queue is bounded, oldest out first", () => {
  const { dispatcher } = build({ maxDeadLetters: 10 });
  for (let i = 0; i < 50; i += 1) {
    void dispatcher.dispatch(event({ eventId: `orphan-${i}`, metricName: "unknown.metric" }));
  }
  const dlq = dispatcher.deadLetters();
  // A DLQ that grows without bound is the memory leak it exists to diagnose.
  assert.equal(dlq.length, 10);
  assert.equal(dlq[0]?.event.eventId, "orphan-40", "the queue dropped the newest rather than the oldest");
});

/* -------------------------------------------------------------------------- */
/* THE BOUNDARY                                                                */
/* -------------------------------------------------------------------------- */

test("routing never emits a field that is not in the envelope", async () => {
  const { dispatcher, seen } = build();
  agent(dispatcher, seen, "secops", ["auth."]);

  const outcome: DispatchOutcome = await dispatcher.dispatch(event({ metricName: "auth.login.failed" }));
  const source: UniversalTelemetryEvent = event();
  // An agent receives the envelope and nothing else: no tenant override, no injected
  // routing hints, no source identifier the envelope does not define.
  assert.deepEqual(Object.keys(outcome).sort(), ["deadLettered", "delivered", "eventId", "failed"]);
  assert.deepEqual(Object.keys(source).sort(), ["eventId", "metadata", "metricName", "timestamp", "value"]);
});