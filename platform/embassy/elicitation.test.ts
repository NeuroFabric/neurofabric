import test from "node:test";
import assert from "node:assert/strict";

import { createApprovalGate, type ApprovalSubject, type ResolvedApproval } from "./elicitation.ts";
import { parseFrame } from "./jsonrpc.ts";
import { MemoryStore } from "../memory/store.ts";

/**
 * THE PRECHECK: A HUMAN IN THE LOOP BEFORE A CREDENTIAL IS READ.
 *
 * === WHAT THIS IS ANSWERING, AND WHY IT HAD TO BE BUILT RATHER THAN BORROWED ===
 *
 * ADR-008 §4 recorded that the kernel vault discloses a value because a person
 * approved that specific call at the precheck, recorded in the trace before the
 * handler ran. The embassy has no precheck. This is that precheck, on the
 * surface where it had to be written from scratch.
 *
 * === WHY NOTHING HERE WAITS, AND WHY THAT IS THE WHOLE OF ASYNC STATE ===
 *
 * A pending approval could be held two ways: a promise the tool call awaits, or a
 * registry the dispatcher reads. The promise makes `dispatch` impure and
 * untestable without a pipe, which is the one property the whole protocol layer
 * was built to keep. The registry holds exactly the same state, across exactly
 * the same interval, and keeps `dispatch` a pure function of a line.
 *
 * So there is no `await` on a human anywhere in this module. A call that needs
 * approval writes an elicitation request and returns. The answer arrives later,
 * as an ordinary inbound line, and the tool result is produced then. The event
 * loop is never occupied and there is nothing to unblock, because the pending
 * call is not a suspended thread -- it is a row in a map.
 *
 * === THE CAPABILITY, NOT THE BEARER ===
 *
 * The prompt names the capability's ID. The specification forbids form mode for
 * requesting API keys and tokens, and form-mode data is exposed to the client by
 * design -- so a bearer value here would be handed to the host process, rendered
 * into whatever UI the host has, and plausibly written to its logs. The ID is
 * what identifies the grant to a person deciding, which is the entire purpose of
 * showing them anything. A test below pins that no bearer value appears.
 *
 * === THE FAIL-CLOSED RULE, WHICH IS THE ONLY RULE THAT MATTERS HERE ===
 *
 * Anything unexpected refuses: a malformed answer, a missing approval, a client
 * that never replies, a sweep that finds an expired entry, a reporter that
 * throws. A gate that fails open on an unparseable answer is not a gate, it is a
 * delay. Every test below looking for a refusal is really a test that the safe
 * answer is also the easy one.
 */

const SUBJECT: ApprovalSubject = {
  tool: "read_credential",
  tenant: "acme",
  capability: "cap-01",
  credentialName: "payments/api-key",
  sideEffects: ["the value is returned to the calling agent", "the read is recorded"],
};

/** A fake clock, because a test that waits on real time cannot prove anything about timeouts. */
function clock(start = 1_000_000) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

function gate(now: () => number, timeoutMs = 30_000) {
  const audits: { outcome: string; approvedBy?: string }[] = [];
  const g = createApprovalGate({
    timeoutMs,
    now,
    audit: (event) => audits.push({ outcome: event.outcome, approvedBy: event.approvedBy }),
  });
  return { g, audits };
}

/** An inbound elicitation answer frame, as a JSON line. */
function answerLine(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

// THE PAYLOAD.

test("THE PROMPT NAMES THE ACTION, so the operator is approving something legible", () => {
  const time = clock();
  const { g } = gate(time.now);
  const frame = JSON.parse(g.begin(SUBJECT, 7).frame) as Record<string, unknown>;
  const params = frame["params"] as Record<string, unknown>;

  assert.equal(frame["method"], "elicitation/create", "this is the method the specification names");
  assert.equal(params["mode"], "form", "form mode, because we are collecting a decision rather than a value");

  const message = String(params["message"]);
  assert.match(message, /read_credential/, "the tool is named");
  assert.match(message, /acme/, "the tenant is named");
  assert.match(message, /payments\/api-key/, "the specific entry is named");
  assert.match(message, /cap-01/, "the capability is identified");

  const schema = params["requestedSchema"] as Record<string, unknown>;
  const properties = schema["properties"] as Record<string, Record<string, unknown>>;
  for (const field of ["tool", "tenant", "capability", "credentialName", "sideEffects", "approve", "approvedBy", "reason"]) {
    assert.ok(properties[field] !== undefined, `the schema presents ${field}`);
  }
  assert.deepEqual(schema["required"], ["approve", "approvedBy", "reason"], "a decision and its justification are required");
  g.dispose();
});

test("THE PAYLOAD NEVER CARRIES A BEARER VALUE, because form mode data is exposed to the client", () => {
  const time = clock();
  const { g } = gate(time.now);
  const line = g.begin({ ...SUBJECT, capability: "cap-01" }, 7).frame;

  assert.equal(line.includes("NEUROFEBRIC_EMBASSY_TOKEN"), false);
  assert.equal(line.includes("tok_secret_value"), false);
  assert.equal(line.includes("sk-live"), false, "no value-shaped content is present anywhere");
  g.dispose();
});

test("SIDE EFFECTS ARE STATED, because an approval with no consequences is a rubber stamp", () => {
  const time = clock();
  const { g } = gate(time.now);
  const frame = JSON.parse(g.begin(SUBJECT, 7).frame) as Record<string, unknown>;
  const schema = (frame["params"] as Record<string, unknown>)["requestedSchema"] as Record<string, unknown>;
  const properties = schema["properties"] as Record<string, Record<string, unknown>>;
  const described = JSON.stringify(properties["sideEffects"]);

  assert.match(described, /returned to the calling agent/);
  assert.match(described, /recorded/);
  g.dispose();
});

// THE DECISION.

test("ACCEPT WITH APPROVAL SET IS THE ONLY PATH TO A READ", () => {
  const time = clock();
  const { g, audits } = gate(time.now);
  const { frame } = g.begin(SUBJECT, 7);

  const parsed = parseFrame(answerLine(JSON.parse(frame).id as number, { action: "accept", content: { approve: true, approvedBy: "operator", reason: "incident 4471" } }));
  const resolved = g.offer(parsed) as ResolvedApproval;

  assert.equal(resolved.decision.approved, true);
  if (resolved.decision.approved) {
    assert.equal(resolved.decision.by, "operator");
    assert.equal(resolved.decision.reason, "incident 4471");
  }
  assert.equal(resolved.pending.toolCallId, 7, "the answer goes back to the call that asked");
  assert.equal(audits.length, 1, "an approval is recorded");
  g.dispose();
});

test("DECLINE, CANCEL, AN UNCHECKED BOX, AND GARBAGE ALL REFUSE, WITH ONE CODE", () => {
  // Seven shapes, one answer. If any were distinguishable the client could learn
  // something from the difference -- and more importantly a future edit that
  // treated one of them as approval would be invisible.
  const cases: readonly (readonly [string, unknown])[] = [
    ["decline", { action: "decline" }],
    ["cancel", { action: "cancel" }],
    ["accept with approve false", { action: "accept", content: { approve: false, approvedBy: "op", reason: "no" } }],
    ["accept with approve missing", { action: "accept", content: { approvedBy: "op", reason: "no" } }],
    ["accept with approve as the string true", { action: "accept", content: { approve: "true", approvedBy: "op", reason: "no" } }],
    ["no action at all", { content: { approve: true } }],
    ["a string", "yes"],
    ["null", null],
  ];

  const codes = new Set<string>();
  for (const [label, result] of cases) {
    const time = clock();
    const { g } = gate(time.now);
    const { frame } = g.begin(SUBJECT, 7);
    const resolved = g.offer(parseFrame(answerLine(JSON.parse(frame).id as number, result))) as ResolvedApproval;
    assert.equal(resolved.decision.approved, false, `${label} must refuse`);
    if (!resolved.decision.approved) codes.add(resolved.decision.code);
    g.dispose();
  }

  assert.equal(codes.size, 1, "a refusal is one answer whatever caused it, or it is an oracle");
});

test("AN APPROVAL WITHOUT A NAME OR REASON IS REFUSED, because an unowned approval is not an approval", () => {
  const time = clock();
  const { g } = gate(time.now);
  const { frame } = g.begin(SUBJECT, 7);

  const resolved = g.offer(
    parseFrame(answerLine(JSON.parse(frame).id as number, { action: "accept", content: { approve: true, approvedBy: "   ", reason: "" } })),
  ) as ResolvedApproval;

  assert.equal(resolved.decision.approved, false, "blank attribution does not count as a person");
  g.dispose();
});

test("A REPLY FOR AN ID NOTHING IS WAITING ON RESOLVES NOTHING", () => {
  const time = clock();
  const { g } = gate(time.now);
  g.begin(SUBJECT, 7);

  const resolved = g.offer(parseFrame(answerLine(9999, { action: "accept", content: { approve: true, approvedBy: "x", reason: "y" } })));

  assert.equal(resolved, undefined, "an unknown correlation resolves nothing");
  assert.equal(g.pendingCount(), 1, "and leaves the real pending entry alone");
  g.dispose();
});

test("TWO PENDING CALLS DO NOT CROSS, because correlation is the whole mechanism", () => {
  const time = clock();
  const { g } = gate(time.now);
  const first = g.begin(SUBJECT, 7);
  const second = g.begin({ ...SUBJECT, credentialName: "billing/token" }, 8);

  assert.notEqual(first.pending.elicitationId, second.pending.elicitationId, "each pending call is its own row");

  const resolved = g.offer(parseFrame(answerLine(second.pending.elicitationId, { action: "accept", content: { approve: true, approvedBy: "op", reason: "second" } }))) as ResolvedApproval;
  assert.equal(resolved.pending.toolCallId, 8, "the answer landed on the call that asked for it");
  assert.equal(g.pendingCount(), 1);
  g.dispose();
});

// TIME.

test("AN UNANSWERED APPROVAL TIMES OUT AND REFUSES, and the timeout is recorded", () => {
  const time = clock();
  const { g, audits } = gate(time.now, 30_000);
  g.begin(SUBJECT, 7);

  assert.deepEqual(g.sweep(time.now()), [], "nothing has expired yet");

  time.advance(30_001);
  const expired = g.sweep(time.now()) as ResolvedApproval[];

  assert.equal(expired.length, 1);
  assert.equal(expired[0]?.decision.approved, false);
  if (!expired[0]?.decision.approved) assert.match(expired[0].decision.reason, /time/i);
  assert.equal(g.pendingCount(), 0, "an expired entry is released, not left to pile up");
  assert.equal(audits.length, 1, "and the timeout is itself an audit event");
  g.dispose();
});

test("A LATE REPLY TO AN EXPIRED REQUEST RESOLVES NOTHING, because the window has closed", () => {
  const time = clock();
  const { g } = gate(time.now, 1_000);
  const { frame } = g.begin(SUBJECT, 7);
  time.advance(2_000);
  g.sweep(time.now);

  const resolved = g.offer(parseFrame(answerLine(JSON.parse(frame).id as number, { action: "accept", content: { approve: true, approvedBy: "op", reason: "late" } })));

  assert.equal(resolved, undefined, "a slow operator does not get a second chance");
  g.dispose();
});

test("DISPOSING RELEASES EVERY PENDING APPROVAL", () => {
  // The same lesson as the evaluation loop in MR !112: a timer in a long-lived
  // object is a handle that keeps a process alive and a thing that outlives
  // whatever owns it. There is a test for that shape elsewhere in this
  // repository and it was hung by it once.
  const time = clock();
  const { g } = gate(time.now, 1_000);
  g.begin(SUBJECT, 7);
  g.begin(SUBJECT, 8);
  g.dispose();
  assert.equal(g.pendingCount(), 0, "disposing releases every pending approval");
});

// THE IMMUTABLE TRAIL.

test("THE APPROVAL IS WRITTEN TO THE DURABLE LOG BEFORE ANY VALUE IS READ", () => {
  const store = MemoryStore.open({ inMemory: true });
  const g = createApprovalGate({
    timeoutMs: 30_000,
    now: clock().now,
    audit: (event) =>
      store.appendAudit("acme", event.approvedBy ?? "nobody", `vault.${event.outcome}`, {
        tool: event.tool,
        tenant: event.tenant,
        capability: event.capability,
        credentialName: event.credentialName,
        reason: event.reason,
      }),
  });

  const { frame } = g.begin(SUBJECT, 7);
  g.offer(parseFrame(answerLine(JSON.parse(frame).id as number, { action: "accept", content: { approve: true, approvedBy: "operator", reason: "incident 4471" } })));

  const trail = store.auditFor("acme");
  assert.equal(trail.length, 1, "who approved what, recorded before the read proceeds");
  assert.equal(trail[0]?.actor, "operator");
  assert.equal(trail[0]?.action, "vault.granted");
  const document = JSON.stringify(trail[0]?.document);
  assert.match(document, /payments\/api-key/);
  assert.match(document, /incident 4471/);
  assert.equal(document.includes("sk-live"), false, "the trail never carries a value");

  g.dispose();
  store.close();
});

test("A REFUSAL IS WRITTEN TOO, because a trail that only records successes cannot answer a question", () => {
  const store = MemoryStore.open({ inMemory: true });
  const g = createApprovalGate({
    timeoutMs: 30_000,
    now: clock().now,
    audit: (event) => store.appendAudit("acme", event.approvedBy ?? "nobody", `vault.${event.outcome}`, { tool: event.tool, reason: event.reason }),
  });

  const { frame } = g.begin(SUBJECT, 7);
  g.offer(parseFrame(answerLine(JSON.parse(frame).id as number, { action: "decline" })));

  assert.equal(store.auditFor("acme")[0]?.action, "vault.refused");
  g.dispose();
  store.close();
});

test("A TRAIL THAT THROWS REFUSES THE READ, because an unrecorded read is not a read we can justify", () => {
  const time = clock();
  const g = createApprovalGate({
    timeoutMs: 30_000,
    now: time.now,
    audit: () => {
      throw new Error("the trail is unavailable");
    },
  });

  const { frame } = g.begin(SUBJECT, 7);
  const resolved = g.offer(parseFrame(answerLine(JSON.parse(frame).id as number, { action: "accept", content: { approve: true, approvedBy: "op", reason: "y" } }))) as ResolvedApproval;

  assert.equal(resolved.decision.approved, false, "an approval nobody can see is not an approval");
  g.dispose();
});