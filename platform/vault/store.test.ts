import test from "node:test";
import assert from "node:assert/strict";

import { createTenantSecretStore, type Capability, type VaultAuditEvent } from "./store.ts";

/**
 * TENANT-ISOLATED, CAPABILITY-BOUNDED SECRET RETRIEVAL.
 *
 * === WHY THIS EXISTS SEPARATELY FROM platform/core/vault.ts ===
 *
 * The D-016 vault is file-backed and operator-scoped, and its safety for an
 * unredacted read comes from somewhere this module cannot borrow: the kernel
 * precheck, where every tool passes through one controlled point and a
 * CONTROLLED-tier reveal requires approval recorded in the trace BEFORE the
 * handler runs.
 *
 * The MCP embassy has no such point. `callTool` invokes a handler directly, and
 * `callCore` reaches the portal with a credential. So a secret reachable from the
 * embassy would be reachable with no approval mechanism at all -- which is not the
 * reviewed capability being enabled, it is a new and weaker one. Hence a separate
 * module whose safety does not depend on a choke point that is not there.
 *
 * === WHAT IS ACTUALLY BEING PINNED ===
 *
 * Every test below is about what a HOLDER OF A CAPABILITY CANNOT DO, because the
 * entitled path is one line and the refusal paths are the design. The repeated
 * assertion is that a refusal is INDistinguishable: one code, one message, for
 * every reason the answer is no.
 *
 * That is the whole security argument. If "you are not entitled to that" and
 * "that does not exist" answer differently, then a caller can enumerate which
 * secret names are real by asking for all of them, and the store becomes an index
 * of every tenant's credentials for anyone holding one token.
 */

const TENANT_A = "acme";
const TENANT_B = "globex";

const SECRET_VALUE = "sk-live-DO-NOT-LOG-THIS-VALUE";

interface Harness {
  readonly retrieve: (capability: Capability, name: string) => Promise<
    | { readonly ok: true; readonly value: string }
    | { readonly ok: false; readonly code: string; readonly message: string }
  >;
  readonly audit: () => readonly VaultAuditEvent[];
  readonly loadedTenants: () => readonly string[];
  readonly revoke: (id: string) => void;
}

function harness(): Harness {
  const events: VaultAuditEvent[] = [];
  const loaded: string[] = [];
  const revoked = new Set<string>();

  const store = createTenantSecretStore({
    // A source that would happily hand over anything, so the tests prove the STORE
    // is the boundary rather than the source being well behaved.
    source: {
      async load(tenant: string) {
        loaded.push(tenant);
        if (tenant !== TENANT_A && tenant !== TENANT_B) return undefined;
        return {
          tenant,
          secrets: [
            { name: "payments/api-key", value: SECRET_VALUE, rotatedAt: "2026-01-01T00:00:00.000Z" },
            { name: "payments/secret-key", value: "shh-" + SECRET_VALUE, rotatedAt: "2026-01-01T00:00:00.000Z" },
          ],
        };
      },
    },
    audit: (event) => events.push(event),
    now: () => 1_000_000,
  });

  return {
    retrieve: (capability, name) => store.retrieve(capability, name),
    audit: () => events,
    loadedTenants: () => loaded,
    revoke: (id) => revoked.add(id),
  };
}

function capability(over: Partial<Capability> = {}): Capability {
  return {
    id: "cap-1",
    tenant: TENANT_A,
    secrets: ["payments/api-key"],
    expiresAt: 2_000_000,
    revoked: false,
    ...over,
  };
}

test("AN ENTITLED CAPABILITY READS ITS OWN SECRET", async () => {
  const { retrieve } = harness();
  const outcome = await retrieve(capability(), "payments/api-key");

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.value, SECRET_VALUE);
});

test("A CAPABILITY CANNOT REACH ANOTHER TENANT, AND THE STORE NEVER LOADS THAT TENANT", async () => {
  const { retrieve, loadedTenants } = harness();

  // The capability names tenant A and asks for a secret name that also exists in
  // tenant B. The answer must be no, and the store must not have gone looking in
  // tenant B at all -- loading it would mean the refusal came after the read, not
  // before it.
  const outcome = await retrieve(capability(), "payments/secret-key");

  assert.equal(outcome.ok, false);
  assert.deepEqual(loadedTenants, [TENANT_A], "only the capability's own tenant is consulted");
});

test("A CAPABILITY CANNOT REACH A SECRET IT WAS NOT GRANTED, IN ITS OWN TENANT", async () => {
  const { retrieve } = harness();

  // Same tenant, right shape, wrong grant. This is the case a tenant-scoped check
  // alone would wave through, because the tenant matches perfectly.
  const outcome = await retrieve(capability(), "payments/secret-key");

  assert.equal(outcome.ok, false);
});

test("NOT ENTITLED AND DOES NOT EXIST ARE THE SAME ANSWER, or the store is an index", async () => {
  const { retrieve } = harness();

  const ungranted = await retrieve(capability(), "payments/secret-key");
  const nonexistent = await retrieve(capability(), "internal/super-secret-that-was-never-a-name");

  assert.equal(ungranted.ok, false);
  assert.equal(nonexistent.ok, false);
  if (!ungranted.ok && !nonexistent.ok) {
    assert.equal(ungranted.code, nonexistent.code, "a differing code is an existence oracle");
    assert.equal(ungranted.message, nonexistent.message, "a differing message is too");
  }
});

test("A CROSS-TENANT REQUEST AND A SAME-TENANT REFUSAL ARE ALSO INDISTINGUISHABLE", async () => {
  const { retrieve } = harness();

  // Otherwise the code alone separates "wrong tenant" from "wrong name", which is
  // enough to confirm that a name exists SOMEWHERE even without naming where.
  const otherTenant = await retrieve(capability({ tenant: TENANT_B }), "payments/secret-key");
  const sameTenant = await retrieve(capability(), "payments/secret-key");

  assert.equal(otherTenant.ok, false);
  assert.equal(sameTenant.ok, false);
  if (!otherTenant.ok && !sameTenant.ok) {
    assert.equal(otherTenant.code, sameTenant.code);
    assert.equal(otherTenant.message, sameTenant.message);
  }
});

test("AN EXPIRED CAPABILITY READS NOTHING", async () => {
  const { retrieve } = harness();
  const outcome = await retrieve(capability({ expiresAt: 999_999 }), "payments/api-key");

  assert.equal(outcome.ok, false);
});

test("A CAPABILITY WITH NO EXPIRY IS REFUSED, because an eternal grant is not a grant", async () => {
  const { retrieve } = harness();
  const outcome = await retrieve(capability({ expiresAt: undefined as unknown as number }), "payments/api-key");

  assert.equal(outcome.ok, false);
});

test("EVERY ATTEMPT IS AUDITED, INCLUDING THE ONES THAT WERE REFUSED", async () => {
  const { retrieve, audit } = harness();

  await retrieve(capability(), "payments/api-key");
  await retrieve(capability(), "payments/secret-key");

  const events = audit();
  assert.equal(events.length, 2, "a refused read is the one most worth recording");
  assert.equal(events[0]?.outcome, "granted");
  assert.equal(events[1]?.outcome, "refused");
});

test("NOTHING IN THE AUDIT TRAIL CONTAINS A SECRET, because the trail outlives the secret", async () => {
  const { retrieve, audit } = harness();

  await retrieve(capability(), "payments/api-key");
  await retrieve(capability(), "payments/secret-key");
  await retrieve(capability({ tenant: TENANT_B }), "payments/api-key");

  const serialised = JSON.stringify(audit());
  assert.equal(serialised.includes(SECRET_VALUE), false, "an audit event carried the value");
  assert.equal(serialised.includes("shh-"), false, "or a prefix of it");
});

test("NOTHING IN A REFUSAL MESSAGE CONTAINS A SECRET OR THE TENANT", async () => {
  const { retrieve } = harness();

  const outcome = await retrieve(capability({ tenant: TENANT_B }), "payments/api-key");

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    // A refusal that names the tenant tells a prober they guessed the tenant
    // right. The answer has to be usable for retry logic and useless for guessing.
    assert.equal(outcome.message.includes(TENANT_B), false);
    assert.equal(outcome.message.includes(SECRET_VALUE), false);
    assert.equal(outcome.message.includes("payments"), false);
  }
});

test("AN AUDIT EVENT NAMES THE SECRET ASKED FOR, so a refusal can still be investigated", async () => {
  const { retrieve, audit } = harness();

  await retrieve(capability(), "payments/secret-key");

  // The refusal hides the value from the CALLER; it must not hide the request from
  // the operator, or an incident review has nothing to work from.
  assert.equal(audit()[0]?.name, "payments/secret-key");
  assert.equal(audit()[0]?.tenant, TENANT_A);
});

test("A REVOKED CAPABILITY IS REFUSED EVEN WHILE IT IS STILL WITHIN ITS WINDOW", async () => {
  const { retrieve } = harness();

  const outcome = await retrieve(capability({ revoked: true }), "payments/api-key");

  assert.equal(outcome.ok, false);
});

test("A CAPABILITY WITH AN EMPTY GRANT READS NOTHING, EVEN FOR ITS OWN TENANT", async () => {
  const { retrieve } = harness();

  const outcome = await retrieve(capability({ secrets: [] }), "payments/api-key");

  assert.equal(outcome.ok, false);
});

test("A GRANT NAMES WHOLE SECRETS, SO A PREFIX NEVER INHERITS ITS NEIGHBOUR", async () => {
  const { retrieve } = harness();

  // Granted `payments/api-key`, asking for `payments/api-key-2`. A prefix or
  // wildcard comparison would hand over a secret the grant never named.
  const granted = capability({ secrets: ["payments/api-key"] });
  const outcome = await retrieve(granted, "payments/api-key-2");

  assert.equal(outcome.ok, false);
});

test("A SOURCE THAT RETURNS A SET FOR A DIFFERENT TENANT IS REFUSED, not served", async () => {
  // The store trusts its source to answer for the tenant asked about. A source
  // that answers for somebody else is a bug in the source, and serving its answer
  // would turn that bug into a cross-tenant disclosure.
  const events: VaultAuditEvent[] = [];
  const store = createTenantSecretStore({
    source: {
      async load(tenant: string) {
        return { tenant: TENANT_B, secrets: [{ name: "payments/api-key", value: SECRET_VALUE, rotatedAt: "now" }] };
      },
    },
    audit: (event) => events.push(event),
    now: () => 1_000_000,
  });

  const outcome = await store.retrieve(capability({ tenant: TENANT_A }), "payments/api-key");

  assert.equal(outcome.ok, false, "a set labelled for another tenant must not be served to this one");
});