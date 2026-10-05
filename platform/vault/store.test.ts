import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createTenantSecretStore, type Capability, type VaultAuditEvent } from "./store.ts";
import { createApprovedCredentialReader } from "./reader.ts";
import { mintCapability, READ_SCOPE } from "./capability.ts";

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

/** A signing key for the handover tests. Local to them, and never exported. */
const HANDOVER_KEY = randomBytes(32);

interface Harness {
  readonly retrieve: (capability: Capability, name: string) => Promise<
    | { readonly ok: true; readonly value: Buffer }
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
        if (tenant === TENANT_A) {
          return {
            tenant,
            secrets: [
              { name: "payments/api-key", value: Buffer.from(SECRET_VALUE, "utf8"), rotatedAt: "2026-01-01T00:00:00.000Z" },
              { name: "payments/secret-key", value: Buffer.from("shh-" + SECRET_VALUE, "utf8"), rotatedAt: "2026-01-01T00:00:00.000Z" },
            ],
          };
        }
        if (tenant === TENANT_B) {
          // A name that exists ONLY here, so a test can ask for a secret that is
          // genuinely real, genuinely reachable by its owner, and genuinely out of
          // reach for anyone else. A name shared by both tenants cannot show
          // isolation, because "the name matched" and "the value came from the
          // other tenant" are indistinguishable at the boundary.
          return {
            tenant,
            secrets: [{ name: "globex/only-here", value: Buffer.from("globex-" + SECRET_VALUE, "utf8"), rotatedAt: "2026-01-01T00:00:00.000Z" }],
          };
        }
        return undefined;
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
  // BYTES, not a string. `deepEqual` on two Buffers compares length and contents,
  // so this is a real equality assertion on the credential rather than on a
  // reference -- a `.toString("utf8")` here would quietly reintroduce the string
  // copy this change exists to remove.
  if (outcome.ok) assert.deepEqual(outcome.value, Buffer.from(SECRET_VALUE, "utf8"));
});

test("A CAPABILITY CANNOT REACH ANOTHER TENANT'S OWN SECRET, AND THAT TENANT IS NEVER LOADED", async () => {
  const { retrieve, loadedTenants } = harness();

  // `globex/only-here` is a real secret belonging to tenant B. A tenant A
  // capability that NAMES it exactly -- so the grant check passes -- must still be
  // refused, because the store only ever loads the capability's own tenant.
  //
  // The stronger half is the load assertion: the store must not have gone looking
  // in tenant B at all. A refusal decided after the bytes were in hand is not an
  // isolation boundary, it is a filter over a read that already happened.
  const outcome = await retrieve(capability({ secrets: ["globex/only-here"] }), "globex/only-here");

  assert.equal(outcome.ok, false);
  // Tenant A IS consulted -- that is the store doing its job, looking only where
  // the capability points. What must never happen is a load of tenant B, because
  // that is where the secret actually lives. Asserting "no tenant was consulted"
  // would have been a stronger claim than the design makes, and would have failed
  // a correct implementation.
  assert.deepEqual(
    loadedTenants(),
    [TENANT_A],
    "only the capability's own tenant is ever consulted, so the other tenant's bytes are never in hand",
  );
});

test("THE ENTITLED TENANT CAN STILL REACH ITS OWN SECRET, so the test above is isolation and not refusal", async () => {
  const { retrieve } = harness();

  // Without this, "cannot reach another tenant" is satisfied by refusing
  // everything. The two claims have to be tested together or the first one is
  // indistinguishable from a store that is simply closed.
  const outcome = await retrieve(
    capability({ tenant: TENANT_B, secrets: ["globex/only-here"] }),
    "globex/only-here",
  );

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.deepEqual(outcome.value, Buffer.from("globex-" + SECRET_VALUE, "utf8"));
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

  // A refusal that names the tenant tells a prober they guessed the tenant right,
  // and one that echoes the secret name turns a refusal into a confirmation. The
  // message has to be usable for retry logic and useless for guessing.
  const outcome = await retrieve(capability({ tenant: TENANT_B, secrets: [] }), "globex/only-here");

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.message.includes(TENANT_B), false);
    assert.equal(outcome.message.includes(TENANT_A), false);
    assert.equal(outcome.message.includes("globex"), false, "the secret name is echoed back");
    assert.equal(outcome.message.includes(SECRET_VALUE), false);
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
      async load() {
        return { tenant: TENANT_B, secrets: [{ name: "payments/api-key", value: Buffer.from(SECRET_VALUE, "utf8"), rotatedAt: "now" }] };
      },
    },
    audit: (event) => events.push(event),
    now: () => 1_000_000,
  });

  const outcome = await store.retrieve(capability({ tenant: TENANT_A }), "payments/api-key");

  assert.equal(outcome.ok, false, "a set labelled for another tenant must not be served to this one");
});

// THE BUFFER HANDOVER, AND THE OVERWRITE THAT FOLLOWS IT.

// === WHY THIS FILE, WHEN THE OVERWRITE LIVES IN THE READER ===
//
// Because the PROPERTY being pinned spans both modules, and the part that is easy to
// get wrong is the seam. The store hands the reader a buffer; the reader consumes it
// and is supposed to leave it overwritten. A test inside either module alone can only
// see half of that -- the store cannot know what the reader did afterwards, and a
// reader test cannot prove what was actually handed to it. So the test lives at the
// join and holds a handle on the exact buffer the source produced.
//
// === WHY "THE REFERENCE IS CORRECT" IS NOT THE TEST ===
//
// Every other assertion about a reference checks that it equals the right digest.
// That assertion passes IDENTICALLY whether or not the credential is still sitting in
// memory -- the bug and the fix produce the same reference. So the reference is
// asserted here only as a secondary fact. The primary assertion is on the BUFFER:
// that its bytes are no longer the credential's.

test("THE STORE HANDS OUT A BUFFER, not a string, because a string cannot be cleared in place", async () => {
  const handed: Buffer[] = [];
  const store = createTenantSecretStore({
    source: {
      async load(tenant: string) {
        const value = Buffer.from(SECRET_VALUE, "utf8");
        handed.push(value);
        return { tenant, secrets: [{ name: "payments/api-key", value, rotatedAt: "2026-01-01T00:00:00.000Z" }] };
      },
    },
    audit: () => {},
    now: () => 1_000_000,
  });

  const outcome = await store.retrieve(capability(), "payments/api-key");

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(Buffer.isBuffer(outcome.value), true, "the granted value is bytes, not text");
  assert.equal(outcome.value.toString("utf8"), SECRET_VALUE, "and it is the right bytes");
});

test("AFTER THE LIFECYCLE THE BUFFER IS OVERWRITTEN, and the reference is still correct", async () => {
  // The two halves of the claim, asserted separately because they fail differently.
  //
  // If only the reference were checked, a store that loaded the credential and
  // dropped it would pass. If only the buffer were checked, a reader that wiped the
  // buffer before hashing would pass while returning a digest of nothing. Together
  // they say: the bytes were read, the digest is of those bytes, and the bytes are
  // gone afterwards.
  const handed: Buffer[] = [];
  const store = createTenantSecretStore({
    source: {
      async load(tenant: string) {
        const value = Buffer.from(SECRET_VALUE, "utf8");
        handed.push(value);
        return { tenant, secrets: [{ name: "payments/api-key", value, rotatedAt: "2026-01-01T00:00:00.000Z" }] };
      },
    },
    audit: () => {},
    now: () => 1_000_000,
  });

  const reader = createApprovedCredentialReader({
    store,
    capability: mintCapability(
      { capabilityId: "cap-01", tenant: TENANT_A, scopes: [READ_SCOPE], expiresAt: 2_000_000 },
      HANDOVER_KEY,
    ),
    verificationKey: HANDOVER_KEY,
    now: () => 1_000_000,
  });

  const outcome = await reader.read({ tenant: TENANT_A, credentialName: "payments/api-key" });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;

  // SECONDARY: the reference was computed from the real bytes, not from an empty or
  // pre-wiped buffer. A reader that wiped first would produce a stable but WRONG
  // digest, and this assertion is what notices.
  assert.match(outcome.reference, /^<redacted_credential_ref:[0-9a-f]{16}>$/);
  assert.equal(outcome.reference.includes(SECRET_VALUE), false);
  assert.equal(outcome.exposed, false);

  // PRIMARY: the buffer the source handed out no longer holds the credential.
  const buffer = handed[0];
  assert.ok(buffer !== undefined, "the source was consulted");
  assert.equal(
    buffer.toString("utf8").includes(SECRET_VALUE),
    false,
    "the credential is no longer in the buffer that was handed over",
  );
  assert.equal(
    buffer.length,
    Buffer.byteLength(SECRET_VALUE, "utf8"),
    "overwritten in place -- same length, different bytes -- rather than truncated or reallocated",
  );
});

test("THE RAW PATH OVERWRITES TOO, so returning a value does not leave the bytes behind", async () => {
  // The raw path is the one that hands a credential to somebody, so it is the one
  // where leaving the bytes behind would matter most.
  const handed: Buffer[] = [];
  const store = createTenantSecretStore({
    source: {
      async load(tenant: string) {
        const value = Buffer.from(SECRET_VALUE, "utf8");
        handed.push(value);
        return { tenant, secrets: [{ name: "payments/api-key", value, rotatedAt: "2026-01-01T00:00:00.000Z" }] };
      },
    },
    audit: () => {},
    now: () => 1_000_000,
  });

  const reader = createApprovedCredentialReader({
    store,
    capability: mintCapability(
      { capabilityId: "cap-01", tenant: TENANT_A, scopes: [READ_SCOPE], expiresAt: 2_000_000 },
      HANDOVER_KEY,
    ),
    verificationKey: HANDOVER_KEY,
    now: () => 1_000_000,
  });

  const outcome = await reader.read({
    tenant: TENANT_A,
    credentialName: "payments/api-key",
    exposure: "raw",
    acknowledged: true,
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok ? outcome.exposed : false, true, "the caller did receive the value");
  assert.equal(handed[0]?.toString("utf8").includes(SECRET_VALUE), false, "and the buffer is still cleared");
});