import {
  proveTenant,
  httpResponse,
  loadTokens,
  type EdgeDecision,
  type EdgeRequest,
  type VaultProvider,
} from "../omniroute/edge-security.ts";
import {
  DynamicAgentRegistry,
  SchemaRejected,
  validateSchema,
  type AgentSchema,
} from "../swarm/dynamic-registry.ts";
import { SECURE_JSON_HEADERS, type UiResponse } from "./ui-routes.ts";

/**
 * THE AUTHORING API. Where a customer builds their own agents.
 *
 * === WHY THIS IS A SEPARATE CREDENTIAL FROM THE PORTAL ONE ===
 *
 * Reading a dashboard and installing an agent are not the same privilege, and one
 * credential for both means every dashboard token is a write token. So authoring
 * has its own provider name: a credential provisioned for `schema-authoring` can
 * rewrite the fleet of agents, and one provisioned for `portal` cannot write
 * anything at all. A UI that is handed a portal credential to render a screen
 * therefore cannot be talked into installing code.
 *
 * The trade is that an operator now provisions two credentials per customer. That
 * is the intended cost: least privilege is cheap to set up once and expensive to
 * retrofit.
 *
 * === TENANTY, AGAIN, AND IT IS THE SAME RULE AS EVERYWHERE ===
 *
 * The tenant is the proven token id. A `tenant` field in a request body is
 * IGNORED, not honoured and not rejected -- ignoring it is deliberate, because a
 * caller that sends one has usually been built against an older contract, and
 * silently succeeding while ignoring it is the worst of the three answers. So the
 * tenant of a created schema is always the caller's, and a path segment naming
 * somebody else's schema simply does not resolve in this tenant's namespace.
 *
 * === HOT-LOADED, AND WHAT THAT DOES AND DOES NOT MEAN ===
 *
 * A create or an update registers a compiled agent immediately: the next event
 * that arrives is evaluated by the new rules with no restart and no redeploy. That
 * is the product.
 *
 * It also means an author can break a running tenant's detection with one POST, so
 * two guards are not optional:
 *   - every write is validated before it is registered, and a refused write
 *     registers NOTHING (a partial write would leave an agent whose schema and
 *     behaviour disagree);
 *   - the DELETE verb requires the header the schema may be marked with, so
 *     removing an agent that is currently being fed is a deliberate act. Absent
 *     the header it is refused with 428, which is the honest code for "I need
 *     more from you" rather than a 400 that implies the request was malformed.
 *
 * === WHAT IS NOT HERE ===
 *
 * No collaborative editing, no version history beyond the replaced agent being
 * RETURNED (so a caller can undo), and no persistence across a restart: this is an
 * in-memory registry, and a restart empties it. All three are stated because a CRUD
 * API that looks like configuration management and behaves like a temporary
 * process-global mutation gets mistaken for the former.
 */

export const AUTHORING_PROVIDER = "schema-authoring";

/** Required on DELETE. The header a caller must set to confirm a destructive act. */
export const CONFIRM_HEADER = "x-confirm-delete";

const BASE = "/api/tenant/schema";

export interface SchemaRoutesOptions {
  /**
   * The live registry. Writes land here immediately; there is no separate store.
   *
   * The concrete class, not a structural copy of it: a hand-written shape here is a
   * second declaration of the registry's contract, and it would drift silently the
   * first time a method changed.
   */
  readonly registry: DynamicAgentRegistry;
  readonly vault: VaultProvider;
  readonly strictVault?: boolean;
  readonly findingCap?: number;
  readonly clock?: () => number;
}

export interface SchemaRouter {
  handle(
    method: string,
    path: string,
    headers?: Readonly<Record<string, string | undefined>>,
    body?: unknown,
  ): Promise<UiResponse>;
  readonly routes: readonly string[];
}

function json(status: number, body: unknown): UiResponse {
  return { status, body, headers: { ...SECURE_JSON_HEADERS } };
}

function refused(decision: EdgeDecision): UiResponse {
  const rendered = httpResponse(decision);
  return { status: rendered.status, body: rendered.body, headers: { ...SECURE_JSON_HEADERS, ...rendered.headers } };
}

/**
 * Strip a `tenant` field if a caller sent one.
 *
 * Exported so the behaviour is testable on its own and so the API can say plainly
 * what it did with it, rather than the reader having to infer it from a schema that
 * has no tenant field in it.
 */
export function withoutTenantField(document: unknown): unknown {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return document;
  const copy: Record<string, unknown> = { ...(document as Record<string, unknown>) };
  delete copy.tenant;
  return copy;
}

export function createSchemaRoutes(options: SchemaRoutesOptions): SchemaRouter {
  const { registry } = options;

  async function handle(
    method: string,
    path: string,
    headers: Readonly<Record<string, string | undefined>> = {},
    body?: unknown,
  ): Promise<UiResponse> {
    const clean = path.split("?")[0] ?? path;
    const verb = method.toUpperCase();

    if (clean !== BASE && !clean.startsWith(`${BASE}/`)) {
      // 404 BEFORE PROOF, and the routes are not named: telling a stranger which
      // paths exist is the reconnaissance this edge exists to prevent.
      return json(404, { error: "no such resource" });
    }

    // THROUGH THE ONE DOOR, like every other router. This file was the FOURTH
    // copy of these four lines, and it was found by the scan in
    // one-door.test.ts rather than by reading -- three routers had already been
    // collapsed by hand and this one was missed, because an audit that lists the
    // files it remembers to look at is not an audit.
    const proven = await proveTenant(options.vault, AUTHORING_PROVIDER, headers, {
      ...(options.strictVault === false ? {} : { strict: true }),
    });
    if (!proven.ok) return refused(proven.decision);
    const tenant = proven.tokenId;

    const segment = clean.slice(BASE.length + 1);
    const id = segment === "" ? undefined : decodeURIComponent(segment);

    // ---- COLLECTION ------------------------------------------------------
    if (id === undefined) {
      if (verb === "GET") {
        return json(200, {
          tenant,
          total: registry.ids(tenant).length,
          // Composite ids, so a client cannot lose track of which namespace an id
          // belongs to when it stores it.
          ids: registry.ids(tenant),
        });
      }
      if (verb === "POST") {
        const validation = validateSchema(withoutTenantField(body));
        if (!validation.ok) return json(400, { error: "schema refused", issues: validation.issues });
        return register(tenant, validation.schema);
      }
      return json(405, { error: "this collection supports GET and POST" });
    }

    // ---- ONE SCHEMA ------------------------------------------------------
    if (verb === "GET") {
      const schema = registry.schemaOf(tenant, id);
      // Not "forbidden": from this tenant's namespace the other tenant's schema is
      // not merely hidden, it does not exist. 403 would confirm it does.
      if (schema === undefined) return json(404, { error: "no agent with that id is registered" });
      return json(200, { schema });
    }

    // PUT ONLY. PATCH is deliberately NOT aliased to it.
    //
    // A PATCH that behaves as a full replace is worse than no PATCH: a caller
    // sending a partial body would get a validation failure about a field it never
    // meant to touch, with nothing in the status code to say the verb was the
    // problem. Returning 405 tells the caller plainly that partial update does not
    // exist here, and a partial update can be added later without having already
    // taught clients it works.
    if (verb === "PUT") {
      const validation = validateSchema(withoutTenantField(body));
      if (!validation.ok) return json(400, { error: "schema refused", issues: validation.issues });
      // A path that names one id and a body that names another is ambiguous, and
      // guessing which one wins is how a customer overwrites the wrong agent.
      if (validation.schema.id !== id) {
        return json(409, {
          error: "the id in the body and the id in the path disagree",
          pathId: id,
          bodyId: validation.schema.id,
        });
      }
      return register(tenant, validation.schema);
    }

    if (verb === "DELETE") {
      const confirm = readHeader(headers, CONFIRM_HEADER);
      if (confirm !== "yes") {
        // 428, not 400: nothing is wrong with the request, the server needs more
        // from the caller before it will do this.
        return json(428, {
          error: "set the confirmation header to remove an agent that may be receiving events",
          header: CONFIRM_HEADER,
        });
      }
      const removed = registry.remove(tenant, id);
      if (!removed) return json(404, { error: "no agent with that id is registered" });
      return json(200, { removed: `${tenant}/${id}` });
    }

    return json(405, { error: "unsupported method" });
  }

  /**
   * Register, and report the previous version so the caller can undo.
   *
   * A refusal here registers NOTHING. That is the point of validating before
   * touching the registry rather than rolling back after: there is no window in
   * which a tenant has an agent whose compiled rules disagree with its stored
   * schema.
   */
  function register(tenant: string, schema: AgentSchema): UiResponse {
    try {
      const { agent, replaced } = registry.register(schema, {
        tenant,
        ...(options.findingCap === undefined ? {} : { sinkCap: options.findingCap }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      });
      return json(replaced === undefined ? 201 : 200, {
        created: replaced === undefined,
        agent: agent.describe(),
        replacedVersion: replaced?.version ?? null,
      });
    } catch (error) {
      if (error instanceof SchemaRejected) {
        return json(400, { error: "schema refused", issues: error.issues });
      }
      return json(409, { error: error instanceof Error ? error.message : "the registry refused this schema" });
    }
  }

  return {
    handle,
    routes: [
      `GET ${BASE}`,
      `POST ${BASE}`,
      `GET ${BASE}/:id`,
      `PUT ${BASE}/:id`,
      `DELETE ${BASE}/:id`,
    ],
  };
}

function readHeader(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return value === undefined || value.trim() === "" ? undefined : value.trim();
  }
  return undefined;
}
