/**
 * THE EMBASSY SERVER. stdio in, stdio out, and nothing else may touch either.
 *
 * === TWO OF THE FOUR OBLIGATIONS ARE ENFORCED HERE ===
 *
 * ADR-006 section 3.2 lists four. Two live in `jsonrpc.ts` (no hand-concatenated
 * envelopes; errors returned rather than thrown). This file owns the other two:
 *
 *  2. **NO ROGUE STDOUT.** stdout is the protocol channel. One `console.log` in
 *     any module on the import path corrupts the stream for the HOST agent, and
 *     the symptom appears on the agent's side as a parse error pointing at our
 *     code -- which is a genuinely awful thing to debug from the other end of a
 *     pipe. So the writer is INJECTED rather than reached for globally, the only
 *     legal implementation of it is this module's, and `stdout-guard.test.ts`
 *     scans the import graph for `console.log` rather than trusting review.
 *
 *  3. **A TRUNCATED FINAL LINE IS A CLEAN EXIT.** If the host closes the pipe
 *     mid-write, readline emits a final `close` with the partial line still in
 *     `line`. Parsing it would be parsing a truncated object, producing a -32700
 *     that the host has already gone away to read. So the final line is DISCARDED
 *     unless the stream ended on a newline, and the exit is the ordinary one.
 *
 * === THE SESSION, AND WHY IT HOLDS ONLY A CREDENTIAL ===
 *
 * ADR-006 section 5.2: the token is presented once, on `initialize`, and every
 * later call is authenticated by being on the established session. What the
 * session stores is the CREDENTIAL -- not a tenant. The core derives the tenant
 * from the credential it proves, in its own process, and this process has no
 * opinion about whose records those are. A session that cached a tenant id would
 * be a second authority for the one question the core answers.
 */

import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import {
  RPC,
  failure,
  parseFrame,
  serialise,
  success,
  type RpcId,
} from "./jsonrpc.ts";
import { TOOLS, callTool, type HandlerContext } from "./tools.ts";
import type { CoreEndpoint } from "./core.ts";

/** The protocol version this embassy speaks. */
export const PROTOCOL_VERSION = "2025-06-18";

/**
 * Where the credential and the core address come from.
 *
 * The ENVIRONMENT, and deliberately not a tool argument and not a config file the
 * host can rewrite. The host chooses how to launch us -- that is not something a
 * credential boundary can pretend otherwise -- so the value is read once at start
 * and treated as fixed for the life of the process, which is what bounds its
 * authority (ADR-006 section 5.2 rule 6).
 */
export interface EmbassyConfig {
  readonly credential: string;
  readonly endpoint: CoreEndpoint;
}

/** Read configuration from the environment. Returns `undefined` when incomplete. */
export function readConfig(env: Readonly<Record<string, string | undefined>>): EmbassyConfig | undefined {
  const credential = env["NEUROFEBRIC_EMBASSY_TOKEN"];
  const origin = env["NEUROFEBRIC_CORE_ORIGIN"];
  if (credential === undefined || credential.trim() === "") return undefined;
  if (origin === undefined || origin.trim() === "") return undefined;

  const rawTimeout = env["NEUROFEBRIC_CORE_TIMEOUT_MS"];
  const parsed = rawTimeout === undefined ? Number.NaN : Number(rawTimeout);
  const timeoutMs = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 60_000) : 5_000;

  return {
    credential,
    // The trailing slash is removed here rather than at the call site, because
    // `origin + path` is string concatenation and `http://h//api/portal/live` is a
    // different path to a different handler on some servers.
    endpoint: { origin: origin.replace(/\/+$/, ""), timeoutMs },
  };
}

/** What the dispatcher is given, so tests can drive it without a pipe. */
export interface DispatcherDeps {
  readonly config: EmbassyConfig;
  /** The only legal way to reach stdout. */
  readonly write: (line: string) => void;
  /** Injected so a test can prove the core was never contacted before `initialize`. */
  readonly fetchImpl?: ((...args: never[]) => Promise<unknown>) | undefined;
}

/**
 * The dispatcher's live state.
 *
 * `established` is deliberately MUTABLE and deliberately the only mutable thing
 * here. The credential is fixed for the life of the process, read once from the
 * environment at start-up; the flag records that `initialize` has been seen. An
 * earlier draft modelled the session as two `readonly` fields and flipped it with
 * `Object.assign`, which compiles and defeats the type checker at the same time --
 * the compiler would have refused `session.established = true` and been right to.
 */
interface SessionState {
  readonly credential: string;
  established: boolean;
}

/**
 * Handle ONE inbound line and return the frames to write back.
 *
 * PURE WITH RESPECT TO I/O: it takes a line and returns zero or more serialised
 * lines. That is what makes the whole protocol testable without a pipe, and it is
 * the reason the framing tests can cover malformed JSON at all.
 */
export async function dispatch(
  line: string,
  session: SessionState,
  deps: DispatcherDeps,
): Promise<readonly string[]> {
  const frame = parseFrame(line);

  // A notification gets NO response, including when it is unknown or malformed
  // enough to reject. That is the specification, and a server that answers one is
  // starting a conversation the client did not open.
  if (frame.kind === "notification") {
    await handleNotification(frame.method, session, deps);
    return [];
  }

  if (frame.kind === "rejected") {
    return [serialise(failure(frame.id, frame.code, frame.message))];
  }

  const id = frame.id;
  try {
    const handled = await handleRequest(id, frame.method, frame.params, session, deps);
    return handled === null ? [] : [handled];
  } catch {
    // Obligation 4, outermost layer. Nothing escapes: a fault here would end the
    // process and end the host agent's session with it. The cause is not
    // forwarded -- an internal message can name files, paths and values.
    return [serialise(failure(id, RPC.INTERNAL_ERROR, "the request did not complete"))];
  }
}

async function handleNotification(method: string, session: SessionState, deps: DispatcherDeps): Promise<void> {
  // `notifications/initialized` is the one notification this protocol requires we
  // accept, and it has no response. Nothing is validated and nothing is acted on:
  // a notification is fire-and-forget by construction, and refusing one would mean
  // answering it, which is the thing the specification forbids.
  void method;
  void session;
  void deps;
}

async function handleRequest(
  id: RpcId,
  method: string,
  params: unknown,
  session: SessionState,
  deps: DispatcherDeps,
): Promise<string | null> {
  const args = toArgs(params);

  if (method === "initialize") {
    // THE ONE DOOR, TAKEN ONCE. Before this, nothing is reachable; after it, the
    // session carries a credential. `params` is not read: the credential came from
    // the environment at start-up, not from a frame, so there is nothing here that
    // a caller could have put in it.
    session.established = true;
    return serialise(
      success(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "neurofebric-embassy", version: "0.1.0" },
      }),
    );
  }

  if (method === "tools/list") {
    /**
     * DISCOVERY IS BEHIND THE HANDSHAKE, AND IT HAS TO BE.
     *
     * `tools/call` has always required an established session. This did not, and
     * the omission was a real disclosure: the tool list IS the capability map --
     * it names every operation this embassy will perform on a tenant's behalf --
     * so a caller that never handshook could enumerate all of them while still
     * being unable to invoke any. `callTool` refuses to name what exists at its
     * "no such tool" for exactly that reason, and the portal edge makes the same
     * choice at its 404 rather than echoing its routes.
     *
     * A boundary that holds on the call and not on the listing is not a boundary;
     * it is a speed bump beside the door.
     *
     * The refusal uses the same code as every other session refusal, so its SHAPE
     * discloses nothing about whether this is an authentication rule or an
     * incidental one. A caller must not be able to map the boundary by probing it,
     * which is the property ADR-006 section 5.2 asked for and the earlier code
     * only half-delivered.
     *
     * This is also what the specification requires in any case: initialization is
     * the first interaction of a session, so a well-behaved client has already
     * handshook by the time it asks what tools exist. Refusing costs a conforming
     * client nothing and closes the door on one that has not.
     */
    if (!session.established) {
      return serialise(failure(id, RPC.TENANT_REFUSED, "this session has not been initialised"));
    }
    return serialise(success(id, { tools: TOOLS }));
  }

  if (method === "tools/call") {
    // A TOOL CALL BEFORE `initialize` IS REFUSED, NOT SERVED. This is the whole of
    // section 5.2 rule 5: a session with no established credential answers no tool
    // call, and the refusal is indistinguishable in shape from any other so a
    // caller cannot map the boundary by probing it.
    if (!session.established) {
      return serialise(failure(id, RPC.TENANT_REFUSED, "this session has not been initialised"));
    }

    const name = args["name"];
    const callArgs = args["arguments"];
    if (typeof name !== "string") {
      return serialise(failure(id, RPC.INVALID_PARAMS, "a tool call needs a tool name"));
    }
    const forwarded =
      callArgs !== undefined && (callArgs === null || typeof callArgs !== "object")
        ? {}
        : { ...(callArgs as Readonly<Record<string, unknown>>) };

    const ctx: HandlerContext = {
      endpoint: deps.config.endpoint,
      credential: session.credential,
      fetchImpl: deps.fetchImpl as HandlerContext["fetchImpl"],
    };
    const outcome = await callTool(name, ctx, forwarded);
    if (outcome.ok) {
      // MCP carries the payload inside `content`, and the `isError` flag is how a
      // tool-level refusal is distinguished from a protocol fault. Reporting a
      // refusal as a successful result with an error-shaped body would make the two
      // indistinguishable to the host model, which is the one party that would
      // otherwise read "success" and act on an empty answer.
      return serialise(success(id, { content: [{ type: "text", text: JSON.stringify(outcome.result ?? null) }], isError: false }));
    }
    return serialise(
      success(id, {
        content: [{ type: "text", text: JSON.stringify(outcome.data ?? { message: outcome.message ?? "refused" }) }],
        isError: true,
      }),
    );
  }

  // An unknown method is named generically. Echoing the method list would be a
  // surface map handed to something probing for one.
  return serialise(failure(id, RPC.METHOD_NOT_FOUND, "no such method"));
}

/** Params are an object or an array per the grammar; anything else was rejected already. */
function toArgs(params: unknown): Readonly<Record<string, unknown>> {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return {};
  return params as Readonly<Record<string, unknown>>;
}

/**
 * The stdio entry point.
 *
 * `input` and `output` are parameters rather than `process.stdin`/`process.stdout`
 * so the whole loop is testable with a pair of streams, and so that this file never
 * holds a global handle to the protocol channel that a later edit could write to by
 * accident.
 */
export async function serve(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  config: EmbassyConfig,
  fetchImpl?: DispatcherDeps["fetchImpl"],
): Promise<void> {
  /**
   * A BROKEN PIPE MUST NOT BECOME AN UNCAUGHT EXCEPTION.
   *
   * `writable.write()` reports failure by EMITTING `error`, not by throwing. With no
   * listener attached, Node turns that into an uncaughtException and terminates the
   * process -- so a host that closes its read end part-way through a reply would
   * take the whole embassy down with it, and every other session this host had open
   * would go with it. A client disconnecting is the most ordinary event a server
   * sees; it is not a reason to exit.
   *
   * So the handler is attached here, before a single byte is written, and it is
   * deliberately quiet: the peer is gone and there is nobody left to tell. It is
   * recorded on stderr because "the host vanished" is worth knowing when somebody
   * asks why an embassy exited without saying.
   */
  output.on("error", (error: Error) => {
    process.stderr.write(`neurofebric-embassy: the output channel failed: ${error.message}\n`);
  });
  // The same for the read side. A host killed mid-frame must not surface as an
  // unhandled 'error' on stdin either -- the truncation path below already handles
  // a normal end, and this covers the abnormal one.
  input.on("error", () => {
    process.stderr.write("neurofebric-embassy: the input channel failed\n");
  });

  const deps: DispatcherDeps = { config, write: (line) => void output.write(line), fetchImpl };
  const session: SessionState = { credential: config.credential, established: false };

  /**
   * OBLIGATION 3, AND WHY IT NEEDS A TAP.
   *
   * readline STRIPS the terminator before yielding, so by the time a line arrives
   * there is no way to tell a complete line from a truncated one. The only place
   * that knowledge still exists is the raw byte stream, so the input is tapped
   * before readline sees it and the final byte is recorded there.
   *
   * This matters because readline ALWAYS emits the last partial line, even on a
   * clean end. Without the tap, a host that closed the pipe mid-frame would get a
   * -32700 parse error for a frame it never finished writing -- an error reported
   * to a party that has already gone away, about a message that does not exist.
   */
  let endedOnNewline = true;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (chunk.length > 0) endedOnNewline = chunk[chunk.length - 1] === 0x0a;
      done(null, chunk);
    },
  });
  input.pipe(tap);

  // `crlfDelay: Infinity` matches the repository's existing JSON-lines readers
  // (jsonl-tokenizer.ts:133, log-tokenizer.ts:240). With the default delay,
  // readline emits a line for a bare CR, so a stream using CRLF would split every
  // frame in half and every dispatch would be a parse error.
  const reader = createInterface({ input: tap, crlfDelay: Infinity });

  const emit = async (line: string): Promise<void> => {
    for (const frame of await dispatch(line, session, deps)) {
      deps.write(frame);
    }
  };

  /**
   * ONE LINE IS HELD BACK, because the last line is the one that cannot be trusted.
   *
   * A line is known-complete only when something FOLLOWS it -- that is what proves
   * a terminator arrived. So each complete line is dispatched as the next one
   * arrives, and the final line waits until the tap has said whether the stream
   * ended on a newline. Dispatching it eagerly and reporting truncation afterwards
   * would answer a frame the host never finished writing, which is precisely the
   * defect obligation 3 exists to prevent.
   */
  let held: string | null = null;
  for await (const line of reader) {
    if (held !== null && held.trim() !== "") await emit(held);
    held = line;
  }

  if (held === null) return;
  if (!endedOnNewline) {
    // Discarded, and named on stderr. stdout is the protocol channel and the host
    // has already closed its end, so a frame here would be a message to nobody.
    process.stderr.write("neurofebric-embassy: the final frame was truncated and was discarded\n");
    return;
  }
  if (held.trim() !== "") await emit(held);
}

/** The process entry point. Used by the launcher, not by the tests. */
export async function main(env: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  const config = readConfig(env);
  if (config === undefined) {
    // stderr, because stdout is the protocol channel and writing a diagnostic into
    // it would be parsed by the host as a frame.
    process.stderr.write(
      "neurofebric-embassy: NEUROFEBRIC_EMBASSY_TOKEN and NEUROFEBRIC_CORE_ORIGIN must both be set\n",
    );
    process.exitCode = 2;
    return;
  }
  await serve(process.stdin, process.stdout, config);
}
