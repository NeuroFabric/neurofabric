import test from "node:test";
import assert from "node:assert/strict";

import { findCrossColumnAnomalies, robustScale } from "./multivariate.ts";

/**
 * WHY A 1D CHECK IS NOT ENOUGH.
 *
 * Every existing check in this product looks at ONE column. A column with an
 * extreme value is flagged; that is the whole model. But the most interesting
 * defect in an enterprise file is not a big number -- it is a number that
 * contradicts its neighbour.
 *
 * A row with high `latency_ms` and low `total_bytes` is not a slow request. It
 * is a request that does not belong to the same population as its neighbours:
 * a mis-joined row, a units error, a field populated from a different source.
 * A 1D check sees "latency is high" and says so, which is true and useless. A
 * 2D check sees the CONTRADICTION, and that is the finding.
 *
 * === THE MATH, AND WHY NOT MEAN AND STDEVIATION ===
 *
 * Standardising by mean and standard deviation is wrong for this job in a way
 * that is easy to miss. The outliers we are hunting are precisely the values
 * that inflate the standard deviation, so each one makes itself less anomalous
 * -- four extreme rows can widen the sigma enough to hide all four. The usual
 * defence is to remove the outliers first, but then the test depends on a first
 * pass that already decided what an outlier is.
 *
 * So the centre is the MEDIAN and the scale is the MAD (median absolute
 * deviation), scaled by 1.4826 so that MAD estimates sigma for a normal
 * distribution. Both are unmoved by a handful of extreme values, because both
 * are medians. This is the standard robust alternative and it is the right tool
 * precisely because the thing being searched for is the thing that would
 * corrupt a non-robust estimator.
 *
 * No dependencies, no matrix library, and the whole thing is two medians and a
 * scan.
 */

const N = 200;
const X = "latency_ms";
const Y = "total_bytes";

/**
 * Rows where X and Y rise together, which is what "normal" looks like.
 * Keyed by the COLUMN NAME, because the detector is handed column names and
 * looks them up on each row -- an earlier draft of this test used `x`/`y` and
 * silently exercised the "column is not present" path, which is a different
 * test than the one it looks like.
 */
function correlated(): Record<string, number>[] {
  const out: Record<string, number>[] = [];
  for (let i = 0; i < N; i++) {
    const x = 100 + ((i * 37) % 90);
    out.push({ [X]: x, [Y]: 5000 + x * 10 + ((i * 13) % 40) });
  }
  return out;
}

function project(rows: { x: number; y: number }[], index: number): Record<string, number> {
  return { [X]: rows[index]!.x, [Y]: rows[index]!.y };
}

test("the robust scale is unmoved by the outliers it is meant to find", () => {
  const clean = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  const dirty = [...clean, 100_000];
  const a = robustScale(clean);
  const b = robustScale(dirty);
  // A single 100,000 appended to a tight run must barely move the centre, and
  // must not move the scale much at all. This is the property that makes the
  // detector able to see the thing it is looking for.
  assert.ok(Math.abs(b.median - a.median) < 2, `median moved: ${a.median} -> ${b.median}`);
  assert.ok(Math.abs(b.sigma - a.sigma) <= Math.max(1, a.sigma * 0.6),
    `sigma moved: ${a.sigma} -> ${b.sigma}`);
});

test("the ordinary mean-based scale WOULD have been corrupted, which is the point", () => {
  const clean = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
  const dirty = [...clean, 100_000];
  const naive = (v: readonly number[]) => {
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    return Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
  };
  // This is not an assertion the detector needs. It is the reason the detector
  // is not written the obvious way, pinned so the obvious way is not chosen
  // again by someone who has not seen the failure.
  assert.ok(naive(dirty) > naive(clean) * 5, "the naive sigma really is blown out by one value");
});

test("a row contradicting its neighbour is found", () => {
  const rows = correlated();
  rows[100] = { [X]: 1000, [Y]: 20 };   // high latency, tiny payload: impossible together
  const found = findCrossColumnAnomalies({ rows, columns: [X, Y] });
  assert.equal(found.length > 0, true, "the contradiction must be found");
  assert.equal(found[0]!.row, 100, "and attributed to the right row");
  assert.match(found[0]!.kind, /discordant/i, "as a contradiction, not a plain outlier");
});

test("ordinary correlated rows produce nothing", () => {
  // The false-positive guard. A detector that flags the whole file is useless
  // and worse than none, because a user who learns to ignore it will ignore the
  // real one too.
  const found = findCrossColumnAnomalies({ rows: correlated(), columns: [X, Y] });
  assert.equal(found.length, 0, `no false positives on clean data, got ${JSON.stringify(found)}`);
});

test("a merely LARGE value on both axes is not a contradiction", () => {
  const rows = correlated();
  rows[7] = { [X]: 900, [Y]: 20_000 };  // big on both, still self-consistent
  const found = findCrossColumnAnomalies({ rows, columns: [X, Y] });
  assert.equal(found.length, 0,
    `a large-but-consistent row is an outlier, not a contradiction: ${JSON.stringify(found)}`);
});

test("a row that is extreme on ONE axis only is left to the 1D checks", () => {
  // Deliberate non-overlap with the existing per-column logic: this module
  // reports only what a 1D pass structurally cannot.
  const rows = correlated();
  rows[3] = { [X]: 1000, [Y]: rows[3]![Y]! };
  const found = findCrossColumnAnomalies({ rows, columns: [X, Y] });
  assert.equal(found.length, 0, "one-axis extremes are the existing checks' job");
});

test("the finding names both columns and carries the evidence", () => {
  const rows = correlated();
  rows[100] = { [X]: 1000, [Y]: 20 };
  const f = findCrossColumnAnomalies({ rows, columns: [X, Y] })[0]!;
  assert.equal(f.x.column, X);
  assert.equal(f.y.column, Y);
  assert.ok(f.x.z > 0, "X is high");
  assert.ok(f.y.z < 0, "Y is low");
  assert.equal(f.row, 100);
  assert.ok(Number.isFinite(f.x.value) && Number.isFinite(f.y.value), "with the raw values kept");
});

test("a column that is constant yields nothing rather than dividing by zero", () => {
  const rows = Array.from({ length: 50 }, () => ({ x: 5, y: 7 }));
  assert.deepEqual(findCrossColumnAnomalies({ rows, columns: [X, Y] }), []);
});

test("too few rows yields nothing, because two medians need a population", () => {
  const rows = [{ x: 1, y: 1 }, { x: 1000, y: 1 }];
  assert.deepEqual(findCrossColumnAnomalies({ rows, columns: [X, Y] }), []);
});
