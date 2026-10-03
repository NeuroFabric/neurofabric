import type { AgentContext } from "../conductor/subagents/types.ts";
import type { BrokerSnapshot } from "../conductor/stream-broker.ts";

/**
 * THE DIAGNOSTIC AGENT CONTRACT.
 *
 * === WHY THIS IS NOT `Subagent` ===
 *
 * `platform/conductor/subagents/types.ts` already defines an agent, and it is a
 * good contract for what it is for: three agents that answer QUESTIONS ABOUT A
 * FILE, chosen by matching a prompt's vocabulary, all synchronously, all sharing
 * one `Reply` type the renderer already knows how to draw.
 *
 * That contract cannot carry what a Multi-Agent Diagnostic Platform needs, for
 * three concrete reasons, each of which is a property rather than a preference:
 *
 *   - SYNCHRONY. An AML sweep or a supply-chain walk is I/O over a package
 *     graph or a ledger. `answer` returns `Reply`, so an agent that must wait
 *     cannot express waiting without lying about it. `diagnose` returns a promise
 *     and may therefore be slow.
 *   - NON-QUESTION SHAPE. A question router is asked "does this sentence belong
 *     to you?" and answers yes or no. A diagnostic agent is handed a SCOPE --
 *     "audit the settlement path" -- and produces a set of findings with evidence.
 *     There is no prompt to match, and pretending there is means a specialist
 *     whose vocabulary nobody has enumerated can never be selected.
 *   - ONE ANSWER TYPE. `Reply` renders on a dashboard. A supply-chain finding
 *     carries a package name, a version range and a published advisory; forcing
 *     that into a widget means the information that made the finding valuable is
 *     the information that got dropped.
 *
 * So there are two contracts and they are both real. The router's agents are
 * unchanged and remain the question path; these are the scope path, and
 * `agent-registry.ts` adapts one into the other so the existing three are
 * registrable alongside the specialists without a line of conductor code moving.
 *
 * === THE RULE THAT MAKES A REGISTRY HONEST ===
 *
 * A stub MUST NOT PRODUCE FINDINGS.
 *
 * The tempting shape is an agent that answers "3 high-severity vulnerabilities
 * detected" so the dashboard has something on it. That is not a stub, it is a
 * fabrication: it will be screenshotted, quoted in a status report, and acted on
 * by somebody who has no way to know it was invented. So a stub declares
 * `maturity: "stub"`, and `diagnose` on a stub returns `status: "unavailable"`
 * with the reason it is unavailable. The registry refuses to route to a stub
 * unless a caller explicitly opts in, and even then what comes back is the
 * refusal, honestly labelled -- never a finding. An empty registry that says so
 * is useful; a populated one that lies is worse than useless.
 */

/** How finished an agent is. Published, because "it exists" is not "it works". */
export type AgentMaturity = "stub" | "ready";

/**
 * THE INDUSTRY AN AGENT DIAGNOSES.
 *
 * A closed union on purpose. This is a platform for pinpointing systemic
 * industry problems, and "systemic" is the operative word: the whole value is in
 * knowing which body of knowledge an answer came from, so an unlisted domain has
 * to be added deliberately and reviewed as a claim about a discipline rather
 * than slipped in as a new string.
 */
export type DiagnosticDomain =
  | "anomaly"
  | "supply-chain"
  | "financial-compliance"
  | "performance";

export interface DiagnosticInput {
  /** The scope as asked for. May be empty when the caller named the agent directly. */
  readonly prompt: string;
  /** The engine's projection of the data, when the caller has one. */
  readonly context?: AgentContext;
  /** A live stream, when the diagnosis is about something still running. */
  readonly snapshot?: BrokerSnapshot;
  /**
   * THE TELEMETRY TO READ, AS A STREAM.
   *
   * `AsyncIterable` and nothing else is deliberate, and it is the whole memory
   * story of this platform. There is no array form, no "events" property and no
   * convenience that takes a buffer, because every one of those would let a
   * caller hand an agent 50,000 events at once and call the agent O(1) because
   * the agent did not itself copy them. An agent that accepts a buffer cannot be
   * held to a memory bound that its own caller did not respect.
   *
   * The stream may be consumed exactly once. `diagnose` is therefore not
   * idempotent for a stream input, and a caller wanting a second reading must
   * supply a second stream -- which is the honest shape, because re-reading a
   * live stream should not silently replay from the beginning.
   */
  readonly stream?: AsyncIterable<TelemetryEvent>;
}

/**
 * WHAT A SWARM AGENT CONSUMES.
 *
 * Declared here rather than imported from the gateway so the swarm is not
 * coupled to one ingress: any provider adapter -- webhook, Kafka, file tail --
 * produces this and nothing else. It is structurally the gateway's own event, so
 * an adapter from `OmniRouteEvent` is a widening and not a translation.
 *
 * Every value is a STRING because it arrived from a wire. Nothing in this file
 * coerces, and every agent parses: a number that has silently become a string is
 * a schema question, and answering it here would answer it once for everybody
 * including the agents that need it to stay a string.
 */
export interface TelemetryEvent {
  readonly fields: Readonly<Record<string, string>>;
  /** Event instant, when the provider carried one. */
  readonly at?: number;
  /**
   * Which partition of the stream this came from.
   *
   * Optional because an adapter may not know, and required to be REPORTED rather
   * than invented: a verdict that claims "across 1 partition" when the caller
   * never said is a claim the agent cannot support.
   */
  readonly partition?: string;
}

export type FindingSeverity = "info" | "warning" | "critical";

/**
 * ONE OBSERVATION, WITH ITS EVIDENCE.
 *
 * `evidence` is required rather than optional because this is the property the
 * entire product has been built on since the first duplicated parser: a claim a
 * user acts on must be traceable to the thing that produced it. An agent that
 * cannot cite is not imprecise, it is unverifiable, and this is where that
 * becomes a type error rather than a review comment.
 */
export interface DiagnosticFinding {
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly detail: string;
  readonly evidence: readonly string[];
}

/**
 * `unavailable` is NOT `ok` with zero findings. It means the agent was asked and
 * could not answer, and the reason is in `summary`. Collapsing the two is how a
 * platform reports a clean bill of health for a check that never ran.
 */
export type DiagnosticStatus = "ok" | "declined" | "unavailable";

export interface DiagnosticResult {
  readonly agentId: string;
  readonly status: DiagnosticStatus;
  readonly summary: string;
  readonly findings: readonly DiagnosticFinding[];
  readonly at: string;
  /**
   * BOUNDED COUNTERS, published so a caller can see the shape of what was read.
   *
   * Optional because an agent with nothing to count has nothing to say, and
   * required to be FLAT NUMBERS: a nested object here is an invitation to hang a
   * growing histogram off it, which is exactly the unbounded structure the stream
   * input exists to prevent.
   */
  readonly stats?: Readonly<Record<string, number>>;
}

/** What the registry publishes about an agent. Carries no credentials and no data. */
export interface AgentDescriptor {
  readonly id: string;
  readonly title: string;
  readonly domain: DiagnosticDomain;
  readonly maturity: AgentMaturity;
  readonly version: string;
  readonly capabilities: readonly string[];
}

export interface DiagnosticAgent {
  /** Stable and unique within a registry. The primary key for everything. */
  readonly id: string;
  readonly title: string;
  readonly domain: DiagnosticDomain;
  readonly maturity: AgentMaturity;
  readonly version: string;
  /** What this agent is for, in the words an operator would use. */
  readonly capabilities: readonly string[];
  /**
   * Does this scope belong to me? Pure, side-effect free, and never throws --
   * an agent that cannot recognise its own scope cannot be asked to confirm it.
   *
   * Optional on purpose. A specialist reached BY NAME rather than by prompt has
   * nothing to match against, and an agent forced to write `handles` for a
   * capability it always accepts ends up with `return true`, which looks like
   * selection and is not.
   */
  handles?(scope: string): boolean;
  /** Run the diagnosis. Async, because a real one does I/O. */
  diagnose(input: DiagnosticInput): Promise<DiagnosticResult>;
  /** The published shape. Used by the registry listing, never by the diagnosis. */
  describe(): AgentDescriptor;
}

/**
 * THE REFUSAL, as a value.
 *
 * Every stub routes through this one function so that "not implemented" is
 * phrased identically by all of them -- a reader who sees three differently-worded
 * refusals has to wonder whether one of them means something slightly different,
 * and that wondering is the cost the shared helper exists to remove.
 */
export function unavailable(agent: DiagnosticAgent, at: () => Date = () => new Date()): DiagnosticResult {
  return {
    agentId: agent.id,
    status: "unavailable",
    summary: `${agent.title} is a stub: registered, described, and deliberately not answering. `
      + "No finding from this agent is a finding about the data.",
    findings: [],
    at: at().toISOString(),
  };
}

/** A well-formed empty result, for an agent that ran and found nothing. */
export function clean(agent: DiagnosticAgent, summary: string, at: () => Date = () => new Date()): DiagnosticResult {
  return { agentId: agent.id, status: "ok", summary, findings: [], at: at().toISOString() };
}

/** The published descriptor of an agent, derived so it cannot drift from the agent. */
export function descriptorOf(agent: DiagnosticAgent): AgentDescriptor {
  return {
    id: agent.id,
    title: agent.title,
    domain: agent.domain,
    maturity: agent.maturity,
    version: agent.version,
    capabilities: [...agent.capabilities],
  };
}
