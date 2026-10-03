import { StreamBroker, type BrokerSnapshot, type BrokerRecord } from "../conductor/stream-broker.ts";
import { evaluateLive, liveFindings, type LiveVerdict } from "../conductor/live-anomaly.ts";
import { guard, TokenBucket, type EdgeDecision, type EdgeRequest, type GatewayToken } from "./edge-security.ts";
import type { DynamicAgent, DynamicAgentRegistry } from "../swarm/dynamic-registry.ts";
import type { DiagnosticResult, TelemetryEvent } from "../swarm/diagnostic-agent.ts";

/**
 * TENANT ROUTING: from a proven credential to the customer's own agents.
 *
 * === THE CORRELATION IS THE WHOLE POINT, AND IT IS ONE LOOKUP ===
 *
 * `guard` has already proved who the caller is and returned the token's id. That
 * id IS the tenant. So routing is a single map lookup against the live registry,
 * and it happens AFTER proof -- never before. A router that resolved a tenant from
 * anything in the request body or the URL would be a tenant parameter an attacker
 * chooses, and the rest of this class would be security theatre.
 *
 * Agents are resolved from the registry on EVERY route rather than cached in a
 * table. A cache would need invalidation, and an invalidation bug presents as
 * "the customer's new rule never fired", which is the hardest failure in a product
 * whose whole promise is that a written rule is live. A Map lookup is O(1); there
 * is no cheaper answer than the right one.
 *
 * === EXCLUSIVELY, AND WHAT THAT COSTS ===
 *
 * A tenant's events reach that tenant's agents and no others. There is no
 * broadcast, no shared lane, and no cross-tenant aggregate: the isolation is
 * structural (separate lane, separate agent set) rather than a filter applied
 * after the fact. A filter is one forgotten predicate away from a leak; a separate
 * queue cannot leak because there is nothing shared to leak through.
 *
 * === WHY THERE IS A BOUNDED QUEUE PER LANE ===
 *
 * Because "exclusively to it" is only true while the lane keeps up. If events
 * arrive faster than the agent evaluates them, an unbounded queue is a memory leak
 * reachable by anyone holding a credential, and it is reached by sending ordinary
 * traffic during an incident. So each lane has a hard depth: past it, events are
 * DROPPED and COUNTED, the push reports that it dropped, and the lane's verdict
 * says so. Dropping a telemetry event under sustained overload is the right failure
 * for a diagnostic platform: the engine reports what it saw and admits what it
 * missed, rather than growing until it is killed.
 *
 * === WHY VERDICTS ARE KEPT IN A RING, NOT A LIST ===
 *
 * Same reason, one level up. A per-tenant history is exactly the kind of unbounded
 * array a long-lived process accumulates, and a portal asking for "the last
 * verdict" does not need the four thousand before it.
 */

/** Events a lane will hold before it starts dropping. Per tenant. */
const DEFAULT_LANE_DEPTH = 4096;
/** Verdicts a lane keeps for its portal. Per tenant. */
const DEFAULT_VERDICT_RING = 32;

export interface TenantRouteOutcome {
  readonly tenant: string;
  readonly accepted: boolean;
  /** The agents this event was handed to. Empty when the tenant has no agent for the stream. */
  readonly agentIds: readonly string[];
  readonly dropped?: boolean;
  /** True when the tenant has no agent at all, so the caller learns why nothing happened. */
  readonly unrouted?: boolean;
}

/** ONE TENANT'S LANE. Private because its whole job is to be a separate queue. */
class TenantLane {
  private queue: TelemetryEvent[] = [];
  private agents: readonly DynamicAgent[];
  private readonly verdicts: DiagnosticResult[] = [];
  private readonly tenant: string;
  private readonly depth: number;
  private readonly ring: number;
  private wake: (() => void) | null = null;
  private draining = false;
  private accepted = 0;
  private dropped = 0;
  private unrouted = 0;

  // Not a parameter property: Node's strip-only type erasure cannot erase one.
  constructor(tenant: string, agents: DynamicAgent[], depth: number, ring: number) {
    this.tenant = tenant;
    this.agents = agents;
    this.depth = depth;
    this.ring = ring;
  }

  get agentIds(): readonly string[] {
    return this.agents.map((agent) => agent.id);
  }

  /** Swap in a freshly resolved agent set, so a hot-loaded schema takes effect now. */
  reconfigure(agents: readonly DynamicAgent[]): void {
    // Compared rather than assigned unconditionally. Every event re-resolves the
    // agent set (that is how a hot-loaded schema is picked up with no cache to
    // invalidate), and assigning an identical array on each one would churn the
    // lane's agent list at the event rate for no observable difference.
    if (this.agents.length === agents.length) {
      let identical = true;
      for (let i = 0; i < agents.length; i += 1) {
        if (this.agents[i]?.id !== agents[i]?.id) { identical = false; break; }
      }
      if (identical) return;
    }
    this.agents = agents;
  }

  push(event: TelemetryEvent): boolean {
    if (this.queue.length >= this.depth) {
      this.dropped += 1;
      return false;
    }
    this.queue.push(event);
    this.accepted += 1;
    const wake = this.wake;
    this.wake = null;
    wake?.();
    return true;
  }

  /**
   * Start a drain if one is not already running. Returns the in-flight promise, or
   * undefined when a drain is already under way.
   *
   * The `draining` flag is the whole of the concurrency control, and it matters:
   * two overlapping drains would each pull from the same queue and each report
   * half the events, so a verdict would describe a fraction of what happened while
   * claiming to describe all of it.
   *
   * The drain is a LOOP, not a single pass, and that is not an optimisation. An
   * event that arrives while a drain is running lands in a fresh queue; if the
   * drain took one batch and stopped, that event would sit there until something
   * else happened to arrive, and the tenant would silently stop being diagnosed
   * at exactly the moment they were busiest.
   */
  startDrain(): Promise<void> | undefined {
    if (this.draining || this.queue.length === 0) return undefined;
    this.draining = true;
    const lane = this;
    return (async () => {
      try {
        while (lane.queue.length > 0) {
          const events = lane.queue;
          lane.queue = [];
          if (lane.agents.length === 0) {
            lane.unrouted += events.length;
            continue;
          }
          for (const agent of lane.agents) {
            // One diagnose per agent over the SAME drained slice. Streaming the
            // slice separately per agent would re-read it N times from memory.
            const stream = (async function* () {
              for (const event of events) yield event;
            })();
            lane.pushVerdict(await agent.diagnose({ prompt: "", stream }));
          }
        }
      } finally {
        lane.draining = false;
      }
    })();
  }

  private pushVerdict(result: DiagnosticResult): void {
    this.verdicts.push(result);
    while (this.verdicts.length > this.ring) this.verdicts.shift();
  }

  get pending(): number {
    return this.queue.length;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  /** Recent verdicts, oldest first. Bounded by the ring. */
  history(): readonly DiagnosticResult[] {
    return [...this.verdicts];
  }

  /** The most recent verdict, or undefined before the first drain. */
  latest(): DiagnosticResult | undefined {
    return this.verdicts[this.verdicts.length - 1];
  }

  stats(): Record<string, number> {
    return {
      accepted: this.accepted,
      dropped: this.dropped,
      unrouted: this.unrouted,
      pending: this.queue.length,
      agents: this.agents.length,
      verdictsRetained: this.verdicts.length,
    };
  }
}

export interface TenantRouterOptions {
  readonly laneDepth?: number;
  readonly verdictRing?: number;
}

/**
 * THE ROUTING MAP. Credential to customer to agents.
 *
 * Resolves a tenant's agents from the registry on every route, so a schema created
 * a moment ago is already reachable and no invalidation can forget it.
 */
export class TenantRouter {
  private readonly lanes = new Map<string, TenantLane>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly registry: DynamicAgentRegistry;
  private readonly depth: number;
  private readonly ring: number;
  private routed = 0;

  // Not a parameter property: Node's strip-only type erasure cannot erase one, and
  // this repository has now been reminded of that several times over.
  constructor(registry: DynamicAgentRegistry, options: TenantRouterOptions = {}) {
    this.registry = registry;
    this.depth = options.laneDepth ?? DEFAULT_LANE_DEPTH;
    this.ring = options.verdictRing ?? DEFAULT_VERDICT_RING;
  }

  /** The agents a tenant owns that declare interest in `stream`, or every agent if none declare any. */
  agentsFor(tenant: string, stream?: string): readonly DynamicAgent[] {
    const owned = this.registry.ids(tenant)
      .map((composite) => this.registry.getByCompositeId(composite))
      .filter((agent): agent is DynamicAgent => agent !== undefined);
    if (owned.length === 0) return [];
    if (stream === undefined || stream === "") return owned;
    // A schema that declared no streams consumes everything; one that declared some
    // consumes only those. The registry's own rule, reused rather than restated,
    // because two implementations of "which streams is this agent for" would
    // disagree at exactly the moment it mattered.
    const interested = owned.filter((agent) => agent.schema.streams.length === 0
      || agent.schema.streams.includes(stream));
    return interested;
  }

  /** Route one PROVEN tenant's event to that tenant's agents, and nothing else. */
  route(tenant: string, event: TelemetryEvent): TenantRouteOutcome {
    const stream = event.partition ?? event.fields.stream ?? event.fields.partition;
    const agents = this.agentsFor(tenant, stream);

    const lane = this.laneFor(tenant);
    lane.reconfigure(agents);

    if (agents.length === 0) {
      // Counted and reported. Swallowing an event for a tenant with no agent is how
      // "the platform received nothing" becomes indistinguishable from "the
      // platform received nothing because it dropped it".
      return { tenant, accepted: false, agentIds: [], unrouted: true };
    }

    const accepted = lane.push(event);
    this.routed += 1;
    this.track(lane.startDrain());
    return {
      tenant,
      accepted,
      agentIds: lane.agentIds,
      ...(accepted ? {} : { dropped: true }),
    };
  }

  private laneFor(tenant: string): TenantLane {
    const existing = this.lanes.get(tenant);
    if (existing !== undefined) return existing;
    const lane = new TenantLane(tenant, [], this.depth, this.ring);
    this.lanes.set(tenant, lane);
    return lane;
  }

  private track(promise: Promise<void> | undefined): void {
    if (promise === undefined) return;
    this.inFlight.add(promise);
    void promise.finally(() => { this.inFlight.delete(promise); });
  }

  /**
   * Await every drain, including drains started by one.
   *
   * Loops because a drain can finish and leave events queued behind it -- an event
   * that arrived while the previous drain was running. Awaiting the first pass
   * only would return before those were judged, and a caller would read a verdict
   * that does not describe what it just pushed.
   */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  /** The most recent verdict for a tenant, or undefined before the first drain. */
  latest(tenant: string): DiagnosticResult | undefined {
    return this.lanes.get(tenant)?.latest();
  }

  history(tenant: string): readonly DiagnosticResult[] {
    return this.lanes.get(tenant)?.history() ?? [];
  }

  stats(tenant?: string): Record<string, number> {
    if (tenant !== undefined) {
      return this.lanes.get(tenant)?.stats() ?? { accepted: 0, dropped: 0, unrouted: 0, pending: 0, agents: 0, verdictsRetained: 0 };
    }
    let accepted = 0;
    let dropped = 0;
    let unrouted = 0;
    for (const lane of this.lanes.values()) {
      const stats = lane.stats();
      accepted += stats.accepted ?? 0;
      dropped += stats.dropped ?? 0;
      unrouted += stats.unrouted ?? 0;
    }
    return { tenants: this.lanes.size, routed: this.routed, accepted, dropped, unrouted };
  }
}


/**
 * OMNIROUTE: the universal ingress for live events, and the single door every
 * provider comes through.
 *
 * === A NAME COLLISION WORTH STATING UP FRONT ===
 *
 * This repository already contains an `OmniRoute` under `OmniRoute/@omniroute/`:
 * an INFERENCE gateway that routes LLM requests to whichever provider serves a
 * model. That is a different concern from this one, which routes EVENTS into a
 * live analysis. They share a name and nothing else -- no shared types, no shared
 * protocol, no shared transport -- and a reader who assumes otherwise will look
 * for a Kafka consumer in a TypeScript HTTP proxy and not find one. This module
 * is deliberately self-contained so that the two can diverge without coupling.
 *
 * === WHY A GATEWAY RATHER THAN "JUST CALL THE BROKER" ===
 *
 * Because the broker is a data structure and a gateway is a CONTRACT. Every
 * provider -- a webhook, a mobile app, a Kafka topic -- has the same three
 * problems, and each has solved them differently at every integration before:
 *
 *   1. WHICH COLUMNS ARE THE KEY AND THE TIME? A provider knows its own schema;
 *      the analysis wants a ranking column and an instant. Making every provider
 *      guess means the same event is ranked differently by two doors.
 *   2. WHEN DO I ALERT? Once per event would be unusable. The gateway alerts on a
 *      NEW BREACH and remembers what it has already said, so a condition that
 *      persists is one alert rather than ten thousand.
 *   3. WHAT DO I TELL THE OPERATOR? Each provider invented its own phrasing, and
 *      the phrases drift until "3 outliers" means something different in two
 *      dashboards. One sentence, written once.
 *
 * A provider that supplies only its events and a schema hint gets all three for
 * free, and two providers carrying the same events cannot disagree about what they
 * mean -- which is the whole property this product has been built on since the
 * first duplicated parser.
 *
 * === WHAT IT DOES NOT DO ===
 *
 * It does not persist, authenticate, rate-limit or retry. Those belong at the
 * edge, in front of this, and a gateway that quietly owns them becomes a thing
 * that must be understood before a single event can be pushed through it. What
 * it does own is the part that must be identical everywhere: what an event is,
 * when to speak, and what to say.
 */

/** What a provider must supply to be routable. */
export interface ProviderBinding {
  /** Stable name, used in alerts so an operator knows which door spoke. */
  readonly name: string;
  /** The column the analysis should rank by. Null when the provider has no key. */
  readonly keyColumn?: string;
  /** The column carrying the event instant. Null when events are undated. */
  readonly timeColumn?: string;
  /** Extra fields to expose as columns beyond the standard pair. */
  readonly fields?: readonly string[];
}

export interface OmniRouteEvent {
  readonly fields: Readonly<Record<string, string>>;
  readonly at?: number;
}

/** What a subscriber receives. */
export interface SwarmAlert {
  readonly provider: string;
  readonly verdict: LiveVerdict;
  readonly text: string;
  readonly at: string;
  /** True the first time this condition is seen; false on a repeat. */
  readonly firstObservation: boolean;
}

export interface GatewayOptions {
  /** Bound a sliding window per provider. Omit for cumulative. */
  readonly windowMs?: number;
  readonly last?: number;
  /**
   * THE CREDENTIALS THIS GATEWAY ACCEPTS.
   *
   * Empty by default, and empty means the gateway REFUSES EVERYTHING. That is
   * deliberate and it is the safe direction: a deployment that forgets to
   * provision a token gets a silent, closed ingress rather than an open one. An
   * ingress that admits by default is an ingress nobody notices is open until
   * someone finds the logs.
   */
  readonly tokens?: readonly GatewayToken[];
  /**
   * THE RATE LIMITER. Optional, and absent means NO LIMIT rather than a default
   * one.
   *
   * A default would be a guess about what is affordable, made once and baked into
   * every deployment. A gateway that is not configured for throttling says so by
   * having none, which is visible; one that silently applies an arbitrary ceiling
   * is discovered by a customer. See `TokenBucket` for why the limit is
   * per-replica.
   */
  readonly limiter?: TokenBucket;
  /**
   * Called on every alert. Optional because a gateway with no subscribers is a
   * perfectly ordinary thing -- a service that pushes events and reads snapshots
   * on demand rather than being told what to look at.
   */
  readonly onAlert?: (alert: SwarmAlert) => void;
}

/**
 * A fingerprint for "the same condition, still true". Deliberately coarse: column
 * plus which fence was crossed, so a breach that gets WORSE re-alerts and one that
 * merely persists does not.
 */
function fingerprint(provider: string, verdict: LiveVerdict): string[] {
  return verdict.columns
    .filter((column) => column.breached)
    .map((column) => `${provider}:${column.column}:${column.max !== null ? "high" : "low"}`);
}

export class OmniRouteGateway {
  private readonly providers = new Map<string, { broker: StreamBroker; binding: ProviderBinding }>();
  private readonly subscribers = new Set<(alert: SwarmAlert) => void>();
  private readonly announced = new Set<string>();
  private readonly options: GatewayOptions;
  /**
   * THE PUSH CHANNEL, one per provider.
   *
   * The first version attached a fresh one-shot partition on every `push`, which
   * meant the fortieth webhook call produced forty partitions. Every counter in
   * the broker is PER PARTITION, so the same event stream would be ranked as
   * forty unrelated series and no ranking would mean anything.
   *
   * So a provider has ONE channel, opened on first use, and pushes queue into it.
   * A webhook is a single event with no end, which is precisely the case a file
   * reader cannot serve and the reason this gateway exists.
   */
  private readonly channels = new Map<string, {
    queue: OmniRouteEvent[];
    wake: (() => void) | null;
    closed: boolean;
  }>();
  /** How many bulk streams each provider has opened, so each gets its own partition. */
  private readonly streams = new Map<string, number>();

  /**
   * THE TENANT ROUTER, when one is attached.
   *
   * Attaching one REDIRECTS admitted pushes: they go to the proven tenant's own
   * agents instead of to that provider's legacy broker. Stated as a behaviour
   * change rather than buried, because the alternative -- running both paths
   * silently -- would mean every tenant's events sat in two places, one of them
   * with no tenant boundary at all.
   */
  private tenantRouter: TenantRouter | undefined;

  // Not a parameter property: Node's strip-only type erasure cannot erase them,
  // which this repository has now learned four times over.
  constructor(options: GatewayOptions = {}) {
    this.options = options;
  }

  /**
   * ATTACH A PROVIDER. Once attached, everything it pushes is routed, ranked and
   * judged identically to everything every other provider pushes.
   */
  connect(binding: ProviderBinding): StreamBroker {
    if (this.providers.has(binding.name)) {
      throw new Error(`provider ${binding.name} is already connected`);
    }
    const broker = new StreamBroker({
      keyColumn: binding.keyColumn,
      timeColumn: binding.timeColumn,
      mode: { ...(this.options.windowMs === undefined ? {} : { windowMs: this.options.windowMs }), ...(this.options.last === undefined ? {} : { last: this.options.last }) },
    });
    this.providers.set(binding.name, { broker, binding });
    return broker;
  }

  /** The broker behind a provider, for callers that want to push a whole stream. */
  brokerFor(name: string): StreamBroker | undefined {
    return this.providers.get(name)?.broker;
  }

  /**
   * THE CONNECTED PROVIDER NAMES, in the order they were attached.
   *
   * Added because a reader that needs to know WHICH providers exist had no way to
   * ask. The tempting shortcut -- recovering the name from a partition's label,
   * which looks like `push:payments` -- was rejected: it is a string-prefix
   * dependency on an internal detail, and it silently returns the wrong name the
   * day a second prefix is added. A snapshot is per-partition; a provider is not.
   */
  providerNames(): readonly string[] {
    return [...this.providers.keys()];
  }

  /**
   * ATTACH A TENANT ROUTER.
   *
   * Separate from the constructor because the router needs a registry, and a
   * gateway that knows about a registry is a gateway that knows about agents. The
   * wiring is explicit so the dependency is visible at the call site rather than
   * inferred from a configuration object.
   */
  attachTenantRouter(router: TenantRouter): () => void {
    this.tenantRouter = router;
    return () => {
      if (this.tenantRouter === router) this.tenantRouter = undefined;
    };
  }

  /**
   * ROUTE AN EVENT TO A PROVEN TENANT, WITHOUT THE PROVIDER BROKER.
   *
   * Takes the same `EdgeRequest` the ingress does, so the proof happens here
   * exactly once and by exactly the same function. The decision is returned rather
   * than thrown, for the same reason `pushAdmitted` does: a refused push is an
   * ordinary outcome of a public ingress.
   */
  pushToTenant(request: EdgeRequest, event: OmniRouteEvent): EdgeDecision & {
    readonly routing?: TenantRouteOutcome;
  } {
    const decision = guard(request, this.options.tokens ?? [], this.options.limiter);
    if (!decision.ok) return decision;
    const tenant = decision.tokenId;
    if (tenant === undefined || this.tenantRouter === undefined) return decision;
    const routing = this.tenantRouter.route(tenant, toTelemetryEvent(event));
    return { ...decision, routing };
  }

  /**
   * THE EDGE CALL. Prove the caller, then push its event.
   *
   * The decision is RETURNED rather than thrown. A refused push is an ordinary
   * outcome of a public ingress -- a wrong key, a revoked token, a partner's
   * outage spamming us -- and an exception for each one turns a rate-limited
   * webhook into a stack trace in somebody else's logs.
   *
   * The check runs BEFORE the push, so a refused event never reaches the broker
   * and never costs the engine anything. That ordering is the entire point of an
   * edge: the maths is the expensive part, and it must not run for strangers.
   *
   * With a tenant router attached the event goes to the proven TENANT's agents and
   * to nothing else; without one it goes to the provider broker as it always has.
   */
  pushAdmitted(request: EdgeRequest, event: OmniRouteEvent): EdgeDecision {
    const decision = guard(request, this.options.tokens ?? [], this.options.limiter);
    if (!decision.ok) return decision;
    if (this.tenantRouter !== undefined && decision.tokenId !== undefined) {
      this.tenantRouter.route(decision.tokenId, toTelemetryEvent(event));
      return decision;
    }
    this.push(request.provider, event);
    return decision;
  }

  /** Just the decision, for a caller that wants to check before it builds a payload. */
  admit(request: EdgeRequest): EdgeDecision {
    return guard(request, this.options.tokens ?? [], this.options.limiter);
  }

  /**
   * PUSH ONE EVENT. The primitive every provider is built on, and the reason a
   * webhook handler is three lines rather than a page.
   *
   * INTERNAL: it does not check the caller. Use `pushAdmitted` at any ingress,
   * or `admit` first -- this method exists for the provider adapters and for
   * tests, and leaving the check off the low-level primitive is what keeps one
   * code path for the push itself.
   */
  push(provider: string, event: OmniRouteEvent): void {
    const attached = this.providers.get(provider);
    if (attached === undefined) throw new Error(`provider ${provider} is not connected`);
    const channel = this.channelFor(provider, attached.broker);
    channel.queue.push(event);
    // Wake the consumer, which is parked waiting for work rather than polling.
    const wake = channel.wake;
    channel.wake = null;
    wake?.();
  }

  private channelFor(provider: string, broker: StreamBroker) {
    const existing = this.channels.get(provider);
    if (existing !== undefined) return existing;
    const channel = { queue: [] as OmniRouteEvent[], wake: null as (() => void) | null, closed: false };
    this.channels.set(provider, channel);
    broker.attach(`push:${provider}`, (async function* () {
      for (;;) {
        if (channel.queue.length === 0) {
          if (channel.closed) return;
          await new Promise<void>((resolve) => { channel.wake = resolve; });
          continue;
        }
        const event = channel.queue.shift()!;
        yield { fields: event.fields, ...(event.at === undefined ? {} : { at: event.at }) } as BrokerRecord;
      }
    })());
    return channel;
  }

  /** Stop accepting pushes on a provider's channel, letting it drain and close. */
  closePushes(provider: string): void {
    const channel = this.channels.get(provider);
    if (channel === undefined) return;
    channel.closed = true;
    channel.wake?.();
  }

  /**
   * PUSH A WHOLE STREAM from a provider. `source` is any async iterable of
   * events, which is the shape Kafka, a socket, and a file reader all already
   * have -- so a provider adapter is a translation and not a framework.
   *
   * Each call opens its OWN partition, numbered rather than reused. A provider
   * that attaches a second stream -- a replay, a second consumer group, a test
   * feeding two batches -- collided on the partition name before, and the
   * collision either threw or, worse, silently merged two streams into one
   * ranking.
   */
  stream(provider: string, source: AsyncIterable<OmniRouteEvent>): StreamBroker {
    const attached = this.providers.get(provider);
    if (attached === undefined) throw new Error(`provider ${provider} is not connected`);
    const sequence = this.streams.get(provider) ?? 0;
    this.streams.set(provider, sequence + 1);
    attached.broker.attach(`stream:${provider}:${sequence}`, (async function* () {
      for await (const event of source) {
        yield { fields: event.fields, ...(event.at === undefined ? {} : { at: event.at }) } as BrokerRecord;
      }
    })());
    return attached.broker;
  }

  /** SUBSCRIBE TO ALERTS. Returns an unsubscribe, because a leaked subscriber is a leak. */
  subscribe(handler: (alert: SwarmAlert) => void): () => void {
    this.subscribers.add(handler);
    if (this.options.onAlert !== undefined) this.subscribers.add(this.options.onAlert);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /** A SNAPSHOT PER PROVIDER, available whenever anyone asks. */
  snapshot(provider?: string): BrokerSnapshot[] {
    const names = provider === undefined ? [...this.providers.keys()] : [provider];
    const out: BrokerSnapshot[] = [];
    for (const name of names) {
      const attached = this.providers.get(name);
      if (attached !== undefined) out.push(attached.broker.snapshot());
    }
    return out;
  }

  /**
   * JUDGE NOW, and alert on anything NEW.
   *
   * The distinction between `firstObservation` and a repeat is the entire alert
   * policy. A breach that persists across ten thousand snapshots is ONE incident;
   * alerting on each of them is how a monitor gets muted, and a muted monitor
   * misses the one that mattered.
   */
  evaluate(provider?: string): SwarmAlert[] {
    const alerts: SwarmAlert[] = [];
    for (const snapshot of this.snapshot(provider)) {
      const verdict = evaluateLive(snapshot);
      const current = new Set(fingerprint(provider ?? "unknown", verdict));
      for (const key of current) {
        const firstObservation = !this.announced.has(key);
        this.announced.add(key);
        const text = liveFindings(verdict);
        const alert: SwarmAlert = {
          provider: provider ?? snapshot.partitions[0]?.name ?? "unknown",
          verdict,
          text,
          at: snapshot.at,
          firstObservation,
        };
        alerts.push(alert);
        if (firstObservation) {
          for (const subscriber of this.subscribers) subscriber(alert);
        }
      }
    }
    return alerts;
  }

  /** The verdict for a provider, without the alert policy. */
  verdict(provider: string): LiveVerdict | undefined {
    const snapshot = this.snapshot(provider)[0];
    return snapshot === undefined ? undefined : evaluateLive(snapshot);
  }
}

export function createGateway(options: GatewayOptions = {}): OmniRouteGateway {
  return new OmniRouteGateway(options);
}

/**
 * ADAPT A GATEWAY EVENT TO THE SWARM'S EVENT SHAPE.
 *
 * Structural, not a translation: the two types were declared to be the same shape,
 * which is what lets a provider adapter be a widening rather than a mapper.
 *
 * The stream name is lifted onto `partition` when the event carries one, because
 * that is what a tenant's schema declares interest in. Lifting it here rather than
 * leaving the agent to dig into `fields` means the routing decision and the
 * evaluation decision read the stream from the same place.
 */
function toTelemetryEvent(event: OmniRouteEvent): TelemetryEvent {
  const stream = event.fields.stream ?? event.fields.partition;
  return {
    fields: event.fields,
    ...(event.at === undefined ? {} : { at: event.at }),
    ...(stream === undefined ? {} : { partition: stream }),
  };
}