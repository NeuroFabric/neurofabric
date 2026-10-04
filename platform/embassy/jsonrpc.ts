/**
 * JSON-RPC 2.0 OVER A LINE. The pure half of the embassy transport.
 *
 * === WHY THIS FILE HAS NO I/O ===
 *
 * The four framing obligations in ADR-006 section 3.2 are all about bytes, and a
 * test that cannot control the bytes cannot test any of them. So the envelope is
 * parsed here, from a string, with nothing else in the file: `server.ts` owns the
 * pipe, this owns the grammar. Every rule below is therefore a pure function of
 * its argument, which is what makes the malformed cases table-testable rather
 * than something you have to provoke with a real pipe.
 *
 * === THE OBLIGATIONS THIS FILE OWES ===
 *
 *  1. NO CONCATENATED ENVELOPES. Every outbound line is produced by `JSON.stringify`
 *     and by nothing else. A hand-built envelope containing a literal newline
 *     splits where the reader does not expect, and the reader silently
 *     resynchronises onto garbage -- a failure that surfaces as a parse error on
 *     the HOST's side, pointing at our code. `serialise` below is the only way
 *     out of this module, and it asserts its own output is a single line.
 *
 *  2. NO ROGUE STDOUT. Enforced in `server.ts`, because stdout is the protocol
 *     channel and one stray `console.log` corrupts it for the host agent.
 *
 *  3. A TRUNCATED FINAL LINE IS A CLEAN EXIT. Handled in `server.ts` at EOF; the
 *     parser's contribution is that a partial line fails as a PARSE ERROR and not
 *     as a `TypeError` from somewhere deeper.
 *
 *  4. ERRORS ARE RETURNED, NOT THROWN. Nothing in this module throws. A throw
 *     that escapes the dispatcher ends the process, and it ends the host agent's
 *     connection with it -- one malformed line from a confused client becomes an
 *     outage for every caller.
 */

/** The largest single frame the reader will accept. ADR-006 section 8. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/**
 * JSON-RPC 2.0 reserved codes, plus the server-defined band this embassy uses.
 *
 * The -32000..-32099 band is RESERVED BY THE SPECIFICATION for
 * implementation-defined server errors, which is why the domain refusals in
 * ADR-006 section 9 live there rather than in invented numbers.
 */
export const RPC = {
  /** Invalid JSON was received. */
  PARSE_ERROR: -32700,
  /** Valid JSON, but not a valid Request object. */
  INVALID_REQUEST: -32600,
  /** The method does not exist. */
  METHOD_NOT_FOUND: -32601,
  /** The method exists; the params do not fit it. */
  INVALID_PARAMS: -32602,
  /** A fault in our own code. The message never crosses to the caller. */
  INTERNAL_ERROR: -32603,
  /** ADR-006 section 9: this session is not authorised for that tenant. */
  TENANT_REFUSED: -32001,
  /** ADR-006 section 9: the schema was refused, carrying the validator's paths. */
  SCHEMA_REFUSED: -32002,
  /** ADR-006 section 9: the request exceeds a stated limit. */
  LIMIT_EXCEEDED: -32003,
  /** ADR-006 section 9: no provider with that name is connected. */
  PROVIDER_NOT_CONNECTED: -32004,
} as const;

/** A JSON-RPC id. The spec allows string, number, or null -- and nothing else. */
export type RpcId = string | number | null;

/** A Request that expects a Response. Carries an id by definition. */
export interface RpcRequest {
  readonly kind: "request";
  readonly id: RpcId;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>> | readonly unknown[] | undefined;
}

/**
 * A Notification: a Request with NO id member.
 *
 * === WHY THIS IS NOT SIMPLY A REQUEST WITH A MISSING ID ===
 *
 * Because the response is different. The spec is unambiguous that a notification
 * gets NO Response -- not an error Response, none. A server that replies to a
 * notification is not being helpful, it is inventing a conversation the client
 * never started, and a client that receives an id it never sent will typically
 * discard it or, worse, log a protocol violation.
 *
 * So `id: null` (present, and asking for a reply with a null id) and an absent
 * `id` are DIFFERENT THINGS, and collapsing them is the most common way a
 * hand-written dispatcher is wrong.
 */
export interface RpcNotification {
  readonly kind: "notification";
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>> | readonly unknown[] | undefined;
}

/** Something the dispatcher did not accept, with the id to answer on if one is known. */
export interface RpcRejection {
  readonly kind: "rejected";
  /** Null when the frame was too broken to carry a usable id. */
  readonly id: RpcId;
  readonly code: number;
  readonly message: string;
}

export type ParsedFrame = RpcRequest | RpcNotification | RpcRejection;

/**
 * Parse one line into a frame.
 *
 * NEVER THROWS. Every malformed input produces an `RpcRejection` carrying a
 * reserved code, which is obligation 4 above: the dispatcher has a value to
 * return, so no path exists by which a bad line can end the process.
 */
export function parseFrame(line: string): ParsedFrame {
  // Obligation 3, parser-side half: a frame over the cap is refused before it is
  // parsed, so an oversized body is a known refusal rather than an allocation
  // that succeeds.
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
    return { kind: "rejected", id: null, code: RPC.INVALID_REQUEST, message: "the frame exceeds the size limit" };
  }

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    // The message names the failure class and nothing else. The underlying
    // SyntaxError carries a position into the frame, which is useful to us and
    // is an echo of caller-supplied content to an untrusted peer.
    return { kind: "rejected", id: null, code: RPC.PARSE_ERROR, message: "the frame is not valid JSON" };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "rejected", id: null, code: RPC.INVALID_REQUEST, message: "the frame is not a Request object" };
  }

  const frame = value as Record<string, unknown>;

  // The version is checked BEFORE anything else, and it is checked for equality.
  // A missing jsonrpc member and a wrong one are the same defect: this is not a
  // JSON-RPC 2.0 peer. Accepting an absent member is how a 1.0 client silently
  // gets 2.0-shaped answers it cannot read.
  if (frame["jsonrpc"] !== "2.0") {
    return { kind: "rejected", id: null, code: RPC.INVALID_REQUEST, message: "the frame does not declare JSON-RPC 2.0" };
  }

  if (typeof frame["method"] !== "string" || frame["method"].length === 0) {
    return { kind: "rejected", id: readId(frame) ?? null, code: RPC.INVALID_REQUEST, message: "the frame carries no method name" };
  }

  const params = frame["params"];
  if (params !== undefined && params !== null) {
    // Structured only: object or array. A scalar `params` is invalid in 2.0, and
    // accepting one would mean every tool had to defend against a number or a
    // string where it expected a bag of named arguments.
    if (typeof params !== "object") {
      return { kind: "rejected", id: readId(frame) ?? null, code: RPC.INVALID_PARAMS, message: "params must be an object or an array" };
    }
  }

  const method = frame["method"];
  const hasId = Object.prototype.hasOwnProperty.call(frame, "id");

  if (!hasId) return { kind: "notification", method, params: params as RpcRequest["params"] };

  const id = readId(frame);
  if (id === undefined) {
    // An id that is present but of an unusable type -- boolean, object, array.
    // These are invalid ids, not notifications, so the rejection carries no id to
    // answer on: there is nothing valid to echo.
    return { kind: "rejected", id: null, code: RPC.INVALID_REQUEST, message: "the id is not a string, a number, or null" };
  }

  return { kind: "request", id, method, params: params as RpcRequest["params"] };
}

/**
 * Read the id member, or `undefined` when it is present but unusable.
 *
 * The id TYPE is checked rather than coerced. `id: true` is a classic way to make
 * a naive dispatcher build a Map keyed on `true`, and every subsequent lookup for
 * the real id then collides with it.
 */
function readId(frame: Readonly<Record<string, unknown>>): RpcId | undefined {
  const id = frame["id"];
  if (id === null) return null;
  if (typeof id === "string") return id;
  if (typeof id === "number" && Number.isFinite(id)) return id;
  return undefined;
}

/** A Response. `id` is echoed exactly as received, including null. */
export interface RpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: RpcId;
  readonly result: unknown;
}

/** An Error object. `data` is optional and always operator-safe. */
export interface RpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: RpcId;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/**
 * Serialise one outbound envelope as a SINGLE LINE, newline included.
 *
 * === THE ONLY EXIT FROM THIS MODULE, BY DESIGN ===
 *
 * Every response path -- success, error, internal fault -- goes through here, so
 * "we never hand-concatenate an envelope" is a structural property rather than a
 * review instruction. `JSON.stringify` escapes every control character inside a
 * string, so the result cannot contain a raw newline; the check below is
 * therefore a guard against a future edit, not a working assumption.
 *
 * Throws only if a value is not serialisable (a cycle, a BigInt). That is a bug
 * in our own code rather than caller input, and it surfaces as an internal error
 * at the dispatcher's outermost layer rather than as a corrupt frame.
 */
export function serialise(envelope: RpcSuccess | RpcFailure): string {
  const line = JSON.stringify(envelope);
  // A literal newline here would split one frame into two and desynchronise the
  // reader. Nothing in a JSON.stringify result can contain one today; if this
  // ever fires, the invariant that justified it stopped being true.
  if (/[\u0000-\u001f]/.test(line)) {
    throw new Error("a serialised envelope contained a raw control character");
  }
  return `${line}\n`;
}

/** A success Response for `id`. */
export function success(id: RpcId, result: unknown): RpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

/**
 * An Error Response for `id`.
 *
 * `data` is passed through deliberately: ADR-006 section 9 sends the schema
 * validator's ISSUE PATHS to the author, because they are the only party who can
 * act on them and a generic "invalid schema" sends them to a log instead.
 *
 * A SEPARATE branch rather than `data: data ?? undefined`, because the Error
 * object must NOT carry a `data` member at all when there is nothing to say. A
 * JSON-RPC peer is entitled to tell "absent" from "present and null", and
 * emitting `"data": null` for every ordinary refusal collapses the two.
 */
export function failure(id: RpcId, code: number, message: string, data?: unknown): RpcFailure {
  const error = data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: "2.0", id, error };
}
