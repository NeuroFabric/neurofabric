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

import { forecast, FORECAST_METHOD, type HourPoint } from "../forecasting.ts";
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

/**
 * THE COLLECTION POINT. ONE AGENT ASKS ANOTHER A QUESTION.
 *
 * This exists because the anomaly agent has a finding about a COLUMN and the
 * only thing that can say whether it is getting worse is the agent holding the
 * method. It calls `evaluate` rather than re-implementing damped Holt, because a
 * second projection in this repository is a second answer to one question --
 * which is the drift this codebase has spent six releases removing.
 *
 * It returns a value, never a Reply. An agent asking a colleague must not be able
 * to hand back a fully-formed reply and skip its own job; the caller still has to
 * synthesise an answer, and the decision to say what is the caller's.
 *
 * `column` is optional. With one, the series is rebuilt from the ROWS for that
 * column, because the file-level forecast on `ctx.forecast` projects ROW COUNTS
 * per hour -- answering "is this file busy" when the user asked "is this column
 * degrading". Without one, the file-level forecast is used.
 *
 * The series is the hourly MEAN, not the max. A maximum is the thing that found
 * the anomaly, and projecting it would confidently extrapolate the worst
 * observed value twelve hours into the future -- a number that describes no hour
 * that has happened, and may never.
 */
/**
 * ONE SHAPE FOR BOTH PROJECTION SOURCES.
 *
 * The engine calls its number `count`, because its series is rows-per-hour. The
 * conversation payload calls it `value`, because a per-column projection is not a
 * count of anything. Both shapes reach this function, so the evaluation
 * NORMALISES to `value` -- one name downstream, whatever produced it, rather than
 * every caller knowing which source it came from.
 */
export interface ForecastEvaluation {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly method: string;
  readonly points: readonly { readonly hour: string; readonly value: number; readonly lower: number; readonly upper: number }[];
  readonly horizon: number;
  readonly direction: "rising" | "falling" | "flat";
  /** The last value actually observed, which is the comparison the user needs. */
  readonly lastObserved: number | null;
}

function hourlySeriesForColumn(ctx: AgentContext, column: string): HourPoint[] | null {
  const rows = ctx.rows;
  if (rows === undefined || rows.length === 0) return null;

  const buckets = new Map<string, { sum: number; n: number }>();
  for (const row of rows) {
    const raw = (row as Record<string, unknown>)[column];
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value)) continue;
    const hour = String((row as Record<string, unknown>)._time ?? "").slice(0, 13);
    if (hour.length < 13) continue;
    const b = buckets.get(hour) ?? { sum: 0, n: 0 };
    b.sum += value;
    b.n += 1;
    buckets.set(hour, b);
  }
  if (buckets.size === 0) return null;

  const total = [...buckets.values()].reduce((s, b) => s + b.n, 0);
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hour, b]) => ({
      hour, count: b.sum / b.n, share: b.n / total,
      multiple: null, spike: false, rule: null,
    }));
}

export function evaluate(ctx: AgentContext, column?: string): ForecastEvaluation {
  const HORIZON = 12;
  const decline = (reason: string): ForecastEvaluation =>
    ({ ok: false, reason, method: FORECAST_METHOD, points: [], horizon: HORIZON, direction: "flat", lastObserved: null });

  if (column !== undefined) {
    const series = hourlySeriesForColumn(ctx, column);
    if (series === null) {
      return decline(`I have no hourly readings for ${column}, so there is nothing to project.`);
    }
    const result = forecast(series, { horizon: HORIZON });
    if (!result.ok) return decline(result.reason ?? `I cannot project ${column}.`);
    const last = series[series.length - 1]!.count;
    const end = result.points[result.points.length - 1]!.count;
    return {
      ok: true,
      reason: null,
      method: result.method,
      // Normalised: the engine says `count`, this interface says `value`.
      points: result.points.map((p) => ({
        hour: p.hour, value: p.count, lower: p.lower, upper: p.upper,
      })),
      horizon: HORIZON,
      direction: end > last ? "rising" : end < last ? "falling" : "flat",
      lastObserved: last,
    };
  }

  // No column: the file-level projection the engine already computed.
  const f = ctx.forecast;
  if (f === undefined || f === null || !f.ok) {
    return decline(f?.reason ?? "this file has no hourly readings for me to project from");
  }
  const first = f.points[0]!;
  const end = f.points[f.points.length - 1]!;
  return {
    ok: true,
    reason: null,
    method: f.method,
    points: f.points,
    horizon: f.points.length,
    direction: end.value > first.value ? "rising" : end.value < first.value ? "falling" : "flat",
    lastObserved: first.value,
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

