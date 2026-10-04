import test, { after } from "node:test";
import assert from "node:assert/strict";

import { startWedgeServer } from "./server.ts";
import { makeTempWorkspace } from "../test-support/temp-workspace.ts";
import { CREDENTIAL_HEADER, staticVault, type GatewayToken } from "../omniroute/edge-security.ts";
import { MemoryStore } from "../memory/store.ts";

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
    // THE COMPOSITE ID IS BUILT FROM THE CREDENTIAL, NOT TYPED IN.
    //
    // The registry namespaces by tenant -- `d221f3d` -- so a roster id is
    // `acme/log-anomaly`. This assertion used to expect the bare id and has been
    // failing since that change; it is not a behaviour that regressed, it is a
    // literal that stopped describing the contract. Deriving it from
    // `TENANT_TOKEN.id` means it cannot go stale against the id format again.
    assert.equal(body.agents[0]?.id, `${TENANT_TOKEN.id}/log-anomaly`);
  } finally {
    await server.close();
  }
});

test("the roster id is the one the schema route accepts, so the UI's round trip closes", async () => {
  // THE DEFECT THIS FILE WAS POINTING AT, NOW STATED AS A CLAIM.
  //
  // The command center takes an id from the roster, puts it in a select, and
  // sends it back to fetch that agent's schema. When the roster published
  // composite ids and the schema route resolved only bare ones, that round trip
  // was a 404 for every agent -- the UI listed an agent and could not open it.
  // Measured before the fix:
  //   GET /api/portal/schema/acme%2Flog-anomaly  ->  404
  //   GET /api/portal/schema/log-anomaly         ->  200
  const server = await harness();
  try {
    await call(server, "/api/portal/schema", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID_SCHEMA),
    });

    const roster = (await (await call(server, "/api/portal/agents")).json()) as { agents: { id: string }[] };
    const fromRoster = roster.agents[0]?.id ?? "";

    // Sent exactly as the UI sends it: the roster's own value, encoded.
    const composite = await call(server, `/api/portal/schema/${encodeURIComponent(fromRoster)}`);
    assert.equal(composite.status, 200, "the id the roster publishes must be the id the schema route accepts");

    // And the bare form still works, because a deep link may carry either.
    const bare = await call(server, "/api/portal/schema/log-anomaly");
    assert.equal(bare.status, 200);
  } finally {
    await server.close();
  }
});

test("a composite id naming ANOTHER tenant is a 404, never a 403", async () => {
  // A 403 here would confirm the agent exists for somebody else, which turns this
  // endpoint into an oracle for enumerating another customer's agent names. Not
  // found and not permitted must be indistinguishable from outside.
  const server = await harness();
  try {
    await call(server, "/api/portal/schema", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID_SCHEMA),
    });

    const foreign = await call(server, "/api/portal/schema/globex%2Flog-anomaly");
    assert.equal(foreign.status, 404);

    const absent = await call(server, "/api/portal/schema/globex%2Fnever-registered");
    // Byte-identical in status and body: the response must not leak existence.
    assert.equal(foreign.status, absent.status);
    assert.deepEqual(await foreign.json(), await absent.json());
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

/* -------------------------------------------------------------------------- */
/* THE LIVE SURFACE                                                           */
/* -------------------------------------------------------------------------- */

const INGEST = "/api/portal/ingest";
const LIVE = "/api/portal/live";

const EVENT = {
  fields: { alert_code: "PEGA0001", elapsed_time: "1200", threshold: "1000", pega_time: "2026-10-03T00:00:00.000Z" },
  at: 1_760_000_000_000,
};

test("the live route refuses without a credential, like every portal route", async () => {
  const server = await harness();
  try {
    const response = await fetch(`${server.url}${LIVE}`);
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test("ingest refuses without a credential", async () => {
  const server = await harness();
  try {
    const response = await fetch(`${server.url}${INGEST}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "pega", events: [EVENT] }),
    });
    assert.equal(response.status, 401);
  } finally {
    await server.close();
  }
});

test("ingest refuses a provider the process never connected", async () => {
  // The provider name is the ingress surface, fixed at boot. A caller must not be
  // able to name a door the process did not open.
  const server = await harness();
  try {
    const response = await call(server, INGEST, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "not-connected", events: [EVENT] }),
    });
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});

test("ingest refuses a malformed body with field-named issues", async () => {
  const server = await harness();
  try {
    const cases: readonly [unknown, string][] = [
      [{ provider: "pega" }, "$.events"],
      [{ provider: "", events: [EVENT] }, "$.provider"],
      [{ provider: "pega", events: [] }, "$.events"],
      [{ provider: "pega", events: [{ fields: { a: {} } }] }, "$.events[0].fields.a"],
      [{ provider: "pega", events: [{ fields: { a: "x" }, at: "soon" }] }, "$.events[0].at"],
    ];
    for (const [body, path] of cases) {
      const response = await call(server, INGEST, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      const parsed = (await response.json()) as { issues: { path: string }[] };
      assert.ok(parsed.issues.some((issue) => issue.path === path), `expected an issue at ${path}`);
    }
  } finally {
    await server.close();
  }
});

test("ingest accepts a well-formed batch and reports what it took", async () => {
  const server = await harness();
  try {
    const response = await call(server, INGEST, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "pega", events: [EVENT, EVENT, EVENT] }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { accepted: number; refused: number };
    assert.equal(body.accepted, 3);
    assert.equal(body.refused, 0);
  } finally {
    await server.close();
  }
});

test("the live route reports a real verdict once traffic has arrived", async () => {
  // The claim that matters: `synthetic: false` on a body the server produced from
  // events it actually received. Until this passed, every throughput figure in
  // the UI was generated locally.
  const server = await harness();
  try {
    const events = Array.from({ length: 400 }, () => EVENT);
    await call(server, INGEST, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "pega", events }),
    });

    // The broker consumes asynchronously, so poll rather than assume.
    let snapshot: LiveBody | null = null;
    for (let attempt = 0; attempt < 25 && snapshot === null; attempt++) {
      const response = await call(server, LIVE);
      assert.equal(response.status, 200);
      const body = (await response.json()) as LiveBody;
      if (body.verdict !== null && body.verdict.records > 0) snapshot = body;
      else await new Promise((resolve) => setTimeout(resolve, 40));
    }

    assert.ok(snapshot !== null, "the verdict never reported any records");
    assert.equal(snapshot.verdict.synthetic, false);
    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.provider, "pega");
    assert.ok(snapshot.verdict.records > 0);
  } finally {
    await server.close();
  }
});

test("the live route reports throughput only once two observations exist", async () => {
  // One observation cannot produce a rate, and returning zero would be
  // indistinguishable from a stream that has stopped.
  const server = await harness();
  try {
    await call(server, INGEST, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "pega", events: Array.from({ length: 200 }, () => EVENT) }),
    });
    let sawNullFirst = false;
    let sawRate = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      const body = (await (await call(server, LIVE)).json()) as LiveBody;
      if (body.throughput === null) sawNullFirst = true;
      else {
        assert.ok(body.throughput.windowMs > 0, "a rate without its window is not a measurement");
        sawRate = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.ok(sawNullFirst, "the first reading should report no rate at all");
    assert.ok(sawRate, "a rate never appeared");
  } finally {
    await server.close();
  }
});

interface LiveBody {
  readonly provider: string;
  readonly enabled: boolean;
  readonly verdict: { records: number; synthetic: boolean; breachedColumns: number } | null;
  readonly throughput: { records: number; delta: number; windowMs: number; eventsPerSecond: number } | null;
}
test("THE DECISION PATH IS REACHED WITH NOBODY READING THE DASHBOARD", async () => {
  // The half that could have been got wrong. Removing evaluation from the read
  // route makes the record unreachable again UNLESS something else drives it --
  // and the earlier version of this comment in server.ts records that this
  // callback used to be the only caller, so "nothing asked for an alert" is a
  // state this platform has already shipped once.
  //
  // So: ingest a breaching batch, then deliberately never open the live route.
  // The record must fill anyway, because evaluation belongs to the deployment
  // and not to whoever is watching. A deployment with no dashboard open is the
  // case that has no other way to learn a breach happened.
  const cwd = await makeTempWorkspace("nf-portal-decision-");
  const store = MemoryStore.open({ inMemory: true });
  const server = await startWedgeServer({
    cwd,
    port: 0,
    portalVault: staticVault([TENANT_TOKEN], "mount-test"),
    memory: { store, tenant: "acme" },
    evaluationIntervalMs: 25,
  });
  trackClose(server.close);

  try {
    // VARIANCE, AND ONE GENUINE OUTLIER. A batch of identical values has an IQR
    // of zero, every fence sits on the same number, and nothing can breach it --
    // so a batch of clones would have made this test pass or fail for a reason
    // that has nothing to do with who drives evaluation.
    const events = Array.from({ length: 400 }, (_, index) => ({
      fields: {
        alert_code: "PEGA0001",
        elapsed_time: String(1_000 + (index % 20) * 5),
        threshold: "1000",
        pega_time: "2026-10-03T00:00:00.000Z",
      },
      at: 1_760_000_000_000 + index * 1_000,
    }));
    events.push({
      fields: {
        alert_code: "PEGA0001",
        elapsed_time: "999999",
        threshold: "1000",
        pega_time: "2026-10-03T00:00:00.000Z",
      },
      at: 1_760_000_000_000 + 401_000,
    });

    const ingested = await call(server, INGEST, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "pega", events }),
    });
    assert.equal(ingested.status, 200);
    const taken = (await ingested.json()) as { accepted: number };
    assert.equal(taken.accepted, 401, "every event reached the broker, so the window is real");

    // The scheduler runs on its own clock and the broker consumes asynchronously,
    // so wait for the record rather than assume a duration.
    const deadline = Date.now() + 8_000;
    let recorded = 0;
    while (Date.now() < deadline && recorded === 0) {
      recorded = store.alertsFor("acme").length;
      if (recorded === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(
      recorded > 0,
      "no alert reached the record with no dashboard open, so this deployment is a monitor nobody can hear from",
    );
  } finally {
    await server.close();
    store.close();
  }
});
