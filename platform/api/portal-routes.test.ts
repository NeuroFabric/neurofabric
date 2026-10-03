import test from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryPortalStore,
  PORTAL_PROVIDER,
  PortalStoreFull,
  createPortalRoutes,
  validatePortalConfig,
} from "./portal-routes.ts";
import { CREDENTIAL_HEADER, staticVault, type GatewayToken } from "../omniroute/edge-security.ts";
import { DynamicAgentRegistry } from "../swarm/dynamic-registry.ts";

/** The owning tenant for the registry in these tests. There is no default bucket. */
const T = "acme";

/**
 * THE PORTAL API. Multi-tenancy, the credential boundary, and generation.
 *
 * The property that matters most is the FIRST one below: a PaaS that serves one
 * customer's layout to another has not had a bug, it has leaked. Tenant isolation
 * is therefore tested with two live credentials rather than one.
 */

const ACME: GatewayToken = { id: "acme", credential: "acme-value", providers: [PORTAL_PROVIDER] };
const GLOBEX: GatewayToken = { id: "globex", credential: "globex-value", providers: [PORTAL_PROVIDER] };

const as = (token: string) => ({ [CREDENTIAL_HEADER]: token });

const CONFIG = "/api/portal/config";
const AGENTS = "/api/portal/agents";
const SCHEMA = "/api/portal/schema";

function schema(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `${id} detector`,
    domain: "anomaly",
    version: "1.0.0",
    capabilities: [`watches ${id}`],
    streams: [],
    rules: [{ id: "r", kind: "missing-field", severity: "info", message: "m", field: "x" }],
    ...over,
  };
}

function harness(over: { store?: InMemoryPortalStore; tokens?: readonly GatewayToken[] } = {}) {
  const registry = new DynamicAgentRegistry();
  const store = over.store ?? new InMemoryPortalStore();
  const routes = createPortalRoutes({
    registry,
    store,
    vault: staticVault(over.tokens ?? [ACME, GLOBEX], "portal-test"),
  });
  return { registry, store, routes };
}

/* ------------------------------------------------------------------ */
/* THE TENANT BOUNDARY                                                 */
/* ------------------------------------------------------------------ */

test("AN UNPROVEN CALLER GETS 401 AND NO PORTAL", async () => {
  const { routes } = harness();

  const response = await routes.handle("GET", CONFIG);

  assert.equal(response.status, 401);
  assert.equal(JSON.stringify(response.body).includes("widget"), false);
});

test("A CREDENTIAL VALID FOR THE COMMAND CENTER CANNOT READ PORTALS", async () => {
  // One credential, one door. A shared value across surfaces is the whole attack
  // surface the moment one partner is compromised.
  const reader: GatewayToken = { id: "acme", credential: "reader-value", providers: ["command-center"] };
  const { routes } = harness({ tokens: [reader] });

  assert.equal((await routes.handle("GET", CONFIG, as("reader-value"))).status, 403);
});

test("ONE TENANT CANNOT READ ANOTHER TENANT'S STORED PORTAL", async () => {
  // The property this whole design exists for. Two live credentials, not one.
  const store = new InMemoryPortalStore();
  const { routes } = harness({ store });

  const written = validatePortalConfig({ title: "Acme internal", version: "1", widgets: [] }, "acme");
  assert.equal(written.ok, true);
  if (written.ok) store.put(written.config);

  const own = await routes.handle("GET", CONFIG, as("acme-value"));
  const other = await routes.handle("GET", CONFIG, as("globex-value"));

  assert.equal(JSON.parse(JSON.stringify(own.body)).config.title, "Acme internal");
  assert.equal(other.status, 200);
  assert.equal(JSON.stringify(other.body).includes("Acme internal"), false, "another tenant's title leaked");
  assert.equal(JSON.parse(JSON.stringify(other.body)).config.tenant, "globex");
});

test("THE TENANT COMES FROM THE PROVEN CREDENTIAL, NEVER FROM THE REQUEST", async () => {
  const { routes } = harness();

  // Even if a caller tries to name a tenant, the served config is addressed to the
  // token that was actually proven.
  const response = await routes.handle("GET", `${CONFIG}?tenant=globex`, as("acme-value"));

  assert.equal(JSON.parse(JSON.stringify(response.body)).config.tenant, "acme");
});

test("AN UNKNOWN PATH IS 404 BEFORE PROOF, AND NAMES NOTHING", async () => {
  const { routes } = harness();

  const response = await routes.handle("GET", "/api/portal/anything");

  assert.equal(response.status, 404);
  assert.equal(JSON.stringify(response.body).includes("portal"), false);
});

test("A REFUSAL NEVER CARRIES THE PRESENTED VALUE", async () => {
  const { routes } = harness();

  const response = await routes.handle("GET", CONFIG, as("a-guess-should-not-be-echoed"));

  assert.equal(JSON.stringify(response.body).includes("a-guess-should-not-be-echoed"), false);
});

/* ------------------------------------------------------------------ */
/* GENERATION                                                          */
/* ------------------------------------------------------------------ */

test("A TENANT WITH NO STORED CONFIG GETS A PORTAL DERIVED FROM ITS AGENTS", async () => {
  const { registry, routes } = harness();
  registry.register(schema("orders"), { tenant: T });

  const body = JSON.parse(JSON.stringify((await routes.handle("GET", CONFIG, as("acme-value"))).body));

  assert.equal(body.derived, true, "and it says it was derived, so the UI can offer to customise");
  assert.equal(body.config.tenant, "acme");
  assert.equal(body.config.dashboards.length, 1);
  assert.equal(body.config.dashboards[0].agentId, "acme/orders");
});

test("A STORED CONFIG OVERRIDES THE DERIVED ONE, AND SAYS IT IS NOT DERIVED", async () => {
  const store = new InMemoryPortalStore();
  const { registry, routes } = harness({ store });
  registry.register(schema("orders"), { tenant: T });
  const written = validatePortalConfig({ title: "Curated", version: "9", widgets: [] }, "acme");
  if (written.ok) store.put(written.config);

  const body = JSON.parse(JSON.stringify((await routes.handle("GET", CONFIG, as("acme-value"))).body));

  assert.equal(body.derived, false);
  assert.equal(body.config.title, "Curated");
});

test("A STORED CONFIG IS RE-VALIDATED ON READ, SO A BAD STORE SERVES 500 RATHER THAN GARBAGE", async () => {
  // The store is replaceable. A read path that trusted it would be one refactor
  // from serving a malformed layout to every tenant at once.
  const store = new InMemoryPortalStore();
  store.put({
    tenant: "acme",
    title: "Curated",
    version: "9",
    widgets: [{ id: "w", kind: "not-a-kind" as never, title: "w" }],
    forms: [],
    dashboards: [],
  });
  const { routes } = harness({ store });

  const response = await routes.handle("GET", CONFIG, as("acme-value"));

  assert.equal(response.status, 500);
  assert.equal(JSON.parse(JSON.stringify(response.body)).error, "the stored portal config is invalid");
});

test("AN EMPTY TENANT GETS AN EMPTY BUT VALID PORTAL, NOT A 404", async () => {
  const { routes } = harness();

  const response = await routes.handle("GET", CONFIG, as("acme-value"));

  assert.equal(response.status, 200);
  const body = JSON.parse(JSON.stringify(response.body));
  assert.deepEqual(body.config.widgets, []);
  assert.deepEqual(body.config.dashboards, []);
});

/* ------------------------------------------------------------------ */
/* PORTAL VALIDATION                                                   */
/* ------------------------------------------------------------------ */

test("A VALID PORTAL CONFIG VALIDATES, AND THE TENANT IS OURS TO SUPPLY", () => {
  const result = validatePortalConfig({
    title: "Ops",
    version: "1",
    widgets: [{ id: "w1", kind: "chart", title: "Latency", agentId: "perf", span: "24h" }],
    forms: [{ id: "f", title: "New", fields: [{ name: "a", label: "A", type: "text", required: true }] }],
    dashboards: [{ agentId: "perf", title: "Perf", layout: "grid", columns: 2 }],
  }, "acme");

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.config.tenant, "acme");
});

test("AN UNRECOGNISED PORTAL FIELD IS A MISSPELLING, AND IS REFUSED", () => {
  // `dashbords` is a portal that silently renders nothing, and nothing is the
  // hardest failure to notice.
  const result = validatePortalConfig({ title: "t", version: "1", dashbords: [] }, "acme");

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((issue) => issue.reason.includes("unrecognised")));
});

test("A MISSPELLED WIDGET KIND IS REFUSED RATHER THAN DEFAULTED", () => {
  const result = validatePortalConfig({
    title: "t", version: "1", widgets: [{ id: "w", kind: "graph", title: "W" }],
  }, "acme");

  assert.equal(result.ok, false);
});

test("A DASHBOARD WITH NO COLUMNS IN RANGE IS REFUSED", () => {
  for (const columns of [0, 13, 2.5]) {
    const result = validatePortalConfig({
      title: "t", version: "1", dashboards: [{ agentId: "a", title: "A", layout: "grid", columns }],
    }, "acme");
    assert.equal(result.ok, false, `accepted columns=${columns}`);
  }
});

test("A CONFIG THAT IS NOT AN OBJECT IS REFUSED", () => {
  for (const bad of [null, [], "ops", 7]) {
    assert.equal(validatePortalConfig(bad, "acme").ok, false);
  }
});

test("EVERY REFUSED PORTAL NAMES A PATH", () => {
  const result = validatePortalConfig({ title: "", version: "", widgets: [{}] }, "acme");

  assert.equal(result.ok, false);
  if (result.ok) return;
  for (const issue of result.issues) assert.ok(issue.path.startsWith("$"));
});

/* ------------------------------------------------------------------ */
/* THE SCHEMA WRITE PATH                                               */
/* ------------------------------------------------------------------ */

test("A VALID SCHEMA POSTED THROUGH THE API IS REGISTERED AND THEN READABLE", async () => {
  const { registry, routes } = harness();

  const written = await routes.handle("POST", SCHEMA, as("acme-value"), schema("orders"));
  assert.equal(written.status, 200);

  assert.equal(registry.get(T, "orders")?.id, "acme/orders");
  const read = await routes.handle("GET", `${SCHEMA}/orders`, as("acme-value"));
  assert.equal(JSON.parse(JSON.stringify(read.body)).schema.id, "orders");
});

test("AN INVALID SCHEMA POST IS A 400 WITH ITS ISSUES, AND REGISTERS NOTHING", async () => {
  const { registry, routes } = harness();

  const response = await routes.handle("POST", SCHEMA, as("acme-value"), { id: "broken" });
  const body = JSON.parse(JSON.stringify(response.body));

  assert.equal(response.status, 400);
  assert.ok(body.issues.length > 0);
  assert.equal(registry.size, 0, "a refused schema must not half-exist");
});

test("THE SCHEMA WRITE PATH IS PROVED LIKE EVERY OTHER PATH", async () => {
  const { registry, routes } = harness();

  const response = await routes.handle("POST", SCHEMA, {}, schema("orders"));

  assert.equal(response.status, 401);
  assert.equal(registry.size, 0);
});

test("THE AGENTS LISTING PUBLISHES MATURITY, SO A PORTAL ADMITS WHAT IS NOT BUILT", async () => {
  const { registry, routes } = harness();
  registry.register(schema("orders"), { tenant: T });

  const body = JSON.parse(JSON.stringify((await routes.handle("GET", AGENTS, as("acme-value"))).body));

  assert.equal(body.total, 1);
  assert.equal(body.ready, 1);
  assert.equal(body.stubCount, 0);
});

test("AN UNKNOWN SCHEMA ID IS 404", async () => {
  const { routes } = harness();

  assert.equal((await routes.handle("GET", `${SCHEMA}/nope`, as("acme-value"))).status, 404);
});

test("A READ-ONLY VERB OTHER THAN GET IS REFUSED ON A READ PATH", async () => {
  const { routes } = harness();

  for (const method of ["PUT", "DELETE", "PATCH"]) {
    assert.equal((await routes.handle(method, CONFIG, as("acme-value"))).status, 405);
  }
});

/* ------------------------------------------------------------------ */
/* THE STORE                                                           */
/* ------------------------------------------------------------------ */

test("THE STORE IS BOUNDED, AND A REFUSAL IS AN ERROR RATHER THAN AN EVICTION", async () => {
  // Evicting a tenant's portal silently would take a customer's screen away and
  // tell nobody.
  const store = new InMemoryPortalStore(2);
  const acme = validatePortalConfig({ title: "a", version: "1", widgets: [] }, "acme");
  const globex = validatePortalConfig({ title: "g", version: "1", widgets: [] }, "globex");
  const initech = validatePortalConfig({ title: "i", version: "1", widgets: [] }, "initech");
  if (acme.ok) store.put(acme.config);
  if (globex.ok) store.put(globex.config);

  assert.throws(() => {
    if (initech.ok) store.put(initech.config);
  }, PortalStoreFull);
  assert.equal(store.size, 2);
  assert.equal(store.refusals, 1);

  // Replacing an existing tenant is allowed at capacity: it is not a new tenant.
  const updated = validatePortalConfig({ title: "a2", version: "2", widgets: [] }, "acme");
  if (updated.ok) store.put(updated.config);
  assert.equal(store.size, 2);
});

test("A REMOVED PORTAL IS GONE, AND THE TENANT FALLS BACK TO A DERIVED ONE", async () => {
  const store = new InMemoryPortalStore();
  const { routes } = harness({ store });
  const written = validatePortalConfig({ title: "Curated", version: "1", widgets: [] }, "acme");
  if (written.ok) store.put(written.config);

  assert.equal(store.remove("acme"), true);
  const body = JSON.parse(JSON.stringify((await routes.handle("GET", CONFIG, as("acme-value"))).body));
  assert.equal(body.derived, true);
  assert.deepEqual(store.tenants(), []);
});

/* ------------------------------------------------------------------ */
/* HEADERS                                                             */
/* ------------------------------------------------------------------ */

test("PORTAL RESPONSES CARRY THE SAME SECURITY HEADERS AS THE COMMAND CENTER", async () => {
  // One control plane, applied by one constant. A second copy in a sibling route
  // file is how a response ends up without nosniff while its sibling has it.
  const { routes } = harness();

  const response = await routes.handle("GET", CONFIG, as("acme-value"));

  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.headers["content-type"] ?? "", /application\/json/);
});

test("AN EMPTY VAULT REFUSES EVERY PORTAL READ RATHER THAN SERVING A DEFAULT TENANT", async () => {
  const routes = createPortalRoutes({
    registry: new DynamicAgentRegistry(),
    store: new InMemoryPortalStore(),
    vault: staticVault([], "empty"),
  });

  assert.equal((await routes.handle("GET", CONFIG, as("acme-value"))).status, 401);
});
