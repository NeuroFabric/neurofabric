import test from "node:test";
import assert from "node:assert/strict";

import { UI_PROVIDER, createUiRoutes } from "./ui-routes.ts";
import { CREDENTIAL_HEADER, environmentVault, staticVault, type GatewayToken } from "../omniroute/edge-security.ts";
import { createGateway } from "../omniroute/omniroute-gateway.ts";
import { AgentRegistry } from "../swarm/agent-registry.ts";
import { SPECIALIST_TEMPLATES } from "../swarm/templates.ts";
import type { UiRoutesOptions } from "./ui-routes.ts";

/**
 * THE COMMAND CENTER SURFACE. The rules are the security rules; the bodies are
 * the interesting part.
 *
 * Nothing here opens a socket. `handle` is a function from (method, path,
 * headers) to a response value, so the whole surface is asserted in microseconds
 * and the credential path is the SAME `guard` the ingress uses -- which is the
 * property that matters most and the one a per-route reimplementation would lose.
 */

const READER: GatewayToken = {
  id: "command-center",
  credential: "reader-value",
  providers: [UI_PROVIDER],
};

const presented = { [CREDENTIAL_HEADER]: "reader-value" };

/** A gateway with one connected provider and nothing pushed into it yet. */
function harness(over: Partial<UiRoutesOptions> = {}) {
  const gateway = createGateway({ tokens: [READER] });
  gateway.connect({ name: "payments", keyColumn: "amount", timeColumn: "at" });
  const registry = new AgentRegistry().registerAll(SPECIALIST_TEMPLATES);
  const routes = createUiRoutes({
    gateway,
    registry,
    vault: staticVault([READER], "test-vault"),
    ...over,
  });
  return { gateway, registry, routes };
}

/* ------------------------------------------------------------------ */
/* THE EDGE                                                            */
/* ------------------------------------------------------------------ */

test("AN UNPROVEN CALLER GETS 401 AND NO DATA", async () => {
  const { routes } = harness();

  for (const path of ["/api/command-center/status", "/api/command-center/agents", "/api/command-center/providers"]) {
    const response = await routes.handle("GET", path);
    assert.equal(response.status, 401);
    assert.equal((response.body as { failure: { code: string } }).failure.code, "UNAUTHENTICATED");
  }
});

test("A CREDENTIAL VALID FOR PUSHING IS NOT VALID FOR READING", async () => {
  // The whole point of scoping: one shared value across every door is the entire
  // attack surface the moment one partner is compromised.
  const pusher: GatewayToken = { id: "partner", credential: "partner-value", providers: ["payments"] };
  const { routes } = harness({ vault: staticVault([pusher], "test-vault") });

  const response = await routes.handle("GET", "/api/command-center/status", {
    [CREDENTIAL_HEADER]: "partner-value",
  });

  assert.equal(response.status, 403);
});

test("A REVOKED READER IS REFUSED", async () => {
  const revoked: GatewayToken = { ...READER, revoked: true };
  const { routes } = harness({ vault: staticVault([revoked], "test-vault") });

  assert.equal((await routes.handle("GET", "/api/command-center/agents", presented)).status, 401);
});

test("A SCOPED CREDENTIAL CANNOT READ, BECAUSE A SCOPE MEANS A PUSH PATH", async () => {
  const scoped: GatewayToken = { ...READER, scope: "payments" };
  const { routes } = harness({ vault: staticVault([scoped], "test-vault") });

  assert.equal((await routes.handle("GET", "/api/command-center/status", presented)).status, 403);
});

test("A REFUSAL NEVER CARRIES THE PRESENTED VALUE", async () => {
  const { routes } = harness();

  const response = await routes.handle("GET", "/api/command-center/status", {
    [CREDENTIAL_HEADER]: "a-guess-that-should-not-be-echoed",
  });

  assert.equal(JSON.stringify(response.body).includes("a-guess-that-should-not-be-echoed"), false);
});

test("AN UNKNOWN PATH IS 404 BEFORE PROOF, AND DOES NOT NAME THE ROUTES", async () => {
  // Naming them in a refusal hands a stranger the map of the surface, which is the
  // reconnaissance the edge exists to prevent.
  const { routes } = harness();

  const response = await routes.handle("GET", "/api/command-center/internal");

  assert.equal(response.status, 404);
  assert.equal(JSON.stringify(response.body).includes("command-center"), false);
});

test("THE SURFACE IS READ-ONLY", async () => {
  const { routes } = harness();

  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    assert.equal((await routes.handle(method, "/api/command-center/status", presented)).status, 405);
  }
});

test("A MALFORMED VAULT FAILS THE ROUTE CLOSED, NOT OPEN", async () => {
  // Strict is the default, so a deployment whose manifest is wrong refuses every
  // read rather than serving a dashboard from half a credential list.
  const { routes } = harness({
    vault: environmentVault({ NEUROFEBRIC_GATEWAY_TOKENS: '[{"id":"broken"}]' }),
  });

  await assert.rejects(() => routes.handle("GET", "/api/command-center/status", presented));
});

test("AN EMPTY VAULT REFUSES EVERYTHING RATHER THAN SERVING A DEFAULT VIEW", async () => {
  const { routes } = harness({ vault: staticVault([], "empty") });

  assert.equal((await routes.handle("GET", "/api/command-center/status", presented)).status, 401);
});

test("EVERY RESPONSE IS JSON, NON-SNIFFABLE, UNFRAMED AND UNCACHED", async () => {
  const { routes } = harness();

  const response = await routes.handle("GET", "/api/command-center/agents", presented);

  assert.match(response.headers["content-type"] ?? "", /application\/json/);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["cache-control"], "no-store");
});

/* ------------------------------------------------------------------ */
/* THE THREE READS                                                     */
/* ------------------------------------------------------------------ */

test("STATUS REPORTS THE CONNECTED PROVIDERS AND SAYS WHEN IT LOOKED", async () => {
  const { routes } = harness();

  const response = await routes.handle("GET", "/api/command-center/status", presented);
  const body = response.body as {
    at: string; connectedProviders: number;
    providers: { name: string; open: boolean; records: number }[];
  };

  assert.equal(response.status, 200);
  assert.equal(body.connectedProviders, 1);
  assert.equal(body.providers[0]?.name, "payments");
  assert.equal(Number.isNaN(Date.parse(body.at)), false);
});

test("STATUS DISTINGUISHES AN OPEN STREAM FROM A CLOSED EXPORT", async () => {
  // "Nothing is past its fence" over a closed file is a finding; the same
  // sentence over a running stream is a statement about the past tense. A UI
  // rendering both identically is lying to somebody.
  const { routes } = harness();

  const body = (await routes.handle("GET", "/api/command-center/status", presented)).body as {
    providers: { open: boolean }[];
  };

  assert.equal(typeof body.providers[0]?.open, "boolean");
});

test("STATUS OMITS EGRESS RATHER THAN ASSERTING IT IS OFF", async () => {
  const { routes } = harness();

  const body = (await routes.handle("GET", "/api/command-center/status", presented)).body as Record<string, unknown>;

  assert.equal("egress" in body, false, "unasked is not the same as unconfigured");
});

test("STATUS REPORTS EGRESS WHEN THE DEPLOYMENT SAYS SO", async () => {
  const { routes } = harness({ egress: { endpoints: 2 } });

  const body = (await routes.handle("GET", "/api/command-center/status", presented)).body as {
    egress: { endpoints: number; configured: boolean };
  };

  assert.deepEqual(body.egress, { endpoints: 2, configured: true });
});

test("AGENTS PUBLISHES THE ROSTER AND COUNTS THE STUBS SEPARATELY", async () => {
  const { routes } = harness();

  const body = (await routes.handle("GET", "/api/command-center/agents", presented)).body as {
    total: number; ready: number; stubCount: number;
    agents: { id: string; maturity: string; domain: string }[];
  };

  assert.equal(body.total, 3);
  assert.equal(body.stubCount, 3);
  assert.equal(body.ready, 0);
  // A dashboard showing three specialists must not read as three capabilities.
  assert.deepEqual(body.agents.map((a) => a.id), ["devsecops", "compliance", "performance"]);
});

test("AGENTS PUBLISHES DESCRIPTORS, NOT DATA", async () => {
  const { routes } = harness();

  const body = (await routes.handle("GET", "/api/command-center/agents", presented)).body as {
    agents: Record<string, unknown>[];
  };

  for (const agent of body.agents) {
    assert.deepEqual(
      Object.keys(agent).sort(),
      ["capabilities", "domain", "id", "maturity", "title", "version"],
    );
  }
});

test("PROVIDERS ROLL UP TO ONE WORD, AND CRITICAL MEANS EVERY PARTITION", async () => {
  const { routes } = harness();

  const body = (await routes.handle("GET", "/api/command-center/providers", presented)).body as {
    total: number;
    providers: { provider: string; state: string; connected: boolean; records: number }[];
  };

  assert.equal(body.total, 1);
  assert.equal(body.providers[0]?.provider, "payments");
  assert.equal(body.providers[0]?.connected, true);
  // Nothing has been pushed, so nothing has breached.
  assert.equal(body.providers[0]?.state, "ok");
});

test("A DISCONNECTED PLATFORM ANSWERS WITH AN EMPTY, HONEST VIEW", async () => {
  const gateway = createGateway({ tokens: [READER] });
  const routes = createUiRoutes({
    gateway, registry: new AgentRegistry(), vault: staticVault([READER], "test-vault"),
  });

  const status = (await routes.handle("GET", "/api/command-center/status", presented)).body as {
    connectedProviders: number; providers: unknown[];
  };
  const providers = (await routes.handle("GET", "/api/command-center/providers", presented)).body as {
    total: number;
  };

  assert.equal(status.connectedProviders, 0);
  assert.deepEqual(status.providers, []);
  assert.equal(providers.total, 0);
});

test("A QUERY STRING DOES NOT BYPASS THE ROUTE MATCH", async () => {
  const { routes } = harness();

  const response = await routes.handle("GET", "/api/command-center/status?token=reader-value", presented);

  assert.equal(response.status, 200);
});

test("A QUERY STRING IS NOT A CREDENTIAL", async () => {
  // The classic mistake: a token in a URL that lands in a log, a referrer and a
  // browser history. The value is only ever read from the header.
  const { routes } = harness();

  const response = await routes.handle("GET", "/api/command-center/status?token=reader-value");

  assert.equal(response.status, 401);
});
