/**
 * THE THREE TOOLS. ADR-006 section 4.
 *
 * === WHY EACH TOOL IS A TRANSPARENT PROXY AND NOT A NEW CAPABILITY ===
 *
 * Each maps one-to-one onto a route the portal already serves and has already
 * had its tenant boundary reviewed for. A tool that assembled its own answer from
 * the kernel's parts would be a second code path to the same capability, and a
 * second path is a second thing to get wrong -- which is the argument the One-Door
 * work made once already, about three routers each writing the same four lines.
 *
 * So these handlers hold no state, cache nothing, and decide nothing. They check
 * the argument shape, hand it to the core, and report what came back.
 *
 * === NO TOOL ACCEPTS A TENANT, A TOKEN, OR A CREDENTIAL ===
 *
 * `additionalProperties: false` on every schema is what enforces this at the
 * edge rather than by review, and it is the reason the property is set on all
 * three rather than being left to good intentions. A caller that tries to smuggle
 * `"tenant": "someone-else"` gets -32602 and the argument never reaches the core.
 * A negative test pins that, because a schema that merely documented the rule
 * would be a comment.
 */

import { CORE_PATHS, callCore, type CoreEndpoint, type CoreFetch } from "./core.ts";
import { RPC } from "./jsonrpc.ts";

/** What a handler returns to the dispatcher. Never throws. */
export interface ToolOutcome {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly code?: number;
  readonly message?: string;
  readonly data?: unknown;
}

/** The published tool list. This array IS the capability surface. */
export const TOOLS = [
  {
    name: "get_verdict",
    description:
      "Current measured anomaly verdict for this session's tenant. Read-only, aggregated, never per-event.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "install_schema",
    description: "Register or replace an agent schema. Reports whether a previous version was replaced.",
    inputSchema: {
      type: "object",
      required: ["schema"],
      properties: {
        schema: {
          type: "object",
          description: "An agent schema. Validated by the core's own validator.",
          required: ["id", "title", "streams", "rules"],
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ingest_events",
    description: "Submit events for this session's tenant. Accepted and refused counts are reported separately.",
    inputSchema: {
      type: "object",
      required: ["events"],
      properties: {
        events: {
          type: "array",
          description: "Events to admit. Each is validated before admission.",
          minItems: 1,
          // MAX_INGEST_EVENTS, which the core already enforces at
          // portal-routes.ts:466. Stated here so an oversized call is refused
          // before it crosses the wire rather than after.
          maxItems: 1000,
          items: { type: "object" },
        },
      },
      additionalProperties: false,
    },
  },
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

/** The published tool list, in the order a client discovers it. */
const PUBLISHED_NAMES: ReadonlySet<string> = new Set<string>(TOOLS.map((tool) => tool.name));

/**
 * True when `name` is one of the published tools.
 *
 * DERIVED FROM `TOOLS`, and that is the whole point of writing it this way.
 * It used to be a hand-written `name === "a" || name === "b" || ...`, which meant
 * the published surface was declared TWICE: once as the list a client discovers,
 * and once as the set the dispatcher will accept. The two agreed, and agreement
 * was a coincidence with an expiry date rather than a property -- a fourth tool
 * added to the list and not to this function would be advertised to every
 * connecting client and then refused at the call, which is a capability that looks
 * real and is not.
 *
 * One authority, so the list cannot drift from the dispatcher. The cost is a Set
 * built once at module load, which is smaller than the bug it removes.
 */
export function isTool(name: string): name is ToolName {
  return PUBLISHED_NAMES.has(name);
}

/**
 * REJECT AN UNKNOWN KEY, AND SAY WHICH ONE.
 *
 * The generic "the arguments did not match the schema" is what `additionalProperties:
 * false` means to a peer. Naming the offending key costs nothing, is not caller data
 * we should withhold -- the caller supplied it -- and turns a confusing refusal into
 * an obvious one.
 */
function rejectUnknown(args: Readonly<Record<string, unknown>>, allowed: readonly string[]): ToolOutcome | null {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      return { ok: false, code: RPC.INVALID_PARAMS, message: `the arguments do not match the schema`, data: { unknown: key } };
    }
  }
  return null;
}

function invalid(message: string, data?: unknown): ToolOutcome {
  return { ok: false, code: RPC.INVALID_PARAMS, message, ...(data === undefined ? {} : { data }) };
}

/**
 * Translate a core answer into a tool outcome.
 *
 * A core refusal is NOT an embassy refusal, and the difference is preserved: the
 * core's own status and body travel back, so the agent sees the validator's issue
 * paths or the edge's reason rather than a generic embassy error. Swallowing those
 * would make every core problem look like an embassy problem.
 */
function fromCore(status: number, body: unknown): ToolOutcome {
  if (status >= 200 && status < 300) return { ok: true, result: body };
  if (status === 401 || status === 403) {
    return { ok: false, code: RPC.TENANT_REFUSED, message: "the core refused this session's credential", data: body };
  }
  if (status === 400) {
    // A schema refusal carries the validator's issue paths, which the author is
    // the only party who can act on. ADR-006 section 9 sends them.
    return { ok: false, code: RPC.SCHEMA_REFUSED, message: "the core refused the payload", data: body };
  }
  if (status === 404) {
    return { ok: false, code: RPC.PROVIDER_NOT_CONNECTED, message: "the core has no such resource", data: body };
  }
  if (status === 413 || status === 429) {
    return { ok: false, code: RPC.LIMIT_EXCEEDED, message: "the request exceeds a limit the core enforces", data: body };
  }
  return { ok: false, code: RPC.INTERNAL_ERROR, message: `the core answered ${status}`, data: body };
}

/** Everything a handler needs, and nothing it could keep between calls. */
export interface HandlerContext {
  readonly endpoint: CoreEndpoint;
  /** The session's credential. Never accepted from a tool argument. */
  readonly credential: string;
  readonly fetchImpl?: CoreFetch | undefined;
}

/**
 * `get_verdict` -- a READ, forwarded to the core's live route.
 *
 * Takes no arguments at all, which is the strongest statement of "this cannot
 * choose a tenant" available: there is no parameter to smuggle one through.
 *
 * The core derives the tenant from the credential it proves, so the response is
 * whatever that tenant's live window holds at the instant of the call. There is no
 * cache here, and the absence of one is load-bearing -- see `core.ts`.
 */
export async function getVerdict(ctx: HandlerContext, args: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  const unknown = rejectUnknown(args, []);
  if (unknown !== null) return unknown;

  const outcome = await callCore(ctx.endpoint, ctx.credential, CORE_PATHS.live, "GET", undefined, ctx.fetchImpl);
  if (!outcome.ok) return { ok: false, code: RPC.INTERNAL_ERROR, message: outcome.message };

  const mapped = fromCore(outcome.status, outcome.body);
  if (!mapped.ok) return mapped;

  /**
   * THE TWO-TRUTHS GUARD, AT THE TRUST BOUNDARY.
   *
   * A tool named `get_verdict` must never answer with a recorded value. ADR-005
   * section 9 says the two truths never appear in one surface, and an MCP response
   * IS a surface -- a more dangerous one than the dashboard, because its reader is
   * a language model that will reconcile a mixed answer into a confident sentence
   * rather than noticing the mismatch.
   *
   * === THE LABEL IS OURS, AND WHY THAT IS HONEST ===
   *
   * ADR-006 section 4.2 specified a `source: "live"` field in this response. **The
   * core does not emit one** -- `LiveSnapshot` (portal-routes.ts:441) is
   * `{at, provider, enabled, verdict, throughput}`, and requiring a field that does
   * not exist would have refused every real call while looking correct in a test
   * written against the ADR rather than against the core. That is caught here by
   * reading the interface instead of the document.
   *
   * So the embassy supplies the label, and it can, because the provenance is not a
   * claim about the RESPONSE -- it is a fact about the REQUEST. This handler called
   * the live route and nothing else. "Everything in this answer came from the
   * running window" is a statement about the line above it, and it is true for the
   * same reason `get_verdict` cannot return a record: there is no other route in
   * this file it could have called.
   *
   * === THE DEFENSIVE CHECK IS KEPT ANYWAY ===
   *
   * If the core ever adds its own discriminator, and it says something other than
   * "live", that is a disagreement between two authorities about what a verdict is,
   * and the embassy must not paper over it by overwriting the field. It refuses.
   * The cost of that is one extra comparison; the cost of not having it is a future
   * core change silently re-introducing a recorded value under a live label.
   */
  const body = mapped.result as Record<string, unknown> | null;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, code: RPC.INTERNAL_ERROR, message: "the core did not return a verdict snapshot" };
  }
  const declared = body["source"];
  if (declared !== undefined && declared !== "live") {
    return {
      ok: false,
      code: RPC.INTERNAL_ERROR,
      message: "the core labelled this snapshot as something other than a live reading, so it is not forwarded",
    };
  }

  return {
    ok: true,
    result: { source: "live", at: body["at"], provider: body["provider"], verdict: body["verdict"] ?? null, throughput: body["throughput"] ?? null },
  };
}

/**
 * `install_schema` -- a WRITE, forwarded to the core's schema route.
 *
 * The schema is passed through UNVALIDATED on purpose. The core owns
 * `validateSchema` and this project does not grow a second validator that could
 * disagree with it about what is acceptable; a second validator is a second
 * answer to "is this schema valid" and only one of them would be right after the
 * first change to the rules.
 */
export async function installSchema(ctx: HandlerContext, args: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  const unknown = rejectUnknown(args, ["schema"]);
  if (unknown !== null) return unknown;

  const schema = args["schema"];
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return invalid("the schema argument must be an object");
  }

  const outcome = await callCore(ctx.endpoint, ctx.credential, CORE_PATHS.schema, "POST", { schema }, ctx.fetchImpl);
  if (!outcome.ok) return { ok: false, code: RPC.INTERNAL_ERROR, message: outcome.message };
  return fromCore(outcome.status, outcome.body);
}

/**
 * `ingest_events` -- a WRITE, forwarded to the core's ingest route.
 *
 * Two checks live here and both are about not wasting a round trip: the array must
 * be present, and it must be within the bounds the core would enforce anyway.
 * The core remains the authority -- these are early refusals so an obviously
 * oversized call is refused without being sent, not a parallel rule set.
 *
 * Note what is NOT here: a `provider` parameter. The core resolves the provider
 * from the credential it proved. A caller that could name its provider could push
 * into another provider's window, which is the same class of mistake as being able
 * to name a tenant.
 */
export async function ingestEvents(ctx: HandlerContext, args: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  const unknown = rejectUnknown(args, ["events"]);
  if (unknown !== null) return unknown;

  const events = args["events"];
  if (!Array.isArray(events)) return invalid("the events argument must be an array");
  if (events.length < 1) return invalid("the events array is empty, so the call carries nothing");
  if (events.length > 1000) return { ok: false, code: RPC.LIMIT_EXCEEDED, message: "more than 1000 events in one call" };

  const outcome = await callCore(ctx.endpoint, ctx.credential, CORE_PATHS.ingest, "POST", { events }, ctx.fetchImpl);
  if (!outcome.ok) return { ok: false, code: RPC.INTERNAL_ERROR, message: outcome.message };

  const mapped = fromCore(outcome.status, outcome.body);
  if (!mapped.ok) return mapped;

  /**
   * A PARTIAL ACCEPT IS REPORTED AS A PARTIAL ACCEPT.
   *
   * `accepted: 900, refused: 100` is a true and useful answer and it is forwarded
   * whole. Collapsing it to "ok" would make the refusal invisible to the only party
   * that could act on it -- which is this project's standing rule that a partial
   * answer that does not announce itself is worse than a refusal.
   */
  return mapped;
}

/** Dispatch one tool call. Returns rather than throws, for obligation 4. */
export async function callTool(name: string, ctx: HandlerContext, args: Readonly<Record<string, unknown>>): Promise<ToolOutcome> {
  if (!isTool(name)) {
    // The published list is not echoed back. Naming what exists to an agent that
    // asked for something else is reconnaissance, and the portal edge makes the
    // same choice at its 404 for the same reason.
    return { ok: false, code: RPC.METHOD_NOT_FOUND, message: "no such tool" };
  }
  const safe = ctx.fetchImpl === undefined ? { ...ctx, fetchImpl: undefined } : ctx;
  try {
    /**
     * EXHAUSTIVE DISPATCH, WITH NO DEFAULT ARM.
     *
     * This used to end in `return await ingestEvents(safe, args)`, treating
     * "everything else" as `ingest_events`. That was harmless while `isTool` was a
     * hand-written triple, because nothing else could get past it -- and it became
     * actively wrong the moment `isTool` was derived from `TOOLS`, which is what
     * removed the second declaration and made it possible for a tool to be
     * published without a handler here.
     *
     * Then the failure mode inverts. A tool added to the list and not to this
     * function is ADVERTISED to every connecting client, and calling it silently
     * runs `ingest_events` against the caller's arguments. An agent asking to
     * install a schema would get an ingest refusal, or worse, a partial accept.
     *
     * So the fallthrough is gone and the last arm refuses. A tool with no handler
     * is a refusal that says so, not a call to somebody else's function.
     */
    if (name === "get_verdict") return await getVerdict(safe, args);
    if (name === "install_schema") return await installSchema(safe, args);
    if (name === "ingest_events") return await ingestEvents(safe, args);
    return { ok: false, code: RPC.INTERNAL_ERROR, message: "this tool is published but has no handler" };
  } catch {
    // The belt to `core.ts`'s braces. A handler that threw would end the
    // dispatcher, and the dispatcher ending is the host agent's session ending.
    return { ok: false, code: RPC.INTERNAL_ERROR, message: "the tool did not complete" };
  }
}
