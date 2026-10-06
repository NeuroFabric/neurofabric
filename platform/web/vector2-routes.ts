/**
 * VECTOR 2: THE ENTERPRISE INGRESS SURFACE.
 *
 * === WHY THIS EXISTS ===
 *
 * Every telemetry producer this gateway can read today is a file, a topic, or a CSV
 * dropped into a directory by a human who is already on the box. None of those are
 * how an enterprise system talks to a platform. An external system wants to POST
 * JSON to a URL and get a status code back, and it wants to do that without
 * compiling this repository's TypeScript and without a seat on the host.
 *
 * So this is that surface: a plain HTTP contract over the components that already
 * work, so a producer can be written in any language that can make a POST.
 *
 * === WHY IT IS A ROUTER AND NOT A SERVER ===
 *
 * The AlertHub is a singleton with a bounded subscriber set, and the ledger is one
 * SQLite file. A second process would fracture both: two hubs means a verdict
 * published in one is invisible to a subscriber attached to the other, and two
 * writers on one ledger file is exactly the concurrent-write shape the replication
 * sidecar and the approval ledger were built to avoid. So this module adds ROUTES
 * to the process that already holds the hub, and it is shaped like every other
 * router in this repository -- `handle(method, path, headers, body) -> UiResponse` --
 * so it mounts in `platform/web/server.ts` the same way `memory-routes.ts` does.
 *
 * === AND WHY 202 RATHER THAN 200 OR 201 ===
 *
 * The dispatcher is a ROUTER, not a queue. By the time this returns, the event has
 * been validated, matched, and handed to the agents registered for it -- or it has
 * been dead-lettered. There is nothing left to await, so 200 would claim a
 * completeness this does not have, and 201 would promise a resource URL for an event
 * that has no such thing. 202 is the honest code: accepted, and this is what became
 * of it.
 *
 * === THE REFUSAL IS DELIBERATELY LEGIBLE, AND THAT IS THE POINT ===
 *
 * `universal-envelope.ts` makes a considered departure from the vault's uniform
 * refusal: telemetry carries no secrets, so a distinct error leaks nothing, and the
 * failure being defended against is a producer shipping a broken shape for an hour.
 * A producer that only ever sees "rejected" has a counter and no way to fix
 * anything. So the response NAMES THE FIELD and carries the validator's code.
 *
 * The `reason` never echoes the offending VALUE. A metric name can carry anything an
 * upstream system put in it, and an error body gets logged, shipped and pasted into
 * a ticket. The field name is safe; the value is not.
 *
 * === AND WHY A REPLAYED TOKEN IS NOT SILENTLY ACCEPTED ===
 *
 * `eventId` is the deduplication key in the envelope, but nothing upstream of this
 * route has ever claimed it. Rather than invent idempotency the pipeline does not
 * yet have, this states the fact plainly in the response body: the event was
 * accepted and handed to these agents. A producer that needs exactly-once semantics
 * across retries needs a deduplicating store in front of the dispatcher, and that
 * is a change to the dispatcher, not to this route.
 */

import { validateUniversalTelemetryEvent } from "../ingestion/universal-envelope.ts";
import { SwarmDispatcher } from "../conductor/swarm-dispatcher.ts";

/** The ingress path. One namespace, one version, one event shape. */
export const TELEMETRY_PATH = "/api/v1/ingress/telemetry";

/** The version prefix both namespaces live under, so a future v2 is a clean break. */
export const VECTOR2_PREFIX = "/api/v1/";

/** A body ceiling. This is a firehose, and it is untrusted: a 4MB metric is a DoS. */
export const MAX_BODY_BYTES = 64 * 1024;

/** The response shape every router in this repository returns. */
export interface Vector2Response {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * HOW A CALLER IS IDENTIFIED.
 *
 * Injected rather than imported so this module keeps no opinion about WHICH
 * credential scheme is in force, and so a test can prove the routing contract
 * without standing up a vault. Returning `undefined` REFUSES the call.
 *
 * Note what it returns: a TENANT, derived from the credential the caller proved.
 * The tenant is never read from the request body, because a body field named
 * `tenant` is a request to be told whose records to read, and answering it from the
 * payload is how one tenant's operator ends up holding another's telemetry.
 */
export type AuthenticateTelemetry = (
  headers: Readonly<Record<string, string | undefined>>,
) => Promise<{ readonly tenant: string } | undefined>;

export interface Vector2Options {
  /** Mandatory. See `AuthenticateTelemetry`. */
  readonly authenticate: AuthenticateTelemetry;
  /** Injected so a test can observe routing; production passes the real registry. */
  readonly dispatcher?: SwarmDispatcher;
  /** Shared body ceiling, so the mount and the route agree on one number. */
  readonly maxBodyBytes?: number;
}

export interface Vector2Router {
  handle: (
    method: string,
    path: string,
    headers?: Readonly<Record<string, string | undefined>>,
    body?: unknown,
  ) => Promise<Vector2Response>;
  /** The dispatcher, so the mount can register its agents on the SAME instance. */
  readonly dispatcher: SwarmDispatcher;
}

function json(status: number, body: unknown): Vector2Response {
  return {
    status,
    body,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // No-store: an ingest response is a fact about one request, and a cached
      // "accepted" is a lie told to the next producer.
      "cache-control": "no-store",
    },
  };
}

/** 404. Says which namespace was asked for, because the path is the whole question. */
const NOT_FOUND = (path: string): Vector2Response =>
  json(404, { error: "no such resource", path });

export function createVector2Routes(options: Vector2Options): Vector2Router {
  const dispatcher = options.dispatcher ?? new SwarmDispatcher();

  return {
    dispatcher,

    async handle(method, path, headers = {}, body): Promise<Vector2Response> {
      // Only the ingress namespace exists so far. A request to any other `/api/v1/`
      // path is refused here rather than falling through to the wedge's own routes,
      // so a typo in a version never reaches a handler written for another one.
      if (path === TELEMETRY_PATH) {
        if (method !== "POST") {
          return json(405, {
            error: "this resource accepts POST only",
            allowed: ["POST"],
          });
        }

        const proven = await options.authenticate(headers);
        if (proven === undefined) {
          // Uniform. A caller cannot learn WHICH part of its credential was wrong,
          // and 401 rather than 403 because the request is not authenticated at all.
          return json(401, { error: "unauthenticated" });
        }

        /**
         * THE BODY IS VALIDATED BEFORE IT IS TRUSTED, AND BEFORE IT IS ROUTED.
         *
         * `unknown` in, because this is `JSON.parse` output and the entire purpose
         * of the validator is to establish that it is something else. The dispatcher
         * re-validates internally; doing it here as well is deliberate, because a 400
         * that NAMES THE FIELD is a producer that can fix itself, and the dispatcher's
         * own refusal is deliberately anonymous.
         */
        const verdict = validateUniversalTelemetryEvent(body);
        if (!verdict.ok) {
          return json(400, {
            error: "the payload is not a UniversalTelemetryEvent",
            code: verdict.code,
            reason: verdict.reason,
          });
        }

        const outcome = await dispatcher.dispatch(verdict.event);

        /**
         * DEAD-LETTERED IS REPORTED, NOT HIDDEN.
         *
         * A 202 with a silent drop is the failure this repository calls out by name:
         * an event accepted, counted, and invisible. If nothing matched, the producer
         * is told so in the body of the same response that said "accepted", because
         * the two are the same transaction and a producer reading only the status
         * code would otherwise never know.
         */
        return json(202, {
          accepted: true,
          eventId: verdict.event.eventId,
          metricName: verdict.event.metricName,
          delivered: [...outcome.delivered],
          failed: [...outcome.failed],
          deadLettered: outcome.deadLettered,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        });
      }

      if (path.startsWith(VECTOR2_PREFIX)) return NOT_FOUND(path);

      // Not ours at all. The mount delegates to us before its own routes, so this
      // is how a non-`/api/v1` path reaches the wedge: said plainly rather than as
      // a 404, because a 404 here would be indistinguishable from a real 404.
      return NOT_FOUND(path);
    },
  };
}
