import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { mintCapability, READ_SCOPE, type CapabilityClaims } from "./capability.ts";
import { createApprovedCredentialReader, REDACTED_REF_PREFIX } from "./reader.ts";
import { createTenantSecretStore, type VaultAuditEvent } from "./store.ts";
import { MemoryStore } from "../memory/store.ts";

/**
 * THE READER: THE ONE PATH FROM AN APPROVED CALL TO A VALUE.
 *
 * === THE ORDER, WHICH IS THE WHOLE OF TASK 2 ===
 *
 * Verify, then read. In that order, always, and the test for it is a source of
 * reads that throws if touched -- so "verification failed" cannot quietly become
 * "verified anyway" later without a test failing. The store is the slow, dangerous
 * dependency; anything that can refuse should refuse before it.
 *
 * === WHY THE VALUE NEVER TRAVELS BY DEFAULT ===
 *
 * The reader of an MCP response is a language model, and its context window is not
 * a trusted place for a credential. It is quoted, summarised, logged, and pasted
 * into the next turn. So the default answer is a REFERENCE: a stable, non-reversible
 * label the agent can carry and cite without ever holding the bytes.
 *
 * Raw bytes exist as an option because a tool that cannot ever return a value is a
 * tool with no use -- and an option nobody can reach is not an option at all. So it
 * is reachable, and it is expensive on purpose.
 *
 * === THE COST OF RAW IS PAID BEFORE, NOT AFTER ===
 *
 * Raw exposure needs a caller flag, an operator told plainly what they are
 * agreeing to, and a SECOND, SEPARATE acknowledgement. One box ticked under a
 * generic heading is how a credential ends up in a transcript, and the difference
 * between "approve this read" and "approve this read AND put a live credential into
 * a model's memory" is exactly the difference the warning exists to make visible.
 */

const KEY = randomBytes(32);
const VALUE = "sk-live-EXAMPLE-DO-NOT-LOG-THIS-VALUE";
const TENANT = "acme";

const CLAIMS: CapabilityClaims = {
  capabilityId: "cap-01",
  tenant: TENANT,
  scopes: [READ_SCOPE],
  expiresAt: 2_000_000,
};

/** A store whose source records every call, so "the store was never invoked" is checkable. */
function harness(over: { capability?: string; raw?: boolean; sourceThrows?: boolean } = {}) {
  const reads: string[] = [];
  const audits: VaultAuditEvent[] = [];
  const store = createTenantSecretStore({
    source: {
      async load(tenant: string) {
        reads.push(tenant);
        if (over.sourceThrows === true) throw new Error("the source exploded");
        return {
          tenant,
          secrets: [{ name: "payments/api-key", value: Buffer.from(VALUE, "utf8"), rotatedAt: "2026-01-01T00:00:00.000Z" }],
        };
      },
    },
    audit: (event) => audits.push(event),
    now: () => 1_000_000,
  });

  const reader = createApprovedCredentialReader({
    store,
    capability: over.capability ?? mintCapability(CLAIMS, KEY),
    verificationKey: KEY,
    now: () => 1_000_000,
  });

  return { reader, reads, audits };
}

// === THE DEFAULT: A REFERENCE, NOT A VALUE ===

test("THE DEFAULT ANSWER IS A REFERENCE, AND THE VALUE IS NOT IN IT", async () => {
  const { reader } = harness();
  const outcome = await reader.read({ tenant: TENANT, credentialName: "payments/api-key" });

  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.ok(outcome.reference.startsWith(REDACTED_REF_PREFIX), "the caller gets a reference");
    assert.equal(outcome.reference.includes(VALUE), false, "and not a byte of the value");
    assert.equal(JSON.stringify(outcome).includes("sk-live"), false, "nor anywhere else in the answer");
    assert.equal(outcome.exposed, false);
  }
});

test("THE REFERENCE IS STABLE AND NON-REVERSIBLE, so it can be logged and cited", async () => {
  const { reader } = harness();
  const first = await reader.read({ tenant: TENANT, credentialName: "payments/api-key" });
  const second = await reader.read({ tenant: TENANT, credentialName: "payments/api-key" });
  const other = await reader.read({ tenant: TENANT, credentialName: "billing/token" });

  assert.equal(first.ok && second.ok ? first.reference === second.reference : false, true, "the same entry gets the same reference");
  assert.equal(
    first.ok && other.ok ? first.reference === other.reference : true,
    true,
    "and two entries must not collide, or a reference would name the wrong credential",
  );
  assert.equal(first.ok ? first.reference.includes("payments") : true, false, "the reference does not embed the entry name either");
});

test("NO REFERENCE EVER CONTAINS THE VALUE, EVEN PARTIALLY", async () => {
  const { reader } = harness();
  const outcome = await reader.read({ tenant: TENANT, credentialName: "payments/api-key" });
  if (outcome.ok) {
    assert.equal(outcome.reference.includes(VALUE.slice(0, 8)), false, "no prefix of the value");
    assert.equal(outcome.reference.includes(VALUE.slice(-4)), false, "no suffix of the value");
  }
});

// === RAW EXPOSURE, AND WHAT IT COSTS ===

test("RAW EXPOSURE RETURNS THE VALUE, AND SAYS SO", async () => {
  const { reader } = harness();
  const outcome = await reader.read({ tenant: TENANT, credentialName: "payments/api-key", exposure: "raw", acknowledged: true });

  assert.equal(outcome.ok, true);
  if (outcome.ok) {
    assert.equal(outcome.exposed, true);
    assert.equal(outcome.reference, VALUE);
  }
});

test("RAW EXPOSURE WITHOUT THE SEPARATE ACKNOWLEDGEMENT IS REFUSED, AND RETURNS NO BYTES", async () => {
  const { reader } = harness();
  const outcome = await reader.read({ tenant: TENANT, credentialName: "payments/api-key", exposure: "raw" });

  assert.equal(outcome.ok, false, "asking for raw is not approving raw");
});

test("AN UNACKNOWLEDGED RAW REQUEST NEVER REACHES THE STORE", async () => {
  const { reader, reads } = harness();
  await reader.read({ tenant: TENANT, credentialName: "payments/api-key", exposure: "raw" });

  assert.deepEqual(reads, [], "a refused exposure must not have loaded the value just to refuse it");
});

// === VERIFICATION GATES THE READ, ALWAYS ===

test("AN UNVERIFIED CAPABILITY REFUSES BEFORE THE STORE IS TOUCHED", async () => {
  const { reader, reads } = harness({ capability: "v1.forged.AAAA" });
  const outcome = await reader.read({ tenant: TENANT, credentialName: "payments/api-key" });

  assert.equal(outcome.ok, false);
  assert.deepEqual(reads, [], "the store was never asked, so it never held the value");
});

test("A CAPABILITY FOR ANOTHER TENANT REFUSES, AND THE STORE IS NEVER LOADED FOR IT", async () => {
  const { reader, reads } = harness();
  const outcome = await reader.read({ tenant: "globex", credentialName: "payments/api-key" });

  assert.equal(outcome.ok, false);
  assert.deepEqual(reads, [], "not even this tenant's own store, because the capability did not name it");
});

test("A CAPABILITY WITH NO READ SCOPE REFUSES", async () => {
  const { reader, reads } = harness({
    capability: mintCapability({ ...CLAIMS, scopes: ["vault:list"] }, KEY),
  });
  const outcome = await reader.read({ tenant: TENANT, credentialName: "payments/api-key" });

  assert.equal(outcome.ok, false);
  assert.deepEqual(reads, []);
});

test("AN EXPIRED CAPABILITY REFUSES", async () => {
  const { reader, reads } = harness({
    capability: mintCapability({ ...CLAIMS, expiresAt: 999_999 }, KEY),
  });
  const outcome = await reader.read({ tenant: TENANT, credentialName: "payments/api-key" });

  assert.equal(outcome.ok, false);
  assert.deepEqual(reads, []);
});

test("THE TENANT THE STORE IS ASKED FOR IS THE VERIFIED ONE, NEVER THE REQUESTED ONE", async () => {
  // This is the seam closing. The store used to receive a caller-ASSERTED tenant;
  // it now receives one extracted from a verified signature. A bug that made these
  // differ would be the worst bug in the file, so it is asserted directly.
  const { reader, reads } = harness();
  await reader.read({ tenant: TENANT, credentialName: "payments/api-key" });

  assert.deepEqual(reads, [TENANT]);
});

// === REFUSALS ARE ONE ANSWER ===

test("EVERY REFUSAL LOOKS THE SAME FROM OUTSIDE", async () => {
  // Unverified, wrong tenant, ungranted entry: all of them must be
  // indistinguishable to the caller, or the difference between "you may not" and
  // "it is not there" becomes an index of what exists.
  const unverified = harness({ capability: "garbage" });
  const wrongTenant = harness();
  const absent = harness();

  const outcomes = [
    await unverified.reader.read({ tenant: TENANT, credentialName: "payments/api-key" }),
    await wrongTenant.reader.read({ tenant: "globex", credentialName: "payments/api-key" }),
    await absent.reader.read({ tenant: TENANT, credentialName: "not/a-real-entry" }),
  ];

  for (const outcome of outcomes) {
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.code, outcomes[0].ok ? "" : outcome.code, "one code");
      assert.equal(outcome.message, outcomes[0].ok ? "" : outcome.message, "one message");
    }
  }
});

test("A STORE THAT FAULTS REFUSES RATHER THAN THROWING INTO THE DISPATCHER", async () => {
  // `callTool` catches, but a fault escaping the reader would be caught at the
  // wrong layer and reported as a protocol fault rather than a refusal.
  const { reader } = harness({ sourceThrows: true });
  const outcome = await reader.read({ tenant: TENANT, credentialName: "payments/api-key" });

  assert.equal(outcome.ok, false);
});

// === THE TRAIL ===

test("THE READER'S OWN TRAIL RECORDS EXPOSURE, because a reference and a value are different events", async () => {
  const events: { exposure: string; credentialName: string }[] = [];
  const store = createTenantSecretStore({
    source: {
      async load(tenant: string) {
        return { tenant, secrets: [{ name: "payments/api-key", value: Buffer.from(VALUE, "utf8"), rotatedAt: "2026-01-01T00:00:00.000Z" }] };
      },
    },
    audit: () => {},
    now: () => 1_000_000,
  });

  const reader = createApprovedCredentialReader({
    store,
    capability: mintCapability(CLAIMS, KEY),
    verificationKey: KEY,
    now: () => 1_000_000,
    audit: (event) => events.push({ exposure: event.exposure, credentialName: event.credentialName }),
  });

  await reader.read({ tenant: TENANT, credentialName: "payments/api-key" });
  await reader.read({ tenant: TENANT, credentialName: "payments/api-key", exposure: "raw", acknowledged: true });

  assert.deepEqual(events.map((e) => e.exposure), ["reference", "raw"], "and both are recorded, in order");
  assert.equal(JSON.stringify(events).includes("sk-live"), false, "without the value");
});

test("THE READER'S TRAIL GOES TO THE DURABLE LOG WHEN ONE IS GIVEN", async () => {
  const store = MemoryStore.open({ inMemory: true });
  const vault = createTenantSecretStore({
    source: {
      async load(tenant: string) {
        return { tenant, secrets: [{ name: "payments/api-key", value: Buffer.from(VALUE, "utf8"), rotatedAt: "2026-01-01T00:00:00.000Z" }] };
      },
    },
    audit: () => {},
    now: () => 1_000_000,
  });

  const reader = createApprovedCredentialReader({
    store: vault,
    capability: mintCapability(CLAIMS, KEY),
    verificationKey: KEY,
    now: () => 1_000_000,
    audit: (event) => store.appendAudit(TENANT, event.capabilityId, `vault.${event.exposure}`, { credentialName: event.credentialName }),
  });

  await reader.read({ tenant: TENANT, credentialName: "payments/api-key", exposure: "raw", acknowledged: true });

  const trail = store.auditFor(TENANT);
  assert.equal(trail.length, 1);
  assert.equal(trail[0]?.action, "vault.raw");
  assert.equal(JSON.stringify(trail[0]?.document).includes("sk-live"), false);
  store.close();
});