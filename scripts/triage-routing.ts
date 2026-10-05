import { RPC } from "../platform/embassy/jsonrpc.ts";

/**
 * === WHAT A TOOL CALL MEANT, WHEN IT DID NOT MEANT "HERE IS YOUR ANSWER" ===
 *
 * A triage agent that cannot get a credential has to wake somebody up, and the only
 * thing it can put in that person's hands is a sentence. So the classification
 * below is not tidiness: it decides whether the sentence is true.
 *
 *   - A REFUSAL is a decision somebody reached on the merits. Route it. Never retry
 *     it, never rephrase it, never ask for a narrower version of it.
 *   - A REFUSAL BY A TOOL is the same kind of decision one layer down -- the tool
 *     ran and declined -- and is kept apart because it is traced to a different
 *     system, and blaming the approval gate for it wastes the investigation.
 *   - A FAULT is a broken system or a bad call. It is nobody's decision, it must
 *     never be described as one, and it is the one outcome that is ESCALATED as a
 *     problem rather than filed as a policy outcome.
 *
 * === TWO FUNCTIONS, DELIBERATELY, NOT ONE ===
 *
 * `classifyToolOutcome` reads a resolved result; `classifyToolFailure` reads a
 * rejection. They cannot be merged into one function that sniffs for a code,
 * because a tool refusal body is `{"code": -32001, ...}` inside a SUCCESSFUL
 * result. One function asked to guess which side of the promise it is looking at
 * will eventually report a successful read as a refusal -- or a refusal as a read.
 *
 * The wire code for a refused approval is the same value as a refused tenant, and
 * that is not a bug to fix here: ADR-009 requires that a caller cannot learn WHY a
 * call was refused, so the two must not be distinguishable on the wire. What the
 * client still must do is notice that neither one is a fault, and this module is
 * where that distinction lives.
 */

export type ToolOutcome =
  | { readonly kind: "granted" }
  | { readonly kind: "refused"; readonly code: number; readonly because: string }
  | { readonly kind: "refused-by-tool"; readonly because: string }
  /** Nobody decided anything. Escalate it as a broken system. */
  | { readonly kind: "fault"; readonly code: number | undefined; readonly because: string };

/**
 * THE ERROR A CALL FAULTS WITH, AND WHY IT IS A CLASS.
 *
 * The client used to reject with `new Error(\`-32001: ...\`)`, which puts the one
 * piece of machine-readable information in the whole exchange inside a sentence.
 * Every caller then had one of two choices, and both are wrong: guess at the message
 * with a regular expression, or -- what actually happened -- throw the code away
 * and treat a policy refusal as an unknown failure.
 *
 * That is not a formatting complaint. The refusal is the difference between "a
 * person said no, route this to a human" and "we broke, escalate this to an
 * engineer", and it was arriving as a string.
 */
export class JsonRpcCallError extends Error {
  /** The wire code, when the peer sent one. Undefined is a transport failure. */
  readonly code: number | undefined;

  constructor(code: number | undefined, message: string) {
    // The message keeps the code for the human reading the log; the field is what
    // the code is FOR.
    super(`${code === undefined ? "transport" : code}: ${message}`);
    this.name = "JsonRpcCallError";
    this.code = code;
  }
}

/**
 * The reserved band for implementation-defined server errors, per JSON-RPC 2.0.
 *
 * In this gateway everything in it is a decision; everything outside it is either a
 * standard protocol error, which is the caller's fault, or a fault in our code.
 */
const REFUSAL_BAND = { lowest: -32099, highest: -32000 } as const;

function isRefusal(code: number): boolean {
  return code >= REFUSAL_BAND.lowest && code <= REFUSAL_BAND.highest;
}

/**
 * The promise RESOLVED. What did the answer say?
 *
 * `isError` is MCP's marker for "the tool ran and refused". Its ABSENCE means
 * success -- absent is not false -- because a gateway that omits the flag would
 * otherwise have every one of its answers filed as a refusal.
 */
export function classifyToolOutcome(result: unknown): ToolOutcome {
  const body = result as { isError?: unknown } | null | undefined;
  if (body !== null && typeof body === "object" && body.isError === true) {
    return { kind: "refused-by-tool", because: "the tool ran and declined this call" };
  }
  return { kind: "granted" };
}

/**
 * The promise REJECTED: an error frame from the server, or a transport that died.
 *
 * The reason strings are ours and never quote the peer's message. That message is
 * operator input by the time it is a client-side string, and it is printed for a
 * human at 2am.
 */
export function classifyToolFailure(thrown: unknown): ToolOutcome {
  const code = readCode(thrown);
  if (code !== undefined && isRefusal(code)) {
    return { kind: "refused", code, because: "the call was not approved for a credential read" };
  }
  return {
    kind: "fault",
    code,
    // Deliberately does not say a person was involved. There was not one, and an
    // escalation that names a nonexistent decision sends someone looking for a
    // prompt that was never shown.
    because:
      code === RPC.INTERNAL_ERROR
        ? "the gateway could not complete the call, and no decision was recorded"
        : "the call did not complete, and no decision was recorded",
  };
}

/**
 * The wire code, if there is one.
 *
 * Read from a real error frame or from anything carrying a numeric `code`, and from
 * nothing else -- so a rejection that is a string, a number, or `undefined` is
 * reported as a fault rather than crashing the caller that is trying to classify
 * it. The transport failure case has no code at all, and that is exactly the case
 * that must never be read as a decision.
 */
function readCode(thrown: unknown): number | undefined {
  if (thrown === null || typeof thrown !== "object") return undefined;
  const code = (thrown as { code?: unknown }).code;
  return typeof code === "number" && Number.isInteger(code) ? code : undefined;
}