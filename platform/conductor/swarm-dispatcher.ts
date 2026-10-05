/**
 * THE SWARM DISPATCHER: ONE EVENT, THE RIGHT SWARM, AND A LEDGER FOR THE REST.
 *
 * === WHAT THIS IS FOR ===
 *
 * The envelope made every source look the same. This is what that buys: a SecOps
 * agent that knows about `auth.*` and an SRE agent that knows about `infra.pod.*`
 * are two modules that share nothing, and adding a FinOps agent touches neither of
 * them. The registry below is the entire coupling surface, and it is a list of
 * strings.
 *
 * === AND WHAT IT IS NOT ===
 *
 * It does not know what SecOps means, does not transform the event for whoever
 * receives it, and does not decide whether an agent is healthy. It routes. Anything
 * that decides is a second decision path, and two decision paths disagree exactly
 * when it is most expensive.
 *
 * === THE ROUTING DECISION IS A PREFIX AND A TAG, AND BOTH ARE EXACT ===
 *
 * `metricName` matches by prefix. `auth.` matches `auth.login.failed` and NOT
 * `oauth.token.refresh`, because a prefix match on a bare string is exactly how a
 * FinOps agent ends up being handed authentication traffic and confidently
 * summarising it. The trailing dot is required in the pattern rather than implied:
 * an agent that registers `auth` has said it wants everything beginning with those
 * four letters, and it gets them.
 *
 * Metadata tags are equality, never prefix. Same reasoning: a tag is a label
 * somebody chose, and choosing `env:prod` must not also capture `env:production`.
 *
 * === WHY AN EVENT CAN GO TO MORE THAN ONE AGENT ===
 *
 * Because `auth.login.failed` with `{env:prod}` is genuinely both a SecOps event and
 * a FinOps one — an authentication outage has a cost. Fan-out is the honest answer;
 * picking a single winner is a claim about which one mattered more, and this module
 * is not entitled to make it.
 *
 * The consequence is that every agent MUST be idempotent about delivery, and that is
 * stated on the interface rather than left to be discovered by whichever agent is
 * written second.
 *
 * === FAIL CLOSED, AND FAIL LOUD, AND FAIL ONCE ===
 *
 * Three separate promises, because a dispatcher is a component everything depends
 * on and the interesting failures are all in how it handles bad input:
 *
 *   1. **No match is not an error.** It goes to the dead-letter queue with the event
 *      and the reason. Dropping it silently is how a swarm quietly stops covering a
 *      domain, and nobody notices until a breach nobody was watching for happens.
 *   2. **A handler that throws does not take the dispatcher down.** One misbehaving
 *      agent must not cost every other agent its events. The failure is attributed
 *      and counted, and the event still goes wherever else it was destined.
 *   3. **Delivery is bounded.** A registry is walked once, registration is refused
 *      after a cap, and the dispatcher refuses to dispatch once stopped. There is no
 *      path by which an event causes unbounded work, because the input is an
 *      untrusted firehose and the classic failure here is a registry that grows
 *      through a re-registration loop.
 *
 * === AND NO RECURSION, EVER ===
 *
 * An agent's handler may dispatch again. That is a feature (an agent that fans out
 * is a legitimate design), and it is bounded by `maxHops`: after two hops the event
 * is dead-lettered with `HOP_LIMIT`. Without that bound a handler that re-dispatches
 * its own input is an infinite loop with no stack overflow, because each hop is a
 * fresh call — which is the worst kind of loop to debug.
 */

import {
  validateUniversalTelemetryEvent,
  type UniversalTelemetryEvent,
  type TelemetryMetadata,
} from "../ingestion/universal-envelope.ts";

/** Why an event did not reach an agent. Recorded on the dead-letter entry. */
export type DeadLetterReason =
  /** No registered agent matched. The common case, and not a fault. */
  | "no-match"
  /** A handler threw. The event is preserved and the agent is blamed by name. */
  | "handler-threw"
  /** Re-dispatch depth exceeded. A cycle between two agents. */
  | "hop-limit"
  /** The dispatcher was stopped. */
  | "stopped";

export interface DeadLetterEntry {
  readonly reason: DeadLetterReason;
  readonly at: string;
  /** The event as it arrived. Preserved whole, because a DLQ that drops the payload
   *  is a DLQ you cannot replay from. */
  readonly event: UniversalTelemetryEvent;
  /** Agent name, when one is to blame. Never a stack: it is not an SSE payload. */
  readonly agent?: string;
  readonly detail?: string;
}

/** An agent's interest. Everything the dispatcher knows about any agent. */
export interface SwarmRegistration {
  /**
   * Metric-name PREFIXES. `auth.` matches `auth.login.failed`.
   *
   * An empty list means "matches nothing by prefix" — it does NOT mean "everything".
   * A registration that wants everything has to say `""`, so a mistake is loud
   * rather than being every agent's default.
   */
  readonly metricPrefixes: readonly string[];
  /** Metadata tags that must match by EXACT equality. All of them, not any. */
  readonly tags?: Readonly<Record<string, string>>;
  /**
   * Deliver the event to this agent.
   *
   * Called at most once per event per hop. May be async; may throw. May fan out
   * further through `context.redispatch`, which carries the hop count with it.
   */
  readonly handle: (event: UniversalTelemetryEvent, context: SwarmContext) => void | Promise<void>;
}

/**
 * WHAT A HANDLER IS GIVEN, AND WHY REDISPATCH IS A CALLBACK RATHER THAN A CALL.
 *
 * The hop count used to be a parameter on `dispatch`, defaulting to zero. That looks
 * bounded and is not: a handler calling `dispatcher.dispatch(event)` resets the
 * counter to 0, so a self-feeding agent looped 2366 times before the test that
 * exists to catch exactly that failed. A bound a caller can reset with the default
 * argument is not a bound.
 *
 * So the count is threaded through a closure the dispatcher builds, and re-dispatch
 * is only reachable through it. It is also concurrency-safe in a way a shared
 * depth counter is not — two unrelated dispatches in flight at once cannot inflate
 * each other's budget.
 */
export interface SwarmContext {
  /** This agent's depth. 0 on first delivery. */
  readonly hop: number;
  /**
   * Re-dispatch, already carrying this hop plus one.
   *
   * Fan-out is a legitimate design, so this exists. What it cannot do is restart the
   * chain: past `maxHops` the event is dead-lettered with `HOP_LIMIT`.
   */
  redispatch(event?: unknown): Promise<DispatchOutcome>;
}

/** What one dispatch did. The per-hop view. */
export interface DispatchOutcome {
  readonly eventId: string;
  /** Agents the event was delivered to. */
  readonly delivered: readonly string[];
  /** Agents that matched and then failed. Counted, and named. */
  readonly failed: readonly string[];
  /** True when the event matched nobody and went to the dead-letter queue. */
  readonly deadLettered: boolean;
  readonly reason?: DeadLetterReason;
}

export interface DispatcherStats {
  readonly dispatched: number;
  readonly matched: number;
  readonly unmatched: number;
  readonly handlerFailures: number;
  readonly hopLimitExceeded: number;
  readonly registered: number;
  readonly deadLetters: number;
  readonly dlqDepth: number;
}

export interface SwarmDispatcherOptions {
  readonly maxHops?: number;
  /** Cap on registrations. See the header: the registry is walked per event. */
  readonly maxAgents?: number;
  readonly now?: () => number;
  /** Called for every dead-lettered event. The logging hook. */
  readonly onDeadLetter?: (entry: DeadLetterEntry) => void;
  /** Cap on retained dead letters. Bounded, or a flood fills the heap. */
  readonly maxDeadLetters?: number;
}

const DEFAULT_MAX_HOPS = 2;
const DEFAULT_MAX_AGENTS = 256;
const DEFAULT_MAX_DEAD_LETTERS = 512;

export class SwarmDispatcher {
  #agents: { readonly name: string; readonly registration: SwarmRegistration }[] = [];
  #deadLetters: DeadLetterEntry[] = [];
  #stopped = false;

  readonly #maxHops: number;
  readonly #maxAgents: number;
  readonly #maxDeadLetters: number;
  readonly #now: () => number;
  readonly #onDeadLetter: ((entry: DeadLetterEntry) => void) | undefined;

  #dispatched = 0;
  #matched = 0;
  #unmatched = 0;
  #handlerFailures = 0;
  #hopLimit = 0;

  constructor(options: SwarmDispatcherOptions = {}) {
    this.#maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
    this.#maxAgents = options.maxAgents ?? DEFAULT_MAX_AGENTS;
    this.#maxDeadLetters = options.maxDeadLetters ?? DEFAULT_MAX_DEAD_LETTERS;
    this.#now = options.now ?? (() => Date.now());
    this.#onDeadLetter = options.onDeadLetter;
  }

  /**
   * REGISTER AN AGENT.
   *
   * The name is not decoration: it is the only thing in a dead letter or a failure
   * count that identifies which of several agents lost an event, and an unnamed
   * failure is an unattributable one.
   *
   * Refuses rather than throws on a duplicate or over-cap registration. A caller
   * that registers in a loop should not be able to take the dispatcher down, and the
   * refusal is returned so it can be acted on.
   */
  register(name: string, registration: SwarmRegistration): { ok: true } | { ok: false; reason: string } {
    if (this.#stopped) return { ok: false, reason: "the dispatcher has been stopped" };
    if (name.length === 0) return { ok: false, reason: "an agent needs a name to be attributable" };
    if (this.#agents.some((agent) => agent.name === name)) {
      return { ok: false, reason: `an agent named ${name} is already registered` };
    }
    if (this.#agents.length >= this.#maxAgents) {
      // Refused rather than grown. A registry that grows without bound is walked in
      // full on every event, so an unbounded registry is a latency bomb that only
      // detonates under load.
      return { ok: false, reason: `the registry is full at ${this.#maxAgents} agents` };
    }
    this.#agents.push({ name, registration });
    return { ok: true };
  }

  unregister(name: string): boolean {
    const before = this.#agents.length;
    this.#agents = this.#agents.filter((agent) => agent.name !== name);
    return this.#agents.length !== before;
  }

  /**
   * ROUTE ONE EVENT.
   *
   * Re-validates before routing, so a caller holding an envelope it built by hand
   * cannot smuggle an event past the schema by skipping the consumer. Cheap, and it
   * is the boundary the whole universal-pipeline claim rests on.
   */
  async dispatch(input: unknown): Promise<DispatchOutcome> {
    return this.#route(input, 0);
  }

  /** The real entry point. `hop` is threaded by `redispatch`, never by a caller. */
  async #route(input: unknown, hop: number): Promise<DispatchOutcome> {
    if (this.#stopped) {
      return this.#deadLetter(input, "stopped", "the dispatcher has been stopped");
    }

    if (hop > this.#maxHops) {
      // The loop bound. Enforced BEFORE any work, so a cycle costs one counter
      // increment rather than an unbounded walk of the registry.
      this.#hopLimit += 1;
      return this.#deadLetter(input, "hop-limit", `exceeded ${this.#maxHops} hops`);
    }

    const verdict = validateUniversalTelemetryEvent(input);
    if (!verdict.ok) {
      // An invalid event never reaches the DLQ as an EVENT -- it is not an event --
      // so it is dropped with a count rather than queued as something replayable.
      this.#unmatched += 1;
      return { eventId: "", delivered: [], failed: [], deadLettered: true, reason: "no-match" };
    }
    const event = verdict.event;

    this.#dispatched += 1;

    const matched = this.#agents.filter((agent) => matches(agent.registration, event));
    if (matched.length === 0) {
      this.#unmatched += 1;
      return this.#deadLetter(event, "no-match", "no registered agent matched this event");
    }
    this.#matched += 1;

    const delivered: string[] = [];
    const failed: string[] = [];

    // AWAITED IN SEQUENCE, DELIBERATELY.
    //
    // Fan-out across agents would be faster and would make ordering between them
    // non-deterministic, which is a property an operator debugging "why did only one
    // swarm see this" cannot use. One slow agent costs latency, not correctness.
    for (const agent of matched) {
      const context: SwarmContext = {
        hop,
        redispatch: (next?: unknown) => this.#route(next ?? event, hop + 1),
      };
      try {
        await agent.registration.handle(event, context);
        delivered.push(agent.name);
      } catch (error) {
        /**
         * ONE AGENT'S BUG IS NOT EVERYONE'S OUTAGE.
         *
         * The exception is contained here and attributed by name. Letting it escape
         * would cost every other agent its events on the next one this agent saw,
         * and the symptom — a whole swarm going quiet — points nowhere near the
         * cause.
         *
         * The message is kept; the stack is not. A DLQ is often serialised into a log
         * or an operator console, and a stack trace through a router is noise that
         * hides the one line that says which agent threw.
         */
        this.#handlerFailures += 1;
        failed.push(agent.name);
        this.#deadLetter(event, "handler-threw", `${agent.name}: ${error instanceof Error ? error.message : "unknown"}`, agent.name);
      }
    }

    return { eventId: event.eventId, delivered, failed, deadLettered: false };
  }

  /** The dead-letter queue, oldest first. Bounded. */
  deadLetters(): readonly DeadLetterEntry[] {
    return this.#deadLetters;
  }

  stats(): DispatcherStats {
    return {
      dispatched: this.#dispatched,
      matched: this.#matched,
      unmatched: this.#unmatched,
      handlerFailures: this.#handlerFailures,
      hopLimitExceeded: this.#hopLimit,
      registered: this.#agents.length,
      deadLetters: this.#deadLetters.length,
      dlqDepth: this.#deadLetters.length,
    };
  }

  /**
   * STOP, AND RELEASE.
   *
   * Events already in a handler's promise chain still settle — the handlers are not
   * cancelled, because cancelling them would mean abandoning a half-finished write
   * somewhere an agent owns. What stops is NEW work.
   */
  stop(): void {
    this.#stopped = true;
    this.#agents = [];
    this.#deadLetters = [];
  }

  #deadLetter(input: unknown, reason: DeadLetterReason, detail: string, agent?: string): DispatchOutcome {
    const eventId = typeof input === "object" && input !== null && "eventId" in input ? String((input as { eventId: unknown }).eventId) : "";
    // A DLQ that drops the payload cannot be replayed from, which defeats the point.
    // An INVALID input is the exception: it is not an event, so there is nothing
    // replayable to keep, and it was counted above.
    if (reason !== "no-match" || isEventShaped(input)) {
      this.#deadLetters.push({
        reason,
        at: new Date(this.#now()).toISOString(),
        event: input as UniversalTelemetryEvent,
        ...(agent === undefined ? {} : { agent }),
        detail,
      });
      // BOUNDED. A flood must not turn the dead-letter queue into the memory leak it
      // exists to diagnose. Oldest out first.
      if (this.#deadLetters.length > this.#maxDeadLetters) {
        this.#deadLetters.splice(0, this.#deadLetters.length - this.#maxDeadLetters);
      }
    }
    this.#onDeadLetter?.({ reason, at: new Date(this.#now()).toISOString(), event: input as UniversalTelemetryEvent, ...(agent === undefined ? {} : { agent }), detail });
    return { eventId, delivered: [], failed: [], deadLettered: true, reason };
  }
}

function isEventShaped(input: unknown): boolean {
  return typeof input === "object" && input !== null && "eventId" in input;
}

/**
 * PREFIX, NARROWED BY TAGS. THE REGISTRY IS AN AND.
 *
 * The first version was an OR: an agent registering `auth.` and `{severity: high}`
 * received anything matching either. That is a fan-out hazard. One registration can
 * then match an unbounded slice of the firehose, because a tag like `env:prod` is
 * true for a large fraction of production traffic, and the agent silently becomes
 * the consumer of everything rather than of the thing it said it wanted.
 *
 * Under AND, tags only ever REDUCE a prefix match:
 *
 *   - prefixes and no tags  -> prefix only (the fallback)
 *   - tags and no prefixes  -> tags only
 *   - both                  -> BOTH must hold
 *   - neither               -> matches NOTHING (see below)
 *
 * The last case is not a vacuous truth and is deliberately not treated as one. An
 * agent that registered no criteria has said nothing about what it wants, and
 * reading that as "everything" turns a typo into an agent that receives the whole
 * stream and quietly contaminates every domain it was meant to be separate from. A
 * criterion you did not state is a filter that does not match.
 */
function matches(registration: SwarmRegistration, event: UniversalTelemetryEvent): boolean {
  const hasPrefixes = registration.metricPrefixes.length > 0;
  const hasTags = registration.tags !== undefined && Object.keys(registration.tags).length > 0;

  // Neither stated: matches nothing. Said first, so the vacuous-truth reading below
  // never reaches it.
  if (!hasPrefixes && !hasTags) return false;

  const byPrefix =
    hasPrefixes && registration.metricPrefixes.some((prefix) => event.metricName.startsWith(prefix));
  const byTags = tagsMatch(registration.tags, event.metadata);

  return hasPrefixes && hasTags ? byPrefix && byTags : hasPrefixes ? byPrefix : byTags;
}

/** EVERY declared tag, by EXACT equality. */
function tagsMatch(
  required: Readonly<Record<string, string>> | undefined,
  metadata: TelemetryMetadata,
): boolean {
  if (required === undefined) return false;
  const keys = Object.keys(required);
  if (keys.length === 0) return false;
  for (const key of keys) {
    const actual = metadata[key];
    // Equality, never prefix: choosing `env:prod` must not also capture
    // `env:production`. A tag is a label somebody picked on purpose.
    if (typeof actual !== "string" || actual !== required[key]) return false;
  }
  return true;
}