/**
 * WHAT A SUBAGENT IS, AND WHY IT IS THIS SHAPE.
 *
 * A subagent owns ONE question and the answer to it. It is told how to recognise
 * its own prompt and it is handed the analysis; it never decides whether some
 * OTHER agent should have answered first. That ordering is the Conductor's job
 * and nobody else's, because an ordering decision scattered across the agents
 * that the ordering decides between is not an ordering at all.
 *
 * `handles` and `answer` are separate on purpose. An agent that only answers
 * cannot be asked "is this yours?" without side effects, so the router cannot
 * probe the list, and a probe is exactly what a router has to do. Splitting them
 * also makes "I matched no agent" a normal, representable outcome rather than an
 * exception -- which matters because the honest decline is still the correct
 * answer to a large class of sentences, and a router that cannot say "not mine"
 * will start guessing.
 *
 * The context is passed WHOLE rather than sliced per agent. Slicing would be a
 * nicer contract in principle and a worse one in practice: the next agent needs
 * a field nobody predicted, and a slice has to be widened at every call site
 * instead of once, here.
 */

import type { ConversationData, Reply } from "../conversation.ts";

export interface AgentContext extends ConversationData {
  /**
   * The engine's projection, when it produced one.
   *
   * Optional and honest about why: forecasting refuses to project across a gap
   * in the timeline, so for a large class of perfectly readable files this is
   * legitimately absent. An agent that finds it missing must say so with the
   * engine's own reason rather than inventing a "no forecast available".
   */
  readonly forecast?: {
    readonly ok: boolean;
    readonly method: string;
    readonly points: readonly {
      readonly hour: string; readonly value: number; readonly lower: number; readonly upper: number;
    }[];
    readonly explanation: string;
    readonly reason: string | null;
    readonly lastObservedHour: string | null;
  } | null;
}

export interface Subagent {
  readonly name: "anomaly" | "forecasting" | "profiler";
  /** Does this prompt belong to me? Must be pure and must have no side effects. */
  handles(prompt: string): boolean;
  /**
   * The answer, or null if the agent matched but genuinely cannot answer --
   * for instance a forecasting agent with no projection to report. Null is NOT
   * the same as declining to own the question: the router will try the next
   * agent, and the last refusal is a better answer than the first agent's.
   *
   * The prompt is passed back in because `handles` matches a FAMILY of questions
   * and one agent legitimately answers several of them differently. Without it
   * an agent that owns "what is wrong" would have to answer every member of that
   * family identically, which is how a contradiction question and a fence
   * question end up sharing one answer.
   */
  answer(ctx: AgentContext, prompt: string): Reply | null;
}

/** `nl` formatting, shared so three agents cannot disagree about a number. */
export function rows(n: number): string {
  return n.toLocaleString("en-US");
}