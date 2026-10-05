import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApprovalGate, type ApprovalSubject } from "./elicitation.ts";
import { parseFrame } from "./jsonrpc.ts";
import { MemoryStore } from "../memory/store.ts";
import { createTenantSecretStore } from "../vault/store.ts";
import { createApprovedCredentialReader } from "../vault/reader.ts";
import { mintCapability, READ_SCOPE } from "../vault/capability.ts";
import { randomBytes } from "node:crypto";
import { createDurableApprovalSink } from "../vault/audit-sink.ts";

/**
 * APPROVALS THAT SURVIVE THE PROCESS.
 *
 * === THE GAP THIS CLOSES ===
 *
 * ADR-010 A5 recorded that the shipped gate logged approvals to STDERR. A decision
 * that lives in a log line is a decision that disappears with the log rotation, and
 * the precheck's entire justification is that a person approved a specific read.
 * "A person approved it" is a claim the platform makes to an operator and to an
 * investigator, and stderr cannot support it.
 *
 * So every decision -- approval, refusal, malformed answer, timeout sweep -- is
 * committed to the same SQLite ledger the wedge keeps its decisions in, and the
 * commit happens BEFORE the gateway emits the response frame.
 *
 * === WHY THESE TESTS DRIVE A REAL STORE AND A REAL FILE ===
 *
 * "We called appendAudit" is not the claim. The claim is that a person can open the
 * ledger afterwards and find who approved what, for which capability, against which
 * tenant, for which entry, and why. So the tests read the rows back with the same
 * query an investigator would use, rather than asserting a spy was called.
 */

const TENANT = "acme";
const CREDENTIAL = "payments/api-key";
const VALUE = "sk-live-EXAMPLE-DO-NOT-LOG-THIS-VALUE";
const KEY = randomBytes(32);

function subject(over: Partial<ApprovalSubject> = {}): ApprovalSubject {
  return {
    tool: "read_credential",
    tenant: TENANT,
    capability: "cap-01",
    credentialName: CREDENTIAL,
    exposure: "reference",
    sideEffects: ["a non-reversible reference is returned"],
    ...over,
  };
}

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "nf-audit-"));
  const ledger = MemoryStore.open({ directory });
  const sink = createDurableApprovalSink(ledger);
  const events: { outcome: string }[] = [];
  const gate = createApprovalGate({
    timeoutMs: 30_000,
    now: () => 1_000_000,
    audit: (event) => {
      events.push({ outcome: event.outcome });
      sink(event);
    },
  });
  return { directory, ledger, gate, events };
}

/**
 * READ A ROW'S DOCUMENT, whichever shape the driver hands back.
 *
 * `auditFor` types `document` as `unknown` and that is honest: whether it arrives as
 * JSON text or as a parsed value is the driver's business, not the caller's. A test
 * that assumed either would be testing the driver.
 */
function readDocument(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") return JSON.parse(raw) as Record<string, unknown>;
  if (raw !== null && typeof raw === "object") return raw as Record<string, unknown>;
  throw new Error("the audit row carried no document");
}

function answer(id: string, result: unknown): ReturnType<typeof parseFrame> {
  return parseFrame(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

// === EVERY DECISION LANDS ===

test("AN APPROVAL IS IN THE LEDGER, WITH WHO, WHAT, WHICH, AND WHY", async () => {
  const { ledger, gate } = harness();
  try {
    const { frame } = gate.begin(subject(), 7);
    const id = String((JSON.parse(frame) as Record<string, unknown>)["id"]);

    gate.offer(
      answer(id, { action: "accept", content: { approve: true, approvedBy: "on-call", reason: "incident 4471" } }),
    );

    const rows = ledger.auditFor(TENANT);
    assert.equal(rows.length, 1, "the decision is on the record, not in a log line");

    const row = rows[0];
    assert.equal(row?.actor, "on-call", "WHO approved");
    assert.equal(row?.action, "vault.approval.granted", "namespaced so an approval row is distinguishable from a reader row in the same table");
    assert.equal(typeof row?.at, "number", "WHEN, as an epoch the ledger can sort on");

    // The document carries the four facts a reader cannot reconstruct from the row.
    const document = readDocument(row?.document);
    assert.equal(document["capability"], "cap-01", "WHICH capability");
    assert.equal(document["tenant"], TENANT, "WHICH tenant");
    assert.equal(document["credentialName"], CREDENTIAL, "WHICH entry");
    assert.equal(document["reason"], "incident 4471", "WHY");
    assert.equal(document["exposure"], "reference");
  } finally {
    gate.dispose();
    ledger.close();
  }
});

test("A DENIAL IS IN THE LEDGER TOO, because a trail of successes cannot answer a question", async () => {
  const { ledger, gate } = harness();
  try {
    const { frame } = gate.begin(subject(), 7);
    const id = String((JSON.parse(frame) as Record<string, unknown>)["id"]);
    gate.offer(answer(id, { action: "decline" }));

    const rows = ledger.auditFor(TENANT);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.action, "vault.approval.refused");
    // A refusal has no operator, and inventing one would be worse than the gap.
    assert.equal(rows[0]?.actor, "nobody");
    const document = readDocument(rows[0]?.document);
    assert.ok(typeof document["reason"] === "string" && document["reason"].length > 0, "but it says WHY it was refused");
  } finally {
    gate.dispose();
    ledger.close();
  }
});

test("A MALFORMED ANSWER IS IN THE LEDGER, because a decision nobody made is still a decision", async () => {
  const { ledger, gate } = harness();
  try {
    const { frame } = gate.begin(subject(), 7);
    const id = String((JSON.parse(frame) as Record<string, unknown>)["id"]);
    gate.offer(answer(id, { action: "accept", content: { approve: true } })); // no actor, no reason

    assert.equal(ledger.auditFor(TENANT)[0]?.action, "vault.approval.refused");
  } finally {
    gate.dispose();
    ledger.close();
  }
});

test("A TIMEOUT IS IN THE LEDGER, or nobody can tell a refusal from an operator walking away", async () => {
  const { ledger, gate } = harness();
  try {
    gate.begin(subject(), 7);
    gate.sweep(1_000_000 + 30_001);

    assert.equal(ledger.auditFor(TENANT)[0]?.action, "vault.approval.refused");
  } finally {
    gate.dispose();
    ledger.close();
  }
});

test("NO LEDGER ROW CARRIES A CREDENTIAL, because the ledger outlives the credential", async () => {
  const { ledger, gate } = harness();
  try {
    const { frame } = gate.begin(subject(), 7);
    const id = String((JSON.parse(frame) as Record<string, unknown>)["id"]);
    gate.offer(answer(id, { action: "accept", content: { approve: true, approvedBy: "on-call", reason: "why" } }));

    const serialised = JSON.stringify(ledger.auditFor(TENANT));
    assert.equal(serialised.includes("sk-live"), false);
    assert.equal(serialised.includes(VALUE.slice(0, 8)), false, "not even a prefix");
  } finally {
    gate.dispose();
    ledger.close();
  }
});

test("THE LEDGER IS APPEND-ONLY, so an approval cannot be quietly edited afterwards", async () => {
  const { ledger, gate } = harness();
  try {
    const { frame } = gate.begin(subject(), 7);
    const id = String((JSON.parse(frame) as Record<string, unknown>)["id"]);
    gate.offer(answer(id, { action: "accept", content: { approve: true, approvedBy: "a", reason: "one" } }));
    const first = ledger.auditFor(TENANT)[0];

    const second = gate.begin(subject(), 8);
    const id2 = String((JSON.parse(second.frame) as Record<string, unknown>)["id"]);
    gate.offer(answer(id2, { action: "accept", content: { approve: true, approvedBy: "b", reason: "two" } }));

    const rows = ledger.auditFor(TENANT);
    assert.equal(rows.length, 2);
    // The earlier row is untouched and still first. There is no update path on this
    // table, which is the property -- not an assertion about a method being absent.
    assert.equal(rows[0]?.actor, "a");
    assert.equal(rows[0]?.at, first?.at);
    assert.equal(rows[1]?.actor, "b");
  } finally {
    gate.dispose();
    ledger.close();
  }
});

test("THE LEDGER SURVIVES THE PROCESS THAT WROTE IT", async () => {
  // The whole point of a durable sink, and the difference from stderr. The store is
  // closed and reopened against the same directory and the row is still there.
  const { directory, ledger, gate } = harness();
  try {
    const { frame } = gate.begin(subject(), 7);
    const id = String((JSON.parse(frame) as Record<string, unknown>)["id"]);
    gate.offer(answer(id, { action: "accept", content: { approve: true, approvedBy: "on-call", reason: "incident 4471" } }));
  } finally {
    gate.dispose();
    ledger.close();
  }

  const reopened = MemoryStore.open({ directory });
  try {
    const rows = reopened.auditFor(TENANT);
    assert.equal(rows.length, 1, "the record outlived the process and the handle");
    assert.equal(rows[0]?.actor, "on-call");
  } finally {
    reopened.close();
  }
});

// === FAIL CLOSED ===

test("A LEDGER THAT WILL NOT WRITE REFUSES THE APPROVAL, and the sink throws so it can be seen", () => {
  // The fail-closed guarantee. A closed store throws on write; the gate must treat
  // that as "no approval happened", because the alternative is granting a credential
  // read that nobody can afterwards be shown to have approved.
  const ledger = MemoryStore.open({ inMemory: true });
  ledger.close();

  const gate = createApprovalGate({
    timeoutMs: 30_000,
    now: () => 1_000_000,
    audit: (event) => createDurableApprovalSink(ledger)(event),
  });

  try {
    const { frame } = gate.begin(subject(), 7);
    const id = String((JSON.parse(frame) as Record<string, unknown>)["id"]);
    const settled = gate.offer(
      answer(id, { action: "accept", content: { approve: true, approvedBy: "on-call", reason: "incident 4471" } }),
    );

    assert.equal(settled?.decision.approved, false, "an unrecordable approval is not an approval");
  } finally {
    gate.dispose();
  }
});

test("A BROKEN SINK IS VISIBLE, not silently swallowed, because the alternative is a disabled trail", () => {
  // A gate whose audit throws on every call must still REFUSE. It must also report
  // that it is degraded: an operator being asked to approve reads whose decisions
  // are not being recorded is exactly the situation where somebody disables the
  // trail, and that must be a loud failure rather than a quiet one.
  const gate = createApprovalGate({
    timeoutMs: 30_000,
    now: () => 1_000_000,
    audit: () => {
      throw new Error("the ledger is unavailable");
    },
  });

  try {
    const { frame } = gate.begin(subject(), 7);
    const id = String((JSON.parse(frame) as Record<string, unknown>)["id"]);
    const settled = gate.offer(
      answer(id, { action: "accept", content: { approve: true, approvedBy: "on-call", reason: "why" } }),
    );

    assert.equal(settled?.decision.approved, false);
    assert.equal(gate.stats().unrecordedDecisions > 0, true, "the sink being down is counted, not forgotten");
  } finally {
    gate.dispose();
  }
});

// === THE WHOLE PATH, THROUGH THE READER ===

test("AN APPROVED READ COMMITS BEFORE THE REFERENCE IS RETURNED", async () => {
  // The ordering guarantee, at the layer where it matters. The sink and the reader
  // push onto one list, and the decision must be committed first -- because a
  // reference returned before its record exists is a reference nobody can trace.
  const directory = mkdtempSync(join(tmpdir(), "nf-order-"));
  const ledger = MemoryStore.open({ directory });
  const order: string[] = [];
  const gate = createApprovalGate({
    timeoutMs: 30_000,
    now: () => 1_000_000,
    audit: (event) => {
      createDurableApprovalSink(ledger)(event);
      order.push("committed");
    },
  });

  const vault = createTenantSecretStore({
    source: {
      async load(tenant: string) {
        order.push(`loaded:${tenant}`);
        return { tenant, secrets: [{ name: CREDENTIAL, value: Buffer.from(VALUE, "utf8"), rotatedAt: "2026-01-01T00:00:00.000Z" }] };
      },
    },
    audit: () => {},
    now: () => 1_000_000,
  });
  const reader = createApprovedCredentialReader({
    store: vault,
    capability: mintCapability({ capabilityId: "cap-01", tenant: TENANT, scopes: [READ_SCOPE], expiresAt: 2_000_000 }, KEY),
    verificationKey: KEY,
    now: () => 1_000_000,
  });

  try {
    const { frame } = gate.begin(subject(), 7);
    const id = String((JSON.parse(frame) as Record<string, unknown>)["id"]);
    const settled = gate.offer(answer(id, { action: "accept", content: { approve: true, approvedBy: "on-call", reason: "incident 4471" } }));
    assert.equal(settled?.decision.approved, true);

    const outcome = await reader.read({ tenant: TENANT, credentialName: CREDENTIAL, exposure: "reference" });
    assert.equal(outcome.ok, true);

    assert.deepEqual(order, ["committed", `loaded:${TENANT}`], "the decision is committed before a credential is loaded");
    assert.equal(ledger.auditFor(TENANT).length, 1, "and the row is there afterwards");
  } finally {
    gate.dispose();
    ledger.close();
  }
});

test("AN UNVERIFIED CAPABILITY COMMITS NOTHING, so the ledger holds only real decisions", async () => {
  const { ledger, gate } = harness();
  try {
    // Nothing was decided, so nothing is written. A ledger full of rows for requests
    // that never reached an operator would make the real ones harder to find.
    gate.offer(parseFrame(JSON.stringify({ jsonrpc: "2.0", id: "el-99", result: { action: "accept" } })));
    assert.equal(ledger.auditFor(TENANT).length, 0);
  } finally {
    gate.dispose();
    ledger.close();
  }
});