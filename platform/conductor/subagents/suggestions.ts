/**
 * THE SUGGESTION CHIPS, IN ONE PLACE.
 *
 * These were a fixed five, offered under every answer, including the ones that
 * could not possibly apply: "show me the worst hour" on a file with no readable
 * timestamps, "what are the top categories" on a file with no categorical
 * column. A suggestion is an INVITATION, and an invitation to ask a question that
 * is guaranteed to be refused teaches the user the suggestions are noise.
 *
 * So each chip is offered only when the data behind it exists, and the question
 * just answered is never offered back -- re-suggesting what somebody just clicked
 * is the clearest possible evidence that nothing is paying attention.
 *
 * === WHY THIS IS A SEPARATE MODULE AND NOT A HELPER IN ONE AGENT ===
 *
 * Because the subagents asked for it independently. The first draft of the
 * anomaly agent, the forecasting agent and the profiler agent each carried their
 * own hardcoded chip list, and the Phase 7 tests failed the moment all three
 * were wired in -- three copies of "what does the data support" is three
 * opinions about it. That is the same defect this repository has been
 * correcting for six releases: two implementations that agree until somebody
 * edits one.
 */

import type { AgentContext } from "./types.ts";

/**
 * THE INTENT EACH CHIP BELONGS TO.
 *
 * The first version compared chips to the prompt as STRINGS, which meant "show
 * me the worst hour" was not recognised as the same intent as "show me the
 * busiest hour" -- different word, same question -- so asking for the busiest
 * hour offered the worst hour right back underneath it.
 *
 * Comparing strings is the wrong tool for "is this the question they just
 * asked". Comparing INTENT is exactly right, and it means the synonyms in the
 * chip list and the synonyms in a user's sentence stop disagreeing.
 */
export type IntentKey = "hour" | "categories" | "findings" | "discordant" | "forecast" | "reading" | "columns" | "identify";

/** The intent a prompt is asking about, or null when it is not one of ours. */
export function intentOf(prompt: string): IntentKey | null {
  const lower = String(prompt ?? "").toLowerCase();
  if (/\b(missing|blank|null|empty|no value|not a number)\b/.test(lower) && /\b(which|what|most|worst|highest)\b/.test(lower)) return null;
  if (/\b(worst|busiest|peak)\b.*\b(hour|time)\b/.test(lower)) return "hour";
  if (/(categor|top |biggest|largest|most common|breakdown|group)/.test(lower)) return "categories";
  if (/(discord|contradict|relational|complex anomal|cross.column|two column)/.test(lower)) return "discordant";
  if (/(forecast|predict|projection|what (happens|will happen)|next \d+|trend|trajectory)/.test(lower)) return "forecast";
  if (/\b(wrong|problem|issue|anomal|findings|broken|bad|error|clean)\b/.test(lower)) return "findings";
  if (/how did you read|how do you read/.test(lower)) return "reading";
  if (/show me the columns|column statistics/.test(lower)) return "columns";
  if (/(summar|overview|tell me|what is this|describe)/.test(lower)) return null;
  return null;
}

export function adaptiveSuggestions(ctx: AgentContext, answered = ""): readonly string[] {
  const chips: { ask: string; intent: IntentKey; weight: number }[] = [];
  // The intent of what was JUST asked, resolved once. When it cannot be
  // resolved we fall back to the string comparison, which still catches the
  // exact-repeat case; when it can, synonym pairs are handled correctly too.
  const askedIntent = intentOf(answered);
  const seen = String(answered ?? "").trim().toLowerCase();

  const offer = (ask: string, intent: IntentKey, weight: number) => {
    const a = ask.trim().toLowerCase();
    if (askedIntent !== null) {
      if (intent === askedIntent) return;
    } else if (seen !== "" && (a === seen || a.includes(seen) || seen.includes(a))) return;
    chips.push({ ask, intent, weight });
  };

  const severe = ctx.anomalies.filter((a) => a.severity === "critical").length;
  if (severe > 0) offer("what is wrong with this file?", "findings", 100);
  if (ctx.purpose.kind === "unknown") offer("tell me what this file is for", "identify", 90);
  if (ctx.timeline.length > 0) offer("show me the worst hour", "hour", 60);
  if (ctx.ranking.length > 0) offer("what are the top categories", "categories", 55);
  if (ctx.columns.length >= 2) offer("are there any complex anomalies?", "discordant", 50);
  if (ctx.forecast?.ok === true) offer("what happens over the next 12 hours?", "forecast", 45);
  offer("how did you read the columns?", "reading", 40);
  offer("show me the columns", "columns", 30);

  return chips.sort((a, b) => b.weight - a.weight).slice(0, 4).map((c) => c.ask);
}