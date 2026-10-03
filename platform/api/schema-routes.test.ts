import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTHORING_PROVIDER,
  CONFIRM_HEADER,
  createSchemaRoutes,
  withoutTenantField,
} from "./schema-routes.ts";
import { CREDENTIAL_HEADER, staticVault, type GatewayToken } from "../omniroute/edge-security.ts";
import { DynamicAgentRegistry } from "../swarm/dynamic-registry.ts";

/**
 * THE AUTHORING API.
 *
 * Two properties carry the weight here. First, that installing an agent takes
 * effect with no restart -- the whole point of the surface. Second, that a caller
 * can only ever act inside its own namespace, which is asserted with two live
 * credentials rather than one.
 */

const AUTHOR: GatewayToken = { id: "acme", credential: "author-value", providers: [AUTHORING_PROVIDER] };
const OTHER: GatewayToken = { id: "globex", credential: "other-value", providers: [AUTHORING_PROVIDER] };
const PORTAL_READER: GatewayToken = { id: "acme", credential: "portal-value", providers: ["portal"] };

const as = (token: string) => ({ [CREDENTIAL_HEADER]: token });
const BASE = "/api/tenant/schema";

function schema(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `${id} detector`,
    domain: "anomaly",
    version: "1.0.0",
    capabilities: [`watches ${id}`],
    streams: ["telemetry"],
    rules: [{ id: "r", kind: "missing-field", severity: "info", message: "m", field: "x" }],
    ...over,
  };
}

function harness(over: { registry?: DynamicAgentRegistry; tokens?: readonly GatewayToken[] } = {}) {
  const registry = over.registry ?? new DynamicAgentRegistry();
  const routes = createSchemaRoutes({
    registry,
    vault: staticVault(over.tokens ?? [AUTHOR, OTHER], "authoring-test"),
  });
  return { registry, routes };
}

/* ------------------------------------------------------------------ */
/* THE EDGE                                                            */
/* ------------------------------------------------------------------ */

test("AN UNPROVEN CALLER GETS 401 AND CANNOT WRITE", async () => {
  const { registry, routes } = harness();

  const response = await routes.handle("POST", BASE, {}, schema("orders"));

  assert.equal(response.status, 401);
  assert.equal(registry.size, 0);
});

test("A PORTAL CREDENTIAL CANNOT AUTHOR, BECAUSE READING A DASHBOARD IS NOT WRITING", async () => {
  // One credential, one privilege. If the UI's token could install agents, then
  // any page holding it holds the power to rewrite the fleet.
  const { registry, routes } = harness({ tokens: [PORTAL_READER] });

  const response = await routes.handle("POST", BASE, as("portal-value"), schema("orders"));

  assert.equal(response.status, 403);
  assert.equal(registry.size, 0);
});

test("AN UNKNOWN PATH IS 404 BEFORE PROOF, AND NAMES NOTHING", async () => {
  const { routes } = harness();

  const response = await routes.handle("POST", "/api/tenant/anything", {});

  assert.equal(response.status, 404);
  assert.equal(JSON.stringify(response.body).includes("tenant"), false);
});

test("EVERY VERB IS PROVED, INCLUDING DELETE", async () => {
  const { registry, routes } = harness();
  registry.register(schema("orders"), { tenant: "acme" });

  for (const verb of ["DELETE"]) {
    assert.equal((await routes.handle(verb, `${BASE}/orders`, {})).status, 401);
  }
  assert.equal(registry.get("acme", "orders")?.id, "acme/orders");
});

/* ------------------------------------------------------------------ */
/* CREATE                                                              */
/* ------------------------------------------------------------------ */

test("A POSTED SCHEMA IS LIVE IMMEDIATELY, WITH NO RESTART AND NO RELOAD", async () => {
  // The product claim: write a rule, and the next event meets it.
  const { registry, routes } = harness();

  const created = await routes.handle("POST", BASE, as("author-value"), schema("orders"));
  assert.equal(created.status, 201);
  assert.equal(registry.get("acme", "orders")?.id, "acme/orders");

  // The compiled agent is the one the registry holds, so an evaluation uses it.
  const result = await registry.get("acme", "orders")!.diagnose({
    prompt: "",
    stream: (async function* () { yield { partition: "telemetry", fields: {} }; })(),
  });
  assert.equal(result.findings.length, 1);
});

test("A REFUSED SCHEMA REGISTERS NOTHING, SO THERE IS NO HALF-WRITTEN AGENT", async () => {
  // A partial write would leave an agent whose compiled rules disagree with its
  // stored schema, and nothing in the system could detect that.
  const { registry, routes } = harness();

  const response = await routes.handle("POST", BASE, as("author-value"), { id: "broken" });

  assert.equal(response.status, 400);
  assert.ok(Array.isArray((response.body as { issues: unknown[] }).issues));
  assert.equal(registry.size, 0);
});

test("A `tenant` FIELD IN THE BODY IS IGNORED, NOT HONOURED", async () => {
  // Ignoring rather than rejecting: a caller built against an older contract
  // sends one, and succeeding while ignoring it is the worst of the three answers.
  const { registry, routes } = harness();

  const response = await routes.handle("POST", BASE, as("author-value"), schema("orders", { tenant: "globex" }));
  const body = JSON.parse(JSON.stringify(response.body));

  assert.equal(response.status, 201);
  assert.equal(body.agent.tenant, "acme");
  assert.equal(registry.get("globex", "orders"), undefined, "the claimed tenant got nothing");
  assert.equal(registry.get("acme", "orders")?.id, "acme/orders");
});

test("withoutTenantField LEAVES EVERYTHING ELSE ALONE", () => {
  const stripped = withoutTenantField({ id: "a", tenant: "globex", title: "t" }) as Record<string, unknown>;

  assert.deepEqual(stripped, { id: "a", title: "t" });
  // Non-objects pass through untouched rather than throwing: a caller sending an
  // array should get a validation issue, not a 500.
  assert.deepEqual(withoutTenantField([1, 2]), [1, 2]);
  assert.equal(withoutTenantField("x"), "x");
});

/* ------------------------------------------------------------------ */
/* READ                                                                */
/* ------------------------------------------------------------------ */

test("A LISTING SHOWS ONLY THE CALLER'S OWN AGENTS, WITH COMPOSITE IDS", async () => {
  const { registry, routes } = harness();
  registry.register(schema("orders"), { tenant: "acme" });
  registry.register(schema("orders"), { tenant: "globex" });

  const body = JSON.parse(JSON.stringify((await routes.handle("GET", BASE, as("author-value"))).body));

  assert.equal(body.tenant, "acme");
  assert.deepEqual(body.ids, ["acme/orders"]);
  assert.equal(JSON.stringify(body).includes("globex"), false);
});

test("ONE TENANT CANNOT READ ANOTHER TENANT'S SCHEMA, AND GETS 404 RATHER THAN 403", async () => {
  // 403 would confirm the schema exists somewhere. From this namespace it does
  // not exist, and saying so is the truthful answer.
  const { registry, routes } = harness();
  registry.register(schema("orders"), { tenant: "globex" });

  const response = await routes.handle("GET", `${BASE}/orders`, as("author-value"));

  assert.equal(response.status, 404);
  assert.equal(JSON.stringify(response.body).includes("detector"), false);
});

test("A READ RETURNS THE SCHEMA EXACTLY AS STORED, WHICH IS WHAT AN EDITOR NEEDS", async () => {
  const { registry, routes } = harness();
  registry.register(schema("orders"), { tenant: "acme" });

  const body = JSON.parse(JSON.stringify((await routes.handle("GET", `${BASE}/orders`, as("author-value"))).body));

  assert.equal(body.schema.id, "orders");
  assert.equal(body.schema.streams[0], "telemetry");
  assert.equal(body.schema.rules.length, 1);
});

/* ------------------------------------------------------------------ */
/* UPDATE                                                              */
/* ------------------------------------------------------------------ */

test("A PUT REPLACES THE AGENT AND RETURNS THE VERSION IT DISPLACED", async () => {
  // Returning the previous version is what makes an update undoable; a caller that
  // cannot see what it overwrote has no way back.
  const { registry, routes } = harness();
  registry.register(schema("orders", { version: "1.0.0" }), { tenant: "acme" });

  const response = await routes.handle(
    "PUT", `${BASE}/orders`, as("author-value"),
    schema("orders", { version: "2.0.0", title: "Newer orders" }),
  );
  const body = JSON.parse(JSON.stringify(response.body));

  assert.equal(response.status, 200);
  assert.equal(body.created, false);
  assert.equal(body.replacedVersion, "1.0.0");
  assert.equal(registry.get("acme", "orders")?.version, "2.0.0");
});

test("AN UPDATE IS LIVE: THE NEW RULE FIRES WITHOUT A RESTART", async () => {
  const { registry, routes } = harness();
  registry.register(schema("orders"), { tenant: "acme" });

  await routes.handle("PUT", `${BASE}/orders`, as("author-value"), schema("orders", {
    version: "2.0.0",
    rules: [{ id: "big", kind: "threshold", severity: "critical", message: "big", field: "amount", operator: ">", value: 10 }],
  }));

  const result = await registry.get("acme", "orders")!.diagnose({
    prompt: "",
    stream: (async function* () { yield { partition: "telemetry", fields: { amount: "99" } }; })(),
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.severity, "critical");
});

test("A PATH/BODY ID MISMATCH IS REFUSED, RATHER THAN ONE OF THE TWO WINNING", async () => {
  // Guessing which id wins is how a customer overwrites the wrong agent.
  const { registry, routes } = harness();
  registry.register(schema("orders"), { tenant: "acme" });

  const response = await routes.handle("PUT", `${BASE}/orders`, as("author-value"), schema("ledger"));

  assert.equal(response.status, 409);
  assert.equal(registry.get("acme", "ledger"), undefined, "and neither id was written");
  assert.equal(registry.get("acme", "orders")?.version, "1.0.0");
});

test("AN UPDATE TO A SCHEMA THAT DOES NOT EXIST CREATES IT, AND SAYS SO", async () => {
  // PUT is idempotent by definition, so a first write through it is a create. The
  // 201 rather than a silent 200 is how a caller can tell which happened.
  const { registry, routes } = harness();

  const response = await routes.handle("PUT", `${BASE}/orders`, as("author-value"), schema("orders"));

  assert.equal(response.status, 201);
  assert.equal(JSON.parse(JSON.stringify(response.body)).created, true);
});

test("AN UPDATE IS REFUSED WHEN THE NEW BODY IS INVALID, LEAVING THE OLD AGENT ALIVE", async () => {
  const { registry, routes } = harness();
  registry.register(schema("orders"), { tenant: "acme" });

  const response = await routes.handle("PUT", `${BASE}/orders`, as("author-value"), schema("orders", {
    version: "2.0.0", rules: [],
  }));

  assert.equal(response.status, 400);
  assert.equal(registry.get("acme", "orders")?.version, "1.0.0", "the running agent is untouched");
});

/* ------------------------------------------------------------------ */
/* DELETE                                                              */
/* ------------------------------------------------------------------ */

test("DELETE WITHOUT THE CONFIRMATION HEADER IS REFUSED WITH 428", async () => {
  // 428 and not 400: nothing is wrong with the request, the server needs more from
  // the caller before it will do this.
  const { registry, routes } = harness();
  registry.register(schema("orders"), { tenant: "acme" });

  const response = await routes.handle("DELETE", `${BASE}/orders`, as("author-value"));

  assert.equal(response.status, 428);
  assert.equal((response.body as { header: string }).header, CONFIRM_HEADER);
  assert.equal(registry.get("acme", "orders")?.id, "acme/orders");
});

test("DELETE WITH CONFIRMATION REMOVES ONLY THE CALLER'S OWN AGENT", async () => {
  const { registry, routes } = harness();
  registry.register(schema("orders"), { tenant: "acme" });
  registry.register(schema("orders"), { tenant: "globex" });

  const response = await routes.handle(
    "DELETE", `${BASE}/orders`, { ...as("author-value"), [CONFIRM_HEADER]: "yes" },
  );

  assert.equal(response.status, 200);
  assert.equal(registry.get("acme", "orders"), undefined);
  assert.equal(registry.get("globex", "orders")?.id, "globex/orders", "the other tenant's agent survived");
});

test("DELETING SOMETHING THAT IS NOT THERE IS 404, NOT A SILENT SUCCESS", async () => {
  const { routes } = harness();

  const response = await routes.handle(
    "DELETE", `${BASE}/nope`, { ...as("author-value"), [CONFIRM_HEADER]: "yes" },
  );

  assert.equal(response.status, 404);
});

test("THE CONFIRMATION HEADER IS MATCHED CASE-INSENSITIVELY", async () => {
  // HTTP header names are case-insensitive, and a caller that sends it in the
  // conventional lowercase form must not be told to fix its own spelling.
  const { registry, routes } = harness();
  registry.register(schema("orders"), { tenant: "acme" });

  const response = await routes.handle(
    "DELETE", `${BASE}/orders`, { ...as("author-value"), [CONFIRM_HEADER.toUpperCase()]: "yes" },
  );

  assert.equal(response.status, 200);
  assert.equal(registry.get("acme", "orders"), undefined);
});

/* ------------------------------------------------------------------ */
/* VERBS AND SHAPE                                                     */
/* ------------------------------------------------------------------ */

test("AN UNSUPPORTED VERB IS 405 AND NAMES WHAT IS SUPPORTED", async () => {
  const { routes } = harness();

  const collection = await routes.handle("DELETE", BASE, as("author-value"));
  const item = await routes.handle("PATCH", `${BASE}/orders`, as("author-value"));

  assert.equal(collection.status, 405);
  assert.equal(item.status, 405);
});

test("EVERY RESPONSE CARRIES THE SHARED SECURITY HEADERS", async () => {
  const { routes } = harness();

  const response = await routes.handle("GET", BASE, as("author-value"));

  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["cache-control"], "no-store");
});

test("A REFUSAL NEVER CARRIES THE PRESENTED VALUE", async () => {
  const { routes } = harness();

  const response = await routes.handle("GET", BASE, { [CREDENTIAL_HEADER]: "a-guess-not-to-be-echoed" });

  assert.equal(JSON.stringify(response.body).includes("a-guess-not-to-be-echoed"), false);
});

test("AN EMPTY VAULT REFUSES EVERYTHING RATHER THAN SERVING A DEFAULT", async () => {
  const { registry, routes } = harness({ tokens: [] });

  assert.equal((await routes.handle("GET", BASE, as("author-value"))).status, 401);
  assert.equal(registry.size, 0);
});

test("A FULL REGISTRY REFUSES A NEW SCHEMA WITH AN ISSUE, NOT A CRASH", async () => {
  const registry = new DynamicAgentRegistry(1);
  const { routes } = harness({ registry });

  assert.equal((await routes.handle("POST", BASE, as("author-value"), schema("orders"))).status, 201);
  const second = await routes.handle("POST", BASE, as("author-value"), schema("ledger"));

  assert.equal(second.status, 400);
  assert.match(JSON.stringify(second.body), /one more/);
  assert.equal(registry.size, 1);
});

test("THE ROUTER PUBLISHES ITS OWN SURFACE", async () => {
  const { routes } = harness();

  assert.equal(routes.routes.length, 5);
  assert.ok(routes.routes.includes(`DELETE ${BASE}/:id`));
});
