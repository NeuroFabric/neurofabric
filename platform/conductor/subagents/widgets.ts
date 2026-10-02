/**
 * THE WIDGETS, IN ONE PLACE.
 *
 * The chart builders used to live inside `conversation.ts`, which was fine when
 * one function built every answer. The moment the conductor delegates to three
 * agents, each needs them, and the obvious thing -- a copy in each agent -- is
 * three definitions of what a bar chart is. A category chart that capped at five
 * bars in one agent and ten in another is not a styling inconsistency; it is
 * two answers to one question, and the tests would have had to pick a winner.
 *
 * So the builders are shared, and the CAP LIVES HERE rather than at the caller.
 * It used to be applied by whichever code built the ConversationData, so it held
 * only for the paths that remembered, and a caller passing the full ranking got
 * a chart of every distinct value in the column -- which for free-text keys is
 * thousands of bars, rendering as a grey stripe rather than a chart.
 */

import type { AgentContext } from "./types.ts";

/**
 * THE WIDGET SHAPE, DECLARED HERE BECAUSE THIS IS WHERE WIDGETS ARE BUILT.
 *
 * It used to live in `conversation.ts`, which made the module that BUILDS a
 * widget depend on a module that also CONSUMED one -- and then, when the
 * subagents started importing this file, two structurally identical `Widget`
 * interfaces appeared and TypeScript correctly refused to treat them as one
 * type. The fix is ownership: one declaration, in the module that owns the
 * concept. `conversation.ts` re-exports it so no caller has to change its
 * import path, which keeps this a refactor rather than a migration.
 *
 * The union of `kind` values is the renderer's whole vocabulary. It is a union
 * and not `string` on purpose: a new widget kind that the page cannot draw is a
 * type error here rather than a blank panel in a browser.
 */
export type WidgetKind =
  | "chart-line" | "chart-bar" | "histogram" | "findings" | "columns" | "mappings" | "capabilities";

export interface Widget {
  readonly kind: WidgetKind;
  readonly title: string;
  readonly note?: string;
  /** The data. Shape depends on `kind`; the renderer branches, nothing else. */
  readonly payload: unknown;
}

/** How many bars a category chart draws. Ten fits without becoming a texture. */
const BAR_DEPTH = 10;

export function lineWidget(ctx: AgentContext): Widget {
  return {
    kind: "chart-line",
    title: "Rows by hour",
    note: "Orange points are spikes the engine flagged against its own mean. Hover for the exact count.",
    payload: { points: ctx.timeline },
  };
}

export function barWidget(ctx: AgentContext): Widget {
  const points = ctx.ranking.slice(0, BAR_DEPTH);
  const hidden = ctx.ranking.length - points.length;
  return {
    kind: "chart-bar",
    title: "Record categories",
    note: hidden > 0
      ? `How many rows fall in each category. Showing the top ${BAR_DEPTH} of ${ctx.ranking.length}.`
      : "How many rows fall in each category.",
    payload: { points, hidden },
  };
}

export function findingsWidget(ctx: AgentContext): Widget {
  const n = ctx.anomalies.length;
  return {
    kind: "findings",
    title: "Findings",
    note: `${n.toLocaleString("en-US")} in total, worst first.`,
    payload: { anomalies: ctx.anomalies },
  };
}

export function mappingsWidget(ctx: AgentContext): Widget {
  const learned = ctx.learned ?? {};
  return {
    kind: "mappings",
    title: "How I read the columns",
    payload: { learned, columns: ctx.columns.map((c) => c.name) },
  };
}