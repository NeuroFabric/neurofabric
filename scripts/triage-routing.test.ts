import test from "node:test";
import assert from "node:assert/strict";

import { classifyToolFailure, classifyToolOutcome, JsonRpcCallError, type ToolOutcome } from "./triage-routing.ts";
import { RPC } from "../platform/embassy/jsonrpc.ts";

/**
 * === WHY A REFUSAL AND A FAULT MUST NOT BE THE SAME ANSWER ===
 *
 * The triage agent's whole reason for existing at 2am is to escalate to a human
 * when it cannot act. That handoff is only useful if it says something true.
 *
 * So the question this file answers is narrow and important: when a credential call
 * comes back with something other than an answer, what may the agent tell the
 * person it wakes up?
 *
 * The previous client treated every failure alike:
 *
 *   const declined = rawResult.error !== undefined || rawResult.isError === true;
 *
 * Three different things collapse into that one line, and each collapse is a false
 * statement about the world:
 *
 *   - "an operator declined" and "our ledger could not take the row" are both an
 *     error. Reporting the first when the second happened sends a human to argue
 *     with a policy decision that was never made. There is no row to find.
 *   - "the core refused this session's credential" arrives as a successful result
 *     with `isError`. It is neither a protocol fault nor an operator decision, and
 *     the agent that files it under "declined" points at the wrong system.
 *   - A socket that died mid-call is not a decision at all. Filing it as a refusal
 *     turns a network into an operator's signature.
 *
 * A refusal is a DECISION somebody reached on the merits. A fault is a broken
 * system. They are routed differently, reported differently, and only one of them
 * may be described as somebody having said no.
 */

test("A GATE REFUSAL IS A ROUTING CONDITION, and the agent does not retry it", () => {
  const outcome = classifyToolFailure({ code: RPC.TENANT_REFUSED, message: "this call was not approved for a credential read" });
  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.kind === "refused" ? outcome.code : undefined, -32001);
});

test("THE WHOLE IMPLEMENTATION-DEFINED BAND IS A DECISION, not a fault", () => {
  // -32000..-32099 is reserved by the specification for implementation-defined
  // server ERRORS -- which in this gateway are all decisions somebody reached. The
  // band's edges are pinned so a future edit cannot quietly widen "refused" to
  // include a fault, which would be the exact confusion this module exists to stop.
  for (const code of [-32000, -32001, -32002, -32099]) {
    assert.equal(classifyToolFailure({ code, message: "refused" }).kind, "refused", `${code} is a decision`);
  }
  for (const code of [-32100, -31999, -33000]) {
    assert.equal(classifyToolFailure({ code, message: "?" }).kind, "fault", `${code} is not ours to call a decision`);
  }
});

test("AN INTERNAL FAULT IS NOT A REFUSAL, and must never be described as one", () => {
  // This is the row that matters most. The durable ledger refusing a read row means
  // the gateway could not keep the record. An agent that calls that "an operator
  // declined" invents a human decision that never happened -- and the person woken
  // up goes looking for a prompt nobody was ever shown.
  const outcome = classifyToolFailure({ code: RPC.INTERNAL_ERROR, message: "the request did not complete" });
  assert.equal(outcome.kind, "fault");
  assert.equal(outcome.kind === "fault" ? outcome.code : undefined, RPC.INTERNAL_ERROR);
  assert.doesNotMatch(
    outcome.because,
    /approv|declin|operator|human/i,
    "a fault has nobody to attribute it to, and saying otherwise is the lie this test exists to prevent",
  );
});

test("A CALLER'S OWN BAD REQUEST IS A FAULT IN THE CALLER, not a decision", () => {
  for (const code of [RPC.INVALID_PARAMS, RPC.INVALID_REQUEST, RPC.METHOD_NOT_FOUND, RPC.PARSE_ERROR]) {
    assert.equal(classifyToolFailure({ code, message: "?" }).kind, "fault", `${code} is the caller's problem`);
  }
});

test("AN ERROR FRAME WITH NO CODE IS A FAULT, never an unknown refusal", () => {
  // The conservative direction. A refusal we cannot identify is a refusal we must not
  // attribute to a person.
  const outcome = classifyToolFailure({ message: "refused" });
  assert.equal(outcome.kind, "fault");
  assert.equal(outcome.kind === "fault" ? outcome.code : undefined, undefined);
});

test("A SOCKET THAT DIED IS A FAULT, and carries no code at all", () => {
  const outcome = classifyToolFailure(new Error("socket hang up"));
  assert.equal(outcome.kind, "fault");
  assert.equal(outcome.kind === "fault" ? outcome.code : undefined, undefined);
});

test("SOMETHING THAT IS NOT AN ERROR AT ALL IS STILL A FAULT, not a crash at the call site", () => {
  // A rejection can carry anything. The classifier reads it; it must not assume.
  for (const thrown of ["boom", 42, null, undefined, { nope: true }]) {
    assert.equal(classifyToolFailure(thrown).kind, "fault", `${String(thrown)} is contained`);
  }
});

test("A TOOL THAT RAN AND REFUSED IS ITS OWN OUTCOME, not a fault and not a human", () => {
  // `tools/call` answers a tool-level refusal in a SUCCESSFUL result carrying
  // `isError`. The tool ran, reached a decision, and reported it. Calling that a
  // protocol fault would send an engineer to debug a policy that worked.
  const outcome = classifyToolOutcome({ content: [{ type: "text", text: "{}" }], isError: true });
  assert.equal(outcome.kind, "refused-by-tool");
});

test("A SUCCESSFUL CALL IS GRANTED, EVEN WHEN ITS BODY QUOTES A REFUSAL CODE", () => {
  // The trap. A tool refusal body is `{"code": -32001, ...}` INSIDE a successful
  // result, so anything that sniffs for a code without knowing which side of the
  // promise it is looking at will report this success as a refusal -- and vice
  // versa. The two sides of the promise get two functions for exactly this reason.
  const outcome = classifyToolOutcome({ content: [{ type: "text", text: "{}" }], code: -32001, isError: false });
  assert.equal(outcome.kind, "granted");
});

test("AN ORDINARY SUCCESS IS GRANTED", () => {
  const outcome = classifyToolOutcome({ content: [{ type: "text", text: '{"exists":true}' }], isError: false });
  assert.equal(outcome.kind, "granted");
});

test("A SUCCESS RESULT WITH NO isError FLAG IS STILL A SUCCESS", () => {
  // Absent is not false. A gateway that simply omits the flag must not have every
  // one of its answers filed as a refusal.
  assert.equal(classifyToolOutcome({ content: [] }).kind, "granted");
});

test("A REFUSAL SAYS A DECISION WAS MADE; A FAULT SAYS NOTHING WAS", () => {
  // The sentence the agent prints for a person. Pinned because the whole point of
  // splitting these is that the sentence can be believed.
  const refused = classifyToolFailure({ code: RPC.TENANT_REFUSED, message: "refused" });
  const fault = classifyToolFailure({ code: RPC.INTERNAL_ERROR, message: "refused" });
  assert.match(because(refused), /not approved|declined/i);
  assert.match(because(fault), /could not|internal|did not/i);
});

test("THE WIRE CODE SURVIVES FROM THE ERROR FRAME TO THE CLASSIFICATION", () => {
  // The whole chain, in one assertion, because it broke end to end once already.
  //
  // The server refused on the wire at -32001. The client rejected with a bare
  // `Error` whose MESSAGE read "-32001: ...". The classifier read the code from the
  // error OBJECT, found none, and correctly concluded -- given what it had -- that
  // nobody had decided anything. The demo then reported a policy refusal as a
  // broken gateway, and the escalation it produced pointed at the wrong system.
  //
  // Nothing in that chain was unreasonable on its own; each step lost exactly one
  // bit, and the last step was faithfully wrong. Pinned end to end so the bit
  // cannot be lost again.
  const thrown = new JsonRpcCallError(RPC.TENANT_REFUSED, "this call was not approved for a credential read");
  assert.equal(thrown.code, -32001, "the code is a field, not a sentence");
  assert.equal(classifyToolFailure(thrown).kind, "refused");
});

test("A TRANSPORT FAILURE CARRIES NO CODE, AND SAYS SO IN ITS MESSAGE", () => {
  const thrown = new JsonRpcCallError(undefined, "socket hang up");
  assert.equal(thrown.code, undefined);
  assert.equal(classifyToolFailure(thrown).kind, "fault");
  assert.match(thrown.message, /^transport: /, "the log line still says where it came from");
});

test("THE REASON TEXT NEVER ECHOES THE SERVER'S MESSAGE", () => {
  // The server's message is operator input by the time it is a client-side string,
  // and it ends up in a line printed for a human at 2am. These reasons are ours.
  const outcome = classifyToolFailure({ code: RPC.TENANT_REFUSED, message: "operator on-call approved then revoked /srv/keys/acme" });
  assert.doesNotMatch(because(outcome), /on-call|\/srv\/keys/, "the handoff line is ours, and does not quote the peer");
});

/** Only a granted call has nothing to say, and a test must not read its silence. */
function because(outcome: ToolOutcome): string {
  return outcome.kind === "granted" ? "" : outcome.because;
}