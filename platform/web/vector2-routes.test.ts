/**
 * THE VECTOR 2 CONTRACT, OVER A REAL SOCKET.
 *
 * === WHY THIS USES A REAL HTTP SERVER AND NOT A DIRECT CALL TO `handle` ===
 *
 * Calling `router.handle("POST", ...)` and asserting on the returned object proves
 * the ROUTER. It does not prove the contract, and the contract is the entire
 * deliverable: a producer in another language is going to see bytes on a socket,
 * a status line, and a content type. A 202 that only exists as a returned object
 * is not a 202 anyone can consume.
 *
 * So these go over a real listener with a real client request. The server mounted
 * here is the SAME router the production mount delegates to, and it is mounted
 * through the same `createServer` + pathname-dispatch shape `platform/web/server.ts`
 * uses, so what is asserted here is what a producer would receive.
 *
 * === WHAT IS ACTUALLY PROVEN, AND WHAT IS NOT ===
 *
 * These prove the ROUTING CONTRACT: validation, status codes, and the exact JSON
 * shapes. They do not prove the dispatcher's AND-matching logic or the envelope
 * bounds -- those have their own suites, and duplicating them here would give the
 * illusion of independent coverage while testing the same assertions twice.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createVector2Routes, TELEMETRY_PATH, type Vector2Router } from "./vector2-routes.ts";
import { SwarmDispatcher } from "../conductor/swarm-dispatcher.ts";

/* -------------------------------------------------------------------------- */
/* A REAL SOCKET, AND A REAL REQUEST                                           */
/* -------------------------------------------------------------------------- */

let server: Server;
let base: string;
const seenBy: string[] = [];

/** One request, one response, as a producer would see them. */
function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: unknown }> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const req = httpRequest(
      `${base}${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          raw += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json: raw === "" ? undefined : JSON.parse(raw) });
        });
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}

before(async () => {
  const dispatcher = new SwarmDispatcher();
  dispatcher.register("secops", {
    metricPrefixes: ["auth."],
    tags: { severity: "high" },
    handle: (event) => {
      seenBy.push(event.metricName);
    },
  });

  // The mount. This is the same delegation `platform/web/server.ts` performs for
  // `/api/memory/*`, reduced to the one namespace under test.
  const router: Vector2Router = createVector2Routes({
    dispatcher,
    // The credential stands in for a proved tenant. The test for a REFUSED caller
    // is below, and it is a separate case rather than an absent option.
    authenticate: async (headers) =>
      headers["x-test-credential"] === "valid" ? { tenant: "acme" } : undefined,
  });

  server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const headers: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
      }

      let payload: unknown;
      if (request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          payload = raw.trim() === "" ? undefined : JSON.parse(raw);
        } catch {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "the request body is not valid JSON" }));
          return;
        }
      }

      const result = await router.handle(request.method ?? "GET", url.pathname, headers, payload);
      const text = JSON.stringify(result.body ?? null);
      response.writeHead(result.status, { ...result.headers, "content-length": Buffer.byteLength(text) });
      response.end(text);
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const GOOD = {
  eventId: "evt-contract-1",
  timestamp: "2026-10-04T12:00:00Z",
  metricName: "auth.anomaly.spike",
  value: 0.97,
  metadata: { severity: "high", service: "gateway" },
};
const AUTH = { "x-test-credential": "valid" };

/* -------------------------------------------------------------------------- */
/* 202 — ACCEPTED                                                               */
/* -------------------------------------------------------------------------- */

test("valid telemetry is accepted with 202 and named as delivered", async () => {
  const res = await post(TELEMETRY_PATH, GOOD, AUTH);
  assert.equal(res.status, 202);
  assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(res.json, {
    accepted: true,
    eventId: "evt-contract-1",
    metricName: "auth.anomaly.spike",
    delivered: ["secops"],
    failed: [],
    deadLettered: false,
  });
  // The event actually reached the agent, over the wire, not just in the response.
  assert.deepEqual(seenBy, ["auth.anomaly.spike"]);
});

test("an unmatched event is ACCEPTED AND SAYS SO, rather than dropping quietly", async () => {
  const res = await post(TELEMETRY_PATH, { ...GOOD, eventId: "evt-contract-2", metricName: "nobody.listens" }, AUTH);
  // 202, not 200 and not 404: the event WAS accepted and routed. What becomes of it
  // is in the body, because a producer reading only the status code would otherwise
  // never learn its event went nowhere.
  assert.equal(res.status, 202);
  const body = res.json as { deadLettered: boolean; reason: string; delivered: string[] };
  assert.equal(body.deadLettered, true);
  assert.equal(body.reason, "no-match");
  assert.deepEqual(body.delivered, []);
});

/* -------------------------------------------------------------------------- */
/* 400 — REFUSED, AND LEGIBLE                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Each case names the SPECIFIC code, not merely "it was a 400".
 *
 * That is the property `universal-envelope.ts` chose deliberately over the vault's
 * uniform refusal, and it is the reason a producer can fix itself. Asserting only
 * the status code would let every one of these collapse into the same answer and the
 * test would still pass.
 */
const REFUSALS: { readonly name: string; readonly body: unknown; readonly code: string }[] = [
  { name: "not an object", body: "a string", code: "NOT_AN_OBJECT" },
  { name: "an unknown top-level field", body: { ...GOOD, datadog_tags: ["prod"] }, code: "UNKNOWN_FIELD" },
  { name: "a missing field", body: { ...GOOD, value: undefined }, code: "MISSING_FIELD" },
  { name: "a non-finite value", body: { ...GOOD, value: "high" }, code: "VALUE_INVALID" },
  { name: "a timestamp with no offset", body: { ...GOOD, timestamp: "2026-10-04T12:00:00" }, code: "TIMESTAMP_INVALID" },
  { name: "a metric name that is not an identifier", body: { ...GOOD, metricName: "auth anomaly" }, code: "METRIC_NAME_INVALID" },
  { name: "metadata that is not an object", body: { ...GOOD, metadata: [] }, code: "METADATA_INVALID" },
];

for (const { name, body, code } of REFUSALS) {
  test(`malformed telemetry is refused: ${name}`, async () => {
    const res = await post(TELEMETRY_PATH, body, AUTH);
    assert.equal(res.status, 400);
    const payload = res.json as { error: string; code: string; reason: string };
    assert.equal(payload.code, code);
    assert.ok(payload.reason.length > 0, "a refusal must say what to fix");
  });
}

test("a refused payload reaches no agent at all", async () => {
  const before = seenBy.length;
  await post(TELEMETRY_PATH, { ...GOOD, value: "not a number" }, AUTH);
  assert.equal(seenBy.length, before, "a malformed event was delivered to an agent");
});

/**
 * THE REFUSAL NEVER ECHOES THE VALUE.
 *
 * An error body gets logged, shipped and pasted into a ticket. A metric name can
 * carry anything an upstream system put in it, so the field NAME is reported and
 * the offending content is not. This asserts the property rather than trusting the
 * comment above it.
 */
test("a refusal names the field without echoing the value", async () => {
  const poison = "sk-live-SHOULD-NEVER-APPEAR";
  const res = await post(TELEMETRY_PATH, { ...GOOD, eventId: poison }, AUTH);
  assert.equal(res.status, 400);
  assert.ok(!JSON.stringify(res.json).includes(poison), "the refusal echoed the offending value back to the caller");
});

/* -------------------------------------------------------------------------- */
/* THE SURROUNDING CONTRACT                                                    */
/* -------------------------------------------------------------------------- */

test("an unauthenticated caller is refused, uniformly", async () => {
  const res = await post(TELEMETRY_PATH, GOOD, { "x-test-credential": "wrong" });
  assert.equal(res.status, 401);
  // Uniform: it must not say WHICH part of the credential was wrong.
  assert.deepEqual(res.json, { error: "unauthenticated" });
});

test("GET on the telemetry path is 405 and advertises the one allowed method", async () => {
  const res = await new Promise<{ status: number; json: unknown }>((resolve, reject) => {
    const req = httpRequest(`${base}${TELEMETRY_PATH}`, { method: "GET" }, (r) => {
      let raw = "";
      r.setEncoding("utf8");
      r.on("data", (c: string) => {
        raw += c;
      });
      r.on("end", () => resolve({ status: r.statusCode ?? 0, json: JSON.parse(raw) }));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(res.status, 405);
  assert.deepEqual(res.json, { error: "this resource accepts POST only", allowed: ["POST"] });
});

test("an unknown /api/v1 path is 404 and never reaches the wedge", async () => {
  const res = await post("/api/v1/governance/verdict", GOOD, AUTH);
  assert.equal(res.status, 404);
  assert.deepEqual(res.json, { error: "no such resource", path: "/api/v1/governance/verdict" });
});
