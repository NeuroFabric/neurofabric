import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { createApprovalGate, type ApprovalSubject } from "./elicitation.ts";
import { dispatch, type DispatcherDeps, type EmbassyConfig } from "./server.ts";
import { RPC, parseFrame } from "./jsonrpc.ts";
import { MemoryStore } from "../memory/store.ts";
import { createTenantSecretStore } from "../vault/store.ts";
import { createApprovedCredentialReader } from "../vault/reader.ts";
import { createDurableApprovalSink, createDurableExposureSink, createDurableReadSink } from "../vault/audit-sink.ts";
import { mintCapability, READ_SCOPE } from "../vault/capability.ts";

/**
 * CREDENTIAL READS THAT SURVIVE THE PROCESS.
 *
 * === THE GAP THIS CLOSES ===
 *
 * ADR-010's A5 amendment closed the *approval* trail: a decision is committed to
 * SQLite before the gateway emits a frame. The store's own trail was left on
 * stderr, and the reasoning for leaving it -- "the store holds credentials and can
 * be opened without a ledger" -- is sound for the CREDENTIALS and wrong for the
 * TRAIL.
 *
 * A stderr line is rotated and eventually deleted. So the shipped embassy was
 * emitting `vault granted acme payments/api-key` to a stream that an investigator
 * cannot search, for the one event that says a credential left the process. The
 * approval said who allowed it; nothing said that it then happened.
 *
 * === WHY THESE ARE SEPARATE TESTS AND NOT MORE CASES IN `durable-audit.test.ts` ===
 *
 * Because the guarantee is different in kind. That file proves a DECISION is
 * committed before a response is emitted. This one proves a READ is, and -- the
 * half that is easy to state and hard to mean -- that a ledger which will not take
 * the read row produces a *protocol* fault rather than a *refusal*, because those
 * two answers mean opposite things to whoever is on call.
 */

const TENANT = "acme";
const CREDENTIAL = "payments/api-key";
const VALUE = "sk-live-EXAMPLE-DO-NOT-LOG-THIS-VALUE";
const KEY = randomBytes(32);
const CAPABILITY_ID = "cap-01";
const ROTATED_AT = "2026-01-01T00:00:00.000Z";
/** The marker every reference carries. Imported nowhere; checked only for absence. */
const REDACTED_MARKER = "<redacted_credential_ref:";

const CONFIG: EmbassyConfig = {
  credential: "tok_value",
  endpoint: { origin: "http://core.test", timeoutMs: 1000 },
  tenant: TENANT,
  capability: CAPABILITY_ID,
};

function subject(): ApprovalSubject {
  return {
    tool: "read_credential",
    tenant: TENANT,
    capability: CAPABILITY_ID,
    credentialName: CREDENTIAL,
    exposure: "reference",
    sideEffects: ["a non-reversible reference is returned"],
  };
}

/**
 * A LEDGER THAT WILL NOT TAKE THE READ ROWS, AND TAKES EVERYTHING ELSE.
 *
 * A real `MemoryStore` behind it, so the approval still commits for real and the
 * test is not asserting against a stub of the durable path -- only against a
 * refusal of ONE class of append, which is the fault being modelled.
 *
 * Every method is re-bound to the real store: `MemoryStore` holds `#db` and
 * `#assertOpen` as private fields, so a method invoked with the proxy as `this`
 * would fault on field access instead of on the fault under test.
 */
function refusingReadLedger(inner: MemoryStore): MemoryStore {
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === "appendAudit") {
        return (tenant: string, actor: string, action: string, document: unknown, at?: number): void => {
          if (action.startsWith("vault.read.")) throw new Error("the ledger did not take the read row");
          target.appendAudit(tenant, actor, action, document, at);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value;
    },
  });
}

/** A store whose trail goes where the test says, over a real one-entry vault. */
function vault(audit: Parameters<typeof createTenantSecretStore>[0]["audit"]): ReturnType<typeof createTenantSecretStore> {
  return createTenantSecretStore({
    source: {
      async load(tenant: string) {
        return { tenant, secrets: [{ name: CREDENTIAL, value: Buffer.from(VALUE, "utf8"), rotatedAt: ROTATED_AT }] };
      },
    },
    audit,
    now: () => 1_000_000,
  });
}

function reader(
  store: ReturnType<typeof vault>,
  audit?: (event: Parameters<NonNullable<Parameters<typeof createApprovedCredentialReader>[0]["audit"]>>[0]) => void,
): ReturnType<typeof createApprovedCredentialReader> {
  return createApprovedCredentialReader({
    store,
    capability: mintCapability({ capabilityId: CAPABILITY_ID, tenant: TENANT, scopes: [READ_SCOPE], expiresAt: 2_000_000 }, KEY),
    verificationKey: KEY,
    now: () => 1_000_000,
    ...(audit === undefined ? {} : { audit }),
  });
}

function readDocument(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") return JSON.parse(raw) as Record<string, unknown>;
  if (raw !== null && typeof raw === "object") return raw as Record<string, unknown>;
  throw new Error("the audit row carried no document");
}



// === THE ROW IS THERE ===

test("A CREDENTIAL READ IS IN THE LEDGER, namespaced apart from an approval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nf-read-"));
  const ledger = MemoryStore.open({ directory });
  try {
    const outcome = await reader(vault(createDurableReadSink(ledger, { directory }))).read({
      tenant: TENANT,
      credentialName: CREDENTIAL,
      exposure: "reference",
    });
    assert.equal(outcome.ok, true, "the read succeeded, so the preconditions held");

    const rows = ledger.auditFor(TENANT);
    assert.equal(rows.length, 1, "the read is on the record, not in a log line");
    assert.equal(
      rows[0]?.action,
      "vault.read.success",
      "and it is namespaced so a read is never mistaken for an approval in the same table",
    );
    assert.notEqual(rows[0]?.action.startsWith("vault.approval."), true);
  } finally {
    ledger.close();
  }
});

test("THE READ ROW CORRELATES TO THE APPROVAL BY THE CAPABILITY, so one question joins two tables", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nf-read-"));
  const ledger = MemoryStore.open({ directory });
  try {
    const gate = createApprovalGate({
      timeoutMs: 30_000,
      now: () => 1_000_000,
      audit: (event) => createDurableApprovalSink(ledger, { directory })(event),
    });

    const frame = gate.begin(subject(), 7);
    const elicitationId = String((JSON.parse(frame.frame) as Record<string, unknown>)["id"]);
    const settled = gate.offer(parseAnswer(elicitationId));
    assert.equal(settled?.decision.approved, true);

    await reader(vault(createDurableReadSink(ledger, { directory }))).read({
      tenant: TENANT,
      credentialName: CREDENTIAL,
      exposure: "reference",
    });

    const rows = ledger.auditFor(TENANT);
    const approval = rows.find((row) => row.action === "vault.approval.granted");
    const read = rows.find((row) => row.action === "vault.read.success");
    assert.ok(approval !== undefined && read !== undefined, "both halves are on the record");

    /**
     * THE SAME FIELD NAME ON BOTH ROWS.
     *
     * Not the same field name "by convention" -- the join is asserted here, so a
     * rename on one side and not the other fails a test rather than silently
     * splitting every audit question in half.
     */
    assert.equal(readDocument(read?.document)["capability"], readDocument(approval?.document)["capability"]);
    assert.equal(readDocument(read?.document)["capability"], CAPABILITY_ID);
    assert.equal(readDocument(read?.document)["tenant"], TENANT);
    assert.equal(readDocument(read?.document)["credentialName"], CREDENTIAL);

    /**
     * AND THE ROW NAMES THE CAPABILITY AS ITS ACTOR.
     *
     * The approval rows name a person because a person decided. The store does not
     * verify capabilities -- the reader does, upstream -- so the only authority the
     * store can honestly attribute a read to is the capability it was handed.
     */
    assert.equal(read?.actor, CAPABILITY_ID, "the asserted authority, not an invented operator");

    gate.dispose();
  } finally {
    ledger.close();
  }
});

/** An approval answer, framed the way the client would frame it. */
function parseAnswer(id: string): ReturnType<typeof parseFrame> {
  return parseFrame(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { action: "accept", content: { approve: true, approvedBy: "on-call", reason: "incident 4471" } },
    }),
  );
}

test("A REFUSED READ IS A ROW TOO, because a trail of successes cannot answer a question", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nf-read-"));
  const ledger = MemoryStore.open({ directory });
  try {
    const store = vault(createDurableReadSink(ledger, { directory }));
    const outcome = await store.retrieve(
      { id: CAPABILITY_ID, tenant: TENANT, secrets: ["somewhere/else"], expiresAt: 2_000_000 },
      "somewhere/else",
    );

    assert.equal(outcome.ok, false);
    const rows = ledger.auditFor(TENANT);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.action, "vault.read.failure", "a denial is recorded as a denial, not as a success with a note");
    assert.equal(readDocument(rows[0]?.document)["credentialName"], "somewhere/else");
  } finally {
    ledger.close();
  }
});

test("NO READ ROW CARRIES A CREDENTIAL, because the ledger outlives the credential", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nf-read-"));
  const ledger = MemoryStore.open({ directory });
  try {
    await reader(vault(createDurableReadSink(ledger, { directory }))).read({
      tenant: TENANT,
      credentialName: CREDENTIAL,
      exposure: "reference",
    });
    const serialised = JSON.stringify(ledger.auditFor(TENANT));
    assert.equal(serialised.includes("sk-live"), false);
    assert.equal(serialised.includes(VALUE.slice(0, 8)), false, "not even a prefix");
  } finally {
    ledger.close();
  }
});

// === FAIL CLOSED, AND AS A PROTOCOL FAULT ===

test("A LEDGER THAT WILL NOT TAKE THE READ ROW ANSWERS INTERNAL_ERROR, and returns no reference", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nf-read-"));
  const ledger = refusingReadLedger(MemoryStore.open({ directory }));
  const gate = createApprovalGate({
    timeoutMs: 30_000,
    now: () => 1_000_000,
    audit: (event) => createDurableApprovalSink(ledger, { directory })(event),
  });
  const session = { credential: "tok_value", tenant: TENANT, capability: CAPABILITY_ID, established: false, elicitation: false };
  const deps: DispatcherDeps = {
    config: CONFIG,
    write: () => {},
    gate,
    credentialReader: () => reader(vault(createDurableReadSink(ledger, { directory }))),
  };

  try {
    // The APPROVAL still commits -- the ledger only refuses the read class -- so the
    // fault under test is the one that must produce an INTERNAL_ERROR rather than a
    // refusal, and not "the gate failed to decide".
    await dispatch('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{"elicitation":{}}}}', session, deps);
    const asked = await dispatch(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "read_credential", arguments: { credentialName: CREDENTIAL } },
      }),
      session,
      deps,
    );
    const elicitationId = (JSON.parse(asked[0] as string) as { id: number }).id;
    const answered = await dispatch(
      JSON.stringify({
        jsonrpc: "2.0",
        id: elicitationId,
        result: { action: "accept", content: { approve: true, approvedBy: "on-call", reason: "incident 4471" } },
      }),
      session,
      deps,
    );

    const frame = JSON.parse(answered[0] as string) as { id: number; error?: { code: number; message: string }; result?: unknown };

    assert.equal(frame.id, 2, "the answer is on the CALLER's id, which is the id anybody on call is waiting on");
    assert.equal(frame.error?.code, RPC.INTERNAL_ERROR, "a broken trail is a fault in OUR code, not a refusal of the caller");
    assert.equal(frame.result, undefined, "and nothing at all came back");
    assert.equal(JSON.stringify(answered).includes("sk-live"), false, "no credential reference, and no value either");
    assert.equal(JSON.stringify(answered).includes(REDACTED_MARKER), false, "not even a reference: the read produced nothing to name");

    const actions = ledger.auditFor(TENANT).map((row) => row.action);
    assert.deepEqual(actions, ["vault.approval.granted"], "the approval is on the record; the read is absent because it was refused");
  } finally {
    gate.dispose();
    ledger.close();
  }
});

test("A BROKEN READ TRAIL IS NOT AN EXISTENCE ORACLE: a granted and an ungranted name fail identically", async () => {
  // The store's whole design is "no is the same answer", and an INTERNAL_ERROR is a
  // new answer. If a broken trail errored only on the path that WOULD have granted,
  // then a caller could learn which names are real by watching for -32603 instead
  // of the refusal -- the store would have become a directory again, through the
  // fault path rather than the intended one.
  const directory = mkdtempSync(join(tmpdir(), "nf-read-"));
  const ledger = refusingReadLedger(MemoryStore.open({ directory }));
  try {
    const granted = vault(createDurableReadSink(ledger, { directory })).retrieve(
      { id: CAPABILITY_ID, tenant: TENANT, secrets: [CREDENTIAL], expiresAt: 2_000_000 },
      CREDENTIAL,
    );
    const ungranted = vault(createDurableReadSink(ledger, { directory })).retrieve(
      { id: CAPABILITY_ID, tenant: TENANT, secrets: [CREDENTIAL], expiresAt: 2_000_000 },
      "globex/only-here",
    );

    const outcomes = await Promise.allSettled([granted, ungranted]);
    const names = outcomes.map((outcome) =>
      outcome.status === "rejected" ? (outcome.reason as Error).name : "resolved:" + JSON.stringify(outcome.value),
    );

    assert.equal(outcomes[0]?.status, "rejected", "a granted read with no durable receipt is not a read");
    assert.equal(outcomes[1]?.status, "rejected", "and neither is an ungranted one -- identically, because the trail is consulted on both paths");
    assert.equal(names[0], names[1], "no observable difference between the two, so there is nothing to learn from the fault");
  } finally {
    ledger.close();
  }
});

test("THE SAME FAULT THROUGH THE APPROVAL PATH IS ALSO CONTAINED, and does not take the process down", async () => {
  // `dispatch` answers a REQUEST inside a try. It did not answer a RESPONSE inside
  // one, and a response is precisely the frame that carries an approved read -- so a
  // ledger fault on the approval path escaped the gateway, out of `dispatch`, and
  // into the readline loop as an unhandled rejection. A host agent would have seen
  // the connection die rather than an error frame.
  const directory = mkdtempSync(join(tmpdir(), "nf-read-"));
  const ledger = refusingReadLedger(MemoryStore.open({ directory }));
  const gate = createApprovalGate({
    timeoutMs: 30_000,
    now: () => 1_000_000,
    audit: (event) => createDurableApprovalSink(ledger, { directory })(event),
  });
  const session = { credential: "tok_value", tenant: TENANT, capability: CAPABILITY_ID, established: false, elicitation: false };
  const deps: DispatcherDeps = {
    config: CONFIG,
    write: () => {},
    gate,
    credentialReader: () => reader(vault(createDurableReadSink(ledger, { directory }))),
  };

  try {
    const frames: string[] = [];
    await dispatch('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{"elicitation":{}}}}', session, deps);
    const asked = await dispatch(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_credential", arguments: { credentialName: CREDENTIAL } } }),
      session,
      deps,
    );
    frames.push(...asked);

    const elicitationId = (JSON.parse(asked[0] as string) as { id: number }).id;
    const answered = await dispatch(
      JSON.stringify({ jsonrpc: "2.0", id: elicitationId, result: { action: "accept", content: { approve: true, approvedBy: "on-call", reason: "why" } } }),
      session,
      deps,
    );

    assert.equal(answered.length, 1, "one frame back: the caller's error, and no silent hang");
    const frame = JSON.parse(answered[0] as string) as { id: number; error?: { code: number } };
    assert.equal(frame.id, 2);
    assert.equal(frame.error?.code, RPC.INTERNAL_ERROR);
  } finally {
    gate.dispose();
    ledger.close();
  }
});

test("THE EXPOSURE IS ITS OWN ROW, because 'a read happened' cannot answer 'was a live value put in a model's context'", async () => {
  // The store knows that a read was granted or refused. It does NOT know whether the
  // caller received a reference or the value itself -- that is the reader's
  // knowledge, and it is the distinction ADR-009 §4 exists to police. So the two are
  // two rows, not one row with a field the store had to be told about.
  const directory = mkdtempSync(join(tmpdir(), "nf-read-"));
  const ledger = MemoryStore.open({ directory });
  try {
    const outcome = await reader(
      vault(createDurableReadSink(ledger, { directory })),
      createDurableExposureSink(ledger, { directory }),
    ).read({ tenant: TENANT, credentialName: CREDENTIAL, exposure: "raw", acknowledged: true });

    assert.equal(outcome.ok, true);
    const rows = ledger.auditFor(TENANT);
    const read = rows.find((row) => row.action === "vault.read.success");
    const exposure = rows.find((row) => row.action.startsWith("vault.exposure."));
    assert.ok(read !== undefined && exposure !== undefined, "both facts are on the record");

    const document = readDocument(exposure?.document);
    assert.equal(document["exposure"], "raw", "a raw read is distinguishable from a reference read after the fact");
    assert.equal(document["capability"], CAPABILITY_ID, "and it correlates to the approval on the same field");
    assert.equal(readDocument(read?.document)["exposure"], undefined, "the store's row does not claim to know the exposure");
    assert.equal(JSON.stringify(rows).includes(VALUE), false, "and no row carries the value");
  } finally {
    ledger.close();
  }
});

test("THE TRAIL IS WRITTEN FOR A REFERENCE READ TOO, because the default path is the common one", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nf-read-"));
  const ledger = MemoryStore.open({ directory });
  try {
    const outcome = await reader(
      vault(createDurableReadSink(ledger, { directory })),
      createDurableExposureSink(ledger, { directory }),
    ).read({ tenant: TENANT, credentialName: CREDENTIAL, exposure: "reference" });

    assert.equal(outcome.ok, true);
    const actions = ledger.auditFor(TENANT).map((row) => row.action);
    assert.deepEqual(actions, ["vault.read.success", "vault.exposure.reference"], "read first, then what it exposed");
  } finally {
    ledger.close();
  }
});