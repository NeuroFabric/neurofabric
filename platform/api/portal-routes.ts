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
import { ThroughputMeter, type ThroughputReading } from "../omniroute/throughput-meter.ts";
import type { LiveVerdict } from "../conductor/live-anomaly.ts";
import type { OmniRouteEvent } from "../omniroute/omniroute-gateway.ts";
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
  /**
   * The live gateway. Omitted means NO live surface, and `/api/portal/live`
   * then answers 503 rather than pretending to have nothing to report.
   *
   * Optional rather than required because this router has a second job: it is
   * the schema and portal surface, which is useful without any stream attached.
   */
  readonly live?: LiveGateway;
  /** The provider name `/api/portal/live` reports on. Defaults to `pega`. */
  readonly liveProvider?: string;
  /**
   * CALLED WHEN A SCHEMA IS ACCEPTED, SO THE DURABLE RECORD CAN HEAR ABOUT IT.
   *
   * A hook rather than a store, because the portal has no business knowing that
   * a database exists -- this file is about configuration and the record is about
   * history, and a portal route that reached into `node:sqlite` would make the
   * record's availability a property of the customer's configuration surface.
   *
   * It is called with the ALREADY-VALIDATED schema and the PROVEN tenant, and it
   * is called AFTER `registry.register` succeeds, so nothing is written for a
   * schema that was refused. A record that contained a refused schema would put
   * the two halves of this platform -- what is running and what was written down
   * -- into disagreement for no reason, which is the exact condition the
   * reconciliation exists to report.
   *
   * Optional: a caller with no record open simply does not get told.
   */
  readonly onSchemaRegistered?: ((tenant: string, schema: AgentSchema) => void) | undefined;
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
const LIVE_PATH = "/api/portal/live";
const INGEST_PATH = "/api/portal/ingest";

/**
 * === THE TWO LIVE ROUTES, AND WHY THEY LIVE HERE ===
 *
 * The live surface is part of the portal, not a separate service. It shares the
 * portal's credential, its tenant boundary and its refusal rendering, and a
 * second owner for one surface is how two policies slowly disagree -- which is
 * the argument this module has already made once about `ui-routes.ts`.
 *
 * === THROUGHPUT IS MEASURED, AND IT IS MEASURED HERE ===
 *
 * A rate needs two instants. The browser has one (now); the server has every
 * instant, because it is the thing being polled. So the meter lives on this side
 * and the reading travels with the verdict. Every earlier throughput statement
 * in this project was a guess, and the UI refused to print one for exactly that
 * reason.
 */
export interface LiveGateway {
  /** The current verdict for a provider, or undefined before any traffic. */
  verdict(provider: string): LiveVerdict | undefined;
  /** Push one already-admitted event. The caller has already run the edge. */
  push(provider: string, event: OmniRouteEvent): void;
  /** Whether a provider is connected. Pushing to an unknown one is an error. */
  connected(provider: string): boolean;
  /**
   * RUN THE ALERT POLICY. Optional, and absent means this read path shows a
   * verdict without raising anything.
   *
   * `verdict` and `evaluate` are deliberately different methods. `verdict` is
   * arithmetic over the window, which is what a dashboard needs on every poll.
   * `evaluate` is the DECISION: it decides whether a condition is NEW, and it is
   * the only path that persists a verdict and dispatches an alert.
   *
   * So this is the seam where the write boundary is entered, and it is a
   * parameter rather than a gateway import so this file stays a decision table
   * and a read of who is who.
   */
  evaluate?(provider: string): void;
}

/** The shape `GET /api/portal/live` returns. Nulls are explicit, never omitted. */
export interface LiveSnapshot {
  readonly at: string;
  readonly provider: string;
  /** False when the process was started with no gateway at all. */
  readonly enabled: boolean;
  /** Null before the first event arrives. A UI must be able to tell "no data yet". */
  readonly verdict: (LiveVerdict & { readonly synthetic: false }) | null;
  /** Null until two observations exist. See ThroughputMeter. */
  readonly throughput: ThroughputReading | null;
}

/** The body `POST /api/portal/ingest` accepts, after validation. */
export interface IngestAccepted {
  readonly provider: string;
  readonly events: readonly OmniRouteEvent[];
}

/**
 * The most events one ingest call may carry.
 *
 * A cap rather than a floor. Unbounded, this is a memory allocation sized by
 * whoever sent the request, which is a denial-of-service reachable from the
 * network by anyone holding a credential. 1000 events is a large batch and a
 * small allocation.
 */
const MAX_INGEST_EVENTS = 1000;

/**
 * VALIDATE AN INGEST BODY.
 *
 * `fields` values are COERCED to strings rather than refused when a number
 * arrives, because every column in this platform is a string and a producer that
 * sends `{ elapsed_time: 1200 }` has done nothing wrong. Refusing it would teach
 * the producer to quote its numbers, which is a workaround for a rule rather than
 * a fix. A non-string, non-number value IS refused, because there is no
 * reasonable reading of `{ port: {} }` as a column.
 */
export function validateIngest(body: unknown): { ok: true; value: IngestAccepted } | { ok: false; issues: readonly PortalIssue[] } {
  const issues: PortalIssue[] = [];
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, issues: [{ path: "$", reason: "an ingest body must be an object" }] };
  }
  const root = body as Record<string, unknown>;

  const provider = root.provider;
  if (typeof provider !== "string" || provider.trim() === "") {
    issues.push({ path: "$.provider", reason: "provider is required" });
  }

  const raw = root.events;
  if (!Array.isArray(raw)) {
    issues.push({ path: "$.events", reason: "events must be an array" });
    return { ok: false, issues };
  }
  if (raw.length === 0) {
    issues.push({ path: "$.events", reason: "events is empty" });
    return { ok: false, issues };
  }
  if (raw.length > MAX_INGEST_EVENTS) {
    issues.push({ path: "$.events", reason: `more than ${MAX_INGEST_EVENTS} events in one call` });
    return { ok: false, issues };
  }

  const events: OmniRouteEvent[] = [];
  raw.forEach((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      issues.push({ path: `$.events[${i}]`, reason: "an event must be an object" });
      return;
    }
    const event = entry as Record<string, unknown>;
    const fieldsRaw = event.fields;
    if (typeof fieldsRaw !== "object" || fieldsRaw === null || Array.isArray(fieldsRaw)) {
      issues.push({ path: `$.events[${i}].fields`, reason: "fields must be an object" });
      return;
    }
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(fieldsRaw as Record<string, unknown>)) {
      if (typeof value === "string") fields[key] = value;
      else if (typeof value === "number" && Number.isFinite(value)) fields[key] = String(value);
      else if (typeof value === "boolean") fields[key] = String(value);
      else {
        issues.push({
          path: `$.events[${i}].fields.${key}`,
          reason: "a field value must be a string, a finite number or a boolean",
        });
      }
    }
    const at = event.at;
    if (at !== undefined && (typeof at !== "number" || !Number.isFinite(at))) {
      issues.push({ path: `$.events[${i}].at`, reason: "at must be a finite number of milliseconds when present" });
    }
    events.push({ fields, ...(typeof at === "number" && Number.isFinite(at) ? { at } : {}) });
  });

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { provider: (provider as string).trim(), events } };
}

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
  // ONLY this tenant's agents. `describeAll` here would put another customer's
  // agent titles on this customer's screen, which is a disclosure in a widget.
  const agents = registry.describeFor(tenant);
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

  /**
   * One meter per provider, created lazily.
   *
   * Lazily because a meter with no samples is indistinguishable from one that has
   * been sampled once, and paying for it on a request path that never reads live
   * telemetry would be waste. The map is bounded by the number of providers,
   * which the caller chooses at boot, so this cannot grow without limit.
   */
  const meters = new Map<string, ThroughputMeter>();
  const meter = (provider: string): ThroughputMeter => {
    const existing = meters.get(provider);
    if (existing !== undefined) return existing;
    const created = new ThroughputMeter();
    meters.set(provider, created);
    return created;
  };

  async function handle(
    method: string,
    path: string,
    headers: Readonly<Record<string, string | undefined>> = {},
    body?: unknown,
  ): Promise<UiResponse> {
    const clean = path.split("?")[0] ?? path;
    const verb = method.toUpperCase();

    const isSchemaWrite = verb === "POST" && clean === SCHEMA_PATH;
    const isIngestWrite = verb === "POST" && clean === INGEST_PATH;
    const known = clean === CONFIG_PATH || clean === AGENTS_PATH || clean === LIVE_PATH
      || clean.startsWith(`${SCHEMA_PATH}/`) || isSchemaWrite || isIngestWrite;
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
        // The tenant comes from the proven credential, never from the body: a
        // caller that could name its tenant could write into another customer's
        // namespace by choosing a different one.
        const { agent, replaced } = registry.register(validation.schema, { tenant });
        // AFTER the registry accepted it, and with the SAME tenant. A write that
        // happened before the accept would put the record ahead of the running
        // system, which is the one ordering this platform refuses to get wrong.
        options.onSchemaRegistered?.(tenant, validation.schema);
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

    if (isIngestWrite) {
      if (options.live === undefined) {
        return json(503, { error: "no live gateway is attached to this process" });
      }
      const validation = validateIngest(body);
      if (!validation.ok) return json(400, { error: "ingest refused", issues: validation.issues });
      const { provider, events } = validation.value;
      if (!options.live.connected(provider)) {
        return json(404, { error: "no provider with that name is connected" });
      }
      // The credential was proven ABOVE, on the same token list every other
      // portal route uses. The edge ran once; these events are admitted.
      for (const event of events) options.live.push(provider, event);
      return json(200, { accepted: events.length, refused: 0, provider });
    }

    if (clean === LIVE_PATH) {
      const gateway = options.live;
      const provider = options.liveProvider ?? "pega";
      if (gateway === undefined) {
        return json(503, { error: "no live gateway is attached to this process" });
      }

      /**
       * THE EVALUATION LOOP, AND THIS IS THE ONLY PLACE IT RUNS.
       *
       * It runs HERE, on the read path, and the consequence is stated rather than
       * left to be discovered: **an alert is raised when something asks how the
       * stream is doing.** A deployment where nobody polls raises no alerts, which
       * is honest and wrong for a monitoring product at the same time -- and the
       * fix is a scheduler this platform does not have, not a trick hidden in a
       * request handler. It is named here so whoever adds one knows this line is
       * already taken.
       *
       * A timer in the server factory was rejected for a specific reason: it
       * would be a handle outliving the object that owns it in every test that
       * builds a server without `startWedgeServer`, and this repository has been
       * hung by exactly that shape. A read path cannot leak, because it exists
       * only while a request does.
       *
       * It runs AFTER nothing, and before `verdict` is read, so the decision and
       * the numbers a dashboard draws come from the same window.
       */
      gateway.evaluate?.(provider);

      const verdict = gateway.verdict(provider);
      // An explicit null, not an omitted field: a dashboard must be able to say
      // "connected but idle" rather than failing to parse the response.
      const snapshot: LiveSnapshot = {
        at: new Date().toISOString(),
        provider,
        enabled: true,
        verdict: verdict === undefined ? null : { ...verdict, synthetic: false },
        // Sampled HERE because this is the only place holding two instants. The
        // meter is per router, so two readers cannot corrupt each other's rate.
        throughput: verdict === undefined ? null : meter(provider).sample(verdict.records),
      };
      return json(200, snapshot);
    }

    if (verb !== "GET") return json(405, { error: "this surface serves reads, and accepts one schema write and one ingest write" });

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
      // Scoped to the caller. A cross-tenant roster here would list another
      // customer's agent titles, which is a disclosure in a list widget.
      const roster = registry.describeFor(tenant);
      return json(200, {
        at: new Date().toISOString(),
        tenant,
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
    // export writes. Scoped to the caller, so a schema id another tenant happens
    // to use is not readable here -- it is not merely hidden by the URL, it is not
    // in this tenant's namespace at all.
    //
    // === BOTH ID FORMS, BECAUSE THE ROSTER PUBLISHES ONE AND THE UI SENDS IT ===
    //
    // `GET /api/portal/agents` publishes COMPOSITE ids -- `demo/log-anomaly` --
    // and the command center puts that value in a select and sends it straight
    // back here. Resolving it against the authenticated tenant produced
    // `demo/demo/log-anomaly` and a 404 for every agent in the UI. Measured on a
    // running wedge before this change:
    //
    //   GET /api/portal/schema/demo%2Flog-anomaly  ->  404
    //   GET /api/portal/schema/log-anomaly         ->  200
    //
    // So a bare id and a composite id are both accepted. A composite id whose
    // tenant is NOT the proven one is a 404, not a 403: it must be
    // indistinguishable from an id nobody registered, or this endpoint becomes an
    // oracle for asking whether another customer has an agent by that name.
    //
    // See docs/DECISIONS.md D-042.1 for why the roster does not simply publish
    // bare ids instead.
    const id = decodeURIComponent(clean.slice(SCHEMA_PATH.length + 1));
    const separator = id.indexOf("/");
    const schema: AgentSchema | undefined =
      separator > 0
        ? // Composite. The tenant in the path is HONOURED ONLY when it matches the
          // proven one; otherwise the whole thing is treated as absent.
          id.slice(0, separator) === tenant
          ? registry.schemaOf(tenant, id.slice(separator + 1))
          : undefined
        : registry.schemaOf(tenant, id);
    if (schema === undefined) return json(404, { error: "no agent with that id is registered" });
    return json(200, { schema });
  }

  return {
    handle,
    routes: [
      `GET ${CONFIG_PATH}`,
      `GET ${AGENTS_PATH}`,
      `GET ${LIVE_PATH}`,
      `GET ${SCHEMA_PATH}/:id`,
      `POST ${SCHEMA_PATH}`,
      `POST ${INGEST_PATH}`,
    ],
  };
}
