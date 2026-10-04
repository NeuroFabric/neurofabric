import {
  httpResponse,
  loadTokens,
  proveTenant,
  type EdgeDecision,
  type VaultProvider,
} from "../omniroute/edge-security.ts";
import type { ServerResponse } from "node:http";
import { differenceKey, reconcile, summarise, type LiveState } from "./reconcile.ts";
import { TARGET_VERSION, type MemoryStore } from "./store.ts";
import {
  AlertHub,
  MAX_CONSUMER_BACKLOG_BYTES,
  SSE_HEADERS,
  bytesOf,
  frame,
  keepAliveFrame,
} from "./alert-hub.ts";
import type { UiResponse } from "../api/ui-routes.ts";

/**
 * THE DIFF, OVER HTTP. Two routes, both about the same question: what does the
 * record say that the running system would not say on its own, and what has the
 * operator done about it.
 *
 * === WHY THIS IS NOT PART OF `portal-routes.ts` ===
 *
 * Because it answers a different question and has a different blast radius. A
 * portal route is the customer's configuration. This route reads the durable
 * record and reports where the record and the running system disagree -- which is
 * the one surface in this platform whose failure is invisible until somebody
 * looks. Folding it into the portal would mean a future change to portal config
 * could change what the reconciliation says, and the reconciliation is the thing
 * an operator trusts when everything else is uncertain.
 *
 * === THE TENANT IS STILL THE PROVEN CREDENTIAL ===
 *
 * The same `guard`, the same vault, the same `x-gateway-token`. Nothing here
 * accepts a tenant in a path, a query string or a body, and the record is
 * namespaced by `tokenId` because ADR-005 §10.1 made that the identity: rotating
 * a credential's VALUE changes nothing, so this surface survives a rotation
 * without an operator act. A second authentication path would have been a second
 * thing to get wrong on the most sensitive surface in the product.
 *
 * === WHAT THESE ROUTES DO NOT DO ===
 *
 * They do not repair, migrate, retire or resolve. There is no verb here that
 * changes a schema, and there is no verb here that clears a difference. A
 * reconciliation that could make itself finish is a reconciliation choosing, and
 * the operator is the only party entitled to that call (ADR-005 §7.3, §10.3).
 *
 * `POST /api/memory/ack` records that a person LOOKED. That is a smaller claim
 * than "handled", and it is written to the append-only audit trail in the same
 * transaction as the acknowledgement itself.
 */

export const MEMORY_DIFF_PATH = "/api/memory/diff";
export const MEMORY_ACK_PATH = "/api/memory/ack";
/** The live alert stream. One direction, one credential, one tenant. */
export const MEMORY_ALERTS_PATH = "/api/memory/alerts";

/** The provider name these routes guard under. Matches the portal's own space. */
export const MEMORY_PROVIDER = "memory";

/**
 * WHAT THE ROUTE CAN SEE OF THE RUNNING SYSTEM.
 *
 * A port rather than the gateway itself, for the same reason `portal-routes.ts`
 * takes a gateway rather than importing one: the decisions worth testing are
 * "is this caller allowed", "which tenant is this", and "what does the diff say",
 * and none of those need a socket.
 *
 * `latest` is the newest live reading per agent, keyed by composite id, or
 * ABSENT when nothing has arrived for it. Absent is load-bearing: it is what
 * produces difference 2 ("no live window yet"), and substituting "now" for it
 * would make that difference impossible to ever see.
 */
export interface MemoryLive {
  readonly providers: readonly string[];
  /**
   * The newest live reading per composite agent id, or ABSENT for an agent that
   * has produced nothing.
   *
   * A FUNCTION, not a value, and that is the load-bearing part: the diff is
   * recomputed on every read because half of what it compares is a moving
   * window, and a snapshot taken when the server started would report "nothing
   * observed yet" for an agent that has been streaming for an hour. A caller
   * holding the map as a value would silently reintroduce that lie.
   *
   * ABSENCE is load-bearing too: it is what produces difference 2 ("no live
   * window yet"), and substituting "now" for a missing reading would make that
   * difference impossible to ever see.
   */
  readonly latest: () => Readonly<Record<string, number>>;
  /** The code's expected record version. The record is compared against this. */
  readonly expectedVersion?: number;
  /** The CURRENT validator, so a tightened grammar is a difference and not corruption. */
  readonly accepts?: (document: unknown) => boolean;
}

export interface MemoryRoutesOptions {
  readonly store: MemoryStore;
  readonly live: MemoryLive;
  readonly vault: VaultProvider;
  /** Fail closed when the vault reports a rejected entry. Default true. */
  readonly strictVault?: boolean;
  /** Who the operator is in the audit trail. The credential's id, not a name. */
  readonly actorOf?: (tenant: string) => string;
  /**
   * HOW OFTEN A STREAM SAYS "STILL HERE".
   *
   * An option so a test can make it long rather than being a constant a test has
   * to wait out. Not a detail: this is what stops an idle connection being closed
   * by something in the middle, which an operator would experience as a feed that
   * is merely quiet -- the exact blur ADR-005 §6 forbids.
   */
  readonly keepAliveMs?: number;
}

/** 15s. Long enough to be free, short enough to notice a dead middlebox. */
const DEFAULT_KEEP_ALIVE_MS = 15_000;
function json(status: number, body: unknown): UiResponse {
  return { status, body, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } };
}

function refused(decision: EdgeDecision): UiResponse {
  const rendered = httpResponse(decision);
  return { status: rendered.status, body: rendered.body, headers: rendered.headers };
}

export interface MemoryRouter {
  handle: (
    method: string,
    path: string,
    headers?: Readonly<Record<string, string | undefined>>,
    body?: unknown,
  ) => Promise<UiResponse>;
  /**
   * OPEN AN EVENT STREAM.
   *
   * Separate from `handle` because it does not return a response body -- it
   * TAKES OVER the socket and keeps writing to it. Folding that into `handle`
   * would mean a `UiResponse` that is never sent and a `Promise` that never
   * settles, and the caller would have to know which of the two it got.
   *
   * Returns true when the stream was opened, false when it was refused. A refusal
   * has already been written, so the caller must not write anything else.
   *
   * `request` is optional and carries only `on`. A stream the client has abandoned
   * is still subscribed until the socket times out, so the caller passes the
   * request to let the stream hear the client leaving. It is typed as a shape with
   * one optional method rather than as `IncomingMessage` so this file keeps no
   * dependency on the transport it happens to be mounted in.
   */
  openStream: (
    method: string,
    path: string,
    headers: Readonly<Record<string, string | undefined>>,
    response: ServerResponse,
    request?: { on?: (event: string, fn: () => void) => void },
  ) => Promise<boolean>;
  /**
   * THE HUB, so the decision path can publish into it.
   *
   * Exposed rather than wrapped because publishing is the decision path's job and
   * wrapping it in a method would only move the ordering guarantee somewhere it
   * could not be asserted -- `publish` is called strictly AFTER `recordDecision`,
   * and that is the whole of ADR-005 §5 rule 3.
   */
  readonly hub: AlertHub;
}

export function createMemoryRoutes(options: MemoryRoutesOptions): MemoryRouter {
  const { store, live } = options;
  const hub = new AlertHub({
    onSlowConsumer: (tenant) => {
      // Named on the console rather than swallowed: a consumer being dropped is a
      // fact an operator needs, because the next question they will ask is "why
      // did the stream stop".
      console.warn(`  a live alert subscriber for "${tenant}" fell behind and was disconnected.`);
    },
  });

  /**
   * THE GUARD, AND THE PROVEN TENANT -- THROUGH THE ONE DOOR.
   *
   * This was a local `prove()` written while the stream was being built, before
   * `proveTenant()` existed. It is now a two-line call rather than a second
   * implementation of the same question, which is the whole point of the
   * refactor: three routers asking "who are you and whose records are yours" in
   * three slightly different ways is three chances to drift.
   */
  const prove = async (headers: Readonly<Record<string, string | undefined>>): Promise<{ ok: true; tenant: string } | { ok: false; response: UiResponse }> => {
    const proven = await proveTenant(options.vault, MEMORY_PROVIDER, headers, {
      ...(options.strictVault === false ? {} : { strict: true }),
    });
    if (!proven.ok) return { ok: false, response: refused(proven.decision) };
    return { ok: true, tenant: proven.tokenId };
  };

  async function handle(
    method: string,
    path: string,
    headers: Readonly<Record<string, string | undefined>> = {},
    body?: unknown,
  ): Promise<UiResponse> {
    const clean = path.split("?")[0] ?? path;
    const verb = method.toUpperCase();

    const isAck = verb === "POST" && clean === MEMORY_ACK_PATH;
    const known = clean === MEMORY_DIFF_PATH || isAck;
    if (!known) {
      // 404 before proof, and the surface is not named in the refusal: naming
      // the routes hands a stranger the map, which is what this edge is for.
      return json(404, { error: "no such resource" });
    }

    const proven = await prove(headers);
    if (!proven.ok) return proven.response;
    const { tenant } = proven;

    /**
     * THE LIVE STATE, BUILT ONCE PER REQUEST AND USED BY BOTH ROUTES.
     *
     * The acknowledgement route needs it as well, because it re-checks the
     * operator's key against the CURRENT list before filing anything: see the
     * note on that route for why acknowledging an absent difference is refused.
     */
    const current = (): { state: LiveState; result: ReturnType<typeof reconcile> } => {
      const state: LiveState = {
        providers: live.providers,
        agentIds: Object.keys(live.latest()),
        latest: live.latest(),
        expectedVersion: live.expectedVersion ?? TARGET_VERSION,
        ...(live.accepts === undefined ? {} : { accepts: live.accepts }),
      };
      return { state, result: reconcile(store, tenant, state) };
    };

    if (isAck) {
      const key = typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>).key
        : undefined;
      if (typeof key !== "string" || key === "") {
        // Named as the caller's error, with the field, because a 401 here would
        // send an operator looking at their credential when the body is what is
        // wrong.
        return json(400, { error: "which difference? `key` is required" });
      }

      const { result } = current();
      const found = result.differences.find((difference) => differenceKey(difference) === key);
      if (found === undefined) {
        /**
         * ACKNOWLEDGING SOMETHING THAT IS NOT ON THE LIST IS REFUSED.
         *
         * The obvious permissive route -- store whatever key arrived -- is a
         * write endpoint that accepts a caller's own account of what the system
         * said, which is the one thing an audit trail must never contain. So the
         * key is resolved against a freshly computed reconciliation and a key
         * that names nothing is a 404.
         *
         * This is also why the check runs against `current()` rather than
         * against a cached snapshot: an acknowledgement is a claim about a
         * moment, so it has to be checked against a moment.
         */
        return json(404, { error: "that difference is not on the list right now" });
      }

      // The kind and subject come from the COMPUTED difference, never from the
      // body, for the same reason the tenant does not.
      store.acknowledgeDifference({
        tenant,
        key,
        kind: found.kind,
        subject: found.subject,
        actor: options.actorOf?.(tenant) ?? `token:${tenant}`,
      });

      const ack = store.acknowledgementsFor(tenant).find((entry) => entry.key === key);
      return json(200, {
        acknowledged: ack ?? null,
        /**
         * What the system did NOT do, said out loud.
         *
         * The difference is still in `differences`, unmodified. A UI that said
         * "resolved" here would be the system choosing, so the response names
         * the difference as still-open and the panel keeps drawing it.
         */
        stillOpen: true,
        subject: found.subject,
        whatToDo: found.whatToDo,
      });
    }

    if (verb !== "GET") {
      return json(405, { error: "this surface serves one read and one acknowledgement" });
    }

    const { state, result } = current();
    const acknowledgements = store.acknowledgementsFor(tenant);

    return json(200, {
      /**
       * WHEN THIS COMPARISON WAS MADE, and it is the FIRST field because it is
       * the one a reader is most likely to need and least likely to be given.
       *
       * Half of what follows is the record and half is the running system, so
       * the whole document is a statement about one moment. Without this stamp a
       * diff left open in a tab reads as current, which is the F1 shape ADR-005
       * §9 exists to prevent.
       */
      at: new Date().toISOString(),
      /**
       * WHICH HALF IS WHICH, IN WORDS, BECAUSE ADR-005 §9 RULE 1 REQUIRES THE
       * DISTINCTION TO BE STRUCTURAL AND A CAPTION IS NOT STRUCTURE.
       */
      source: "the record",
      tenant,
      recordVersion: store.version(),
      expectedVersion: state.expectedVersion,
      summary: summarise(result),
      differences: result.differences.map((difference) => {
        const key = differenceKey(difference);
        const ack = acknowledgements.find((entry) => entry.key === key);
        return {
          ...difference,
          key,
          acknowledged: ack !== undefined,
          /**
           * WHEN the operator looked, not just that they did.
           *
           * A bare boolean cannot answer "is this the same one I saw yesterday,
           * or a new one?", and `seenCount` alone cannot answer it either without
           * a clock. Both travel together, and a panel that draws only one of
           * them is drawing half of the fact.
           */
          acknowledgedAt: ack?.at ?? null,
          seenCount: ack?.seenCount ?? 0,
        };
      }),
      /**
       * CORRUPTION IS A SEPARATE FIELD, NOT A FLAG ON A DIFFERENCE.
       *
       * It is the only category that means something is WRONG rather than
       * something CHANGED, and folding it into the list is precisely how it
       * becomes something the operator learns to skim past.
       */
      corruptions: result.corruptions,
      /**
       * THE RECORD'S OWN VIEW OF THE PAST, and it is kept out of `differences`
       * because it is not a disagreement -- it is what the record believes, which
       * is half of the two-truths contract and needs its own surface.
       */
      recorded: {
        verdicts: store.verdictsFor(tenant).map((verdict) => ({
          agentId: verdict.agentId,
          at: new Date(verdict.at).toISOString(),
          provider: verdict.provider,
          records: verdict.records,
          breached: verdict.breached,
        })),
        alerts: store.alertsFor(tenant, 25).map((alert) => ({
          id: alert.id,
          agentId: alert.agentId,
          raisedAt: new Date(alert.raisedAt).toISOString(),
          severity: alert.severity,
          acknowledged: alert.acknowledged,
        })),
      },
    });
  }

  /**
   * OPEN THE STREAM. Authenticated exactly like everything else.
   *
   * === WHY THE GUARD IS FIRST, BEFORE ANY HEADER IS WRITTEN ===
   *
   * Because the first byte is the whole answer. A stream that writes `200 OK` and
   * then refuses is a surface that reports success to a scanner and delivers
   * nothing to the operator -- the "a 200 that installs nothing" shape
   * `portal-routes.ts` calls worse than an error, because it is a success the
   * caller has to disbelieve. So the credential is proven first, and a refusal is
   * an ordinary JSON error carrying the same status every other route returns.
   *
   * === BACK-PRESSURE IS A REFUSAL, NOT A QUEUE ===
   *
   * The socket's own writable buffer is the measurement, and
   * `MAX_CONSUMER_BACKLOG_BYTES` is the ceiling. A consumer further behind than
   * that is disconnected with a final frame explaining why, and its keep-alive
   * timer is cleared in the same breath -- a timer that outlives its consumer is a
   * handle that keeps this process alive, and this repository has been hung by
   * exactly that shape.
   *
   * What it loses is a NOTIFICATION, never an alert: `onDecision` persisted the
   * alert before this file was reached, so the consumer's recovery is to reconnect
   * and read `/api/memory/diff`.
   */
  async function openStream(
    method: string,
    path: string,
    headers: Readonly<Record<string, string | undefined>>,
    response: ServerResponse,
    request?: { on?: (event: string, fn: () => void) => void },
  ): Promise<boolean> {
    const clean = path.split("?")[0] ?? path;
    if (clean !== MEMORY_ALERTS_PATH) return write(response, json(404, { error: "no such resource" }));

    // The verb is proved, not guessed. An event stream is a read, and answering a
    // POST with a stream would be a surface nobody could reason about.
    if (method.toUpperCase() !== "GET") {
      const verbProof = await prove(headers);
      if (!verbProof.ok) return write(response, verbProof.response);
      return write(response, json(405, { error: "an event stream is read with GET" }));
    }

    const proven = await prove(headers);
    if (!proven.ok) return write(response, proven.response);
    const { tenant } = proven;

    response.writeHead(200, SSE_HEADERS);
    /**
     * AN OPENING COMMENT, with no payload.
     *
     * So the client's `open` event fires immediately rather than on the first
     * alert. Without it, "connected" and "something has happened" are
     * indistinguishable, and the liveness strip cannot tell a quiet feed from a
     * dead one -- which is the blur ADR-005 §6 forbids.
     */
    response.write(": connected\n\n");

    let closed = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    /**
     * ONE CLOSE, THREE CAUSES, ONE SET OF HANDLES CLEARED.
     *
     * Guarded by `closed` because all three can fire for the same disconnection,
     * and closing a subscription twice would decrement nothing and read as though
     * something had been removed that was not.
     */
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      unsubscribe();
    };

    /**
     * ONE WRITE, OR A DISCONNECT.
     *
     * `write()` returning false does not mean the data was lost -- it means the
     * socket's buffer is full. The ceiling on how full is the whole policy: past
     * it, this consumer is not slow, it is gone.
     */
    const send = (payload: string): void => {
      if (closed) return;
      if (response.write(payload)) return;
      if (response.writableLength <= MAX_CONSUMER_BACKLOG_BYTES) return;
      // THE DISCONNECT. Explained, then closed -- a bare socket close looks to the
      // operator like a server fault, and "you fell behind" is a fact they can act
      // on by reconnecting.
      try {
        response.write(
          frame("slow-consumer", "slow-consumer", {
            reason: `this connection fell more than ${MAX_CONSUMER_BACKLOG_BYTES} bytes behind`,
            whatToDo: "Reconnect, then read /api/memory/diff. The alert is in the record; only the notification was lost.",
          }),
        );
      } catch {
        // The socket is already unusable. Closing below is still correct.
      }
      close();
      response.end();
    };

    const unsubscribe = hub.open(tenant, send);

    timer = setInterval(() => {
      if (closed) return;
      try {
        response.write(keepAliveFrame());
      } catch {
        close();
        response.end();
      }
    }, options.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS);
    // A timer that outlives its consumer keeps the process alive for a connection
    // nobody has. Not optional, and not something a test can notice.
    timer.unref?.();

    // THREE WAYS A STREAM ENDS, all of them clearing the same handles.
    response.on("close", close);
    response.on("error", close);
    /**
     * THE CLIENT GOING AWAY.
     *
     * Without this, a consumer whose browser has closed the tab stays subscribed
     * until the socket times out, and every alert in the meantime is written to a
     * dead consumer. Not a leak anybody would notice, and exactly the "a handle
     * that outlived the thing that owned it" shape this repository has been bitten
     * by once already.
     */
    request?.on?.("close", close);

    return true;
  }

  return { handle, hub, openStream };
}
/**
 * WRITE A REFUSAL AND REPORT THAT THIS CALL HAS ALREADY ANSWERED.
 *
 * Returns false rather than a `UiResponse`, because every caller of `openStream`
 * has exactly one job left when this returns: do not write anything else. A
 * helper that handed back a response would invite a second `writeHead`, and a
 * second `writeHead` on a live socket is the failure this shape exists to make
 * impossible.
 */
function write(response: ServerResponse, result: UiResponse): boolean {
  const text = JSON.stringify(result.body ?? null);
  response.writeHead(result.status, { ...result.headers, "content-length": Buffer.byteLength(text) });
  response.end(text);
  return false;
}
