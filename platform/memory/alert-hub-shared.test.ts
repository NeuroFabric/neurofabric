import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAlertHub, AlertHub } from "../memory/alert-hub.ts";
import { createVerdictBroadcaster, verdictFrame, type VerdictHub } from "../embassy/async-approval.ts";
import { createMemoryRoutes } from "../memory/memory-routes.ts";
import { MemoryStore } from "../memory/store.ts";
import { environmentVault } from "../omniroute/edge-security.ts";

/**
 * THE SHARED HUB, AND WHY IT NEEDS A TEST.
 *
 * Two modules each calling `new AlertHub()` compiles, passes every existing test,
 * and produces a gateway that publishes verdicts into a subscriber set nobody is
 * subscribed to. There is no symptom other than silence, and silence is exactly
 * what a feature that is not working looks like.
 *
 * So the thing asserted here is SHARED IDENTITY: one instance, reachable from the
 * publisher side and the subscription side. If anyone reintroduces an internal
 * construction, this fails.
 */

const VERDICT = {
  taskToken: "tk_shared",
  status: "approved" as const,
  subject: { tenant: "acme", tool: "read_credential", credentialName: "k", exposure: "reference" as const },
  decidedAt: new Date(1_000).toISOString(),
  result: "<redacted_credential_ref:shared>",
};

test("an injected hub is the SAME instance the memory routes publish and subscribe on", () => {
  const shared = createAlertHub();
  const seen: string[] = [];

  const store = MemoryStore.open({ directory: scratchDir() });
  const routes = createMemoryRoutes({
    store,
    live: { providers: [], latest: () => undefined, accepts: () => true },
    vault: environmentVault(),
    hub: shared,
  });

  assert.equal(routes.hub, shared, "the memory routes built their own hub instead of using the injected one");

  // A subscriber on the SHARED hub receives a verdict published through the routes'
  // own reference to it.
  shared.open("acme", (frame) => seen.push(frame));
  routes.hub.publish("acme", "id: 1\nevent: test\ndata: {}\n\n");

  assert.equal(seen.length, 1, "a subscriber on the shared hub received nothing");
  store.close?.();
});

test("with NO injected hub the routes still build one, so nothing regresses", () => {
  const store = MemoryStore.open({ directory: scratchDir() });
  const routes = createMemoryRoutes({
    store,
    live: { providers: [], latest: () => undefined, accepts: () => true },
    vault: environmentVault(),
  });
  assert.ok(routes.hub instanceof AlertHub, "omitting the hub must still produce a working one");
  store.close?.();
});

test("a verdict published to an INJECTED hub reaches that hub's subscribers", () => {
  // The exact failure the previous commit had: two hubs, one publisher, one
  // subscriber set, and a verdict that vanishes with no error anywhere.
  const shared = createAlertHub();
  const frames: string[] = [];
  shared.open("acme", (frame) => frames.push(frame));

  const broadcast = createVerdictBroadcaster(shared satisfies VerdictHub);
  broadcast(VERDICT);

  assert.equal(frames.length, 1, "the verdict was not delivered to the injected hub");
  assert.ok(frames[0]?.includes(VERDICT.taskToken));

  // And it is tenant-scoped: another tenant's subscriber sees nothing.
  const other: string[] = [];
  shared.open("globex", (frame) => other.push(frame));
  broadcast(VERDICT);
  assert.deepEqual(other, [], "a verdict crossed tenants");
});

test("verdictFrame still renders one SSE event, not two", () => {
  // A newline in the data would split the frame and the client would read two
  // events. The hub's framer exists for exactly this and is not reimplemented.
  const frame = verdictFrame(VERDICT);
  assert.equal((frame.match(/\n\n/g) ?? []).length, 1, "the verdict rendered as more than one SSE event");
  assert.ok(frame.startsWith(`id: ${VERDICT.taskToken}\n`));
});

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "hub-shared-"));
}