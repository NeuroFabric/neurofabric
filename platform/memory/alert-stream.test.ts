import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { issueToken, staticVault, CREDENTIAL_HEADER, type VaultProvider } from "../omniroute/edge-security.ts";
import { MemoryStore } from "./store.ts";
import { createMemoryRoutes, MEMORY_ALERTS_PATH, MEMORY_PROVIDER, MEMORY_DIFF_PATH, type MemoryRouter } from "./memory-routes.ts";
import { AlertHub, MAX_CONSUMER_BACKLOG_BYTES, bytesOf, frame } from "./alert-hub.ts";

/**
 * THE TWO CONSTRAINTS ON THE STREAM, AND NOTHING ELSE.
 *
 * ADR-005 §5 sets three rules. The third -- *the subscription is not the record* --
 * is not tested here because it is not testable in this file: it is enforced one
 * layer up in `OmniRouteGateway.onDecision`, and `decision-boundary.test.ts` is
 * where its ordering is proved by interleaving. Duplicating a weaker version of
 * that assertion here would be the kind of green check that outlives the thing it
 * checked.
 *
 * So this file covers exactly the two the operator named:
 *
 *  1. **THE TOKEN GUARD ACTIVELY DEFENDS THE ROUTE** -- and "actively" is the
 *     word doing work. A guard that runs and then returns 200 is not a guard, so
 *     each refusal asserts on the bytes actually written to the socket, including
 *     that no `text/event-stream` header was ever sent.
 *  2. **A SLOW CONSUMER IS DISCONNECTED, NOT BUFFERED** -- asserted by making a
 *     consumer that refuses to drain and then checking it is gone, with a reason,
 *     and that the hub reports the loss instead of pretending to have delivered.
 */

const TENANT = "acme";
const OTHER = "globex";
const AGENT = "log-anomaly";

const TOKENS = [TENANT, OTHER].map((tenant) => ({ tenant, token: issueToken(tenant, [MEMORY_PROVIDER]) }));
const vault = (): VaultProvider => staticVault(TOKENS.map((entry) => entry.token));
const auth = (tenant: string): Record<string, string> => ({
  [CREDENTIAL_HEADER]: TOKENS.find((entry) => entry.tenant === tenant)?.token.credential ?? "",
});

function aStore(): MemoryStore {
  return MemoryStore.open({ directory: mkdtempSync(path.join(tmpdir(), "nf-sse-")), inMemory: true });
}

/**
 * A RESPONSE DOUBLE THAT CAN BE SLOW ON PURPOSE.
 *
 * The real `ServerResponse` is not used because the property under test IS the
 * socket's back-pressure, and a double is the only way to drive a socket into the
 * exact state that triggers it. `writableLength` is writable here precisely so a
 * test can pretend a consumer has stopped reading -- which is the situation the
 * disconnect exists for.
 */
class FakeResponse extends EventEmitter {
  status: number | undefined;
  headers: Record<string, string> = {};
  readonly chunks: string[] = [];
  ended = false;
  /** Pretend the OS socket buffer is this full. */
  writableLength = 0;
  /** What `write()` reports. False means "buffered, not delivered". */
  accept = true;

  writeHead(status: number, headers: Record<string, string>): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.accept;
  }

  /**
   * `end(chunk)` sends a final body, which is exactly how `write()` in
   * `memory-routes.ts` sends a refusal.
   *
   * The first version of this double took no argument and pushed nothing, so
   * every refusal came back as an EMPTY string while its status line was
   * correct. Five tests failed on a fixture that was lying rather than on code
   * that was broken -- which is the test-harness version of a receipt that
   * cannot fail.
   */
  end(chunk?: string): this {
    if (typeof chunk === "string" && chunk !== "") this.chunks.push(chunk);
    this.ended = true;
    return this;
  }

  get text(): string {
    return this.chunks.join("");
  }
}

/* ================================================================== *
 * CONSTRAINT 1: THE GUARD ACTIVELY DEFENDS THE ROUTE.                  *
 * ================================================================== */

test("NO CREDENTIAL IS REFUSED, AND NO STREAM HEADER IS EVER SENT", async () => {
  const routes = createMemoryRoutes({ store: aStore(), live: { providers: ["pega"], latest: () => ({}) }, vault: vault() });
  const response = new FakeResponse();

  const didOpen = await routes.openStream("GET", MEMORY_ALERTS_PATH, {}, response as never);

  assert.equal(didOpen, false, "the stream must not open");
  assert.equal(response.status, 401, "and the caller must be told so in the status line");
  // THE ASSERTION THAT SEPARATES A GUARD FROM A DECORATION. If the guard wrote
  // 200 and the stream headers first and refused afterwards, a scanner would see
  // a working stream and an operator would see a connection that carries nothing.
  assert.equal(response.headers["content-type"], undefined, "no content-type was written");
  assert.equal(response.text.includes("text/event-stream"), false, "the stream header never went out");
  assert.match(response.text, /no credential presented/);
  assert.equal(routes.hub.size, 0, "and nothing was subscribed");
});

test("A CREDENTIAL THAT WAS NEVER ISSUED IS REFUSED THE SAME WAY", async () => {
  const routes = createMemoryRoutes({ store: aStore(), live: { providers: ["pega"], latest: () => ({}) }, vault: vault() });
  const response = new FakeResponse();

  await routes.openStream("GET", MEMORY_ALERTS_PATH, { [CREDENTIAL_HEADER]: "not-a-real-credential" }, response as never);

  assert.equal(response.status, 401);
  assert.match(response.text, /not recognised/);
  assert.equal(response.headers["content-type"], undefined);
});

test("A PROVEN CREDENTIAL OPENS THE STREAM, and it is that tenant's", async () => {
  const routes = createMemoryRoutes({ store: aStore(), live: { providers: ["pega"], latest: () => ({}) }, vault: vault() });
  const response = new FakeResponse();

  const didOpen = await routes.openStream("GET", MEMORY_ALERTS_PATH, auth(TENANT), response as never);

  assert.equal(didOpen, true);
  assert.equal(response.status, 200);
  assert.match(String(response.headers["content-type"]), /text\/event-stream/);
  // The opening comment, so a client can tell "connected" from "something has
  // happened" -- which is what keeps a quiet feed distinct from a dead one.
  assert.match(response.text, /^: connected/);
  assert.equal(routes.hub.subscribersFor(TENANT), 1);
  assert.equal(routes.hub.subscribersFor(OTHER), 0, "and not the other tenant's");
});

test("THE STREAM'S TENANT IS FIXED AT CONNECT, and never re-scoped", async () => {
  const routes = createMemoryRoutes({ store: aStore(), live: { providers: ["pega"], latest: () => ({}) }, vault: vault() });
  const acme = new FakeResponse();
  const globex = new FakeResponse();
  await routes.openStream("GET", MEMORY_ALERTS_PATH, auth(TENANT), acme as never);
  await routes.openStream("GET", MEMORY_ALERTS_PATH, auth(OTHER), globex as never);

  // Publish to each tenant in turn. Nothing that says "all" exists on this API,
  // which is the point: a broadcast helper would be one call away from a leak.
  routes.hub.publish(TENANT, frame("a", "alert", { id: "a" }));
  routes.hub.publish(OTHER, frame("b", "alert", { id: "b" }));

  assert.match(acme.text, /id: a/);
  assert.equal(acme.text.includes("id: b"), false, "acme never sees globex's alert");
  assert.match(globex.text, /id: b/);
  assert.equal(globex.text.includes("id: a"), false, "globex never sees acme's alert");
});

test("THE STREAM IS PROVED WITH THE SAME FUNCTION THE ORDINARY ROUTES USE", async () => {
  // The "one door" property, asserted rather than asserted-about: a refusal from
  // the stream and a refusal from a JSON route must be BYTE-IDENTICAL, because
  // they come from one `prove()`. If they ever diverge, that is the day a second
  // authentication path was born.
  const routes = createMemoryRoutes({ store: aStore(), live: { providers: ["pega"], latest: () => ({}) }, vault: vault() });
  const stream = new FakeResponse();

  await routes.openStream("GET", MEMORY_ALERTS_PATH, {}, stream as never);
  const fromRoute = await routes.handle("GET", MEMORY_DIFF_PATH, {});

  assert.equal(stream.status, 401);
  assert.equal(fromRoute.status, 401);
  assert.equal(stream.text, JSON.stringify(fromRoute.body), "one guard, one refusal, byte for byte");
});

test("A POST IS REFUSED THE STREAM, and the refusal happens AFTER proof", async () => {
  const routes = createMemoryRoutes({ store: aStore(), live: { providers: ["pega"], latest: () => ({}) }, vault: vault() });
  const anonymous = new FakeResponse();
  const proven = new FakeResponse();

  // Unproven first: the answer to a stranger is the same whatever they asked for.
  await routes.openStream("POST", MEMORY_ALERTS_PATH, {}, anonymous as never);
  assert.equal(anonymous.status, 401, "a stranger is not told the route exists");

  await routes.openStream("POST", MEMORY_ALERTS_PATH, auth(TENANT), proven as never);
  assert.equal(proven.status, 405, "a proven caller is told what the route does accept");
  assert.match(proven.text, /read with GET/);
});

/* ================================================================== *
 * CONSTRAINT 2: A SLOW CONSUMER IS DISCONNECTED, NOT BUFFERED.        *
 * ================================================================== */

test("A CONSUMER THAT FALLS BEHIND IS DISCONNECTED, WITH A REASON", async () => {
  const routes = createMemoryRoutes({ store: aStore(), live: { providers: ["pega"], latest: () => ({}) }, vault: vault() });
  const response = new FakeResponse();
  await routes.openStream("GET", MEMORY_ALERTS_PATH, auth(TENANT), response as never);

  // Now it stops draining. Two conditions, and BOTH are required, because the
  // real failure needs both: `write` reporting a full buffer AND the backlog past
  // the ceiling. A consumer that is momentarily behind is not a consumer that is
  // gone, and disconnecting the first one would make the stream useless on a slow
  // network for no reason at all.
  response.accept = false;
  response.writableLength = MAX_CONSUMER_BACKLOG_BYTES + 1;

  routes.hub.publish(TENANT, frame("slow", "alert", { id: "slow" }));

  assert.equal(response.ended, true, "the consumer must be disconnected, not left waiting");
  assert.match(response.text, /event: slow-consumer/, "and told WHY in words an operator can act on");
  assert.match(response.text, /only the notification was lost/, "and what it actually lost");
  assert.equal(routes.hub.subscribersFor(TENANT), 0, "it must no longer be subscribed");
});

test("A CONSUMER BEHIND, BUT WITHIN THE CEILING, IS KEPT", async () => {
  const routes = createMemoryRoutes({ store: aStore(), live: { providers: ["pega"], latest: () => ({}) }, vault: vault() });
  const response = new FakeResponse();
  await routes.openStream("GET", MEMORY_ALERTS_PATH, auth(TENANT), response as never);

  response.accept = false;
  response.writableLength = MAX_CONSUMER_BACKLOG_BYTES - 1;
  routes.hub.publish(TENANT, frame("slowish", "alert", { id: "slowish" }));

  assert.equal(response.ended, false, "momentarily behind is not gone");
  assert.equal(routes.hub.subscribersFor(TENANT), 1, "and it stays subscribed");
});

test("THE LOSS IS COUNTED, not reported as a delivery", () => {
  const hub = new AlertHub();
  hub.open(TENANT, () => {
    throw new Error("EPIPE");
  });

  const result = hub.publish(TENANT, frame("x", "alert", { id: "x" }));

  // The whole reason this number exists. A publish that returned 1 while nothing
  // reached anybody would let the caller believe a notification landed.
  assert.equal(result.told, 0, "nobody was told");
  assert.equal(result.dropped, 1, "and the loss is visible rather than swallowed");
  assert.equal(hub.size, 0, "the dead consumer is gone, not retried forever");
  assert.equal(hub.disconnected().length, 1);
});

test("A DISCONNECTED CONSUMER LOSES A NOTIFICATION, NOT AN ALERT", async () => {
  // What the disconnect MEANS, stated as an assertion about this module's
  // responsibility: the record is written by `onDecision` before this file is
  // reached, so what vanishes here is a notification and nothing else.
  const store = aStore();
  const routes = createMemoryRoutes({ store, live: { providers: ["pega"], latest: () => ({}) }, vault: vault() });
  const response = new FakeResponse();
  // Awaited, not `void`ed. `openStream` is async -- it reads the vault before it
  // subscribes -- so a fire-and-forget call publishes into a hub with no
  // consumer in it yet, and the test would pass for the wrong reason.
  await routes.openStream("GET", MEMORY_ALERTS_PATH, auth(TENANT), response as never);

  // The alert is in the record first, exactly as the decision path does it.
  store.recordDecision({
    tenant: TENANT,
    agentId: `${TENANT}/pega`,
    verdict: { at: new Date().toISOString(), provider: "pega", records: 10, breached: 1, document: {} },
    alert: { id: "alert-1", severity: "critical", document: {} },
    audit: { actor: "system", action: "raise-alert", document: {} },
  });

  response.accept = false;
  response.writableLength = MAX_CONSUMER_BACKLOG_BYTES + 1;
  routes.hub.publish(TENANT, frame("alert-1", "alert", { id: "alert-1" }));

  assert.equal(response.ended, true, "the notification was lost");
  const surviving = store.alertsFor(TENANT);
  assert.equal(surviving.length, 1, "and the alert is still there to be read");
  assert.equal(surviving[0]?.id, "alert-1");
});

test("THE BACKLOG CEILING IS A NAMED CONSTANT, and it is small", () => {
  // Asserted as a number so that raising it is a deliberate edit somebody
  // reviewed, rather than something that happened to a variable.
  assert.equal(MAX_CONSUMER_BACKLOG_BYTES, 65_536);
  assert.ok(bytesOf(frame("id", "alert", { note: "x".repeat(100) })) < 512, "an ordinary frame is small; the ceiling is generous on purpose");
});

test("A CLOSED STREAM UNSUBSCRIBES, so nothing is published into a dead socket", async () => {
  const routes = createMemoryRoutes({ store: aStore(), live: { providers: ["pega"], latest: () => ({}) }, vault: vault() });
  const response = new FakeResponse();
  await routes.openStream("GET", MEMORY_ALERTS_PATH, auth(TENANT), response as never);
  assert.equal(routes.hub.subscribersFor(TENANT), 1);

  // The client goes away. Without this listener the consumer stays subscribed
  // until the socket times out, and every alert in the meantime goes to nobody.
  response.emit("close");

  assert.equal(routes.hub.subscribersFor(TENANT), 0, "a consumer that left is not still receiving");
});

/* ================================================================== *
 * THE FRAME FORMAT, which is easy to get subtly wrong.                 *
 * ================================================================== */

test("A MULTILINE PAYLOAD IS ONE EVENT, not several", () => {
  const rendered = frame("id-1", "alert", "line one\nline two");
  // SSE treats a blank line as the end of an event, so an unescaped newline in a
  // payload silently becomes TWO events -- and a client sees an alert with no id
  // followed by one that is not JSON.
  const events = rendered.split("\n\n").filter((chunk) => chunk.trim() !== "");
  assert.equal(events.length, 1);
  assert.match(rendered, /data: line one\ndata: line two/);
});

test("AN ID OR EVENT NAME CONTAINING A NEWLINE CANNOT INJECT A FIELD", () => {
  const rendered = frame("id\ninjected: yes", "alert\ninjected: yes", { ok: true });
  assert.equal(rendered.includes("\ninjected:"), false, "a caller-supplied id must not become a field");
  assert.match(rendered, /^id: id injected: yes/);
});
