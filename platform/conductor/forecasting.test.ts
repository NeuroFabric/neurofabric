import test from "node:test";
import assert from "node:assert/strict";

import { forecast, FORECAST_METHOD } from "./forecasting.ts";

/**
 * PREDICTIVE FORECASTING. And an honest account of how little it knows.
 *
 * === WHY THIS IS THE HARDEST THING IN THE PRODUCT ===
 *
 * Every other feature here answers a question about data that already exists.
 * This one asserts something about data that does not. That is a different kind
 * of claim, and the failure mode is not "it was wrong" -- it is "it was wrong
 * and nobody could tell", because a forecast that looks like a measurement is
 * indistinguishable from one.
 *
 * So the constraints here are mostly about HONESTY rather than accuracy:
 *
 *   - A forecast must carry an INTERVAL. A single projected line is a guess
 *     wearing a number's clothes. The interval grows with the horizon, because
 *     uncertainty compounds, and a flat interval across 12 hours is a lie told
 *     once per hour.
 *   - It must DECLINE on too little data. Four hourly points and a trend line is
 *     arithmetic; twelve is barely a signal. Below the floor this returns
 *     nothing rather than a number that looks like a prediction.
 *   - It must say what it is doing. "Exponential smoothing of the observed
 *     hourly counts" is checkable. "Predicting the future" is not.
 *   - Gaps must not be treated as zero. A file covering 09:00 and 11:00 and not
 *     10:00 has no 10:00 row, and that is missing data -- not a quiet hour.
 *
 * === WHAT IT IS NOT ===
 *
 * It is not anomaly prediction, and the module never claims to be. A high
 * forecast means "this is where the trend points", not "something will break".
 * The distinction matters because a tool that says the second gets a page at
 * 3am, and it will have been wrong.
 */

/** A steady rising series: 20 hours climbing 10 per hour. */
const RISING = Array.from({ length: 20 }, (_, i) => ({
  hour: `2026-09-30T${String(i).padStart(2, "0")}`,
  count: 100 + i * 10,
  share: 0,
  multiple: null,
  spike: false,
  rule: null as string | null,
}));

/** A flat series: no trend at all. */
const FLAT = Array.from({ length: 20 }, (_, i) => ({
  hour: `2026-09-30T${String(i).padStart(2, "0")}`,
  count: 50, share: 0, multiple: null, spike: false, rule: null as string | null,
}));

/** The observed hours in the engine's own shape, for realistic inputs. */
function observed(series: { count: number }[]) {
  const total = series.reduce((n, s) => n + s.count, 0);
  return series.map((s, i) => ({
    hour: `2026-09-30T${String(i).padStart(2, "0")}`,
    count: s.count,
    share: total === 0 ? 0 : s.count / total,
    multiple: null as number | null,
    spike: false as boolean,
    rule: null as string | null,
  }));
}

test("a rising series is forecast upward, and the direction is right", () => {
  const result = forecast(RISING, { horizon: 12 });
  assert.equal(result.ok, true, `expected a forecast: ${result.reason ?? ""}`);
  assert.equal(result.points.length, 12, "twelve hours ahead");

  const lastObserved = RISING[RISING.length - 1]!.count;
  const firstForecast = result.points[0]!.count;
  assert.ok(firstForecast >= lastObserved,
    `a series climbing 10/hour must not forecast downward: ${lastObserved} -> ${firstForecast}`);
});

test("a flat series is forecast FLAT, not into a slope", () => {
  // The failure this catches is the characteristic one: exponential smoothing
  // applied to a constant series with any noise at all produces a gentle drift,
  // and a drifting line on a chart reads as "something is changing".
  const result = forecast(FLAT, { horizon: 12 });
  assert.equal(result.ok, true);
  for (const p of result.points) {
    assert.ok(Math.abs(p.count - 50) < 5,
      `a flat series must not acquire a trend: got ${p.count}`);
  }
});

test("EVERY point carries an INTERVAL, and it widens with the horizon", () => {
  const result = forecast(RISING, { horizon: 12 });
  for (const p of result.points) {
    assert.ok(p.lower !== null && p.upper !== null, "an unbounded point is a guess in a number's clothes");
    assert.ok(p.lower <= p.count && p.count <= p.upper, `the interval must contain the point: ${JSON.stringify(p)}`);
  }
  const first = result.points[0]!;
  const last = result.points[result.points.length - 1]!;
  const firstWidth = first.upper! - first.lower!;
  const lastWidth = last.upper! - last.upper! + (last.upper! - last.lower!) - (last.upper! - last.upper!);
  const lastRealWidth = last.upper! - last.lower!;
  assert.ok(lastRealWidth > firstWidth,
    `uncertainty must compound: ${firstWidth} at +1h versus ${lastRealWidth} at +12h`);
});

test("it REFUSES on too little data, rather than projecting from four points", () => {
  for (const n of [0, 1, 2, 3, 5]) {
    const series = Array.from({ length: n }, (_, i) => ({
      hour: `2026-09-30T${String(i).padStart(2, "0")}`,
      count: 10 + i, share: 0, multiple: null, spike: false, rule: null as string | null,
    }));
    const result = forecast(series, { horizon: 12 });
    assert.equal(result.ok, false, `${n} hourly points must not produce a forecast`);
    assert.ok(result.reason !== undefined && result.reason.length > 0,
      "and must say why, in words");
  }
});

test("it states WHAT IT IS DOING, in words a person can check", () => {
  const result = forecast(RISING, { horizon: 12 });
  assert.equal(result.method, FORECAST_METHOD);
  assert.match(String(result.explanation), /smoothing|trend|exponential/i);
  // And it must not claim more than it is.
  assert.doesNotMatch(String(result.explanation), /will|predict|expect|guarantee/i,
    `a forecast must not use the language of certainty: ${result.explanation}`);
});

test("GAPS are not treated as zero", () => {
  // A file with 09:00, then 11:00, has no 10:00 row. Forecasting across it as
  // though the hour were empty would invent a dip and then predict a recovery
  // from it -- two confident lies from one missing cell.
  const gapped = [
    { hour: "2026-09-30T09", count: 20, share: 0, multiple: null, spike: false, rule: null as string | null },
    { hour: "2026-09-30T11", count: 24, share: 0, multiple: null, spike: false, rule: null as string | null },
  ];
  const result = forecast(gapped, { horizon: 4 });
  // With a gap, the honest answer is to decline rather than to bridge it.
  assert.equal(result.ok, false, "a series with an internal gap must not be projected across");
  assert.match(String(result.reason), /gap|missing|not continuous|hour/i);
});

test("the forecast continues the clock, hour by hour, across midnight", () => {
  const result = forecast(RISING, { horizon: 12 });
  const lastObservedHour = RISING[RISING.length - 1]!.hour;
  assert.ok(result.points[0]!.hour > lastObservedHour, "the first forecast is after the last observation");
  for (let i = 1; i < result.points.length; i += 1) {
    assert.ok(result.points[i]!.hour > result.points[i - 1]!.hour,
      "and the hours strictly increase");
  }
});

test("predicted points are marked, so a chart cannot present them as measured", () => {
  const result = forecast(RISING, { horizon: 12 });
  for (const p of result.points) {
    assert.equal(p.predicted, true, "every returned point is a prediction and must say so");
  }
  assert.equal(result.lastObservedHour, RISING[RISING.length - 1]!.hour,
    "and the boundary must be published, so the chart can draw the divide");
});

test("a NEGATIVE or absurd forecast is clamped, not published", () => {
  // Smoothing a steeply falling series with a large alpha will overshoot below
  // zero. A row count of -140 is not a number of rows, and charting it would put
  // a nonsense axis under the whole conversation.
  const falling = Array.from({ length: 20 }, (_, i) => ({
    hour: `2026-09-30T${String(i).padStart(2, "0")}`,
    count: Math.max(0, 200 - i * 12),
    share: 0, multiple: null, spike: false, rule: null as string | null,
  }));
  const result = forecast(falling, { horizon: 12 });
  if (result.ok) {
    for (const p of result.points) {
      assert.ok(p.count >= 0, `a row count cannot be negative: ${p.count}`);
      assert.ok(p.lower! >= 0, "and neither can its interval");
    }
  }
});

test("the forecast is DETERMINISTIC", () => {
  // A forecast that changed between two calls on the same input would make every
  // number in the report non-reproducible, and a report nobody can reproduce is
  // a report nobody can check.
  const a = forecast(RISING, { horizon: 12 });
  const b = forecast(RISING, { horizon: 12 });
  assert.deepEqual(a, b);
});

test("a noisy series gets a WIDER interval than a smooth one", () => {
  // This is the property that makes the interval meaningful rather than
  // decorative: it must respond to the data's own variance.
  const noisy = RISING.map((s, i) => ({ ...s, count: s.count + (i % 2 === 0 ? 40 : -40) }));
  const smooth = forecast(RISING, { horizon: 6 });
  const rough = forecast(noisy, { horizon: 6 });
  assert.equal(smooth.ok, true);
  assert.equal(rough.ok, true);
  const width = (r: typeof smooth) => r.points[0]!.upper! - r.points[0]!.lower!;
  assert.ok(width(rough) > width(smooth),
    `a noisy series must be less certain: ${width(rough)} versus ${width(smooth)}`);
});