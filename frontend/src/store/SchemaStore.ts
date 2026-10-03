import {
  validateAgentRoster,
  validateAgentSchema,
  validatePortalEnvelope,
  type AgentDescriptor,
  type AgentSchema,
  type PortalConfig,
  type ShapeIssue,
} from "../api/contracts";
import type { GatewayFailure } from "../api/gateway-client";

/**
 * THE SCHEMA-DRIVEN STATE MACHINE.
 *
 * === WHY THIS IS NOT REDUX, ZUSTAND, JOTAI OR A CONTEXT PROVIDER ===
 *
 * The brief says "vanilla React context or a lightweight subscription model".
 * This is the second, for a reason that is not fashion: the components that
 * consume this state cannot be visually tested in this environment, so the state
 * machine is going to be verified entirely by unit tests against an object. A
 * context provider needs a React renderer to exercise; a subscription needs
 * nothing. Every rule about a malformed payload is therefore provable here,
 * today, without a browser.
 *
 * The subscription is three lines -- a Set of listeners and a `notify()` -- and
 * a state manager is the one place where a dependency is hardest to remove later
 * and easiest to add by accident. Three lines costs nothing to delete later.
 *
 * === THE STORE NEVER THROWS INTO A COMPONENT ===
 *
 * This is the load-bearing decision, and it is what "malformed JSON must not
 * crash the frontend state" means in practice. A payload that fails validation
 * becomes a RECORDED ISSUE on the state object. The UI keeps rendering what it
 * already had, plus a banner naming what is wrong. A store that threw would push
 * the failure into a React render path, where the only recovery is an error
 * boundary, and an error boundary around a dashboard is a blank screen: the user
 * loses the 200 widgets that DID load because one agent's rules were malformed.
 *
 * Partial data with a visible fault is strictly better than no data, and it is
 * the only presentation that stays honest about which half is missing.
 *
 * === CONCURRENCY: A STALE RESPONSE CANNOT OVERWRITE A FRESH ONE ===
 *
 * Selecting agent A then agent B fires two schema loads. If A's response lands
 * second -- and it will, whenever A is the slower request -- a store without
 * sequencing shows B's selection with A's rules. That is a UI that lies
 * confidently, which is the failure mode this whole layer exists to prevent.
 * So every load carries a generation number and a response whose generation is
 * stale is DISCARDED, not applied. This is pinned by a test rather than assumed,
 * because it is a race and races pass on a fast machine by luck.
 *
 * === BOUNDED RETENTION ===
 *
 * Cached schemas are capped. A long session clicking through every agent would
 * otherwise retain every rule document it ever saw, and each schema can hold 256
 * rules -- so unbounded retention is a leak reachable by ordinary use, which is
 * the worst time to discover one.
 */

/** The slice of `GatewayClient` this store needs. Structural, so the real client satisfies it. */
export interface PortalSource {
  fetchActiveSchemas(): Promise<AgentRosterLike>;
  fetchPortalConfig(): Promise<{ derived: boolean; config: PortalConfig }>;
  fetchSchema(id: string): Promise<AgentSchema>;
}

/**
 * A structural stand-in for `AgentRoster`.
 *
 * Declared as its own shape so this module does not import the concrete type
 * just to name it, and so a test double does not have to reproduce the class.
 */
export interface AgentRosterLike {
  readonly at: string;
  readonly total: number;
  readonly agents: readonly AgentDescriptor[];
  readonly ready: number;
  readonly stubCount: number;
}

export type StoreStatus =
  /** Nothing has been requested yet. */
  | "idle"
  /** A load is in flight and nothing has ever loaded. */
  | "loading"
  /** Data is present and every payload validated. */
  | "ready"
  /**
   * Data is present, but something was refused. This is the interesting state:
   * `agents` and `port` may be perfectly good while `issues` names the part
   * that is not.
   */
  | "degraded";

/** A transport failure, reduced to what a UI needs to choose a screen. */
export interface StoreError {
  readonly kind: GatewayFailure;
  readonly message: string;
  readonly issues: readonly ShapeIssue[];
}

/** Everything the components are allowed to read. One object, one shape, always. */
export interface UIConfig {
  readonly status: StoreStatus;
  readonly tenant: string;
  readonly title: string;
  readonly version: string;
  /** True when the backend had no stored config and generated one from the roster. */
  readonly derived: boolean;
  readonly widgets: PortalConfig["widgets"];
  readonly forms: PortalConfig["forms"];
  readonly dashboards: PortalConfig["dashboards"];
  readonly agents: readonly AgentDescriptor[];
  readonly readyCount: number;
  readonly stubCount: number;
  readonly selectedAgentId: string | null;
  /** The selected agent's rules, or null when none has loaded or validation refused it. */
  readonly schema: AgentSchema | null;
  /** Field-named faults accumulated so far. Never thrown, always rendered. */
  readonly issues: readonly ShapeIssue[];
  readonly error: StoreError | null;
  /** True while a schema request is in flight, independent of portal status. */
  readonly schemaLoading: boolean;
}

const EMPTY: UIConfig = Object.freeze({
  status: "idle",
  tenant: "",
  title: "",
  version: "",
  derived: false,
  widgets: Object.freeze([]),
  forms: Object.freeze([]),
  dashboards: Object.freeze([]),
  agents: Object.freeze([]),
  readyCount: 0,
  stubCount: 0,
  selectedAgentId: null,
  schema: null,
  issues: Object.freeze([]),
  error: null,
  schemaLoading: false,
});

/** How many agent rule documents are retained at once. */
export const SCHEMA_CACHE_LIMIT = 32;

export type Listener = (state: UIConfig) => void;

export class SchemaStore {
  #state: UIConfig = EMPTY;
  readonly #listeners = new Set<Listener>();
  /** Insertion-ordered, so eviction is "the oldest thing we still hold". */
  readonly #schemas = new Map<string, AgentSchema>();
  /** Monotonic counter; a response older than the current one is discarded. */
  #generation = 0;

  getState(): UIConfig {
    return this.#state;
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      // Idempotent by construction: `Set.delete` on an absent member is a no-op,
      // so calling the unsubscribe twice -- which React does in StrictMode --
      // cannot corrupt anything or throw.
      this.#listeners.delete(listener);
    };
  }

  /**
   * Notify every listener, isolating failures.
   *
   * One listener that throws must not prevent the others from seeing the new
   * state. Without this a single broken component can freeze the whole command
   * center on a stale frame, and the stack trace points at the store rather than
   * at the component that actually threw.
   */
  #publish(next: UIConfig): void {
    this.#state = Object.freeze(next);
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.#state);
      } catch {
        // Swallowed deliberately. The store's contract is that it delivers state,
        // not that it polices its subscribers.
      }
    }
  }

  #patch(change: Partial<UIConfig>): UIConfig {
    return { ...this.#state, ...change };
  }

  /* ------------------------------------------------------------------ */
  /* THE LOAD PATHS                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Load the portal and the roster together.
   *
   * They are two independent requests and are settled independently on purpose.
   * Waiting for both and failing together would mean a roster outage blanks a
   * perfectly good portal layout; the dashboard would have nothing to draw when
   * the thing that tells it what to draw is the part that broke.
   */
  async load(source: PortalSource): Promise<void> {
    this.#generation += 1;
    const generation = this.#generation;
    this.#publish(this.#patch({ status: "loading", error: null }));

    const [portalOutcome, rosterOutcome] = await Promise.allSettled([
      source.fetchPortalConfig(),
      source.fetchActiveSchemas(),
    ]);

    // A newer load started while this one was in flight.
    if (generation !== this.#generation) return;

    const issues: ShapeIssue[] = [];
    let widgets: PortalConfig["widgets"] = [];
    let forms: PortalConfig["forms"] = [];
    let dashboards: PortalConfig["dashboards"] = [];
    let tenant = "";
    let title = "";
    let version = "";
    let derived = false;
    let agents: readonly AgentDescriptor[] = [];
    let error: StoreError | null = null;

    if (portalOutcome.status === "fulfilled") {
      const verdict = validatePortalEnvelope(portalOutcome.value);
      if (verdict.ok) {
        widgets = verdict.value.config.widgets;
        forms = verdict.value.config.forms;
        dashboards = verdict.value.config.dashboards;
        tenant = verdict.value.config.tenant;
        title = verdict.value.config.title;
        version = verdict.value.config.version;
        derived = verdict.value.derived;
      } else {
        issues.push(...verdict.issues);
      }
    } else {
      issues.push({ path: "$.portal", reason: describe(portalOutcome.reason) });
      error = toStoreError(portalOutcome.reason);
    }

    if (rosterOutcome.status === "fulfilled") {
      // Re-validated here even though the client already validated it. The client
      // is the right place to check the wire; this is the right place to refuse
      // to build state out of something, and a store handed a hand-built object
      // in a test deserves the same scrutiny as one handed a real response.
      const verdict = validateAgentRoster(rosterOutcome.value);
      if (verdict.ok) {
        agents = verdict.value.agents;
      } else {
        issues.push(...verdict.issues);
      }
    } else {
      issues.push({ path: "$.roster", reason: describe(rosterOutcome.reason) });
      error ??= toStoreError(rosterOutcome.reason);
    }

    // Keep the selection if it still names a real agent, otherwise clear it.
    // Holding a selection for an agent that no longer exists renders an empty
    // dashboard with a heading naming something that is gone.
    const selected = this.#state.selectedAgentId;
    const selectionAlive = selected !== null && agents.some((agent) => agent.id === selected);
    this.#schemas.clear();

    this.#publish(
      this.#patch({
        widgets,
        forms,
        dashboards,
        tenant,
        title,
        version,
        derived,
        agents,
        readyCount: agents.filter((agent) => agent.maturity === "ready").length,
        stubCount: agents.filter((agent) => agent.maturity === "stub").length,
        selectedAgentId: selectionAlive ? selected : null,
        schema: null,
        schemaLoading: false,
        issues,
        error,
        status: issues.length > 0 ? "degraded" : "ready",
      }),
    );
  }

  /**
   * Load one agent's rules.
   *
   * A refusal here does NOT clear an already-rendered schema. Replacing good
   * rules with a blank panel because a refresh failed is a worse outcome than
   * showing slightly stale rules beside a banner saying they are stale.
   */
  async loadSchema(source: PortalSource, agentId: string): Promise<void> {
    if (typeof agentId !== "string" || agentId.trim() === "") return;

    this.#generation += 1;
    const generation = this.#generation;

    const cached = this.#schemas.get(agentId);
    if (cached !== undefined) {
      this.#publish(
        this.#patch({
          selectedAgentId: agentId,
          schema: cached,
          schemaLoading: false,
          // Schema-scoped faults are cleared by a schema that DID load. Portal
          // and roster faults are left alone: a successful schema load knows
          // nothing about whether the portal config is sound.
          issues: withoutSchemaIssues(this.#state.issues),
        }),
      );
      return;
    }

    this.#publish(this.#patch({ selectedAgentId: agentId, schemaLoading: true }));

    try {
      const raw = await source.fetchSchema(agentId);
      if (generation !== this.#generation) return; // superseded
      const verdict = validateAgentSchema(raw);
      if (!verdict.ok) {
        this.#publish(
          this.#patch({
            schemaLoading: false,
            // Namespaced under `$.schema` so these faults can be distinguished
            // from portal and roster faults, and so a later valid schema can
            // clear exactly its own. `validateAgentSchema` reports bare paths
            // like `$.rules[0].kind` because on its own it has no idea who is
            // asking; here we know, and the path is how that is recorded.
            issues: [
              ...withoutSchemaIssues(this.#state.issues),
              ...verdict.issues.map((issue) => ({ ...issue, path: `$.schema${issue.path}` })),
            ],
            status: "degraded",
          }),
        );
        return;
      }
      this.#retain(agentId, verdict.value);
      this.#publish(
        this.#patch({
          schema: verdict.value,
          schemaLoading: false,
          issues: withoutSchemaIssues(this.#state.issues),
          status: this.#state.status === "degraded" && portalStillFaulty(this.#state.issues) ? "degraded" : "ready",
        }),
      );
    } catch (cause) {
      if (generation !== this.#generation) return;
      this.#publish(
        this.#patch({
          schemaLoading: false,
          issues: [
            { path: `$.schema.${agentId}`, reason: describe(cause) },
            ...toStoreError(cause).issues,
          ],
          error: toStoreError(cause),
          status: "degraded",
        }),
      );
    }
  }

  /** Select without fetching. The caller decides whether to load. */
  select(agentId: string | null): void {
    if (agentId === this.#state.selectedAgentId) return;
    const cached = agentId === null ? undefined : this.#schemas.get(agentId);
    this.#publish(this.#patch({ selectedAgentId: agentId, schema: cached ?? null, schemaLoading: false }));
  }

  /** Bound the cache, evicting the oldest entry. */
  #retain(agentId: string, schema: AgentSchema): void {
    // Re-inserting moves it to the most-recent position, so a revisited agent
    // is not the next thing evicted.
    this.#schemas.delete(agentId);
    this.#schemas.set(agentId, schema);
    while (this.#schemas.size > SCHEMA_CACHE_LIMIT) {
      const oldest = this.#schemas.keys().next();
      if (oldest.done === true) break;
      this.#schemas.delete(oldest.value);
    }
  }

  }

/**
 * Drop issues belonging to an agent's schema.
 *
 * Namespaced by path prefix rather than matched by equality, because a rule
 * failure reports `$.schema.rules[3].kind` and an agent failure reports
 * `$.schema.<id>`; both are schema faults and both should clear together.
 */
function withoutSchemaIssues(issues: readonly ShapeIssue[]): readonly ShapeIssue[] {
  return issues.filter((issue) => !issue.path.startsWith("$.schema"));
}

/** True when something OUTSIDE the schema layer is still wrong. */
function portalStillFaulty(issues: readonly ShapeIssue[]): boolean {
  return withoutSchemaIssues(issues).length > 0;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Reduce a thrown value to what a UI needs.
 *
 * A non-`GatewayError` is a bug rather than a transport fact, so it is reported
 * as `malformed` rather than being given a kind that would send a user to a
 * sign-in screen for a programming error.
 */
function toStoreError(cause: unknown): StoreError {
  if (typeof cause === "object" && cause !== null && "kind" in cause && "message" in cause) {
    const typed = cause as { kind: GatewayFailure; message: string; issues?: readonly ShapeIssue[] };
    return { kind: typed.kind, message: typed.message, issues: typed.issues ?? [] };
  }
  return { kind: "malformed", message: describe(cause), issues: [] };
}