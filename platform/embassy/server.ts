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
import { TOOLS, PROXIED_TOOLS, READ_CREDENTIAL_TOOL, callTool, readCredentialArgs, type HandlerContext } from "./tools.ts";
import { approvalRefusal, createApprovalGate, type ApprovalGate } from "./elicitation.ts";
import { createApprovedCredentialReader } from "../vault/reader.ts";
import { createTenantSecretStore } from "../vault/store.ts";
import { createFileSecretSource } from "../vault/file-source.ts";
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
  /**
   * Names for the prompt: which tenant, and which capability is being exercised.
   *
   * IDENTITY for a human deciding, never authority. The tenant here is for the
   * label on the approval; the credential still decides who the data belongs to,
   * and the store still derives that from what it proves.
   */
  readonly tenant?: string;
  readonly capability?: string;
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

/**
 * HOW THE GATEWAY REACHES A CREDENTIAL ONCE, AND ONLY ONCE, SOMEONE APPROVED.
 *
 * A PORT, not the vault. This module must not be able to name the vault's store
 * module by path, for two reasons that point the same way: the embassy would
 * acquire a dependency on a store whose authority is still deliberately scoped, and
 * a future change could reach for the store from anywhere in the dispatcher instead
 * of from the one branch that earned it.
 *
 * There is a test that scans this directory's import graph for that path, and it is
 * not decorative -- it caught this very comment the first time it was written.
 *
 * It arrives as a FACTORY for the sharper reason. A function that returns a reader
 * cannot be called at startup, at configuration time, or in any handler that is not
 * an approved read -- so "the store is reachable only through an approval" becomes
 * a fact about construction that a test can COUNT, rather than a promise about
 * discipline.
 *
 * Whoever implements this owns the capability construction, which ADR-008 §4.1
 * flagged as the seam the store deliberately does not hold.
 */
export interface ApprovedCredentialReader {
  read(subject: {
    tenant: string;
    credentialName: string;
    exposure?: "metadata" | "reference" | "raw";
    acknowledged?: boolean;
  }): Promise<{ ok: true; reference: string; exposed: boolean; metadata?: { present: boolean; rotatedAt: string } } | { ok: false }>;
}

/** What the dispatcher is given, so tests can drive it without a pipe. */
export interface DispatcherDeps {
  readonly config: EmbassyConfig;
  /** The only legal way to reach stdout. */
  readonly write: (line: string) => void;
  /** Injected so a test can prove the core was never contacted before `initialize`. */
  readonly fetchImpl?: ((...args: never[]) => Promise<unknown>) | undefined;
  /** The precheck. Absent means no credential tool can be served at all. */
  readonly gate?: ApprovalGate | undefined;
  /** Consulted ONLY inside an approved read. Never at startup. */
  readonly credentialReader?: (() => ApprovedCredentialReader) | undefined;
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
  /**
   * The tenant this session's credential resolves to, for naming in a prompt.
   *
   * Taken from the credential's own id rather than from anything the caller sends.
   * It is used ONLY to label an operator's decision, never to select data -- the
   * store derives the tenant from the credential it proves, in its own process, and
   * a session that could choose its tenant would be a second authority for the one
   * question the core answers.
   */
  readonly tenant: string;
  /** The capability's identifier, shown to the operator so they know what is exercised. */
  readonly capability: string;
  established: boolean;
  /**
   * Whether the client DECLARED it can ask an operator, from
   * `initialize.params.capabilities.elicitation`.
   *
   * Recorded rather than assumed. The specification says a server must not send an
   * elicitation in a mode the client did not declare, and asking anyway would park
   * the call until it timed out -- a refusal that also spends an operator's time
   * for a decision nobody can give.
   */
  elicitation: boolean;
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

  if (frame.kind === "response") {
    return resolveResponse(frame.id, frame.result, frame.error !== undefined, session, deps);
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

/**
 * AN ANSWER, MATCHED AGAINST A PENDING ROW.
 *
 * The counterpart of the branch in `dispatch`. An answer to an id nothing is
 * waiting on resolves nothing and produces NO REPLY -- a JSON-RPC response is not a
 * request and gets none, the same rule that governs notifications. That is also the
 * safe reading: a peer answering an id we are not waiting on is confused or
 * probing, and the two interesting behaviours -- accepting it, or reporting it --
 * both hand back information about what this gateway is doing.
 *
 * On a REFUSAL the answer goes to the ORIGINAL tool call's id, not to the
 * elicitation's. The caller is waiting on id 2; id 1 was ours, and answering it
 * would be the gateway talking to itself in front of the client.
 */
async function resolveResponse(
  id: RpcId,
  result: unknown,
  isError: boolean,
  session: SessionState,
  deps: DispatcherDeps,
): Promise<readonly string[]> {
  const gate = deps.gate;
  if (gate === undefined) return [];

  const settled = gate.offer({
    kind: "response",
    id,
    result,
    ...(isError ? { error: { code: -32603, message: "the peer declined to answer" } } : {}),
  });
  if (settled === undefined) return [];

  const callId = settled.pending.toolCallId;
  if (!settled.decision.approved) {
    // HARD BLOCK. The refusal is a protocol error on the caller's own id, and the
    // reader is not consulted -- not "consulted and then refused", which would
    // still have constructed it.
    return [approvalRefusal(callId)];
  }

  const factory = deps.credentialReader;
  if (factory === undefined) return [approvalRefusal(callId)];

  /**
   * THE ONE PLACE THE READER EXISTS.
   *
   * Everything above is refusal-shaped and every one of those paths returns without
   * reaching here. Constructing the reader is therefore the proof that an approval
   * happened -- which is why the tripwire tests count factory invocations rather
   * than checking that a value came back.
   */
  const reader = factory();
  const outcome = await reader.read({
    tenant: settled.pending.subject.tenant,
    credentialName: settled.pending.subject.credentialName,
    exposure: settled.pending.subject.exposure,
    // The gate has ALREADY required the operator's separate acknowledgement for a
    // raw read -- it would never have approved without it. Carrying the fact across
    // means the reader does not have to trust this dispatcher to have checked, and
    // a second caller wiring the port cannot skip the rule by omitting a field.
    acknowledged: settled.pending.subject.exposure === "raw",
  });
  if (!outcome.ok) return [approvalRefusal(callId)];

  return [
    serialise(
      success(callId, {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              credentialName: settled.pending.subject.credentialName,
              exposure: settled.pending.subject.exposure,
              // The only result field, and it holds the value ONLY on an approved raw
              // read. The model is told plainly which it got rather than being left to
              // infer it from a field that is sometimes a label.
              result: outcome.reference,
              // Present only for a metadata read, and the whole reason that mode
              // exists: an agent triaging at 2am can learn WHEN a credential was last
              // rotated and never cause one to be loaded.
              ...(outcome.metadata === undefined
                ? {}
                : { exists: outcome.metadata.present, rotatedAt: outcome.metadata.rotatedAt }),
            }),
          },
        ],
        isError: false,
      }),
    ),
  ];
}

/**
 * THE PRECHECK, AND WHERE IT SITS.
 *
 * Inside the `tools/call` handler rather than around it, so the ordering is
 * structural: a credential call is intercepted before it can reach a core route at
 * all, and the other three tools are untouched by any of this.
 *
 * Three refusals happen before an operator is ever interrupted, in this order:
 * a malformed call, a client that cannot ask, and a gateway with no precheck
 * configured. Interrupting a person to tell them their request was malformed would
 * spend their attention on nothing.
 */
async function handleCredentialCall(
  id: RpcId,
  args: Readonly<Record<string, unknown>>,
  session: SessionState,
  deps: DispatcherDeps,
): Promise<string> {
  const malformed = readCredentialArgs(args);
  if (malformed !== null) {
    return serialise(success(id, { content: [{ type: "text", text: JSON.stringify(malformed.data ?? { message: malformed.message }) }], isError: true }));
  }

  if (!session.elicitation || deps.gate === undefined) {
    return serialise(failure(id, RPC.METHOD_NOT_FOUND, "this tool needs an approval path this session cannot use"));
  }

  const credentialName = String(args["credentialName"]).trim();
  // Defaulted HERE rather than trusted from the argument, so an absent or misspelled
  // field lands on the safe answer. `readCredentialArgs` has already rejected
  // anything outside the published enum.
  const mode = args["exposure"];
  const exposure = mode === "raw" || mode === "metadata" ? mode : "reference";
  const raw = exposure === "raw";

  const { frame } = deps.gate.begin(
    {
      tool: READ_CREDENTIAL_TOOL,
      tenant: session.tenant,
      capability: session.capability,
      credentialName,
      exposure,
      sideEffects: raw
        ? [
            "a LIVE credential in PLAINTEXT is placed into the model's context window",
            "the decision is recorded permanently against your name",
          ]
        : exposure === "metadata"
          ? ["the credential is never loaded; only its existence and last rotation are answered", "the decision is recorded permanently against your name"]
          : ["a non-reversible reference is returned, and the credential is loaded here to compute it", "the decision is recorded permanently against your name"],
    },
    id,
  );

  // Only the request. The call is answered by a LATER line, which is what makes
  // this non-blocking: there is no suspended call, only a row the gate holds.
  return frame;
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
    // session carries a credential. `params` is not read for a credential: it came
    // from the environment at start-up, not from a frame, so there is nothing here
    // that a caller could have put in it.
    //
    // The ONE thing read is the client's declared capabilities, because the
    // precheck may only send an elicitation the client said it can handle.
    const capabilities = args["capabilities"];
    const declared =
      capabilities !== null && typeof capabilities === "object" && !Array.isArray(capabilities)
        ? (capabilities as Record<string, unknown>)["elicitation"]
        : undefined;
    session.established = true;
    session.elicitation = declared !== null && typeof declared === "object" && !Array.isArray(declared);
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

    // THE INTERCEPT, BEFORE ANY DISPATCH. The published surface includes this tool
    // so a client can discover it, and `callTool` refuses it so nothing can reach a
    // handler by accident -- this branch is the only way in.
    if (name === READ_CREDENTIAL_TOOL) {
      const credentialArgs =
        callArgs === undefined || callArgs === null || typeof callArgs !== "object" || Array.isArray(callArgs)
          ? {}
          : (callArgs as Readonly<Record<string, unknown>>);
      return await handleCredentialCall(id, credentialArgs, session, deps);
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
  /**
   * The precheck and the credential reader.
   *
   * A fifth parameter rather than two more positional ones, and both are OPTIONAL:
   * a gateway with neither serves the three core tools exactly as before, and the
   * credential tool refuses itself rather than pretending. Absence is the default
   * because a process that cannot ask an operator must not be one step away from
   * being able to.
   */
  precheck?: { gate?: ApprovalGate | undefined; credentialReader?: (() => ApprovedCredentialReader) | undefined },
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

  const deps: DispatcherDeps = {
    config,
    write: (line) => void output.write(line),
    fetchImpl,
    gate: precheck?.gate,
    credentialReader: precheck?.credentialReader,
  };
  const session: SessionState = {
    credential: config.credential,
    tenant: config.tenant ?? "unknown",
    capability: config.capability ?? config.tenant ?? "unknown",
    established: false,
    elicitation: false,
  };

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

  /**
   * THE PRECHECK AND THE READER, BUILT HERE AND ONLY HERE.
   *
   * This is the composition root, so this is the one place in the embassy that knows
   * both halves exist. Everything below receives a port: the dispatcher receives a
   * gate and a reader FACTORY, and neither it nor anything it imports can name the
   * vault's modules -- a boundary the import-graph test enforces rather than a
   * convention.
   *
   * All of it is optional, and that is the safe default. With none of it configured
   * the three core tools work exactly as before and the credential tool refuses
   * itself, so an operator who has not finished the setup gets a closed door rather
   * than a half-open one.
   */
  const precheck = buildPrecheck(env);
  await serve(process.stdin, process.stdout, config, undefined, precheck);
}

/**
 * BUILD THE APPROVAL PATH FROM THE ENVIRONMENT, OR RETURN NONE.
 *
 * Four variables, all optional together: a half-configured vault is refused rather
 * than half-armed, because a gate with no reader would ask an operator to approve
 * reads that can only ever be refused -- which trains people to approve without
 * reading.
 *
 * ADR-010 section 5 listed "where does the signing key come from" as open. This is
 * an answer, and it is deliberately the weakest one that works: a hex key in the
 * environment. It is kept beside the credential it authorises and inherits the
 * environment's protections -- which for most deployments is to say it inherits
 * very little. Rotation, and a source that is not a file, remain open and are named
 * as such in ADR-010 rather than left to be discovered during an incident.
 */
function buildPrecheck(env: Readonly<Record<string, string | undefined>>): {
  gate: ApprovalGate;
  credentialReader: () => ApprovedCredentialReader;
} | undefined {
  const capability = env["NEUROFEBRIC_CAPABILITY"];
  const keyHex = env["NEUROFEBRIC_VAULT_KEY"];
  const vaultFile = env["NEUROFEBRIC_VAULT_FILE"];
  if (capability === undefined || keyHex === undefined || vaultFile === undefined) return undefined;

  let verificationKey: Buffer;
  try {
    verificationKey = Buffer.from(keyHex, "hex");
  } catch {
    process.stderr.write("neurofebric-embassy: NEUROFEBRIC_VAULT_KEY is not valid hex\n");
    process.exitCode = 2;
    throw new Error("the vault key is not valid hex");
  }

  const store = createTenantSecretStore({
    source: createFileSecretSource(vaultFile),
    // The store's own trail goes to stderr. stdout is the protocol channel and a
    // credential event on it would be parsed by the host as a frame.
    audit: (event) => process.stderr.write(`neurofebric-embassy: vault ${event.outcome} ${event.tenant} ${event.name}\n`),
  });

  const gate = createApprovalGate({
    // No trail sink is passed, so the gate treats the audit as optional -- which
    // means an approval here is NOT durably recorded. That is a real gap and it is
    // called out rather than papered over: this adapter is for deployments that have
    // not yet wired the durable log ADR-009 describes. See ADR-010 section 5.
    audit: (event) =>
      process.stderr.write(
        `neurofebric-embassy: approval ${event.outcome} ${event.tenant} ${event.credentialName}` +
          `${event.approvedBy === undefined ? "" : ` by ${event.approvedBy}`}\n`,
      ),
  });

  const reader = createApprovedCredentialReader({ store, capability, verificationKey });

  return { gate, credentialReader: () => reader };
}
