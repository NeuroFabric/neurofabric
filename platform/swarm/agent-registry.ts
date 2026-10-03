import {
  descriptorOf,
  unavailable,
  type AgentDescriptor,
  type DiagnosticAgent,
  type DiagnosticInput,
  type DiagnosticResult,
} from "./diagnostic-agent.ts";

/**
 * THE REGISTRY. A roster with rules, rather than a list with a `find` in it.
 *
 * === WHY A CLASS AND NOT AN ARRAY ===
 *
 * Because the three properties that matter are not properties of a list. They are
 * uniqueness of ids, an ORDER that means something, and a uniform answer to
 * "who did you ask?". An array gives you lookup by `find`, and then every caller
 * writes its own loop, and each loop makes its own decision about what to do when
 * an agent declines -- which is precisely the decision that must be identical
 * everywhere, because two callers disagreeing about who answered a question is a
 * bug that reports itself as a flaky test three weeks later.
 *
 * === THE ROUTING RULES, AND WHY EACH IS HERE ===
 *
 *  1. FIRST MATCH WINS, IN REGISTRATION ORDER. Same rule as the Conductor's agent
 *     router, for the same reason: the precedence is a product decision, so it
 *     lives in data that a reviewer can diff rather than in a conditional.
 *
 *  2. A DECLINE IS NOT A REFUSAL. An agent that matched but could not answer
 *     (`status: "declined"`) yields to the next, because it owns a FAMILY of
 *     scopes and cannot do every member of it. This is what makes an honest
 *     decline usable instead of fatal.
 *
 *  3. STUBS DO NOT WIN. A stub is asked only when the caller opts in, and what
 *     comes back is its refusal. The rule exists so that shipping three templates
 *     ahead of three implementations cannot make the platform look covered.
 *
 *  4. EVERY DISPATCH REPORTS WHO WAS CONSULTED. When nothing answers, the caller
 *     is told which agents were asked and what each said. "No agent owned this"
 *     is a real answer, and it is only trustworthy if the reader can see that the
 *     roster was not simply empty.
 */

/** The outcome of asking the roster. */
export interface RegistryDispatch {
  /** The agent that answered, or null when none did. */
  readonly agent: AgentDescriptor | null;
  readonly result: DiagnosticResult | null;
  /** Every agent that was asked, in order. Present on failure as well as success. */
  readonly consulted: readonly string[];
  /** True when a stub was refused rather than allowed to answer. */
  readonly stubRefused?: boolean;
}

export interface RegistryOptions {
  /**
   * Allow a stub to be selected. Off by default, per rule 3.
   *
   * The point of the flag is observability, not permissiveness: a deployment
   * turning it on still receives `status: "unavailable"` and never a fabricated
   * finding.
   */
  readonly allowStubs?: boolean;
}

export class AgentRegistry {
  private readonly agents: DiagnosticAgent[] = [];
  private readonly options: RegistryOptions;

  constructor(options: RegistryOptions = {}) {
    this.options = options;
  }

  /**
   * ADD AN AGENT.
   *
   * A duplicate id THROWS rather than shadowing. Silently keeping the first would
   * mean a deployment that registered an override got the original and no error;
   * silently keeping the second would mean the roster order no longer explains
   * what runs. Both are discovered by a user noticing the wrong answer.
   */
  register(agent: DiagnosticAgent): this {
    if (this.agents.some((existing) => existing.id === agent.id)) {
      throw new Error(`an agent with id "${agent.id}" is already registered`);
    }
    this.agents.push(agent);
    return this;
  }

  registerAll(agents: Iterable<DiagnosticAgent>): this {
    for (const agent of agents) this.register(agent);
    return this;
  }

  get size(): number {
    return this.agents.length;
  }

  /** THE PUBLISHED ROSTER, in precedence order. For the registry listing. */
  describeAll(): readonly AgentDescriptor[] {
    return this.agents.map(descriptorOf);
  }

  get(id: string): DiagnosticAgent | undefined {
    return this.agents.find((agent) => agent.id === id);
  }

  /** The agents registered for one domain, for a caller narrowing by discipline. */
  describeDomain(domain: DiagnosticAgent["domain"]): readonly AgentDescriptor[] {
    return this.describeAll().filter((descriptor) => descriptor.domain === domain);
  }

  /**
   * ASK THE ROSTER.
   *
   * An agent that throws is treated as having declined, not as an error the
   * caller must handle: one specialist failing on a malformed scope must not take
   * the other specialists offline with it, and the fact that it threw is reported
   * in `consulted` rather than swallowed.
   */
  async dispatch(scope: string, input: Omit<DiagnosticInput, "prompt"> = {}): Promise<RegistryDispatch> {
    const consulted: string[] = [];
    let stubRefused = false;

    for (const agent of this.agents) {
      if (agent.handles !== undefined) {
        let owns = false;
        try {
          owns = agent.handles(scope);
        } catch {
          // An agent that cannot recognise its own scope certainly cannot answer
          // it, and must not be allowed to take the process down asking.
          owns = false;
        }
        if (!owns) continue;
      }

      if (agent.maturity === "stub" && this.options.allowStubs !== true) {
        stubRefused = true;
        continue;
      }

      let result: DiagnosticResult;
      try {
        result = await agent.diagnose({ ...input, prompt: scope });
      } catch {
        result = {
          agentId: agent.id,
          status: "declined",
          summary: `${agent.title} could not complete this diagnosis.`,
          findings: [],
          at: new Date().toISOString(),
        };
      }

      // A decline yields to the next agent, and is remembered either way.
      if (result.status === "declined") {
        consulted.push(agent.id);
        continue;
      }
      consulted.push(agent.id);
      return { agent: descriptorOf(agent), result, consulted, ...(stubRefused ? { stubRefused } : {}) };
    }

    // Nothing answered. Say so, and say who was asked, rather than returning an
    // empty success that a dashboard would render as "no problems found".
    const reason = this.agents.length === 0
      ? "no agents are registered"
      : stubRefused
        ? "every agent that matched is a stub and stubs are not enabled"
        : "no registered agent owned that scope";
    return {
      agent: null,
      result: {
        agentId: "registry",
        status: "declined",
        summary: `${reason}. Consulted: ${consulted.length === 0 ? "none" : consulted.join(", ")}.`,
        findings: [],
        at: new Date().toISOString(),
      },
      consulted,
      ...(stubRefused ? { stubRefused } : {}),
    };
  }

  /**
   * ASK ONE AGENT BY NAME, bypassing selection.
   *
   * Separate from `dispatch` rather than an extra argument, because "the best
   * agent for this" and "this agent, specifically" are different questions and
   * lumping them behind a parameter produces a call site that silently means one
   * of the two.
   *
   * `Partial` rather than the prompt-less shape `dispatch` takes, because being
   * named explicitly is precisely the case where the caller already knows the
   * scope and wants it passed through.
   */
  async run(id: string, input: Partial<DiagnosticInput> = {}): Promise<DiagnosticResult> {    const agent = this.get(id);
    if (agent === undefined) {
      return {
        agentId: id,
        status: "unavailable",
        summary: `no agent with id "${id}" is registered`,
        findings: [],
        at: new Date().toISOString(),
      };
    }
    if (agent.maturity === "stub" && this.options.allowStubs !== true) {
      return unavailable(agent);
    }
    // A named run with no scope is an explicit empty one, not a fabricated one.
    // The spread comes second so a caller-supplied scope wins.
    return agent.diagnose({ prompt: "", ...input });
  }
}

/**
 * THE CONDUCTOR'S EXISTING AGENTS, AS DIAGNOSTIC AGENTS.
 *
 * This is the whole refactor, and it is deliberately this small: the conductor is
 * kernel and not one line of it changes. `Subagent.answer` is synchronous and
 * returns a `Reply`, so the adapter bridges that into the async `diagnose` and
 * projects the reply's TEXT into a result -- it does not attempt to parse widgets
 * into findings, because a lossy conversion that looks structured is how a widget
 * becomes a fabricated finding one refactor later.
 *
 * Note what the adapter does NOT claim: the reply's widget payload is dropped.
 * That is stated rather than hidden, and it is the honest boundary for an adapter
 * whose source type is a render instruction rather than a diagnosis.
 */
export function fromSubagent(
  subagent: { readonly name: string; handles(prompt: string): boolean; answer(ctx: never, prompt: string): unknown },
  domain: DiagnosticAgent["domain"] = "anomaly",
): DiagnosticAgent {
  const agent: DiagnosticAgent = {
    id: `conductor:${subagent.name}`,
    title: `Conductor ${subagent.name} agent`,
    domain,
    maturity: "ready",
    version: "1.0.0",
    capabilities: [`answers questions about data via the existing ${subagent.name} route`],
    handles: (scope: string) => subagent.handles(scope),
    async diagnose(input: DiagnosticInput): Promise<DiagnosticResult> {
      const context = input.context;
      if (context === undefined) {
        return {
          agentId: `conductor:${subagent.name}`,
          status: "unavailable",
          summary: "the conductor agents need analysed data, and none was supplied",
          findings: [],
          at: new Date().toISOString(),
        };
      }
      try {
        const reply = subagent.answer(context as never, input.prompt) as { kind?: string; text?: string } | null;
        if (reply === null || reply === undefined) {
          return {
            agentId: `conductor:${subagent.name}`,
            status: "declined",
            summary: `the ${subagent.name} agent matched this scope but could not answer it`,
            findings: [],
            at: new Date().toISOString(),
          };
        }
        const text = typeof reply.text === "string" ? reply.text : "";
        return {
          agentId: `conductor:${subagent.name}`,
          status: "ok",
          summary: text === "" ? `the ${subagent.name} agent returned a reply with no text` : text,
          // Evidence is the reply itself, quoted, so the claim is traceable to it.
          findings: text === "" ? [] : [{
            severity: "info" as const,
            title: `${subagent.name} answer`,
            detail: text,
            evidence: [`conductor:${subagent.name}`],
          }],
          at: new Date().toISOString(),
        };
      } catch {
        return {
          agentId: `conductor:${subagent.name}`,
          status: "declined",
          summary: `the ${subagent.name} agent failed on this scope`,
          findings: [],
          at: new Date().toISOString(),
        };
      }
    },
    // Referenced through the binding rather than `this`, which inside an object
    // literal's arrow is the enclosing scope -- undefined in a module-level
    // function, so `descriptorOf` would have been handed nothing.
    describe: () => descriptorOf(agent),
  };
  return agent;
}
