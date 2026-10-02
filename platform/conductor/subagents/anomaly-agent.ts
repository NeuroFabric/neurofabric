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
  const severeWord = severe.length === 0 ? "finding" : "severe finding";
  return {
    kind: "answer",
    text: `${rows(ctx.anomalies.length)} ${ctx.anomalies.length === 1 ? "finding" : "findings"}` +
      `${severe.length === 0 ? ", none of them severe" : ""}. The worst is ${severeWord} in ${lead.column}: ${lead.detail}.`,
    widgets: [findingsWidget(ctx)],
    suggestions: adaptiveSuggestions(ctx),
  };
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