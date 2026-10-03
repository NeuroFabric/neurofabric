import test from "node:test";
import assert from "node:assert/strict";

import { TenantRouter, createGateway, type GatewayOptions } from "./omniroute-gateway.ts";
import { CREDENTIAL_HEADER, type EdgeRequest, type GatewayToken } from "./edge-security.ts";
import { DynamicAgentRegistry } from "../swarm/dynamic-registry.ts";

/**
 * TENANT ROUTING. From a proven credential to that customer's agents, and to
 * nobody else's.
 *
 * The isolation here is STRUCTURAL -- a separate lane with its own agent set --
 * rather than a filter applied after the fact, because a filter is one forgotten
 * predicate away from a leak and a separate queue has nothing shared to leak
 * through. These tests are written to fail if that ever becomes a filter.
 */

const ACME: GatewayToken = { id: "acme", credential: "acme-value", providers: ["telemetry"] };
const GLOBEX: GatewayToken = { id: "globex", credential: "globex-value", providers: ["telemetry"] };

const as = (value: string): EdgeRequest => ({
  headers: { [CREDENTIAL_HEADER]: value },
  provider: "telemetry",
  events: 1,
});

function schema(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `${id} detector`,
    domain: "anomaly",
    version: "1.0.0",
    capabilities: [`watches ${id}`],
    streams: ["telemetry"],
    rules: [{ id: "big", kind: "threshold", severity: "critical", message: "over the limit", field: "amount", operator: ">", value: 1000 }],
    ...over,
  };
}

function harness(options: GatewayOptions = {}, routerOptions = {}) {
  const registry = new DynamicAgentRegistry();
  const router = new TenantRouter(registry, routerOptions);
  const gateway = createGateway({ tokens: [ACME, GLOBEX], ...options });
  gateway.attachTenantRouter(router);
  return { registry, router, gateway };
}

const money = (amount: string, stream = "telemetry") => ({ fields: { amount, stream } });

/**
 * Wait for the broker's async consumer to pick up what was pushed.
 *
 * The same helper the existing gateway suite uses, and for the same reason: the
 * broker drains its channel in a microtask, so a snapshot taken immediately after
 * a push legitimately reports zero records. That is the transport being
 * asynchronous, not the push being lost, and the distinction is exactly what these
 * two tests are checking.
 */
async function settle(broker: { snapshot(): { records: number } }, target: number): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (broker.snapshot().records < target && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/* ------------------------------------------------------------------ */
/* THE CORRELATION                                                     */
/* ------------------------------------------------------------------ */

test("AN EVENT REACHES THE SENDER'S AGENT AND NOBODY ELSE'S", async () => {
  const { registry, router } = harness();
  registry.register(schema("orders"), { tenant: "acme" });
  registry.register(schema("payments"), { tenant: "globex" });

  await router.route("acme", money("5000"));
  await router.settled();

  assert.equal(router.latest("acme")?.agentId, "acme/orders");
  assert.equal(router.latest("globex"), undefined, "another tenant's lane saw nothing at all");
  assert.equal(router.stats("globex").accepted, 0);
});

test("THE TENANT IS THE PROVEN CREDENTIAL'S ID, AND A REFUSED PUSH ROUTES NOTHING", async () => {
  const { registry, router, gateway } = harness();
  registry.register(schema("orders"), { tenant: "acme" });

  const refused = gateway.pushToTenant(as("a-guess"), { fields: { amount: "5000", stream: "telemetry" } });
  await router.settled();

  assert.equal(refused.ok, false);
  assert.equal(router.latest("acme"), undefined, "an unproven caller reached no lane");
  assert.equal(router.stats("acme").accepted, 0);
});

test("ONE TENANT'S ANOMALY NEVER APPEARS IN ANOTHER TENANT'S VERDICT", async () => {
  // The property stated as an assertion about findings, not about routing: the
  // value that trips acme's rule is ordinary to globex, and a leak would show up
  // as globex's verdict carrying acme's finding.
  const { registry, router } = harness();
  registry.register(schema("orders"), { tenant: "acme" });
  registry.register(schema("payments"), { tenant: "globex" });

  await router.route("acme", money("99999"));
  await router.route("globex", money("12"));
  await router.settled();

  assert.equal(router.latest("acme")?.findings.length, 1);
  assert.equal(router.latest("globex")?.findings.length, 0);
  assert.equal(router.latest("globex")?.stats?.eventsRead, 1);
});

test("A TENANT WITH NO AGENT IS TOLD SO, RATHER THAN BEING SILENTLY SWALLOWED", async () => {
  const { registry, router } = harness();
  registry.register(schema("orders"), { tenant: "acme" });

  const outcome = router.route("initech", money("5000"));

  assert.equal(outcome.accepted, false);
  assert.equal(outcome.unrouted, true);
  assert.deepEqual(outcome.agentIds, []);
});

test("AN AGENT IS ONLY FED THE STREAMS IT DECLARED", async () => {
  const { registry, router } = harness();
  registry.register(schema("orders", { streams: ["payments"] }), { tenant: "acme" });

  const wrong = router.route("acme", money("5000", "telemetry"));
  const right = router.route("acme", money("5000", "payments"));
  await router.settled();

  assert.equal(wrong.unrouted, true, "the agent declared another stream");
  assert.equal(right.accepted, true);
  assert.equal(router.latest("acme")?.agentId, "acme/orders");
});

test("AN AGENT THAT DECLARED NO STREAMS CONSUMES EVERY STREAM", async () => {
  const { registry, router } = harness();
  registry.register(schema("catchall", { streams: [] }), { tenant: "acme" });

  router.route("acme", money("5000", "anything-at-all"));
  await router.settled();

  assert.equal(router.latest("acme")?.findings.length, 1);
});

/* ------------------------------------------------------------------ */
/* HOT LOADING                                                         */
/* ------------------------------------------------------------------ */

test("A SCHEMA CREATED AFTER THE ROUTER WAS ATTACHED IS ALREADY REACHABLE", async () => {
  // No cache, no invalidation: the agent set is resolved from the registry on every
  // route, so a rule written a moment ago is live. A cache would need invalidating,
  // and a stale cache presents as "the customer's new rule never fired".
  const { registry, router } = harness();

  assert.equal(router.route("acme", money("5000")).unrouted, true);

  registry.register(schema("orders"), { tenant: "acme" });
  await router.route("acme", money("5000"));
  await router.settled();

  assert.equal(router.latest("acme")?.agentId, "acme/orders");
});

test("AN UPGRADED SCHEMA TAKES EFFECT WITH THE SAME ROUTER ATTACHED", async () => {
  const { registry, router } = harness();
  registry.register(schema("orders", { version: "1.0.0" }), { tenant: "acme" });

  registry.register(schema("orders", { version: "2.0.0" }), { tenant: "acme" });
  await router.route("acme", money("5000"));
  await router.settled();

  assert.equal(router.latest("acme")?.findings.length, 1);
  assert.equal(router.latest("acme")?.agentId, "acme/orders", "the same id, a recompiled rule set");
});

/* ------------------------------------------------------------------ */
/* BOUNDS                                                              */
/* ------------------------------------------------------------------ */

test("A LANE AT CAPACITY DROPS AND COUNTS, RATHER THAN GROWING", async () => {
  // "Exclusively to it" is only true while the lane keeps up. An unbounded queue is
  // a memory leak reachable by anyone holding a credential, reached by sending
  // ordinary traffic during an incident.
  const { registry, router } = harness({}, { laneDepth: 4 });
  registry.register(schema("orders"), { tenant: "acme" });

  let dropped = 0;
  for (let i = 0; i < 40; i += 1) {
    if (!router.route("acme", money("5000")).accepted) dropped += 1;
  }
  await router.settled();

  assert.ok(dropped > 0, "the lane filled and refused");
  assert.equal(router.stats("acme").dropped, dropped);
  assert.ok((router.stats("acme").accepted ?? 0) <= 40);
});

test("THE VERDICT HISTORY IS A RING, NOT A LIST THAT GROWS FOR EVER", async () => {
  const { registry, router } = harness({}, { verdictRing: 3 });
  registry.register(schema("orders"), { tenant: "acme" });

  for (let i = 0; i < 20; i += 1) {
    router.route("acme", money("5000"));
    await router.settled();
  }

  assert.equal(router.history("acme").length, 3, "bounded by the ring");
});

test("EVERY EVENT IS JUDGED EXACTLY ONCE, WITH NO OVERLAPPING DRAINS", async () => {
  // Two concurrent drains would each pull half the queue and each report half the
  // events, so a verdict would describe a fraction while claiming to describe all.
  const { registry, router } = harness();
  registry.register(schema("orders"), { tenant: "acme" });

  for (let i = 0; i < 200; i += 1) router.route("acme", money("5000"));
  await router.settled();

  const stats = router.latest("acme")?.stats;
  let total = 0;
  for (const result of router.history("acme")) total += result.stats?.eventsRead ?? 0;

  assert.equal(total, 200, "every event was judged, and none twice");
  assert.ok(stats !== undefined);
});

test("EVENTS ARRIVING DURING A DRAIN ARE STILL JUDGED", async () => {
  // The failure this prevents: a drain that takes one batch and stops leaves the
  // next event sitting in the queue, and the tenant silently stops being
  // diagnosed at exactly the moment they are busiest.
  const { registry, router } = harness();
  registry.register(schema("orders"), { tenant: "acme" });

  router.route("acme", money("5000"));
  router.route("acme", money("6000"));
  router.route("acme", money("7000"));
  await router.settled();

  let total = 0;
  for (const result of router.history("acme")) total += result.stats?.eventsRead ?? 0;
  assert.equal(total, 3);
});

/* ------------------------------------------------------------------ */
/* GATEWAY WIRING                                                      */
/* ------------------------------------------------------------------ */

test("AN ADMITTED PUSH GOES TO THE TENANT LANE, NOT TO THE PROVIDER BROKER", async () => {
  const { registry, router, gateway } = harness();
  registry.register(schema("orders"), { tenant: "acme" });
  gateway.connect({ name: "telemetry", keyColumn: "amount", timeColumn: "at" });

  gateway.pushAdmitted(as("acme-value"), { fields: { amount: "5000", stream: "telemetry" } });
  await router.settled();

  assert.equal(router.latest("acme")?.findings.length, 1);
  assert.equal(gateway.snapshot("telemetry")[0]?.records, 0, "and did not also sit in the shared broker");
});

test("WITHOUT A ROUTER THE PROVIDER BROKER PATH IS EXACTLY AS IT WAS", async () => {
  // Attaching a router REDIRECTS admitted pushes, and that is a behaviour change.
  // It is stated rather than buried, and this test is what says the old path still
  // works when nothing is attached.
  const gateway = createGateway({ tokens: [ACME] });
  gateway.connect({ name: "telemetry", keyColumn: "amount", timeColumn: "at" });

  gateway.pushAdmitted(as("acme-value"), { fields: { amount: "5000" } });
  await settle(gateway.brokerFor("telemetry")!, 1);

  assert.ok((gateway.snapshot("telemetry")[0]?.records ?? 0) > 0);
});

test("A REFUSED PUSH IS REFUSED BEFORE ANY LANE IS TOUCHED", async () => {
  const { registry, router, gateway } = harness();
  registry.register(schema("orders"), { tenant: "acme" });

  const revoked: GatewayToken = { ...ACME, revoked: true };
  const strict = createGateway({ tokens: [revoked] });
  const attached = new TenantRouter(registry);
  strict.attachTenantRouter(attached);

  const decision = strict.pushAdmitted(as("acme-value"), { fields: { amount: "5000", stream: "telemetry" } });
  await attached.settled();

  assert.equal(decision.ok, false);
  assert.equal(attached.stats("acme").accepted, 0);
});

test("DETACHING THE ROUTER RESTORES THE LEGACY PATH", async () => {
  const { registry, router, gateway } = harness();
  registry.register(schema("orders"), { tenant: "acme" });
  gateway.connect({ name: "telemetry", keyColumn: "amount", timeColumn: "at" });

  const detach = gateway.attachTenantRouter(router);
  gateway.pushAdmitted(as("acme-value"), { fields: { amount: "5000", stream: "telemetry" } });
  await router.settled();
  assert.equal(gateway.snapshot("telemetry")[0]?.records, 0);

  detach();
  gateway.pushAdmitted(as("acme-value"), { fields: { amount: "5000" } });
  await settle(gateway.brokerFor("telemetry")!, 1);

  assert.ok((gateway.snapshot("telemetry")[0]?.records ?? 0) > 0);
  assert.equal(router.stats("acme").accepted, 1, "and the lane saw nothing more");
});

test("THE ROUTING DECISION NAMES THE AGENTS IT REACHED", async () => {
  const { registry, router } = harness();
  registry.register(schema("orders"), { tenant: "acme" });
  registry.register(schema("ledger"), { tenant: "acme" });

  const outcome = router.route("acme", money("5000"));

  assert.deepEqual(outcome.agentIds.sort(), ["acme/ledger", "acme/orders"]);
  assert.equal(outcome.tenant, "acme");
});

test("GLOBAL STATS AGGREGATE WITHOUT NAMING ANY TENANT'S AGENTS", async () => {
  const { registry, router } = harness();
  registry.register(schema("orders"), { tenant: "acme" });
  registry.register(schema("payments"), { tenant: "globex" });

  await router.route("acme", money("5000"));
  await router.route("globex", money("5000"));
  await router.settled();

  const stats = router.stats();
  assert.equal(stats.tenants, 2);
  assert.equal(stats.routed, 2);
  assert.equal(stats.accepted, 2);
  assert.equal(stats.dropped, 0);
});

test("STATISTICS FOR AN UNKNOWN TENANT ARE ZEROS, NOT A CRASH", () => {
  const { router } = harness();

  assert.equal(router.stats("nobody").accepted, 0);
  assert.deepEqual(router.history("nobody"), []);
  assert.equal(router.latest("nobody"), undefined);
});
