/**
 * THE FORECASTING AGENT. What happens next, and whether it gets worse.
 *
 * Until Phase 8 this agent did not exist and the capability it owns had NO entry
 * point at all. The dashboard drew a projection, the executive summary quoted
 * it, and nothing a user could type asked about it -- a feature they could only
 * discover by looking. The agent's first job is therefore to make the thing
 * visible in conversation, not to improve the maths, which was already tested.
 *
 * === WHY IT DECLINES WITH THE ENGINE'S OWN REASON ===
 *
 * Forecasting refuses to project across a gap in the timeline, and says which
 * hour broke continuity. That reason is the most useful thing this agent can
 * give a user who asks about a forecast that does not exist: "no" is useless,
 * and "no, because 2026-09-26T14 is missing and a missing hour is missing data,
 * not a quiet hour" tells them what to fix. Inventing a projection to fill the
 * gap would be the single most damaging thing this agent could do.
 */

import type { Reply } from "../conversation.ts";
import { type AgentContext, type Subagent } from "./types.ts";
import { adaptiveSuggestions } from "./suggestions.ts";

/**
 * Forward-looking vocabulary.
 *
 * NO TRAILING BOUNDARY on a prefix alternative: "forecast" terminated by a word
 * boundary cannot match "forecasting", because the next character is itself a
 * word character. That mistake has been made twice in this codebase already.
 */
const ACCEPTS: readonly RegExp[] = [
  /forecast|predict|projection|project/,
  /what (happens|will happen|comes|is coming)/,
  /next (12|24|day|days|hours?|week)/,
  /going to (happen|do|be)/,
  /trend/,
  /trajectory/,
  /is it (getting|worsen|improving)/,
  /extrapolat/,
];

export function asksAboutForecast(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return ACCEPTS.some((re) => re.test(lower));
}

/**
 * THE PROJECTION, OR THE REASON THERE IS NOT ONE.
 *
 * Exported so the anomaly agent can ask this agent the same question during a
 * handoff, rather than re-reading the forecast field and forming its own
 * opinion. One agent owns the judgement; another may request it.
 */
export function describeForecast(ctx: AgentContext): { text: string; ok: boolean } {
  const f = ctx.forecast;
  if (f === undefined || f === null || !f.ok) {
    const reason = f?.reason ?? "this file has no hourly readings for me to project from";
    return {
      ok: false,
      text: `I cannot project this file. ${reason}.`,
    };
  }

  const points = f.points;
  if (points.length === 0) {
    return { ok: false, text: "I have no projection to report for this file." };
  }

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const rising = last.value > first.value;
  const widening = (last.upper - last.lower) > (first.upper - first.lower);
  const direction = rising ? "rising" : last.value < first.value ? "falling" : "flat";

  return {
    ok: true,
    text: `I project ${points.length} hours ahead by ${f.method}, from the hours up to ` +
      `${(f.lastObservedHour ?? "the last reading").replace("T", " ")}. ` +
      `It goes ${direction}, from ${Math.round(first.value).toLocaleString("en-US")} at ` +
      `${first.hour.replace("T", " ")} to ${Math.round(last.value).toLocaleString("en-US")} by ` +
      `${last.hour.replace("T", " ")}, with a band that is ` +
      `${widening ? "widening" : "holding steady"} -- ` +
      `that is how much the model has been missing by so far.`,
  };
}

export const forecastingAgent: Subagent = {
  name: "forecasting",
  handles(prompt) {
    return asksAboutForecast(prompt);
  },
  answer(ctx) {
    const { text, ok } = describeForecast(ctx);
    return {
      kind: "answer",
      text: ok
        ? text + " It is a projection, not a measurement: it says where this series has been heading, not what will happen."
        : text + " I would rather say that than draw a line through a gap and call it a prediction.",
      widgets: [],
      suggestions: adaptiveSuggestions(ctx),
    };
  },
};

