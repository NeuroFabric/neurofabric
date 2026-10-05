import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { createTenantSecretStore, type Capability, type SecretSetMetadata } from "./store.ts";
import { mintCapability, READ_SCOPE, type CapabilityClaims } from "./capability.ts";
import { createApprovedCredentialReader } from "./reader.ts";

/**
 * METADATA WITHOUT THE VALUE, WHICH IS THE RESIDUAL ADR-010 §5 NAMED.
 *
 * === WHY THIS IS NOT A FLAG ON THE EXISTING READ ===
 *
 * The reference read loads the credential in order to hash it. So the default
 * "safe" path still pulls a live credential into this process to produce a label
 * that contains none of it -- which protects the CONTEXT WINDOW and leaves the
 * process exactly as exposed as before. Closing that needs a read that never
 * materialises the bytes at all, which is a different PORT rather than a different
 * argument, because the difference is in what crosses the process boundary.
 *
 * === THE TEST THAT MATTERS IS A NEGATIVE ONE ===
 *
 * `loads` counts calls to the source's value-loading method. Every metadata case
 * asserts it is ZERO. Asserting that the answer "looks metadata-shaped" would prove
 * nothing -- a store that loaded the value and then carefully left it out of the
 * return type would pass. Counting the load is the only way to show the bytes were
 * never in hand.
 *
 * === NO FALLBACK, DELIBERATELY ===
 *
 * A source that cannot describe anything must REFUSE, not quietly fall back to
 * loading values. A fallback would make the safe path depend on the source being
 * well configured, which is exactly the kind of property that is true in a test and
 * false in production.
 */

const TENANT = "acme";
const VALUE = "sk-live-EXAMPLE-DO-NOT-LOG-THIS-VALUE";
const METADATA: SecretSetMetadata = {
  tenant: TENANT,
  entries: [
    { name: "payments/api-key", rotatedAt: "2026-01-01T00:00:00.000Z", present: true },
    { name: "billing/token", rotatedAt: "2025-06-01T00:00:00.000Z", present: false },
  ],
};

function capability(over: Partial<Capability> = {}): Capability {
  return { id: "cap-01", tenant: TENANT, secrets: ["payments/api-key"], expiresAt: 2_000_000, ...over };
}

/** A source that counts value loads, so "the bytes were never read" is checkable. */
function countingSource() {
  const loads: string[] = [];
  const describes: string[] = [];
  const source = {
    async load(tenant: string) {
      loads.push(tenant);
      return { tenant, secrets: [{ name: "payments/api-key", value: Buffer.from(VALUE, "utf8"), rotatedAt: "2026-01-01T00:00:00.000Z" }] };
    },
    async describe(tenant: string) {
      describes.push(tenant);
      return METADATA;
    },
  };
  return { source, loads, describes };
}

// THE STORE.

test("DESCRIBE ANSWERS EXISTENCE AND ROTATION WITHOUT LOADING A VALUE", async () => {
  const { source, loads } = countingSource();
  const store = createTenantSecretStore({ source, audit: () => {}, now: () => 1_000_000 });

  const outcome = await store.describe(capability(), "payments/api-key");

  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.metadata.present, true);
    assert.equal(outcome.metadata.rotatedAt, "2026-01-01T00:00:00.000Z");
  }
  assert.deepEqual(loads, [], "the value-loading path was never called, so the bytes were never in hand");
});

test("A SOURCE THAT CANNOT DESCRIBE REFUSES, AND NEVER FALLS BACK TO LOADING", async () => {
  // The fallback is the trap. If `describe` quietly used `load`, the safe path would
  // depend on every source implementing a metadata projection -- and the failure
  // would be invisible in the type system and in production.
  let loads = 0;
  const store = createTenantSecretStore({
    source: {
      async load(tenant: string) {
        loads += 1;
        return { tenant, secrets: [{ name: "payments/api-key", value: Buffer.from(VALUE, "utf8"), rotatedAt: "now" }] };
      },
    },
    audit: () => {},
    now: () => 1_000_000,
  });

  const outcome = await store.describe(capability(), "payments/api-key");

  assert.equal(outcome.ok, false);
  assert.equal(loads, 0, "and the value was not loaded on the way to refusing");
});

test("DESCRIBE IS GATED EXACTLY LIKE THE VALUE READ", async () => {
  // A metadata read that skipped the grant check would be a way to enumerate what
  // exists -- "which credential names are real" is exactly what the store refuses to
  // be an oracle about, and it is just as sensitive without the values.
  const { source, loads } = countingSource();
  const store = createTenantSecretStore({ source, audit: () => {}, now: () => 1_000_000 });

  const ungranted = await store.describe(capability(), "billing/token");
  const wrongTenant = await store.describe(capability({ tenant: "globex" }), "payments/api-key");
  const expired = await store.describe(capability({ expiresAt: 999_999 }), "payments/api-key");

  for (const outcome of [ungranted, wrongTenant, expired]) {
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.code, ungranted.ok ? "" : outcome.code, "one refusal for every cause");
  }
  assert.deepEqual(loads, [], "no gate was skipped");
});

test("DESCRIBE REPORTS ABSENCE WITHOUT DISCLOSING WHETHER THE NAME IS REAL", async () => {
  const { source } = countingSource();
  const store = createTenantSecretStore({ source, audit: () => {}, now: () => 1_000_000 });

  const granted = await store.describe(capability({ secrets: ["payments/api-key", "billing/token"] }), "billing/token");
  const absent = await store.describe(capability({ secrets: ["payments/api-key", "billing/token"] }), "internal/never-existed");

  // A granted name that is NOT present answers `present: false`, and an ungranted
  // one refuses outright. Those are different answers, so the grant -- not
  // existence -- is what the caller has to already know.
  assert.equal(granted.ok, true);
  if (granted.ok) assert.equal(granted.metadata.present, false);
  assert.equal(absent.ok, false);
});

test("NO DESCRIBE RESULT CARRIES A VALUE, AT ANY DEPTH", async () => {
  const { source } = countingSource();
  const store = createTenantSecretStore({ source, audit: () => {}, now: () => 1_000_000 });

  const outcome = await store.describe(capability(), "payments/api-key");

  assert.equal(JSON.stringify(outcome).includes("sk-live"), false);
  assert.equal((outcome as { value?: unknown }).value, undefined, "there is no value field to leak");
});

// THE READER.

const KEY = randomBytes(32);
const CLAIMS: CapabilityClaims = { capabilityId: "cap-01", tenant: TENANT, scopes: [READ_SCOPE], expiresAt: 2_000_000 };

test("A METADATA READ USES THE METADATA PATH AND NEVER THE VALUE PATH", async () => {
  const { source, loads, describes } = countingSource();
  const store = createTenantSecretStore({ source, audit: () => {}, now: () => 1_000_000 });
  const reader = createApprovedCredentialReader({
    store,
    capability: mintCapability(CLAIMS, KEY),
    verificationKey: KEY,
    now: () => 1_000_000,
  });

  const outcome = await reader.read({ tenant: TENANT, credentialName: "payments/api-key", exposure: "metadata" });

  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.metadata?.present, true);
    assert.equal(outcome.metadata?.rotatedAt, "2026-01-01T00:00:00.000Z");
  }
  assert.deepEqual(loads, [], "the value path was never entered");
  assert.deepEqual(describes, [TENANT]);
});

test("AN ACKNOWLEDGEMENT CANNOT TURN A METADATA READ INTO A VALUE READ", async () => {
  // The exposure decides, not the boxes. A caller that sets the raw acknowledgement
  // on a metadata request must still get metadata, or the cheapest way to get a
  // value would be to claim metadata and wave the acknowledgement flag.
  const { source, loads } = countingSource();
  const store = createTenantSecretStore({ source, audit: () => {}, now: () => 1_000_000 });
  const reader = createApprovedCredentialReader({
    store,
    capability: mintCapability(CLAIMS, KEY),
    verificationKey: KEY,
    now: () => 1_000_000,
  });

  const outcome = await reader.read({
    tenant: TENANT,
    credentialName: "payments/api-key",
    exposure: "metadata",
    acknowledged: true,
  });

  assert.equal(outcome.ok, true);
  if (outcome.ok) assert.equal(outcome.exposed, false);
  assert.deepEqual(loads, [], "and still no value was loaded");
});

test("AN UNVERIFIED CAPABILITY NEVER REACHES EITHER PATH", async () => {
  const { source, loads, describes } = countingSource();
  const store = createTenantSecretStore({ source, audit: () => {}, now: () => 1_000_000 });
  const reader = createApprovedCredentialReader({
    store,
    capability: "v1.forged.AAAA",
    verificationKey: KEY,
    now: () => 1_000_000,
  });

  const outcome = await reader.read({ tenant: TENANT, credentialName: "payments/api-key", exposure: "metadata" });

  assert.equal(outcome.ok, false);
  assert.deepEqual(loads, []);
  assert.deepEqual(describes, []);
});

test("THE METADATA READ IS AUDITED AS ITS OWN EVENT, not folded into the reference one", async () => {
  const events: { exposure: string }[] = [];
  const { source } = countingSource();
  const store = createTenantSecretStore({ source, audit: () => {}, now: () => 1_000_000 });
  const reader = createApprovedCredentialReader({
    store,
    capability: mintCapability(CLAIMS, KEY),
    verificationKey: KEY,
    now: () => 1_000_000,
    audit: (event) => events.push({ exposure: event.exposure }),
  });

  await reader.read({ tenant: TENANT, credentialName: "payments/api-key", exposure: "metadata" });

  assert.deepEqual(events, [{ exposure: "metadata" }]);
});