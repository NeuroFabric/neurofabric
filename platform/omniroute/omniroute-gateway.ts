import { StreamBroker, type BrokerSnapshot, type BrokerRecord } from "../conductor/stream-broker.ts";
import { evaluateLive, liveFindings, type LiveVerdict } from "../conductor/live-anomaly.ts";
import { guard, type EdgeDecision, type EdgeRequest, type GatewayToken } from "./edge-security.ts";

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
   */
  pushAdmitted(request: EdgeRequest, event: OmniRouteEvent): EdgeDecision {
    const decision = guard(request, this.options.tokens ?? []);
    if (!decision.ok) return decision;
    this.push(request.provider, event);
    return decision;
  }

  /** Just the decision, for a caller that wants to check before it builds a payload. */
  admit(request: EdgeRequest): EdgeDecision {
    return guard(request, this.options.tokens ?? []);
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