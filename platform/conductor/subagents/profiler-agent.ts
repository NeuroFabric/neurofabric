/**
 * THE PROFILER AGENT. What this file IS, and how the engine read it.
 *
 * It owns the semantic purpose statement, the synthesis summary, the category
 * ranking, the timeline shape, and the reading the engine assigned to each
 * column -- which is to say, everything a person asks when they have just opened
 * a file and do not yet know anything about it.
 *
 * === WHY THE SCHEMA CORRECTION IS DESCRIBED HERE BUT NOT PARSED HERE ===
 *
 * The correction grammar has to be SERIALISED INTO THE BROWSER by
 * Function.prototype.toString, because the page and the test suite must run the
 * same parser rather than two that agree today. So it cannot be imported here
 * without breaking that arrangement -- the browser has no module loader and no
 * access to this bundle.
 *
 * That constraint is worth stating rather than working around, because the
 * tempting "fix" is to import the parser here and quietly create a second
 * implementation that agrees until somebody edits one. The parse stays where it
 * is; this agent owns everything AFTER it.
 *
 * === NOTHING IN HERE INVENTS A SUGGESTION OR A WIDGET ===
 *
 * Every `suggestions` below is `adaptiveSuggestions(ctx, prompt)` and every
 * widget comes from `widgets.ts`. The first draft of this agent carried its own
 * hardcoded chip lists and inline widget literals, and the moment all three
 * agents were wired in the Phase 7 adaptive-suggestion tests failed -- because
 * three copies of "what the data supports" is three opinions about it.
 *
 * That is the exact defect this repository has been correcting for six releases:
 * two implementations that agree until somebody edits one. I introduced it while
 * refactoring to prevent it. The shared modules are the fix, and this file is
 * now written as though they were the only option, because they are.
 *
 * === WHY THE PROMPT IS COMPUTED ONCE AND PASSED DOWN ===
 *
 * `adaptiveSuggestions` needs to know what was just asked, so it can avoid
 * offering the question the user is looking at straight back at them. Passing it
 * from `answer` into each builder -- rather than having every builder accept a
 * prompt and recompute -- means the "what did they just ask" decision is made in
 * exactly one place per turn, and a branch that forgets to pass it cannot end up
 * with a different set of chips from its neighbours.
 */

import type { Reply } from "../conversation.ts";
import { rows, type AgentContext, type Subagent } from "./types.ts";
import { adaptiveSuggestions } from "./suggestions.ts";
import { barWidget, findingsWidget, lineWidget, mappingsWidget } from "./widgets.ts";

const ACCEPTS: readonly RegExp[] = [
  /(summar|tell me (more |anything |everything )?about|what is this|what s this|describe (this|the)|catch me up|walk me through|what can you tell me|what could you tell me|what do you see|give me (an? )?(summary|overview|tour|breakdown)|fill me in|anything (interesting|notable)|brief me)/,
  /(categor|top |biggest|largest|most common|breakdown|group|which .*most)/,
  /how did you read|how do you read|what did you (make|think) of/,
  /show me the columns|column statistics|describe the columns/,
  /\b(help|what can you|capabilit|how do i|what do you)\b/,
  /\b(worst|busiest|peak)\b.*\b(hour|time)\b/,
];

function num(v: number): string {
  return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : String(Math.round(v * 100) / 100);
}

/** The chips for this turn, minus whatever was just asked. Computed once. */
type Chips = readonly string[];

/** THE SYNTHESIS: every measured fact, in one paragraph. */
export function synthesis(ctx: AgentContext): string {
  const severe = ctx.anomalies.filter((a) => a.severity === "critical");
  const parts: string[] = [];

  parts.push(`I read ${rows(ctx.totalRows)} rows across ${ctx.columns.length} numeric column${ctx.columns.length === 1 ? "" : "s"}.`);

  parts.push(ctx.purpose.kind === "unknown"
    ? "I cannot tell what this file is for from the column names alone, so I will not pretend otherwise."
    : ctx.purpose.confidence === "high"
      ? ctx.purpose.statement
      : `${ctx.purpose.statement} That is a reading of the column names, not something I checked.`);

  const top = ctx.ranking[0];
  if (top !== undefined) {
    parts.push(`The largest category is "${top.key}" with ${rows(top.count)} rows, across ${rows(ctx.ranking.length)} distinct value${ctx.ranking.length === 1 ? "" : "s"} I can rank.`);
  }

  const busiest = [...ctx.timeline].sort((a, b) => b.count - a.count)[0];
  if (busiest !== undefined) {
    parts.push(`The busiest hour is ${busiest.hour.replace("T", " ")}:00 with ${rows(busiest.count)} rows.`);
  }

  if (severe.length > 0) {
    const worst = severe[0]!;
    const stat = ctx.columns.find((c) => c.name === worst.column);
    const value = stat?.max ?? null;
    const figure = value === null ? "" : ` at ${num(value)}`;
    parts.push(`I found ${rows(severe.length)} severe finding${severe.length === 1 ? "" : "s"}; the worst is in ${worst.column}${figure}.`);
  } else if (ctx.anomalies.length > 0) {
    parts.push(`Nothing is severe. I found ${rows(ctx.anomalies.length)} thing${ctx.anomalies.length === 1 ? "" : "s"} worth looking at.`);
  } else {
    parts.push("Nothing in it looks malformed -- every column is clean by the engine's own thresholds.");
  }

  parts.push("Ask me about the categories, the busiest hour, what is wrong with it, what happens next, or how I read each column, and I will go further.");
  return parts.join(" ");
}

function overviewReply(ctx: AgentContext, chips: Chips): Reply {
  const severe = ctx.anomalies.filter((a) => a.severity === "critical");
  return {
    kind: "answer",
    text: synthesis(ctx),
    widgets: severe.length > 0 ? [findingsWidget(ctx)] : [],
    suggestions: chips,
  };
}

function categoriesReply(ctx: AgentContext, chips: Chips): Reply {
  if (ctx.ranking.length === 0) {
    return {
      kind: "answer",
      text: "I could not find a categorical column in this file, so there is nothing to rank. " +
        "If a column of yours groups things -- a channel, a region, a status -- tell me in plain English " +
        "and I will use it: say \"channel is the category\".",
      widgets: [],
      suggestions: chips,
    };
  }
  const top = ctx.ranking[0]!;
  return {
    kind: "answer",
    text: `${rows(ctx.ranking.length)} distinct value${ctx.ranking.length === 1 ? "" : "s"} in the category column. ` +
      `The largest is "${top.key}" with ${rows(top.count)} rows.`,
    widgets: [barWidget(ctx)],
    suggestions: chips,
  };
}

function hourReply(ctx: AgentContext, chips: Chips): Reply {
  if (ctx.timeline.length === 0) {
    return {
      kind: "answer",
      text: "This file has no readable timestamps, so there is no hour to rank. " +
        "If it has a time column and I did not recognise it, say so and I will read it that way.",
      widgets: [],
      suggestions: chips,
    };
  }
  const worst = [...ctx.timeline].sort((a, b) => b.count - a.count)[0]!;
  const spikes = ctx.timeline.filter((p) => p.spike);
  return {
    kind: "answer",
    text: spikes.length > 0
      ? `${spikes.length} hour${spikes.length === 1 ? "" : "s"} stand out against the mean. ` +
        `The busiest is ${worst.hour.replace("T", " ")}:00 with ${rows(worst.count)} rows.`
      : `No hour stands out against the mean. The busiest is ${worst.hour.replace("T", " ")}:00 with ${rows(worst.count)} rows.`,
    widgets: [lineWidget(ctx)],
    suggestions: chips,
  };
}

function columnsReply(ctx: AgentContext, chips: Chips): Reply {
  if (ctx.columns.length === 0) {
    return {
      kind: "answer",
      text: "This file has no numeric columns for me to measure.",
      widgets: [],
      suggestions: chips,
    };
  }
  const lines = ctx.columns.slice(0, 8).map((c) =>
    `${c.name}: mean ${c.mean === null ? "unknown" : num(c.mean)}, ` +
    `range ${c.min === null ? "?" : num(c.min)} to ${c.max === null ? "?" : num(c.max)}, ` +
    `${rows(c.measured)} measured, ${rows(c.empty)} blank.`);
  return {
    kind: "answer",
    text: `${rows(ctx.columns.length)} numeric column${ctx.columns.length === 1 ? "" : "s"}. ${lines.join(" ")}`,
    widgets: [],
    suggestions: chips,
  };
}

function readingReply(ctx: AgentContext, chips: Chips): Reply {
  const learned = Object.entries(ctx.learned ?? {});
  const learnedText = learned.length > 0
    ? `${learned.length} of those mappings came from what you told me in this conversation. `
    : "";
  return {
    kind: "answer",
    text: `${learnedText}I inferred the rest from column names and a statistical profile of the values. ` +
      `None of it has been checked by a person, so treat it as a first reading. ` +
      `The column names here are ${ctx.columns.map((c) => c.name).join(", ")}. ` +
      `Tell me a mapping in plain English and I will remember it for this checkout.`,
    widgets: [mappingsWidget(ctx)],
    suggestions: chips,
  };
}

function helpReply(ctx: AgentContext, chips: Chips): Reply {
  const can = [
    ctx.timeline.length > 0 ? "the busiest hour" : null,
    ctx.ranking.length > 0 ? "the biggest categories" : null,
    "what looks wrong with it",
    "how I read each column",
  ].filter((x) => x !== null);
  return {
    kind: "answer",
    text: `I can show you ${can.join(", ")}. You can also correct a column in plain English, and I will re-read the file. ` +
      "I do not answer free-form questions about values -- I can only report what the engine measured.",
    widgets: [],
    suggestions: chips,
  };
}

export const profilerAgent: Subagent = {
  name: "profiler",
  handles(prompt) {
    const lower = prompt.toLowerCase();
    return ACCEPTS.some((re) => re.test(lower));
  },
  answer(ctx, prompt) {
    const lower = prompt.toLowerCase();
    // Computed ONCE, and passed to whichever branch answers. A branch that
    // recomputed it could disagree with its neighbours about which question the
    // user just asked, and the whole point is that nobody should be offered
    // back the thing they are already looking at.
    const chips = adaptiveSuggestions(ctx, prompt);
    // NARROWEST FIRST, and the order is a specification rather than an
    // implementation detail: "what is wrong" is not here, but "which column has
    // the most missing values" would otherwise be answered as a category
    // ranking, because "most" is in both vocabularies.
    if (/\b(missing|blank|null|empty|no value|not a number)\b/.test(lower) && /\b(which|what|most|worst|highest)\b/.test(lower)) {
      return null; // the anomaly agent owns data quality
    }
    if (/\b(worst|busiest|peak)\b.*\b(hour|time)\b/.test(lower)) return hourReply(ctx, chips);
    if (/(categor|top |biggest|largest|most common|breakdown|group|which .*most)/.test(lower)) return categoriesReply(ctx, chips);
    if (/how did you read|how do you read|what did you (make|think) of/.test(lower)) return readingReply(ctx, chips);
    if (/show me the columns|column statistics|describe the columns/.test(lower)) return columnsReply(ctx, chips);
    if (/\b(help|what can you|capabilit|how do i|what do you)\b/.test(lower)) return helpReply(ctx, chips);
    return overviewReply(ctx, chips);
  },
};