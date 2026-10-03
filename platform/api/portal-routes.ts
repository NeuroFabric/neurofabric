import {
  guard,
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
 * THE PORTAL API. The factory's other half: agents come from schemas, and the
 * screen comes from a configuration.
 *
 * === WHY A PORTAL IS A VALUE AND NOT A TEMPLATE ===
 *
 * The obvious design renders HTML. It fails the moment two customers want the same
 * widget in a different place, and it puts the customer's data into a server-side
 * template engine -- which is a second language on a platform whose entire claim
 * is that it has one (D-018). So this API returns a PORTAL CONFIG: a plain JSON
 * document describing widgets, forms and dashboards, and the frontend interprets
 * it. A layout change is a data change, a customer's portal is exportable, and the
 * server never assembles markup for somebody else to paste.
 *
 * === THE TENANT BOUNDARY IS THE CREDENTIAL, AND THAT IS A DELIBERATE CHOICE ===
 *
 * A PaaS that serves one customer's layout to another is not a PaaS with a bug, it
 * is a PaaS that has leaked. The boundary is the token's own `id`: the credential
 * proves the tenant by existing, and a portal read is scoped to that id alone. No
 * tenant name in a path, header or body is ever consulted, because a tenant
 * parameter that a caller can choose is a tenant parameter an attacker chooses.
 *
 * Adding a `tenant` field to `GatewayToken` would be tidier and was rejected:
 * the token list is provisioned through the vault, and a second tenant field is a
 * second thing to get wrong at issuance. The id is already unique and already
 * proven, so it is the tenancy key.
 *
 * === WHY A STORED CONFIG IS VALIDATED ON WRITE AND RE-VALIDED ON READ ===
 *
 * Validated on write, because that is where the error is useful to the author.
 * Re-validated on read, because a store is allowed to be something else later --
 * a database, a file, another team's table -- and a read path that trusts its own
 * store is one refactor away from serving a malformed layout to every customer at
 * once.
 *
 * === WHAT THE WRITE PATH IS NOT ===
 *
 * `POST schema` installs an agent into an IN-MEMORY registry. It does not persist
 * across a restart, it does not version-control anything, and it does not
 * authenticate the author beyond the portal credential. Stated here because a
 * `POST` that looks like configuration management and behaves like a temporary
 * process-global mutation is the kind of thing that gets mistaken for the former.
 */

export const PORTAL_PROVIDER = "portal";

export interface PortalWidget {
  readonly id: string;
  readonly kind: "metric" | "table" | "chart" | "feed";
  readonly title: string;
  /** The agent whose findings this widget shows. Omitted for a static widget. */
  readonly agentId?: string;
  /** What the widget reads, in the frontend's own vocabulary. */
  readonly span?: string;
}

export interface PortalField {
  readonly name: string;
  readonly label: string;
  readonly type: "text" | "number" | "select" | "boolean";
  readonly required?: boolean;
}

export interface PortalForm {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly PortalField[];
}

export interface PortalDashboard {
  readonly agentId: string;
  readonly title: string;
  readonly layout: "grid" | "stack";
  readonly columns: number;
}

export interface PortalConfig {
  readonly tenant: string;
  readonly title: string;
  readonly version: string;
  readonly widgets: readonly PortalWidget[];
  readonly forms: readonly PortalForm[];
  readonly dashboards: readonly PortalDashboard[];
}

export interface PortalIssue {
  readonly path: string;
  readonly reason: string;
}

export type PortalValidation =
  | { readonly ok: true; readonly config: PortalConfig }
  | { readonly ok: false; readonly issues: readonly PortalIssue[] };

const WIDGET_KINDS: ReadonlySet<string> = new Set(["metric", "table", "chart", "feed"]);
const FIELD_TYPES: ReadonlySet<string> = new Set(["text", "number", "select", "boolean"]);

/** How many widgets, forms and dashboards one portal may declare. */
const PORTAL_LIMITS = { widgets: 200, forms: 50, dashboards: 50, fields: 40 } as const;

/**
 * VALIDATE A PORTAL CONFIG.
 *
 * Unknown fields refused for the same reason agent schemas refuse them: a
 * misspelled `dashboards` is a portal that silently renders nothing, and nothing
 * is the hardest failure to notice.
 */
export function validatePortalConfig(document: unknown, tenant: string): PortalValidation {
  const issues: PortalIssue[] = [];
  const push = (path: string, reason: string) => { issues.push({ path, reason }); };

  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { ok: false, issues: [{ path: "$", reason: "a portal config must be a JSON object" }] };
  }
  const root = document as Record<string, unknown>;
  const allowed = new Set(["title", "version", "widgets", "forms", "dashboards"]);
  for (const key of Object.keys(root)) if (!allowed.has(key)) push(`$.${key}`, "unrecognised field");

  if (typeof root.title !== "string" || root.title.trim() === "") push("$.title", "title is required");
  if (typeof root.version !== "string" || root.version.trim() === "") {
    push("$.version", "version is required so a cached portal can be invalidated");
  }

  const widgets: PortalWidget[] = [];
  if (root.widgets !== undefined) {
    if (!Array.isArray(root.widgets)) push("$.widgets", "widgets must be an array");
    else if (root.widgets.length > PORTAL_LIMITS.widgets) {
      push("$.widgets", `more than ${PORTAL_LIMITS.widgets} widgets`);
    } else {
      root.widgets.forEach((entry, i) => {
        const widget = entry as Record<string, unknown>;
        if (typeof widget !== "object" || widget === null) {
          push(`$.widgets[${i}]`, "a widget must be an object");
          return;
        }
        const id = typeof widget.id === "string" ? widget.id : "";
        if (id === "") push(`$.widgets[${i}].id`, "id is required");
        if (typeof widget.kind !== "string" || !WIDGET_KINDS.has(widget.kind)) {
          push(`$.widgets[${i}].kind`, "kind must be one of: metric, table, chart, feed");
        }
        if (typeof widget.title !== "string" || widget.title.trim() === "") {
          push(`$.widgets[${i}].title`, "title is required");
        }
        if (widget.agentId !== undefined && typeof widget.agentId !== "string") {
          push(`$.widgets[${i}].agentId`, "agentId must be a string when present");
        }
        if (widget.span !== undefined && typeof widget.span !== "string") {
          push(`$.widgets[${i}].span`, "span must be a string when present");
        }
        widgets.push({
          id,
          kind: (typeof widget.kind === "string" ? widget.kind : "metric") as PortalWidget["kind"],
          title: typeof widget.title === "string" ? widget.title : "",
          ...(typeof widget.agentId === "string" ? { agentId: widget.agentId } : {}),
          ...(typeof widget.span === "string" ? { span: widget.span } : {}),
        });
      });
    }
  }

  const forms: PortalForm[] = [];
  if (root.forms !== undefined) {
    if (!Array.isArray(root.forms)) push("$.forms", "forms must be an array");
    else if (root.forms.length > PORTAL_LIMITS.forms) push("$.forms", `more than ${PORTAL_LIMITS.forms} forms`);
    else {
      root.forms.forEach((entry, i) => {
        const form = entry as Record<string, unknown>;
        if (typeof form !== "object" || form === null) {
          push(`$.forms[${i}]`, "a form must be an object");
          return;
        }
        if (typeof form.id !== "string" || form.id === "") push(`$.forms[${i}].id`, "id is required");
        if (typeof form.title !== "string" || form.title.trim() === "") {
          push(`$.forms[${i}].title`, "title is required");
        }
        const fields: PortalField[] = [];
        if (!Array.isArray(form.fields)) push(`$.forms[${i}].fields`, "fields must be an array");
        else if (form.fields.length > PORTAL_LIMITS.fields) {
          push(`$.forms[${i}].fields`, `more than ${PORTAL_LIMITS.fields} fields`);
        } else {
          form.fields.forEach((raw, j) => {
            const field = raw as Record<string, unknown>;
            if (typeof field !== "object" || field === null) {
              push(`$.forms[${i}].fields[${j}]`, "a field must be an object");
              return;
            }
            if (typeof field.name !== "string" || field.name === "") {
              push(`$.forms[${i}].fields[${j}].name`, "name is required");
            }
            if (typeof field.label !== "string" || field.label.trim() === "") {
              push(`$.forms[${i}].fields[${j}].label`, "label is required");
            }
            if (typeof field.type !== "string" || !FIELD_TYPES.has(field.type)) {
              push(`$.forms[${i}].fields[${j}].type`, "type must be one of: text, number, select, boolean");
            }
            fields.push({
              name: typeof field.name === "string" ? field.name : "",
              label: typeof field.label === "string" ? field.label : "",
              type: (typeof field.type === "string" ? field.type : "text") as PortalField["type"],
              ...(field.required === true ? { required: true } : {}),
            });
          });
        }
        forms.push({
          id: typeof form.id === "string" ? form.id : "",
          title: typeof form.title === "string" ? form.title : "",
          fields,
        });
      });
    }
  }

  const dashboards: PortalDashboard[] = [];
  if (root.dashboards !== undefined) {
    if (!Array.isArray(root.dashboards)) push("$.dashboards", "dashboards must be an array");
    else if (root.dashboards.length > PORTAL_LIMITS.dashboards) {
      push("$.dashboards", `more than ${PORTAL_LIMITS.dashboards} dashboards`);
    } else {
      root.dashboards.forEach((entry, i) => {
        const dashboard = entry as Record<string, unknown>;
        if (typeof dashboard !== "object" || dashboard === null) {
          push(`$.dashboards[${i}]`, "a dashboard must be an object");
          return;
        }
        if (typeof dashboard.agentId !== "string" || dashboard.agentId === "") {
          push(`$.dashboards[${i}].agentId`, "agentId is required: a dashboard is always about an agent");
        }
        if (dashboard.layout !== "grid" && dashboard.layout !== "stack") {
          push(`$.dashboards[${i}].layout`, "layout must be grid or stack");
        }
        const columns = typeof dashboard.columns === "number" ? dashboard.columns : 0;
        if (!Number.isInteger(columns) || columns < 1 || columns > 12) {
          push(`$.dashboards[${i}].columns`, "columns must be a whole number from 1 to 12");
        }
        dashboards.push({
          agentId: typeof dashboard.agentId === "string" ? dashboard.agentId : "",
          title: typeof dashboard.title === "string" ? dashboard.title : "",
          layout: (dashboard.layout === "stack" ? "stack" : "grid") as PortalDashboard["layout"],
          columns: columns === 0 ? 1 : columns,
        });
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    // `tenant` comes from the proven credential and never from the document, so a
    // caller cannot post a config addressed to somebody else.
    config: {
      tenant,
      title: root.title as string,
      version: root.version as string,
      widgets,
      forms,
      dashboards,
    },
  };
}

/* ==================================================================== */
/* THE STORE                                                            */
/* ==================================================================== */

/** Where one tenant's portal lives. Replaceable; validated on both ends. */
export interface PortalStore {
  get(tenant: string): PortalConfig | undefined;
  put(config: PortalConfig): void;
  tenants(): readonly string[];
  remove(tenant: string): boolean;
}

/**
 * AN IN-MEMORY STORE, BOUNDED.
 *
 * Bounded because it is a factory's tenant table: unbounded, it is a memory leak
 * reachable from the network by anyone who can hold a credential. The capacity is
 * a refusal rather than an eviction, because evicting a tenant's portal silently
 * would take a customer's screen away and tell nobody.
 */
export class InMemoryPortalStore implements PortalStore {
  private readonly configs = new Map<string, PortalConfig>();
  private readonly capacity: number;
  private rejected = 0;

  constructor(capacity = 512) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  get(tenant: string): PortalConfig | undefined {
    return this.configs.get(tenant);
  }

  put(config: PortalConfig): void {
    if (!this.configs.has(config.tenant) && this.configs.size >= this.capacity) {
      this.rejected += 1;
      throw new PortalStoreFull(`the portal store holds ${this.capacity} tenants`);
    }
    this.configs.set(config.tenant, config);
  }

  tenants(): readonly string[] {
    return [...this.configs.keys()];
  }

  remove(tenant: string): boolean {
    return this.configs.delete(tenant);
  }

  get size(): number {
    return this.configs.size;
  }

  get refusals(): number {
    return this.rejected;
  }
}

export class PortalStoreFull extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortalStoreFull";
  }
}

/* ==================================================================== */
/* THE ROUTES                                                           */
/* ==================================================================== */

export interface PortalRoutesOptions {
  readonly registry: DynamicAgentRegistry;
  readonly store: PortalStore;
  readonly vault: VaultProvider;
  readonly strictVault?: boolean;
}

export interface PortalRouter {
  handle(
    method: string,
    path: string,
    headers?: Readonly<Record<string, string | undefined>>,
    body?: unknown,
  ): Promise<UiResponse>;
  readonly routes: readonly string[];
}

const CONFIG_PATH = "/api/portal/config";
const AGENTS_PATH = "/api/portal/agents";
const SCHEMA_PATH = "/api/portal/schema";

function json(status: number, body: unknown): UiResponse {
  return { status, body, headers: { ...SECURE_JSON_HEADERS } };
}

function refused(decision: EdgeDecision): UiResponse {
  const rendered = httpResponse(decision);
  return { status: rendered.status, body: rendered.body, headers: { ...SECURE_JSON_HEADERS, ...rendered.headers } };
}

/**
 * A portal DERIVED FROM WHAT THE TENANT HAS REGISTERED.
 *
 * This is the "generate on the fly" half of the platform: a tenant with agents and
 * no stored configuration still gets a working screen, because the registered
 * agents ARE the dashboard list. What comes back declares that it was derived, so
 * a frontend can show "customise me" rather than pretending a customer chose it.
 */
function derivePortal(tenant: string, registry: DynamicAgentRegistry): PortalConfig {
  const agents = registry.describeAll();
  return {
    tenant,
    title: `${tenant} diagnostics`,
    version: "0.0.0-derived",
    widgets: agents.map((agent) => ({
      id: `feed:${agent.id}`,
      kind: "feed" as const,
      title: `${agent.title} findings`,
      agentId: agent.id,
      span: "recent",
    })),
    forms: [{
      id: "new-schema",
      title: "Install an agent",
      fields: [
        { name: "id", label: "Agent id", type: "text" as const, required: true },
        { name: "title", label: "Title", type: "text" as const, required: true },
      ],
    }],
    dashboards: agents.map((agent) => ({
      agentId: agent.id,
      title: agent.title,
      layout: "grid" as const,
      columns: agent.capabilities.length === 0 ? 1 : 2,
    })),
  };
}

export function createPortalRoutes(options: PortalRoutesOptions): PortalRouter {
  const { registry, store } = options;

  async function handle(
    method: string,
    path: string,
    headers: Readonly<Record<string, string | undefined>> = {},
    body?: unknown,
  ): Promise<UiResponse> {
    const clean = path.split("?")[0] ?? path;
    const verb = method.toUpperCase();

    const isSchemaWrite = verb === "POST" && clean === SCHEMA_PATH;
    const known = clean === CONFIG_PATH || clean === AGENTS_PATH || clean.startsWith(`${SCHEMA_PATH}/`) || isSchemaWrite;
    if (!known) {
      // 404 before proof, and the routes are not named in the refusal: naming
      // them hands a stranger the surface map, which is the reconnaissance this
      // edge exists to prevent.
      return json(404, { error: "no such resource" });
    }

    const tokens = await loadTokens(options.vault, {
      ...(options.strictVault === false ? {} : { strict: true }),
    });

    const request: EdgeRequest = { headers, provider: PORTAL_PROVIDER, events: 1 };
    const decision = guard(request, tokens);
    if (!decision.ok) return refused(decision);

    // THE TENANT IS THE PROVEN TOKEN ID. Nothing in the request chose it.
    const tenant = decision.tokenId;
    if (tenant === undefined) return refused({ ok: false, status: 401, reason: "no credential was proven" });

    if (isSchemaWrite) {
      const validation = validateSchema(body);
      if (!validation.ok) {
        // The author's error, with paths. Nothing is registered on a refusal, so a
        // rejected schema cannot half-exist.
        return json(400, { error: "schema refused", issues: validation.issues });
      }
      try {
        const { agent, replaced } = registry.register(validation.schema);
        return json(200, {
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

    if (verb !== "GET") return json(405, { error: "this surface serves reads, and accepts one schema write" });

    if (clean === CONFIG_PATH) {
      const stored = store.get(tenant);
      if (stored !== undefined) {
        // Re-validated on read. The store is replaceable, and a read path that
        // trusts it is one refactor from serving a malformed layout to everyone.
        const revalidated = validatePortalConfig(
          {
            title: stored.title,
            version: stored.version,
            widgets: stored.widgets,
            forms: stored.forms,
            dashboards: stored.dashboards,
          },
          tenant,
        );
        if (!revalidated.ok) {
          return json(500, { error: "the stored portal config is invalid", issues: revalidated.issues });
        }
        return json(200, { derived: false, config: revalidated.config });
      }
      return json(200, { derived: true, config: derivePortal(tenant, registry) });
    }

    if (clean === AGENTS_PATH) {
      const roster = registry.describeAll();
      return json(200, {
        at: new Date().toISOString(),
        total: roster.length,
        agents: roster,
        // Published so a portal can tell a customer which of these are real. A
        // dashboard showing a capability that refuses to answer is worse than one
        // admitting it is not built yet.
        ready: roster.filter((agent) => agent.maturity === "ready").length,
        stubCount: roster.filter((agent) => agent.maturity === "stub").length,
      });
    }

    // GET schema/<id>: the raw schema, which is what an editor renders and what an
    // export writes. The id is tenant-independent -- schemas are platform objects,
    // not customer data -- but the CALLER is still proven.
    const id = decodeURIComponent(clean.slice(SCHEMA_PATH.length + 1));
    const schema: AgentSchema | undefined = registry.schemaOf(id);
    if (schema === undefined) return json(404, { error: "no agent with that id is registered" });
    return json(200, { schema });
  }

  return {
    handle,
    routes: [`GET ${CONFIG_PATH}`, `GET ${AGENTS_PATH}`, `GET ${SCHEMA_PATH}/:id`, `POST ${SCHEMA_PATH}`],
  };
}
