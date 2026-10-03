/**
 * THE CONDUCTOR. It decides who answers. It never answers.
 *
 * === WHY THIS IS NOT A RENAME OF `replyTo` ===
 *
 * `replyTo` was a chain of `if (regex) return ...` where every branch owned both
 * the DECISION ("is this my question?") and the ANSWER ("what do I say?"). Those
 * two concerns had fused, which cost more than readability:
 *
 *   - Adding a capability meant finding the right branch NUMBER, and branches
 *     were ordered by accident, so "what is wrong with this file" was matched by
 *     whichever regex happened to come first.
 *   - The cross-column branch had to be placed ABOVE the findings branch because
 *     the findings regex matches the word "anomalies", and that ordering
 *     constraint existed only as a comment in one test.
 *   - The forecast existed, was drawn on the dashboard, was quoted by the
 *     executive summary -- and could not be asked about in conversation at all,
 *     because nobody had written the branch.
 *
 * So the split is decision-from-answer. The router holds the ORDER as data, so
 * reordering it is a diff someone reviews rather than a conditional somebody
 * inserts above five others. And a missing capability becomes a missing agent,
 * which is visible, instead of a forgotten branch, which is not.
 *
 * === FIRST MATCH WINS, AND WHY THE ORDER IS WHAT IT IS ===
 *
 * Two vocabularies genuinely overlap and the precedence is a product decision:
 *
 *   1. anomaly  -- "what is wrong" is the question users ask most, and it is
 *                  also the broadest. If it ran last, a phrasing like "what is
 *                  the biggest problem in the latency column" would be answered
 *                  by the profiler's category branch.
 *   2. forecasting -- narrow, but its vocabulary ("next 12 hours", "trend") can
 *                  appear in a sentence about a defect, so it goes before the
 *                  profiler's overview branch and after the anomaly one.
 *   3. profiler -- the default specialist. It owns the broadest family of
 *                  questions, which makes it the right LAST entry and the wrong
 *                  first one.
 *
 * The order is asserted by tests, so reordering it is deliberate.
 */

import type { Reply } from "./conversation.ts";
import { anomalyAgent } from "./subagents/anomaly-agent.ts";
import { forecastingAgent } from "./subagents/forecasting-agent.ts";
import { profilerAgent } from "./subagents/profiler-agent.ts";
import type { AgentContext, Subagent } from "./subagents/types.ts";

export type { AgentContext, Subagent } from "./subagents/types.ts";
import type { BrokerSnapshot } from "./stream-broker.ts";

/**
 * THE ROSTER, IN PRECEDENCE ORDER. See the note above before reordering it.
 */
export const AGENTS: readonly Subagent[] = [anomalyAgent, forecastingAgent, profilerAgent];

export interface RouteResult {
  /** Which agent answered, or null when none owned the question. */
  readonly agent: Subagent["name"] | null;
  /** Its answer, or undefined when no agent could. The caller declines. */
  readonly reply?: Reply;
  /**
   * True when the answer came from a LIVE stream rather than from a file.
   *
   * Published because it changes what the answer MEANS and a caller cannot see it
   * otherwise: "nothing is past its fence" over a closed export is a finding, and
   * the same sentence over a stream that is still running is a statement about
   * the past tense. A UI that renders both identically is lying to somebody.
   */
  readonly live?: boolean;
}

/**
 * LIVE INTENT: the questions that are about a stream, not about a file.
 *
 * Checked BEFORE the file agents, and that ordering is the whole point. An open
 * stream handed to a file-shaped agent finds no rows, and the agent answers
 * "nothing is wrong" -- which on a dashboard is indistinguishable from a clean
 * stream. So a question that clearly means "right now" must never reach an agent
 * that would read it from a finite file.
 */
const LIVE_INTENT = /\b(live|right now|currently|now|streaming|real[\s-]?time|incoming|tail)\b/i;

/**
 * ROUTE A PROMPT TO THE AGENT THAT OWNS IT.
 *
 * Returns the ANSWER rather than the agent's name, because a router that
 * returns a name has merely relabelled the monolith. The agent is returned
 * alongside so the choice is testable; a caller that only wants the text can
 * ignore it, and a test that only wanted the text could not catch a monolith.
 *
 * An agent may match and still decline (`answer` returning null) because it
 * owns a family of questions and cannot answer this member of it. The router
 * then tries the next, which is why an agent's vocabulary must not be a net
 * cast wider than the answers it can actually give.
 */
/**
 * ROUTE WITH AN OPTIONAL LIVE STREAM.
 *
 * Kept separate from `route` rather than an extra nullable argument, because "no
 * stream" and "a stream" produce genuinely different answers, and lumping them
 * behind a parameter invites a call site that forgets which one it is asking.
 * With no snapshot the file path is preserved exactly.
 */
export function routeWith(
  prompt: string,
  ctx: AgentContext,
  live: BrokerSnapshot | undefined,
): RouteResult {
  const text = String(prompt ?? "").trim();
  if (text === "") return { agent: null };

  // THE INTENT GATE COMES FIRST, and it is the whole fix for a bug this routing
  // shipped with: `answerLive` exists on the anomaly agent, and its `handles`
  // matches "wrong", "anomaly" and "problem" -- which is also how a FILE is
  // described. So with any stream attached, "what is wrong with this FILE?" was
  // answered from the stream, which is not a live question being answered
  // correctly, it is a static question being answered by the wrong owner.
  if (live !== undefined && LIVE_INTENT.test(text)) {
    for (const agent of AGENTS) {
      if (agent.answerLive === undefined || !agent.handles(text)) continue;
      try {
        const reply = agent.answerLive(live);
        if (reply !== null && reply !== undefined) return { agent: agent.name, reply, live: true };
      } catch {
        // Fall through to the file agents rather than failing the question: a
        // live answer is better, not required. The risk of the fallback is
        // bounded because a file-shaped answer over a stream is still phrased
        // about what has been read.
      }
    }
    // A live question the live agents did not claim still falls through, so a
    // static question asked while a stream runs is answered from the file.
    if (LIVE_INTENT.test(text)) {
      return {
        agent: "anomaly",
        reply: {
          kind: "answer",
          text: "That question is about something happening now, and no live agent could answer it from the "
            + "stream attached. Ask what is past its fence, which the stream can answer.",
          widgets: [],
          suggestions: ["what is past its fence?"],
        },
        live: true,
      };
    }
  }

  for (const agent of AGENTS) {
    let owns: boolean;
    try {
      owns = agent.handles(text);
    } catch {
      // A malformed prompt must not take the process down. An agent that
      // cannot even recognise its own question certainly cannot answer it.
      owns = false;
    }
    if (!owns) continue;

    let reply: Reply | null = null;
    try {
      reply = agent.answer(ctx, text);
    } catch {
      reply = null;
    }
    if (reply !== null) return { agent: agent.name, reply };
  }

  return { agent: null };
}

/**
 * ROUTE A PROMPT, WITH NO STREAM ATTACHED.
 *
 * The thin wrapper exists so the file path keeps its exact name and signature:
 * every existing caller, and every existing test, asks questions of files. What
 * that file path MUST NOT do is quietly change -- the integration test asserts
 * `route` and `routeWith(..., undefined)` agree exactly.
 */
export function route(prompt: string, ctx: AgentContext): RouteResult {
  return routeWith(prompt, ctx, undefined);
}

/**
 * The Conductor, as a namespace rather than a class.
 *
 * A class here would be a container with no state and no lifecycle, and a
 * stateless container with two members is a module wearing a noun. What matters
 * architecturally is that routing is SEPARATE from answering, and that reads
 * better as a function than as an object you instantiate and never configure.
 */
export const Conductor = { route, routeWith, AGENTS } as const;