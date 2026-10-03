import test, { after } from "node:test";
import assert from "node:assert/strict";

import { startWedgeServer } from "./server.ts";
import { makeTempWorkspace } from "../test-support/temp-workspace.ts";
import { CREDENTIAL_HEADER, staticVault, type GatewayToken } from "../omniroute/edge-security.ts";

/**
 * THE PORTAL API, REACHED OVER REAL HTTP.
 *
 * `portal-routes.test.ts` proves the router in isolation and
 * `e2e-dynamic-platform.test.ts` proves it against a real registry. Neither
 * proves the part that actually broke: the routes existed, were correct, and
 * were imported ONLY BY THEIR TESTS. Nothing served them. A client written
 * against a contract nobody exposes is a green suite and a dead product, which
 * is the exact shape of bug this file exists to rule out.
 *
 * So these tests boot the wedge and go through the socket. Every claim below is
 * about a URL a browser could actually open.
 *
 * TEARDOWN, WHICH A FAILING ASSERTION CANNOT SKIP.
 *
 * Each test closes its server in a `finally`, so a failed assertion still
 * releases the listener. This file additionally closes anything left open in
 * `after`, because a test that dies before its finally is exactly what left five
 * listening sockets and a 37-minute hang in this suite once already.
 */
const openServers = new Set<{ close: () => Promise<void> }>();

function trackClose(close: () => Promise<void>): { close: () => Promise<void> } {
  let closed = false;
  const handle = {
    close: async () => {
      if (closed) return;
      closed = true;
      openServers.delete(handle);
      await close();
    },
  };
  openServers.add(handle);
  return handle;
}

after(async () => {
  await Promise.allSettled([...openServers].map((server) => server.close()));
});

const TENANT_TOKEN: GatewayToken = {
  id: "acme",
  credential: "acme-value",
  providers: ["portal"],
};

const VALID_SCHEMA = {
  id: "log-anomaly",
  title: "Log anomalies",
  domain: "anomaly",
  version: "1.0.0",
  capabilities: ["finds bursts"],
  streams: ["app.log"],
  rules: [
    { id: "burst", kind: "regex", severity: "warning", message: "an error burst", pattern: "FATAL" },
  ],
};

async function harness() {
  const cwd = await makeTempWorkspace("nf-portal-mount-");
  const server = await startWedgeServer({ cwd, port: 0, portalVault: staticVault([TENANT_TOKEN], "mount-test") });
  trackClose(server.close);
  return server;
}

function call(server: Awaited<ReturnType<typeof harness>>, path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { [CREDENTIAL_HEADER]: "acme-value", ...(init.headers as Record<string, string>) };
  return fetch(`${server.url}${path}`, { ...init, headers });
}

test("a portal read without a credential is refused with 401", async () => {
  const server = await harness();
  try {
    // No credential at all. The edge answers, and it does not name the routes.
    const response = await fetch(`${server.url}/api/portal/config`);
    assert.equal(response.status, 401);
    const body = (await response.json()) as { status: string; failure?: { code: string } };
    assert.equal(body.status, "FAILED");
    assert.equal(body.failure?.code, "UNAUTHENTICATED");
  } finally {
    await server.close();
  }
});

test("a portal read with the wrong credential is refused", async () => {
  const server = await harness();
  try {
    const response = await fetch(`${server.url}/api/portal/config`, {
      headers: { [CREDENTIAL_HEADER]: "wrong-value" },
    });
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test("the portal config route is reachable and reports a derived portal", async () => {
  const server = await harness();
  try {
    const response = await call(server, "/api/portal/config");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { derived: boolean; config: { tenant: string; widgets: unknown[] } };
    // The tenant is the PROVEN token id. Nothing in the request chose it.
    assert.equal(body.derived, true);
    assert.equal(body.config.tenant, "acme");
  } finally {
    await server.close();
  }
});

test("an unknown portal path is a 404, not the wedge's own page", async () => {
  const server = await harness();
  try {
    const response = await call(server, "/api/portal/nothing-here");
    // The router names no routes in its refusal: naming them hands a stranger
    // the surface map, which is the reconnaissance this edge exists to prevent.
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  } finally {
    await server.close();
  }
});

test("a schema POSTed over HTTP appears in the roster a later GET reads", async () => {
  // THE CLAIM THAT MATTERS. A registry built per request would answer 200 to the
  // POST and show an empty roster to the GET: a success the caller has to
  // disbelieve.
  const server = await harness();
  try {
    const posted = await call(server, "/api/portal/schema", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID_SCHEMA),
    });
    assert.equal(posted.status, 200);

    const roster = await call(server, "/api/portal/agents");
    assert.equal(roster.status, 200);
    const body = (await roster.json()) as { total: number; ready: number; agents: { id: string }[] };
    assert.equal(body.total, 1);
    assert.equal(body.ready, 1);
    assert.equal(body.agents[0]?.id, "log-anomaly");
  } finally {
    await server.close();
  }
});

test("a malformed schema POST is refused with field-named issues and registers nothing", async () => {
  const server = await harness();
  try {
    const posted = await call(server, "/api/portal/schema", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "no id" }),
    });
    assert.equal(posted.status, 400);
    const body = (await posted.json()) as { error: string; issues: { path: string }[] };
    assert.equal(body.error, "schema refused");
    assert.ok(body.issues.some((issue) => issue.path === "$.id"));

    const roster = (await (await call(server, "/api/portal/agents")).json()) as { total: number };
    assert.equal(roster.total, 0, "a refused schema must not half-exist");
  } finally {
    await server.close();
  }
});

test("a body that is not JSON is refused rather than reaching the router", async () => {
  const server = await harness();
  try {
    const response = await call(server, "/api/portal/schema", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ this is not json",
    });
    // Otherwise the router receives `undefined` and reports every required field
    // missing, which is a confusing answer to a syntax error.
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /not valid JSON/);
  } finally {
    await server.close();
  }
});

test("the wedge's own routes still work alongside the portal surface", async () => {
  // A mount that shadowed an existing route would be a regression the portal
  // tests alone would never see.
  const server = await harness();
  try {
    const page = await fetch(`${server.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  } finally {
    await server.close();
  }
});

test("portal responses carry the hardened JSON headers", async () => {
  const server = await harness();
  try {
    const response = await call(server, "/api/portal/config");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    await server.close();
  }
});