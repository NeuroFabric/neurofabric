import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { issueToken, staticVault, CREDENTIAL_HEADER, type VaultProvider } from "../omniroute/edge-security.ts";
import { MemoryStore } from "./store.ts";
import { createMemoryRoutes, MEMORY_ACK_PATH, MEMORY_DIFF_PATH, MEMORY_PROVIDER } from "./memory-routes.ts";

/**
 * THE DIFF, OVER HTTP.
 *
 * === WHAT IS ACTUALLY BEING ASSERTED HERE ===
 *
 * Three properties, each of which is a promise the product makes in words
 * somewhere and nowhere proves:
 *
 *  1. **THE SYSTEM PRESENTS.** An acknowledgement records that a person looked
 *     and changes nothing else. The difference is still on the list afterwards,
 *     in the same shape, and the response says so explicitly. A test that only
 *     checked "the ack was stored" would pass against an implementation that
 *     quietly marked the difference resolved -- which is the one behaviour
 *     ADR-005 §7.3 refuses.
 *  2. **THE RECORD IS TENANT-SCOPED.** Not asserted with one tenant. Both are
 *     seeded and read with each other's credential, because a scope test with one
 *     tenant passes against a reconciler that ignored the tenant entirely.
 *  3. **THE ACKNOWLEDGEMENT IS DURABLE.** Closed and reopened as a FILE, because
 *     an in-memory store cannot demonstrate persistence and "we stored it" is not
 *     the same claim as "it survives a restart".
 *
 * The absence of a `resolve` verb is asserted by the type gate and by the 405 on
 * an unknown verb; there is deliberately no test for a resolve endpoint, because
 * writing one would be writing it.
 */

const TENANT = "acme";
const OTHER = "globex";
const AGENT = "log-anomaly";

function opened(): MemoryStore {
  return MemoryStore.open({ directory: mkdtempSync(path.join(tmpdir(), "nf-routes-")), inMemory: true });
}

/** A store with one registered agent and one recorded verdict for a tenant. */
function seeded(store: MemoryStore, tenant: string): void {
  store.putSchema(tenant, AGENT, "1.0.0", { id: AGENT, version: "1.0.0" }, 1_700_000_000_000);
  store.recordDecision({
    tenant,
    agentId: `${tenant}/${AGENT}`,
    verdict: {
      at: new Date(1_700_000_000_000).toISOString(),
      provider: "pega",
      records: 262,
      breached: 1,
      document: { column: "elapsed_time" },
    },
  });
}

/**
 * THE CREDENTIALS, MINTED ONCE AND SHARED BY EVERY ROUTER BUILT HERE.
 *
 * `issueToken` generates the presented value at random, so minting it inside the
 * factory hands the router a token list whose credentials no caller holds. The
 * first version of this file did exactly that, and it produced a 401 -- a correct
 * refusal, satisfied by nothing, in eight tests at once. A shared list is also the
 * only version in which "the OTHER tenant's credential is refused on THIS
 * tenant's route" means anything.
 *
 * The value is read off the token the same way a deployment reads it: from what
 * the issuer minted, never invented by the test.
 */
const TOKENS = [TENANT, OTHER].map((tenant) => ({ tenant, token: issueToken(tenant, [MEMORY_PROVIDER]) }));
const vault = (): VaultProvider => staticVault(TOKENS.map((entry) => entry.token));
const auth = (tenant: string): Record<string, string> => ({
  [CREDENTIAL_HEADER]: TOKENS.find((entry) => entry.tenant === tenant)?.token.credential ?? "",
});

function routesFor(store: MemoryStore, latest: Record<string, number> = {}) {
  return createMemoryRoutes({
    store,
    live: { providers: ["pega"], latest: () => latest, accepts: () => true },
    vault: vault(),
  });
}

/* ------------------------------------------------------------------ */

test("an unknown path is 404 BEFORE proof, and the surface is not named", async () => {
  const routes = routesFor(opened());
  const result = await routes.handle("GET", "/api/memory/secrets", {});
  assert.equal(result.status, 404);
  assert.equal(JSON.stringify(result.body).includes(MEMORY_DIFF_PATH), false, "the refusal must not name the real routes");
});

test("no credential means no diff. The record is not served to a stranger.", async () => {
  const store = opened();
  seeded(store, TENANT);
  const result = await routesFor(store).handle("GET", MEMORY_DIFF_PATH, {});
  assert.equal(result.status, 401);
});

test("the diff answers for the PROVEN tenant only, with both tenants seeded", async () => {
  const store = opened();
  seeded(store, TENANT);
  seeded(store, OTHER);
  const routes = routesFor(store);

  const mine = await routes.handle("GET", MEMORY_DIFF_PATH, auth(TENANT));
  const theirs = await routes.handle("GET", MEMORY_DIFF_PATH, auth(OTHER));
  assert.equal(mine.status, 200);
  assert.equal(theirs.status, 200);

  const mineBody = mine.body as Record<string, unknown>;
  const theirsBody = theirs.body as Record<string, unknown>;
  assert.equal(mineBody.tenant, TENANT);
  assert.equal(theirsBody.tenant, OTHER);
  // The other tenant's agent is named by its own id, so a leak would be visible
  // in the subject of any difference. Neither tenant may see the other's.
  const mineSubjects = JSON.stringify(mineBody.differences);
  const theirsSubjects = JSON.stringify(theirsBody.differences);
  assert.ok(mineSubjects.includes(`agent ${AGENT}`), "the recorded agent produces a difference");
  assert.equal(mineSubjects.includes(OTHER), false, "another tenant's id must not appear in this diff");
  assert.equal(theirsSubjects.includes(TENANT), false, "another tenant's id must not appear in this diff");
});

test("the envelope names its own source and when it was compared", async () => {
  const store = opened();
  seeded(store, TENANT);
  const body = (await routesFor(store).handle("GET", MEMORY_DIFF_PATH, auth(TENANT))).body as Record<string, unknown>;
  // ADR-005 §9 rule 1 is STRUCTURAL, so the words have to travel with the data:
  // a panel that cannot say which half it is showing is the F1 shape.
  assert.equal(body.source, "the record");
  assert.equal(typeof body.at, "string");
  assert.equal(Number.isNaN(Date.parse(body.at as string)), false);
});

test("an empty live window produces difference 2; a live reading retires it", async () => {
  const store = opened();
  seeded(store, TENANT);

  const empty = (await routesFor(store, {}).handle("GET", MEMORY_DIFF_PATH, auth(TENANT))).body as {
    differences: { kind: string }[];
  };
  assert.ok(empty.differences.some((d) => d.kind === "no-live-window-yet"), "an empty window is a legal difference");

  const flowing = (await routesFor(store, { [`${TENANT}/${AGENT}`]: 1_700_000_000_500 }).handle(
    "GET",
    MEMORY_DIFF_PATH,
    auth(TENANT),
  )).body as { differences: { kind: string }[] };
  assert.equal(flowing.differences.some((d) => d.kind === "no-live-window-yet"), false, "a reading retires that difference");
});

test("ACKNOWLEDGING RECORDS THAT A PERSON LOOKED, AND RESOLVES NOTHING", async () => {
  const store = opened();
  seeded(store, TENANT);
  const routes = routesFor(store, {});

  const before = (await routes.handle("GET", MEMORY_DIFF_PATH, auth(TENANT))).body as {
    differences: { key: string; kind: string }[];
  };
  const key = before.differences[0]?.key;
  assert.ok(key, "there is a difference to acknowledge");

  const ack = await routes.handle("POST", MEMORY_ACK_PATH, auth(TENANT), { key });
  assert.equal(ack.status, 200);
  assert.equal((ack.body as { stillOpen: boolean }).stillOpen, true, "the response must say the difference is still open");

  const after = (await routes.handle("GET", MEMORY_DIFF_PATH, auth(TENANT))).body as {
    differences: { key: string; acknowledged: boolean }[];
  };
  const same = after.differences.find((d) => d.key === key);
  assert.ok(same, "THE DIFFERENCE IS STILL LISTED. Acknowledging is not resolving.");
  assert.equal(same.acknowledged, true, "and it now carries the operator's acknowledgement");
});

test("acknowledging something that is NOT on the list is refused", async () => {
  const store = opened();
  seeded(store, TENANT);
  const routes = routesFor(store, {});

  const invented = await routes.handle("POST", MEMORY_ACK_PATH, auth(TENANT), { key: "no-live-window-yet|agent imaginary" });
  assert.equal(invented.status, 404, "an audit trail must not record the caller's own account of what the system said");

  const empty = await routes.handle("POST", MEMORY_ACK_PATH, auth(TENANT), {});
  assert.equal(empty.status, 400);
  assert.equal(JSON.stringify(empty.body).includes("key"), true, "the refusal names the field that is missing");
});

test("an acknowledgement is TENANT-SCOPED on the way in", async () => {
  const store = opened();
  seeded(store, TENANT);
  seeded(store, OTHER);
  const routes = routesFor(store, {});

  const mine = (await routes.handle("GET", MEMORY_DIFF_PATH, auth(TENANT))).body as { differences: { key: string }[] };
  const key = mine.differences[0]?.key ?? "";
  // Same key shape, other tenant: this is only meaningful because the subject is
  // the bare agent id, which both tenants share. The write must not cross.
  await routes.handle("POST", MEMORY_ACK_PATH, auth(OTHER), { key });
  const after = (await routes.handle("GET", MEMORY_DIFF_PATH, auth(OTHER))).body as {
    differences: { key: string; acknowledged: boolean }[];
  };
  const theirs = after.differences.find((d) => d.key === key);
  assert.equal(theirs?.acknowledged, true, "their own acknowledgement is recorded");
  const mineAfter = (await routes.handle("GET", MEMORY_DIFF_PATH, auth(TENANT))).body as {
    differences: { key: string; acknowledged: boolean }[];
  };
  assert.equal(mineAfter.differences.find((d) => d.key === key)?.acknowledged, false, "and mine is untouched");
});

test("THE ACKNOWLEDGEMENT SURVIVES A RESTART, PROVEN THROUGH THE FILE", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nf-routes-durable-"));
  const first = MemoryStore.open({ directory });
  seeded(first, TENANT);
  const live = { providers: ["pega"], latest: () => ({}), accepts: () => true };
  const routes = createMemoryRoutes({ store: first, live, vault: vault() });
  const value = auth(TENANT);
  const diff = (await routes.handle("GET", MEMORY_DIFF_PATH, value)).body as {
    differences: { key: string }[];
  };
  const key = diff.differences[0]?.key ?? "";
  await routes.handle("POST", MEMORY_ACK_PATH, value, { key });
  first.close();

  const reopened = MemoryStore.open({ directory });
  try {
    const after = createMemoryRoutes({ store: reopened, live, vault: vault() });
    const body = (await after.handle("GET", MEMORY_DIFF_PATH, value)).body as {
      differences: { key: string; acknowledged: boolean }[];
      recorded: { verdicts: { agentId: string; breached: boolean }[] };
    };
    assert.equal(body.differences.find((d) => d.key === key)?.acknowledged, true, "it was still acknowledged after a restart");
    assert.equal(body.recorded.verdicts[0]?.breached, true, "and the recorded verdict is still there, because it was the record all along");
  } finally {
    reopened.close();
  }
});

test("the same difference acknowledged twice is COUNTED, not duplicated", async () => {
  const store = opened();
  seeded(store, TENANT);
  const routes = routesFor(store, {});
  const diff = (await routes.handle("GET", MEMORY_DIFF_PATH, auth(TENANT))).body as { differences: { key: string }[] };
  const key = diff.differences[0]?.key ?? "";

  await routes.handle("POST", MEMORY_ACK_PATH, auth(TENANT), { key });
  const second = await routes.handle("POST", MEMORY_ACK_PATH, auth(TENANT), { key });
  const acknowledged = (second.body as { acknowledged: { seenCount: number } }).acknowledged;
  assert.equal(acknowledged?.seenCount, 2, "a difference that came BACK after an operator looked at it is a different situation");
});

test("CORRUPTION IS ITS OWN FIELD, and is not in the difference list", async () => {
  const store = opened();
  seeded(store, TENANT);
  // A validator that REFUSES is difference 1. A validator that THROWS is
  // corruption, and folding it into the list is how a list gets skimmed.
  const routes = createMemoryRoutes({
    store,
    live: {
      providers: ["pega"],
      latest: () => ({}),
      accepts: () => {
        throw new Error("the validator changed shape");
      },
    },
    vault: vault(),
  });
  const body = (await routes.handle("GET", MEMORY_DIFF_PATH, auth(TENANT))).body as {
    differences: { kind: string }[];
    corruptions: { what: string }[];
  };
  // NOT "no differences at all". The agent is registered and nothing is live, so
  // difference 2 is still true and still owed to the operator. What must not
  // happen is a THROWING validator manufacturing a difference 1 -- which would
  // report the same agent as "the rules tightened" on every boot, forever, and be
  // skimmed with the rest.
  assert.equal(
    body.differences.some((d) => d.kind === "schema-not-accepted-now"),
    false,
    "a throwing validator must not manufacture a difference that says something else",
  );
  assert.ok(body.corruptions.some((c) => /threw/.test(c.what)), `expected an alarm, got ${JSON.stringify(body.corruptions)}`);
});

test("a tightened grammar is DIFFERENCE 1, with what the operator can do", async () => {
  const store = opened();
  seeded(store, TENANT);
  const routes = createMemoryRoutes({
    store,
    live: { providers: ["pega"], latest: () => ({}), accepts: () => false },
    vault: vault(),
  });
  const body = (await routes.handle("GET", MEMORY_DIFF_PATH, auth(TENANT))).body as {
    differences: { kind: string; whatToDo: string }[];
    summary: string;
  };
  const tightened = body.differences.find((d) => d.kind === "schema-not-accepted-now");
  assert.ok(tightened, "a schema the current rules refuse is a legal disagreement, not corruption");
  assert.ok(tightened.whatToDo.length > 0, "every difference carries what the operator can DO");
  assert.ok(body.summary.includes("Nothing has been changed"), "the summary says the system did not act");
});

test("there is no verb here that changes a schema or clears a difference", async () => {
  const store = opened();
  seeded(store, TENANT);
  const routes = routesFor(store, {});
  for (const verb of ["DELETE", "PUT", "PATCH"]) {
    const result = await routes.handle(verb, MEMORY_DIFF_PATH, auth(TENANT));
    assert.equal(result.status, 405, `${verb} must not be a way to change anything`);
  }
  for (const path of ["/api/memory/reconcile", "/api/memory/migrate", "/api/memory/resolve"]) {
    const result = await routes.handle("POST", path, auth(TENANT), {});
    assert.equal(result.status, 404, `${path} does not exist, and its absence is the design`);
  }
});
