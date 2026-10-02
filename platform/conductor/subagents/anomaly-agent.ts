/**
 * THE ANOMALY AGENT. What is wrong with this file, and what contradicts itself.
 *
 * It owns the 1D fences (Tukey IQR, the 3x and 1.5x fences) and the 2D check
 * (robust median/MAD across two columns at once), because those are two readings
 * of the same question -- "is anything here inconsistent?" -- and splitting them
 * across two agents would mean a user asking "is this file clean?" gets half an
 * answer from each.
 *
 * === WHY THE 2D CHECK LIVES WITH THE 1D AND NOT WITH THE PROFILER ===
 *
 * A row that is high in one column and low in another is a defect of the RELATION
 * between columns, and it is invisible to anything that reads columns one at a
 * time. But it is still a data-quality finding, so it belongs with the fences
 * rather than with the file's purpose. Grouping by "what the user is asking
 * about" rather than by "which module computes it" is the whole reason agents
 * are worth having.
 */

import { findCrossColumnAnomalies, type CrossColumnAnomaly } from "../multivariate.ts";
import type { Reply } from "../conversation.ts";
import { rows, type AgentContext, type Subagent } from "./types.ts";
import { adaptiveSuggestions } from "./suggestions.ts";
import { findingsWidget } from "./widgets.ts";
import { evaluate } from "./forecasting-agent.ts";

const CONTRADICTION: readonly RegExp[] = [
  /(discord|contradict|relational|out of step|inconsistent pair|complex anomal|cross.column|two column|both column)/,
];

/** Is this the narrower, cross-column question rather than the general one? */
export function asksAboutDiscordance(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return CONTRADICTION.some((re) => re.test(lower));
}

function fmtNum(v: number): string {
  return Math.abs(v) >= 1000
    ? Math.round(v).toLocaleString("en-US")
    : String(Math.round(v * 100) / 100);
}

/**
 * THE CROSS-COLUMN SEARCH, shared by this agent's own answer and by the
 * handoff in the forecasting agent.
 *
 * Exported rather than duplicated: two agents that each ran their own copy of
 * "find the most discordant pair" would eventually disagree, and a disagreement
 * between two specialists is far harder to diagnose than a duplicate function.
 */
export function bestDiscordantPair(ctx: AgentContext):
  | { anomaly: CrossColumnAnomaly; x: string; y: string; all: readonly CrossColumnAnomaly[] }
  | null {
  const data = ctx.rows;
  if (data === undefined || data.length === 0) return null;
  const numeric = ctx.columns.map((c) => c.name).filter((n) => n !== undefined).slice(0, 6);
  let best: { anomaly: CrossColumnAnomaly; x: string; y: string; all: readonly CrossColumnAnomaly[] } | null = null;
  for (let i = 0; i < numeric.length; i++) {
    for (let j = i + 1; j < numeric.length; j++) {
      const found = findCrossColumnAnomalies({ rows: data, columns: [numeric[i]!, numeric[j]!] });
      if (found.length > 0 && (best === null || found[0]!.strength > best.anomaly.strength)) {
        best = { anomaly: found[0]!, x: numeric[i]!, y: numeric[j]!, all: found };
      }
    }
  }
  return best;
}

function discordanceAnswer(ctx: AgentContext): Reply {
  if (ctx.rows === undefined || ctx.rows.length === 0) {
    return {
      kind: "answer",
      text: "I cannot check for rows that disagree with each other from the summary I was given -- " +
        "that needs the rows themselves, and I do not have them here. " +
        "I can still show you the per-column findings, the categories, and how I read each column.",
      widgets: [],
      suggestions: adaptiveSuggestions(ctx),
    };
  }

  const best = bestDiscordantPair(ctx);
  if (best === null) {
    return {
      kind: "answer",
      text: `No. Across ${rows(ctx.totalRows)}, no row has two numeric columns that contradict each other -- ` +
        "every row that is high in one is also high in the other, or low in both. " +
        "Rows that are merely large are a different question, and I answer that one from the per-column findings.",
      widgets: [],
      suggestions: adaptiveSuggestions(ctx),
    };
  }

  const { anomaly: a, x, y, all } = best;
  const n = all.length;
  return {
    kind: "answer",
    text: `Yes. ${n} row${n === 1 ? "" : "s"} contradict${n === 1 ? "s" : ""} ` +
      `${n === 1 ? "itself" : "themselves"}: ` +
      `${a.x.column} is unusually ${a.x.z > 0 ? "high" : "low"} (${fmtNum(a.x.value)}) while ` +
      `${a.y.column} is unusually ${a.y.z > 0 ? "high" : "low"} (${fmtNum(a.y.value)}), which do not go together. ` +
      `Row ${a.row + 1} is the clearest: ${a.x.column} ${a.x.z.toFixed(1)} robust deviations from its median, ` +
      `${a.y.column} ${a.y.z.toFixed(1)}. ` +
      "A row like that is usually a join that went wrong or a field measured in the wrong unit, rather than a real observation.",
    widgets: [],
    suggestions: adaptiveSuggestions(ctx),
  };
}

/**
 * THE HANDOFF. ONE AGENT ASKS ANOTHER A QUESTION.
 *
 * A critical finding is a statement about a MOMENT. "latency_ms hit 1,200ms"
 * tells a user what happened and leaves the only question they actually have
 * unanswered: is it getting worse? The data for that already exists, in the
 * module holding the projection method, and this is the call that reaches it.
 *
 * === WHY IT IS THE AGENT AND NOT THE ROUTER ===
 *
 * The Conductor decides who answers a USER'S question. This is an agent asking a
 * colleague something, which is a different relationship, and routing it through
 * the orchestrator would mean the orchestrator orchestrating its own
 * specialists -- which is how a router stops being a router and starts being the
 * thing it coordinates. The dependency runs agent to agent, not agent to
 * conductor to agent.
 *
 * === WHY IT FIRES ONLY ON CRITICAL ===
 *
 * An agent that consults a colleague on every small finding produces two
 * paragraphs about a rounding error. A user who learns to skim that will skim
 * the real one too, and the whole arrangement is worthless. One severe finding
 * per answer is the budget.
 */
function consultForecast(ctx: AgentContext, column: string): string {
  const eval_ = evaluate(ctx, column);
  if (!eval_.ok) {
    // The projection is a BONUS on a finding that is already true. If it cannot
    // be produced, the finding stands alone rather than the answer apologising
    // for itself.
    return `I asked the forecasting agent about ${column} and it could not project it -- ${eval_.reason ?? "no reason given"}.`;
  }
  const end = eval_.points[eval_.points.length - 1]!;
  // The verbs AGREE WITH "which". The first draft wrote "which project this will
  // get worse", which reads as a typo and costs the reader a beat of doubt about
  // the whole sentence -- including about the number in it.
const verb = eval_.direction === "rising" ? "projects this will get worse"
    : eval_.direction === "falling" ? "projects this will settle"
      : "projects this will hold steady";
  return `I consulted the forecasting agent, which ${verb}, from ${fmtNum(eval_.lastObserved ?? 0)} to about ` +
    `${fmtNum(end.value)} over the next ${eval_.horizon} hours ` +
    `(a band from ${fmtNum(end.lower)} to ${fmtNum(end.upper)}).`;
}

function findingsAnswer(ctx: AgentContext): Reply {
  const severe = ctx.anomalies.filter((a) => a.severity === "critical");
  if (ctx.anomalies.length === 0) {
    return {
      kind: "answer",
      text: "Nothing to flag. Every column is numerically clean by the engine's own thresholds, " +
        "and there are no extreme values past the 3x-IQR fence.",
      widgets: [findingsWidget(ctx)],
      suggestions: adaptiveSuggestions(ctx),
    };
  }

  const lead = severe[0] ?? ctx.anomalies[0]!;
  const headline = `${ctx.anomalies.length === 1 ? "1 finding" : `${ctx.anomalies.length.toLocaleString("en-US")} findings`}` +
    `${severe.length === 0 ? ", none of them severe" : ""}. The worst is ` +
    `${severe.length === 0 ? "a finding" : "a severe finding"} in ${lead.column}: ${lead.detail}.`;

  // THE HANDOFF, and only for a severe finding on a column we can actually
  // build a series for. Both halves are labelled so the user can tell which is
  // measured and which is modelled.
  const projected = severe.length > 0 ? consultForecast(ctx, lead.column) : null;

  return {
    kind: "answer",
    text: projected === null
      ? `${headline} ${forecastFollowup("tell me more about this file")}`
      : `${headline} ${projected} That is a projection of a trend, not a measurement of what will happen.`,
    widgets: [findingsWidget(ctx)],
    suggestions: adaptiveSuggestions(ctx),
  };
}

function forecastFollowup(ask: string): string {
  return `Ask me "${ask}" if you want the rest of the file.`;
}

export const anomalyAgent: Subagent = {
  name: "anomaly",
  handles(prompt) {
    const lower = prompt.toLowerCase();
    // The cross-column vocabulary is checked first because it OVERLAPS the
    // findings vocabulary -- "complex anomalies" contains "anomalies" -- and an
    // agent that matched only the broader word would answer a narrower question
    // than the one that was asked.
    if (asksAboutDiscordance(lower)) return true;
    return /\b(wrong|problem|issue|anomal|findings|broken|bad|error|clean)\b/.test(lower);
  },
  answer(ctx, prompt) {
    return asksAboutDiscordance(prompt) ? discordanceAnswer(ctx) : findingsAnswer(ctx);
  },
};