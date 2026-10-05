import test from "node:test";
import assert from "node:assert/strict";

import {
  createAsyncApprovalGate,
  ELICITATION_REQUIRED,
  VERDICT_CHANNEL,
  VERDICT_EVENT,
  type PendingAuditEvent,
  type VerdictBroadcast,
} from "./async-approval.ts";
import type { ApprovalSubject } from "./elicitation.ts";

/**
 * ASYNCHRONOUS HITL.
 *
 * === WHAT IS ACTUALLY WORTH ASSERTING HERE ===
 *
 * Not "it returns a token". The four properties that matter, in order:
 *
 *   1. **The pending row is written before the caller is told anything.** A request
 *      that no operator ever saw must be distinguishable from one that was refused.
 *      If the row were written at settle time, an approval nobody answered would
 *      leave no trace, and that is exactly the case an operator queries for.
 *   2. **The token is unguessable.** It authorises collection of an approved
 *      credential. If it were a counter, the approval would be a speed bump.
 *   3. **A refusal and a fault are different facts.** A broken ledger must not be
 *      reported to an operator as "the human said no".
 *   4. **The result is single-use.** A token that can be replayed hands the same
 *      approved credential out repeatedly.
 */

const SUBJECT: ApprovalSubject = {
  tool: "vault_read_credential",
  tenant: "acme",
  capability: "cap-1",
  credentialName: "payments/api-key",
  exposure: "reference",
  sideEffects: ["a non-reversible reference is returned"],
};

function harness(options: { broadcast?: (v: VerdictBroadcast) => void } = {}) {
  const rows: PendingAuditEvent[] = [];
  let clock = () => 1_000;
  const gate = createAsyncApprovalGate({
    audit: (event) => rows.push(event),
    now: () => clock(),
    taskTtlMs: 10_000,
    resultTtlMs: 5_000,
    ...(options.broadcast === undefined ? {} : { broadcast: options.broadcast }),
  });
  return {
    rows,
    gate,
    setNow: (value: number) => {
      clock = () => value;
    },
  };
}

test("the code is -32001, which is implementation-defined and not a misuse code", () => {
  // A client has to be able to tell "go obtain an approval" apart from "you are
  // refused", because the two call for different behaviour entirely.
  assert.equal(ELICITATION_REQUIRED, -32001);
});

test("the PENDING row is written BEFORE begin returns", () => {
  const { rows, gate } = harness();
  gate.begin(SUBJECT);

  assert.equal(rows.length, 1, "no row was written when the request was made");
  assert.equal(rows[0]?.outcome, "pending");
  assert.equal(rows[0]?.subject.credentialName, "payments/api-key");
  // The row carries the token and the subject, and no value.
  assert.ok((rows[0]?.taskToken ?? "").startsWith("tk_"));

  gate.dispose();
});

test("a trail that will not take the pending row REFUSES the request", () => {
  // No try/catch inside the gate, deliberately. A request with no record is
  // indistinguishable from a request that was never made.
  const gate = createAsyncApprovalGate({
    audit: () => {
      throw new Error("the ledger is unavailable");
    },
    now: () => 1_000,
  });
  assert.throws(() => gate.begin(SUBJECT), /ledger is unavailable/);
  assert.equal(gate.stats().requested, 0, "a refused request was counted as requested");
  gate.dispose();
});

test("the -32001 payload names what to do next and carries no value", () => {
  const { gate } = harness();
  const data = gate.begin(SUBJECT);

  assert.equal(data.status, "pending");
  assert.equal(data.notify.transport, "sse");
  assert.equal(data.notify.channel, VERDICT_CHANNEL);
  assert.equal(data.notify.event, VERDICT_EVENT);
  assert.equal(data.subject.exposure, "reference");
  assert.ok(Date.parse(data.expiresAt) > 0);

  // No credential, and no bearer that could produce one.
  const serialised = JSON.stringify(data);
  assert.equal(serialised.includes("cap-1"), false, "the capability value leaked into the -32001 payload");

  gate.dispose();
});

test("tokens are unguessable, and two requests never collide", () => {
  const { gate } = harness();
  const tokens = new Set<string>();
  for (let i = 0; i < 200; i += 1) tokens.add(gate.begin(SUBJECT).taskToken);

  assert.equal(tokens.size, 200, "a token repeated");
  // 24 bytes of CSPRNG, hex. Anything sequential here would make the approval a
  // speed bump rather than a control.
  for (const token of tokens) {
    assert.match(token, /^tk_[0-9a-f]{48}$/);
  }
  gate.dispose();
});

test("a token for one request does not resolve another", () => {
  const { gate } = harness();
  const first = gate.begin(SUBJECT);
  const second = gate.begin({ ...SUBJECT, credentialName: "other" });

  gate.settle(second.taskToken, { approved: true, approvedBy: "op", reason: "yes" }, { value: "SECOND" });

  // The first is still pending and untouched.
  assert.equal(gate.subject(first.taskToken)?.credentialName, "payments/api-key");
  assert.equal(gate.collect(first.taskToken), undefined);

  gate.dispose();
});

test("an unknown or already-settled token resolves nothing", () => {
  const { gate } = harness();
  const data = gate.begin(SUBJECT);

  assert.equal(gate.settle("tk_not-a-real-token", { approved: false, reason: "no" }), undefined);
  gate.settle(data.taskToken, { approved: false, approvedBy: "op", reason: "no" });
  // A second verdict for the same token is not applied again.
  assert.equal(gate.settle(data.taskToken, { approved: true, approvedBy: "op", reason: "yes" }, { value: "x" }), undefined);

  gate.dispose();
});

test("a grant is recorded and broadcast with its result; a refusal with none", () => {
  const seen: VerdictBroadcast[] = [];
  const { gate, rows } = harness({ broadcast: (v) => seen.push(v) });

  const granted = gate.begin(SUBJECT);
  gate.settle(granted.taskToken, { approved: true, approvedBy: "operator@example", reason: "reviewed" }, { value: "<redacted_ref:abc>" });

  assert.equal(rows.filter((r) => r.outcome === "pending").length, 1);
  assert.equal(rows.filter((r) => r.outcome === "granted").length, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.status, "approved");
  assert.equal(seen[0]?.result, "<redacted_ref:abc>");
  assert.equal(seen[0]?.approvedBy, "operator@example");

  const refused = gate.begin({ ...SUBJECT, credentialName: "second" });
  gate.settle(refused.taskToken, { approved: false, approvedBy: "operator@example", reason: "not this tenant" });

  assert.equal(rows.filter((r) => r.outcome === "refused").length, 1);
  const last = seen[seen.length - 1];
  assert.equal(last?.status, "refused");
  assert.equal(last?.result, undefined, "a refusal broadcast carried a result");

  gate.dispose();
});

test("the subject comes from the token, and only while pending", () => {
  const { gate } = harness();
  const data = gate.begin(SUBJECT);

  assert.equal(gate.subject(data.taskToken)?.tenant, "acme");
  gate.settle(data.taskToken, { approved: false, reason: "no" });
  assert.equal(gate.subject(data.taskToken), undefined, "a settled task still answers for a subject");

  gate.dispose();
});

test("an approved result is collected exactly once", () => {
  const { gate } = harness();
  const data = gate.begin(SUBJECT);
  gate.settle(data.taskToken, { approved: true, approvedBy: "op", reason: "yes" }, { value: "<redacted_ref:once>" });

  const first = gate.collect(data.taskToken);
  assert.equal(first?.result, "<redacted_ref:once>");
  // The replay, which is the property that matters.
  assert.equal(gate.collect(data.taskToken), undefined, "an approved result was handed out twice");

  gate.dispose();
});

test("a refused task has nothing to collect", () => {
  const { gate } = harness();
  const data = gate.begin(SUBJECT);
  gate.settle(data.taskToken, { approved: false, reason: "no" });
  assert.equal(gate.collect(data.taskToken), undefined);
  gate.dispose();
});

test("an approval nobody answers is EXPIRED and recorded as expired", () => {
  const { rows, gate, setNow } = harness();
  const data = gate.begin(SUBJECT);
  assert.equal(gate.stats().pending, 1);

  setNow(1_000 + 10_001);
  gate.sweep();

  // The row is the point: an approval that vanished leaves no trace that a person
  // was ever asked.
  assert.equal(rows.filter((r) => r.outcome === "expired").length, 1);
  assert.equal(gate.stats().pending, 0);
  assert.equal(gate.collect(data.taskToken), undefined);
  gate.dispose();
});

test("an approved result that nobody collects expires rather than lingering", () => {
  const { gate, setNow } = harness();
  const data = gate.begin(SUBJECT);
  gate.settle(data.taskToken, { approved: true, approvedBy: "op", reason: "yes" }, { value: "<redacted_ref:x>" });

  setNow(1_000 + 5_001);
  gate.sweep();

  assert.equal(gate.collect(data.taskToken), undefined, "a stale approved result was still collectable");
  gate.dispose();
});

test("stats separate a pending task from an approved one awaiting collection", () => {
  const { gate } = harness();
  const a = gate.begin(SUBJECT);
  gate.begin({ ...SUBJECT, credentialName: "other" });
  gate.settle(a.taskToken, { approved: true, approvedBy: "op", reason: "yes" }, { value: "<redacted_ref:a>" });

  const stats = gate.stats();
  assert.equal(stats.requested, 2);
  assert.equal(stats.approved, 1);
  assert.equal(stats.pending, 1);
  assert.equal(stats.uncollected, 1, "an approved result nobody collected was not visible");

  gate.dispose();
});

test("dispose drops everything, including an approved result still held", () => {
  const { gate } = harness();
  const data = gate.begin(SUBJECT);
  gate.settle(data.taskToken, { approved: true, approvedBy: "op", reason: "yes" }, { value: "<redacted_ref:leak>" });

  gate.dispose();
  assert.equal(gate.collect(data.taskToken), undefined, "an approved result outlived the object that held it");
});

test("no row and no broadcast ever carries a credential value", () => {
  const secret = "sk_live_NOT_IN_ANY_ROW";
  const seen: VerdictBroadcast[] = [];
  const { rows, gate } = harness({ broadcast: (v) => seen.push(v) });

  const data = gate.begin(SUBJECT);
  // The result IS the value on a grant -- it has to be, the caller needs it -- so
  // the assertion is about the pending row and about a refusal, which is the only
  // path that has to carry nothing.
  gate.settle(data.taskToken, { approved: false, reason: `refused, ${secret} not granted` });

  const pendingRow = rows.find((r) => r.outcome === "pending");
  assert.equal(JSON.stringify(pendingRow).includes(secret), false);
  const refusal = seen[0];
  assert.equal(JSON.stringify(refusal).includes(secret), false, "a refusal broadcast carried the string it mentioned");

  gate.dispose();
});