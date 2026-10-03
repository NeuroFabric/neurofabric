import {
  CREDENTIAL_HEADER,
  guard,
  httpResponse,
  loadTokens,
  type EdgeDecision,
  type EdgeRequest,
  type GatewayToken,
  type VaultProvider,
} from "../omniroute/edge-security.ts";
import type { OmniRouteGateway } from "../omniroute/omniroute-gateway.ts";
import { evaluateLive } from "../conductor/live-anomaly.ts";
import type { AgentRegistry } from "../swarm/agent-registry.ts";

/**
 * THE COMMAND CENTER API. Three reads the React UI needs, and nothing else.
 *
 * === WHY THIS FILE HAS NO HTTP SERVER IN IT ===
 *
 * Exactly the rule `platform/web/server.ts` states for itself, applied here:
 * `handle` is a pure-ish function from (method, path, headers) to a response
 * VALUE, and the transport that mounts it is someone else's problem. The reason
 * is not tidiness. A route that both decides and listens cannot be tested without
 * a socket, and the decisions in it -- is this caller allowed, what does a health
 * roll-up mean when nothing is connected -- are exactly the parts worth testing
 * exhaustively and cheaply.
 *
 * It also means there is no second set of security rules. `handle` calls the same
 * `guard` the ingress calls, with the same tokens, provisioned through the same
 * `VaultProvider`. A route that validated credentials its own way would be a
 * second control plane that drifts from the first, and the first is the one under
 * attack.
 *
 * === WHY THE READS SHARE THE INGRESS CREDENTIAL MODEL ===
 *
 * There is one namespace and one credential. A deployment that already issues
 * gateway tokens does not learn a second scheme for reading a dashboard, and an
 * operator does not hold two lists that can disagree about who is who. The cost
 * is that reads consume the same per-provider rate-limit bucket as pushes, which
 * is the correct trade: the bucket is the cheapest place to stop a UI polling loop
 * from starving a partner's events.
 *
 * A command-center credential is issued WITHOUT a scope. `guard` refuses a scoped
 * credential whose scope does not match the request, and a scoped credential is
 * scoped to a PUSH path; a reader has no such path, so the honest configuration is
 * an unscoped one restricted to this provider name.
 */

/** THE PROVIDER NAME A COMMAND-CENTER CREDENTIAL MUST BE PROVISIONED FOR. */
export const UI_PROVIDER = "command-center";

export interface UiResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

export interface UiRoutesOptions {
  readonly gateway: OmniRouteGateway;
  readonly registry: AgentRegistry;
  /**
   * WHERE THE CREDENTIALS COME FROM.
   *
   * A `VaultProvider` rather than a token array, so a route cannot be handed an
   * inline list of values by a call site -- the thing this epic exists to stop.
   */
  readonly vault: VaultProvider;
  /** Fail closed when the vault reports a rejected entry. Default true. */
  readonly strictVault?: boolean;
  /**
   * The egress configuration, when there is one.
   *
   * Optional because this router must not depend on the dispatcher to answer a
   * health question -- but PUBLISHED when supplied, so the UI can say whether
   * alerts are leaving the platform. Reporting a hardcoded `false` here would be
   * the exact fabrication the stubs exist to avoid: a dashboard asserting that
   * nothing is configured, on a deployment that has configured it.
   */
  readonly egress?: { readonly endpoints: number };
}

export interface UiRouter {
  handle(method: string, path: string, headers?: Readonly<Record<string, string | undefined>>): Promise<UiResponse>;
  /** The paths this router serves, for a 404 that can list them. */
  readonly routes: readonly string[];
}

/** One provider's health, as the UI needs to render it. */
interface ProviderHealth {
  readonly provider: string;
  readonly connected: boolean;
  readonly records: number;
  readonly open: boolean;
  readonly breachedColumns: number;
  readonly partitions: number;
  /** `ok` no breach; `degraded` breached somewhere; `critical` breached everywhere. */
  readonly state: "ok" | "degraded" | "critical";
  readonly lastEventAt: string | null;
}

/**
 * The headers every JSON response on this surface carries.
 *
 * Exported rather than duplicated, because a second copy in a sibling route file
 * is how a dashboard response ends up without `nosniff` while its sibling has it.
 * Security headers are one control plane, applied by one function.
 */
export const SECURE_JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  // The command center shows operational data, not a document: no sniffing, and
  // no framing, so a misconfigured proxy cannot turn a dashboard into a clickjack.
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};

function json(status: number, body: unknown): UiResponse {
  return { status, body, headers: { ...SECURE_JSON_HEADERS } };
}

/** THE REFUSAL, rendered by the same adapter the ingress uses. */
function refused(decision: EdgeDecision): UiResponse {
  const rendered = httpResponse(decision);
  return { status: rendered.status, body: rendered.body, headers: { ...SECURE_JSON_HEADERS, ...rendered.headers } };
}

export function createUiRoutes(options: UiRoutesOptions): UiRouter {
  const { gateway, registry } = options;
  const routes = [
    "GET /api/command-center/status",
    "GET /api/command-center/agents",
    "GET /api/command-center/providers",
  ] as const;

  /**
   * Prove the caller ONCE per request, before any of the three handlers run.
   *
   * Not per route: three routes that each proved separately would be three places
   * to forget, and the forgotten one is a dashboard exposing provider topology to
   * a stranger.
   */
  async function handle(
    method: string,
    path: string,
    headers: Readonly<Record<string, string | undefined>> = {},
  ): Promise<UiResponse> {
    const normalisedPath = path.split("?")[0] ?? path;

    const known = routes.some((route) => route.endsWith(normalisedPath));
    if (!known) {
      // 404 before proof. Naming the routes in the body of a refusal would hand a
      // stranger the map of the surface, which is the reconnaissance this edge
      // exists to prevent.
      return json(404, { error: "no such resource" });
    }
    if (method.toUpperCase() !== "GET") {
      return json(405, { error: "this surface is read-only" });
    }

    const tokens: readonly GatewayToken[] = await loadTokens(options.vault, {
      ...(options.strictVault === false ? {} : { strict: true }),
    });

    const request: EdgeRequest = {
      headers,
      provider: UI_PROVIDER,
      events: 1,
    };

    const decision = guard(request, tokens);
    if (!decision.ok) {
      return refused(decision);
    }

    // Proven once, above, for all three handlers: three routes that each proved
    // separately would be three places to forget, and the forgotten one is a
    // dashboard exposing provider topology to a stranger.
    switch (normalisedPath) {
      case "/api/command-center/status":
        return json(200, swarmStatus());
      case "/api/command-center/agents":
        return json(200, agentRoster());
      case "/api/command-center/providers":
        return json(200, providerHealth());
      default:
        return json(404, { error: "no such resource" });
    }
  }

  /**
   * LIVE SWARM STATUS.
   *
   * Reports what the platform is doing RIGHT NOW, and distinguishes a running
   * stream from a closed export. That distinction is not cosmetic: "nothing is
   * past its fence" over a closed file is a finding, and the same sentence over a
   * stream that is still running is a statement about the past tense. A UI that
   * renders both identically is lying to somebody, so `open` travels with every
   * provider rather than being inferred from a count.
   */
  function swarmStatus(): unknown {
    const providers = gateway.providerNames().map((name) => {
      const verdict = evaluateLive(gateway.snapshot(name)[0]!);
      return {
        name,
        records: verdict.records,
        open: verdict.open,
        breachedColumns: verdict.breachedColumns,
        partitions: verdict.columns.reduce((widest, c) => Math.max(widest, c.partitions), 0),
        busiestHour: verdict.busiestHour,
      };
    });
    return {
      // A status endpoint that omits its own freshness invites a stale dashboard
      // to be read as a live one.
      at: new Date().toISOString(),
      connectedProviders: providers.length,
      providers,
      // Absent unless the deployment told us. An unconfigured platform and one
      // that has not been asked are different states and are not merged.
      ...(options.egress === undefined
        ? {}
        : { egress: { endpoints: options.egress.endpoints, configured: options.egress.endpoints > 0 } }),
    };
  }

  /**
   * THE REGISTRY, PUBLISHED.
   *
   * Descriptors only. An agent's data and its findings are not on this surface,
   * because "which disciplines does this platform cover" is a question the roster
   * answers and "what did it find in my data" is a question that needs the data
   * to be in scope.
   *
   * `stubCount` is published for the same reason the stubs refuse to answer: a
   * dashboard showing three specialists must not let a reader conclude three
   * capabilities exist.
   */
  function agentRoster(): unknown {
    const roster = registry.describeAll();
    return {
      at: new Date().toISOString(),
      total: roster.length,
      ready: roster.filter((agent) => agent.maturity === "ready").length,
      stubCount: roster.filter((agent) => agent.maturity === "stub").length,
      agents: roster,
    };
  }

  /**
   * PROVIDER HEALTH.
   *
   * Rolls each provider's verdict up to one word, and the word is chosen so that
   * "critical" cannot mean two things. A breach in every partition is a fleet
   * problem; a breach in one of forty is a replica problem, and calling the
   * second one critical is how an on-call rotation learns to ignore the word.
   */
  function providerHealth(): unknown {
    // The provider NAME comes from the gateway's own roster, never recovered from
    // a partition label: a snapshot is per-partition and a provider is not.
    const providers: ProviderHealth[] = gateway.providerNames().map((name) => {
      const verdict = evaluateLive(gateway.snapshot(name)[0]!);
      const breached = verdict.columns.filter((column) => column.breached);
      const universal = breached.length > 0 && breached.every((column) => column.breachedEverywhere);
      return {
        provider: name,
        // True because the name came from the roster of ATTACHED providers. A
        // provider on the roster with no events is connected and idle, which is a
        // different state from disconnected and is not reported as one.
        connected: true,
        records: verdict.records,
        open: verdict.open,
        breachedColumns: verdict.breachedColumns,
        partitions: verdict.columns.reduce((widest, c) => Math.max(widest, c.partitions), 0),
        state: breached.length === 0 ? "ok" : universal ? "critical" : "degraded",
        lastEventAt: verdict.at,
      };
    });
    return { at: new Date().toISOString(), providers, total: providers.length };
  }

  return { handle, routes };
}

/** Re-exported so a mounting server has the header name without a second import. */
export { CREDENTIAL_HEADER };
