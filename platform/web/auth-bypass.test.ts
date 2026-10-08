import test, { after } from "node:test";
import assert from "node:assert/strict";

import { startWedgeServer, type RunningWedge } from "./server.ts";
import { credentialHeaders, incidentCommanderHeaders } from "./auth-middleware.ts";
import { makeTempWorkspace } from "../test-support/temp-workspace.ts";

/**
 * PHASE 9 RED TEAM — AUTH BYPASS AGAINST THE DASHBOARD GATE.
 *
 * The middleware is mounted exclusively on `/`, `/index.html` and
 * `/api/dashboard`. These tests aim at that gate the way an adversary would:
 * no token, an expired token, a token that authenticates but has no Incident
 * Commander role. Each must be refused before a handler runs.
 *
 * `/api/report` is the control. If the gate leaked onto every route, a missing
 * token would 401 there too, and the existing wedge tests would all go red
 * for the wrong reason.
 */

const openServers = new Set<RunningWedge>();
after(async () => {
  await Promise.all([...openServers].map((s) => s.close().catch(() => undefined)));
});

async function harness() {
  const cwd = await makeTempWorkspace("nf-authz-");
  const server = await startWedgeServer({ cwd, port: 0 });
  openServers.add(server);
  return server;
}

function unsignedJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

async function get(server: RunningWedge, path: string, headers?: Record<string, string>) {
  const response = await fetch(`${server.url}${path}`, headers === undefined ? undefined : { headers });
  const text = await response.text();
  return { status: response.status, text };
}

test("a missing token is refused on the dashboard routes", async () => {
  const server = await harness();
  for (const path of ["/", "/index.html", "/api/dashboard?path=pega.csv"]) {
    const { status, text } = await get(server, path);
    assert.equal(status, 401, `${path} without a token must be 401, got ${status}: ${text.slice(0, 180)}`);
    assert.match(text, /UNAUTHENTICATED|Missing credential header/);
  }
});

test("an expired token is refused", async () => {
  const server = await harness();
  const fixture = await get(server, "/", credentialHeaders("expired-token"));
  assert.equal(fixture.status, 401, fixture.text.slice(0, 180));
  assert.match(fixture.text, /Token expired/);

  const jwt = await get(server, "/", credentialHeaders(unsignedJwt({
    role: "Incident Commander",
    exp: Math.floor(Date.now() / 1000) - 60,
  })));
  assert.equal(jwt.status, 401, jwt.text.slice(0, 180));
  assert.match(jwt.text, /Token expired/);
});

test("a token without the Incident Commander role is forbidden", async () => {
  const server = await harness();
  const fixture = await get(server, "/", credentialHeaders("no-role-token"));
  assert.equal(fixture.status, 403, fixture.text.slice(0, 180));
  assert.match(fixture.text, /Incident Commander/);

  const jwt = await get(server, "/", credentialHeaders(unsignedJwt({
    role: "observer",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })));
  assert.equal(jwt.status, 403, jwt.text.slice(0, 180));
  assert.match(jwt.text, /Incident Commander/);
});

test("an Incident Commander JWT is admitted to the landing page", async () => {
  const server = await harness();
  const fixture = await get(server, "/", incidentCommanderHeaders());
  assert.equal(fixture.status, 200, fixture.text.slice(0, 180));
  assert.match(fixture.text, /<!doctype html>/i);

  const jwt = await get(server, "/", credentialHeaders(unsignedJwt({
    roles: ["Incident Commander"],
    exp: Math.floor(Date.now() / 1000) + 3600,
  })));
  assert.equal(jwt.status, 200, jwt.text.slice(0, 180));
});

test("the gate is exclusive: /api/report is not covered", async () => {
  const server = await harness();
  const response = await fetch(`${server.url}/api/report`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const text = await response.text();
  assert.notEqual(response.status, 401, `report route must not inherit the dashboard gate: ${text.slice(0, 180)}`);
  assert.notEqual(response.status, 403, `report route must not inherit the dashboard gate: ${text.slice(0, 180)}`);
});
