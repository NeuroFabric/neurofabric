/**
 * PREDICTIVE FORECASTING. The one place this product asserts something about
 * data that does not exist yet.
 *
 * === WHY THE CONSTRAINTS HERE ARE ABOUT HONESTY, NOT ACCURACY ===
 *
 * Every other feature answers a question about data that already exists. This
 * one does not, and that changes the failure mode. A wrong report is caught by
 * somebody reading it. A wrong FORECAST is caught by nobody, because a forecast
 * that looks like a measurement is indistinguishable from one -- and the reader
 * has no baseline to compare it against, which is the entire reason they asked.
 *
 * So the design is mostly about what it refuses to say:
 *
 *   - EVERY point carries an interval. A single projected line is a guess wearing
 *     a number's clothes. The interval WIDENS with the horizon, because
 *     uncertainty compounds and a flat interval across twelve hours is a lie
 *     repeated once an hour.
 *   - IT DECLINES below a floor of observations. Four hourly points and a trend
 *     line is arithmetic, not a signal.
 *   - IT DECLINES across a GAP. A file with 09:00 and then 11:00 has no 10:00
 *     row. That is missing data, not a quiet hour, and projecting across it
 *     invents a dip and then a recovery from it -- two confident lies from one
 *     missing cell.
 *   - IT SAYS WHAT IT IS DOING, in words that can be checked against the data.
 *   - IT NEVER CLAIMS INCIDENTS. A high forecast means the trend points there,
 *     not that something will break. A tool that says the second gets a 3am
 *     page and will have been wrong.
 *
 * === THE METHOD, AND WHY THIS ONE ===
 *
 * Simple exponential smoothing with a damped local trend. Chosen over ARIMA
 * deliberately: an ARIMA fit on twenty hourly points would select parameters
 * with a genuine opportunity to overfit, and it would be unfalsifiable -- nobody
 * reading the output could tell which model won. SES is one smoothing constant,
 * the level is inspectable, and the residual spread is available for an interval
 * that actually responds to how noisy the series is.
 *
 * The trend is DAMPED because an undamped local slope compounds without limit:
 * twelve hours of a steep climb projects a spike that no amount of arithmetic
 * justifies, and the interval cannot save a point estimate that is simply wrong.
 */

/** What was observed, in the engine's own hour shape. */
export interface HourPoint {
  readonly hour: string;
  readonly count: number;
  readonly share: number;
  readonly multiple: number | null;
  readonly spike: boolean;
  readonly rule: string | null;
}

export interface ForecastPoint {
  /** ISO hour key, continuing the observed clock. */
  readonly hour: string;
  readonly count: number;
  /** Lower and upper bound. Never null -- see the module note. */
  readonly lower: number;
  readonly upper: number;
  /** ALWAYS TRUE on this type. Published so a chart cannot present it as measured. */
  readonly predicted: true;
}

export interface Forecast {
  readonly ok: boolean;
  /** Why it declined. Present exactly when `ok` is false. */
  readonly reason?: string;
  readonly points: readonly ForecastPoint[];
  readonly method: string;
  /** One sentence, in words, saying what was done. Never a promise. */
  readonly explanation: string;
  /** The last hour actually observed, so a chart can draw the divide. */
  readonly lastObservedHour: string | null;
}

export const FORECAST_METHOD = "damped exponential smoothing with a local linear trend";

/**
 * Below this, a trend is arithmetic rather than a signal. Twelve hours is the
 * point where a diurnal pattern has something to say; below it the smoothing is
 * dominated by whichever hour happened to be busy.
 */
export const MIN_OBSERVATIONS = 12;

/** How hard to follow the most recent observation. Tuned once, stated, not tuned per file. */
const ALPHA = 0.3;

/**
 * How hard to update the TREND. Small on purpose.
 *
 * The trend is a derivative of the level, so it is two noisy observations
 * removed. Letting it chase the level as eagerly as the level chases the data
 * makes it chase noise, and an over-eager trend compounds: the first version of
 * this loop used ALPHA here and a series climbing a steady 10/hour was forecast
 * DOWNWARD, because the trend accelerated, overshot, and came back. A slow trend
 * is the difference between projecting a trend and amplifying one.
 */
const BETA = 0.1;

/** How much of the local slope to carry forward. Below 1, so a trend cannot run away. */
const DAMPING = 0.85;

/** Residual multiplier for the interval. 1.96 would imply a normal distribution we cannot check. */
const Z = 1.64;

/** One hour, as a comparable key. Gaps are detected by discontinuity in this. */
function hourIndex(hour: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(hour);
  if (m === null) return null;
  const days = Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
  return days * 24 + Number(m[4]);
}

/** Render an absolute hour index back to the same ISO key. */
function hourKey(index: number): string {
  const days = Math.floor(index / 24);
  const h = index - days * 24;
  const d = new Date(days * 86_400_000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${da}T${String(h).padStart(2, "0")}`;
}

function makeRefusal(reason: string, lastHour: string | null): Forecast {
  return { ok: false, reason, points: [], method: FORECAST_METHOD, explanation: "", lastObservedHour: lastHour };
}

/**
 * PROJECT THE NEXT `horizon` HOURS, OR REFUSE.
 *
 * Pure and total: every input produces a Forecast, and `ok: false` means the
 * caller must show the reason rather than render nothing silently.
 */
export function forecast(
  observedHours: readonly HourPoint[],
  options: { readonly horizon?: number } = {},
): Forecast {
  const horizon = Math.max(1, Math.min(48, options.horizon ?? 12));
  const lastHour = observedHours.length > 0
    ? observedHours[observedHours.length - 1]!.hour
    : null;

  if (observedHours.length < MIN_OBSERVATIONS) {
    return makeRefusal(
      `I need at least ${MIN_OBSERVATIONS} hourly readings to project anything, and this file has ` +
      `${observedHours.length}. A trend drawn through ${observedHours.length} point${observedHours.length === 1 ? "" : "s"} ` +
      "is arithmetic, not a prediction.", lastHour);
  }

  // === THE GAP CHECK, BEFORE ANY ARITHMETIC ===
  //
  // Every consecutive pair must be exactly one hour apart. A file that skips an
  // hour does not have a zero there; it has a hole, and smoothing across a hole
  // invents a dip and then a recovery from it.
  const indices = observedHours.map((p) => hourIndex(p.hour));
  if (indices.some((i) => i === null)) {
    return makeRefusal("Some hours in this file are not in a form I can place on a clock, so I cannot project past them.", lastHour);
  }
  const sorted = [...indices].sort((a, b) => a! - b!);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]! - sorted[i - 1]! !== 1) {
      return makeRefusal(
        `The hours in this file are not continuous -- ${observedHours[i - 1]!.hour} and ` +
        `${observedHours[i]!.hour} are not adjacent. A missing hour is missing data, not a quiet ` +
        "hour, so I will not project across it.", lastHour);
    }
  }

  const series = [...observedHours].sort((a, b) => a.hour.localeCompare(b.hour)).map((p) => p.count);

  // === SIMPLE EXPONENTIAL SMOOTHING WITH A LOCAL, DAMPED TREND ===
  let level = series[0]!;
  let trend = series[1]! - series[0]!;
  const residuals: number[] = [];

  for (let i = 1; i < series.length; i += 1) {
    const observation = series[i]!;
    const predicted = level + DAMPING * trend;
    residuals.push(observation - predicted);
    // Standard Holt. The trend is updated from the CHANGE IN LEVEL, damped by
    // BETA, and it is the only term that carries the slope forward.
    const previousLevel = level;
    level = ALPHA * observation + (1 - ALPHA) * predicted;
    trend = BETA * (level - previousLevel) + (1 - BETA) * trend;
  }

  // The spread of what the model MISSED. This is what makes the interval
  // responsive: a noisy series leaves large residuals and therefore a wide one,
  // and a smooth one leaves almost nothing.
  const spread = residuals.length === 0 ? 0 : residualSpread(residuals);

  const points: ForecastPoint[] = [];
  const base = sorted[sorted.length - 1]!;
  for (let step = 1; step <= horizon; step += 1) {
    const count = level + step * DAMPING * trend;
    // Uncertainty compounds with the square root of the horizon: the longer the
    // projection, the less any of it is worth. A flat interval across twelve
    // hours would be a lie told once an hour.
    const band = Z * spread * Math.sqrt(step);
    const clamped = Math.max(0, count);
    points.push({
      hour: hourKey(base + step),
      count: Math.round(clamped),
      lower: Math.max(0, Math.round(clamped - band)),
      upper: Math.max(0, Math.round(clamped + band)),
      predicted: true,
    });
  }

  return {
    ok: true,
    points,
    method: FORECAST_METHOD,
    explanation:
      `${points.length} hours projected by ${FORECAST_METHOD}, from the ${series.length} observed hours. ` +
      "The shaded band is how much the model has been missing by so far, widened with distance. " +
      "Read it as 'the trend points somewhere in this range', not as a claim about anything breaking.",
    lastObservedHour: lastHour,
  };
}

/**
 * The typical size of a residual.
 *
 * Mean absolute deviation rather than a standard deviation: the residuals are a
 * handful of points with no defensible assumption of normality behind them, and
 * MAD cannot be dragged upward by a single outlier the way a variance can --
 * which matters when the outlier is the thing being forecast around.
 */
function residualSpread(residuals: readonly number[]): number {
  if (residuals.length === 0) return 0;
  const mean = residuals.reduce((n, r) => n + r, 0) / residuals.length;
  const deviations = residuals.map((r) => Math.abs(r - mean));
  return deviations.reduce((n, d) => n + d, 0) / deviations.length;
}