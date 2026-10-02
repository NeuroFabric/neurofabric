import type { ColumnHealth, DataHealth, NumericColumnStat } from "./bottlenecks.ts";
import { describeCrossColumn, type CrossColumnAnomaly } from "./multivariate.ts";

/**
 * THE "SO WHAT?" ENGINE. Statistics into a sentence a person can act on.
 *
 * Everything else in this pipeline computes numbers and stops. A report that
 * says "col_15 has one value beyond the outer fence" has done the statistics
 * and handed the interpretation to the reader -- and interpretation is the part
 * that needs judgement. So this module is the judgement, and it is deliberately
 * a small, auditable set of rules rather than a model: a generated sentence a
 * user acts on must be traceable to the numbers that produced it, and every
 * number used here is one the report already prints.
 *
 * === THE ONLY HARD PROBLEM IS THE OPENING CLAUSE ===
 *
 * The shape everyone writes is "The dataset is generally stable, but <problem>".
 * That is true only when the dataset IS generally stable. A file where most of
 * its cells hold text in a numeric column cannot be described as stable, and a
 * template that says so anyway emits the most dangerous sentence this product
 * can produce: a reassuring opening attached to a catastrophic second clause. A
 * reader skims the first clause. So the opening is COMPUTED from the measured
 * share of compromised cells, and the tests pin that it moves.
 *
 * === WHAT COUNTS AS COMPROMISED, AND WHY THE TWO ARE NOT THE SAME ===
 *
 * A type mismatch and an extreme value are both "wrong", and they call for
 * opposite responses. "N/A" in a float column is a broken producer -- a bad
 * cast, a locale change, a sentinel -- and the fix is upstream of this product.
 * A value of 9,999,999.99 in a column of small numbers may be a real
 * measurement, a misplaced decimal, or a units error. So the summary names them
 * differently and does not average them into one alarming number.
 *
 * A MARGINAL outlier (past 1.5x IQR but not 3x) is deliberately NOT escalated.
 * At 1.5x a normal distribution flags about 1.4% of its values by definition,
 * so treating those as a finding is how a real anomaly once became one clause
 * among seventeen and the reader learned nothing. A warning that fires on
 * ordinary variation is not a warning.
 */

export type Verdict = "clean" | "minor" | "compromised" | "unusable";

export interface SynthesisInput {
  readonly totalRows: number;
  /** The file's numeric columns, as the profiler measured them. */
  readonly columns: readonly NumericColumnStat[];
  /** Dirty cells and outliers across every numeric column. */
  readonly health: DataHealth;
  /**
   * Rows whose values CONTRADICT each other, across two columns at once.
   *
   * Optional because every finding in this module is per-column, and adding a
   * required field that only some callers can supply would mean every existing
   * caller either grew a rows parameter or passed a lie. A summary that
   * silently omits cross-column findings is wrong, so the renderer states when
   * the check did not run rather than implying the file was clear.
   */
  readonly crossColumn?: readonly CrossColumnAnomaly[];
}

export interface Finding {
  readonly column: string;
  /** `extreme` is past the 3x fence; `marginal` is past 1.5x; the rest are structural. */
  readonly kind: "extreme" | "marginal" | "type-mismatch" | "missing";
  readonly count: number;
  /** The magnitude, for the kinds that have one. */
  readonly value: number | null;
  /** How many times past the 3x-IQR fence, when there is a fence to divide by. */
  readonly factor: number | null;
  /** The offending values, for a type mismatch, so the reader can grep a pipeline. */
  readonly examples: readonly string[];
}

export interface ExecutiveSummary {
  /** The paragraph. One block of prose, no bullet points, no headings. */
  readonly paragraph: string;
  /** One line for a dashboard header. Derived from `paragraph`, never a second opinion. */
  readonly headline: string;
  readonly verdict: Verdict;
  readonly findings: readonly Finding[];
}

/**
 * THE THRESHOLD THAT DECIDES THE OPENING CLAUSE.
 *
 * One in twenty cells is a defect, not a collapse: a file with 5% bad cells is
 * a file that is generally sound with something wrong in it, which is a
 * different instruction to the reader from one that is broadly unusable. 0.20 is
 * a named constant rather than a literal in the middle of a sentence so that the
 * boundary can be argued about in one place, and so that changing it is a visible
 * edit rather than an accident.
 */
const COMPROMISED_SHARE = 0.20;

const NUM = new Intl.NumberFormat("en-US");

/** Commas, and never scientific notation or a bare decimal tail. */
function num(value: number): string {
  return Number.isInteger(value) ? NUM.format(value) : NUM.format(Number(value.toFixed(2)));
}

/**
 * The fence, at enough precision that the factor is REPRODUCIBLE.
 *
 * The factor is a ratio of a large number to a small one, so rounding the
 * denominator to two decimals shows up amplified in the quotient: a fence of
 * 3.065 printed as "3.07" makes 9,999,999.99 / 3.07 come out as 3,257,003 rather
 * than the 3,262,070 printed beside it. A reader who checks the arithmetic finds
 * a mismatch and has to decide whether to trust the tool. Four fraction digits
 * is enough for any fence this product computes, and the claim becomes
 * checkable exactly as the report's whole philosophy requires.
 */
const FENCE_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
function fenceText(value: number): string {
  return FENCE_FORMAT.format(value);
}

/**
 * THE FACTOR, defined in the module header and in the report: the ratio of the
 * worst value to the 3x-IQR outer fence that value cleared.
 *
 * Returns null rather than a number whenever the division is not meaningful --
 * no fence, a zero fence (a constant column), or a non-finite result. "A factor
 * of Infinity" is the kind of sentence that gets forwarded to make a point.
 */
function factorOf(value: number | null, fence: number | null): number | null {
  if (value === null || fence === null || fence === 0) return null;
  const ratio = Math.abs(value / fence);
  return Number.isFinite(ratio) ? ratio : null;
}

/** "200", "1,888" -- a factor read at a glance, never "199.9999998". */
function factorText(factor: number): string {
  if (factor >= 1000) return NUM.format(Math.round(factor));
  if (factor >= 10) return String(Math.round(factor));
  return factor.toFixed(1);
}

/**
 * IS THE MEAN WORTH TRUSTING?
 *
 * The one insight available here that is not visible in any single field, and
 * the reason this is a data-science module rather than a formatter. A mean is
 * the sum over the count, so a single enormous value moves it in proportion to
 * its own size: 199 values near zero and one at 9,999,999.99 produce a mean
 * around 50,000, a number that describes no row in the file. Anyone who reads
 * the mean and not this warning will quote it.
 *
 * The share is estimated as `worstValue / (mean * measured)`, which is exact
 * for a single outlier and conservative for several, and the threshold is high
 * because a warning here that fires on ordinary variation is worse than no
 * warning -- the same rule the profiler applies to fences.
 */
const MEAN_DOMINANCE = 0.5;

function meanIsContaminated(stat: NumericColumnStat | undefined, worst: number | null): boolean {
  if (stat === undefined || stat.mean === null || stat.measured <= 0 || worst === null) return false;
  const total = stat.mean * stat.measured;
  if (total === 0) return true; // a non-zero value in a column whose sum is zero
  return Math.abs(worst / total) >= MEAN_DOMINANCE;
}

/** Proper pluralisation, because this is prose a person reads. */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function cells(n: number): string {
  return `${num(n)} ${plural(n, "cell", "cells")}`;
}

/**
 * Collect every finding.
 *
 * ITERATES BOTH SOURCES, and the second one was missing for a while. A column
 * that is merely noisy -- past the 1.5x fence, not the 3x one -- is not in
 * `health.columns` at all, because health reports only the actionable fences.
 * So a first version that walked `health.columns` alone could not see ordinary
 * variation anywhere, and two tests built on top of it passed VACUOUSLY: zero
 * findings, zero mentions, green. The column statistics are the only place a
 * marginal outlier is recorded, so they have to be walked too.
 *
 * Findings are then SORTED BY SEVERITY, which is the other half of the same
 * lesson. Collected order is column order, so a first-wins selection leads with
 * whichever column happens to sort first -- which is how the Owner's file opened
 * with "ordinary variation, not a defect" while its one real anomaly was
 * buried. Order of arrival is not order of importance.
 */
const SEVERITY_ORDER: Record<Finding["kind"], number> = {
  extreme: 0,
  "type-mismatch": 1,
  marginal: 2,
  missing: 3,
};

function collect(input: SynthesisInput): Finding[] {
  const stats = new Map(input.columns.map((c) => [c.column, c]));
  const found: Finding[] = [];
  const seen = new Set<string>();

  for (const health of input.health.columns) {
    seen.add(health.column);
    const stat = stats.get(health.column);
    if (health.outliers > 0 && health.worstValue !== null) {
      found.push({ column: health.column, kind: "extreme", count: health.outliers, value: health.worstValue, factor: factorOf(health.worstValue, health.fence), examples: [] });
    } else if (stat !== undefined && stat.outliers > 0 && stat.outlierMax !== null) {
      found.push({ column: health.column, kind: "marginal", count: stat.outliers, value: stat.outlierMax, factor: factorOf(stat.outlierMax, stat.fenceExtremeUpper), examples: [] });
    }
    if (health.dirty > 0) {
      found.push({ column: health.column, kind: "type-mismatch", count: health.dirty, value: null, factor: null, examples: health.examples });
    }
    if (health.empty > 0) {
      found.push({ column: health.column, kind: "missing", count: health.empty, value: null, factor: null, examples: [] });
    }
  }

  // Columns with nothing in health but noise in their statistics.
  for (const stat of input.columns) {
    if (seen.has(stat.column)) continue;
    if (stat.outliers > 0 && stat.outlierMax !== null) {
      found.push({ column: stat.column, kind: "marginal", count: stat.outliers, value: stat.outlierMax, factor: factorOf(stat.outlierMax, stat.fenceExtremeUpper), examples: [] });
    }
  }

  // Worst first. Within a kind, the bigger magnitude first, so two extreme
  // anomalies are led by the one that matters more.
  return found.sort((a, b) => {
    const byKind = SEVERITY_ORDER[a.kind] - SEVERITY_ORDER[b.kind];
    if (byKind !== 0) return byKind;
    return magnitude(b) - magnitude(a);
  });
}

/** A comparable magnitude for ordering, so "bigger" means something for every kind. */
function magnitude(finding: Finding): number {
  if (finding.kind === "type-mismatch" || finding.kind === "missing") return finding.count;
  return finding.factor ?? Math.abs(finding.value ?? 0);
}

/**
 * One clause describing one finding, INCLUDING ITS COLUMN.
 *
 * The column name lives here rather than at the call sites so that every use of
 * a clause is self-contained. It was previously prepended by the callers, and
 * the refactor that removed the duplication also removed the name from the lead
 * sentence -- so a report could name a type mismatch and never say which column
 * it was in, which is the one piece of information the sentence exists to
 * deliver. A test caught it; the sentence is now whole on its own.
 */
function clause(finding: Finding): string {
  switch (finding.kind) {
    case "extreme": {
      const magnitude = finding.value === null ? "an extreme value" : `a value of ${num(finding.value)}`;
      const factor = finding.factor === null
        ? "beyond the 3x-IQR fence that bounds ordinary variation"
        : `which exceeds normal variance by a factor of ${factorText(finding.factor)}`;
      // The fence is quoted so the factor is CHECKABLE. A ratio with no
      // denominator printed is an oracle, and a reader who cannot reproduce
      // 200 from a printed 9,999,999.99 has to take it on trust -- which is
      // the one thing this product asks people not to do.
      const fence = finding.value !== null && finding.factor !== null
        ? ` (against a 3x-IQR fence of ${fenceText(Math.abs(finding.value / finding.factor))})`
        : "";
      return `an extreme anomaly in ${finding.column}: ${magnitude} ${factor}${fence}`;
    }
    case "marginal":
      return `ordinary variation in ${finding.column}: ${plural(finding.count, "value", "values")} past the 1.5x fence, which is expected in a normal distribution and is not a defect`;
    case "type-mismatch": {
      const shown = finding.examples.length > 0 ? `, such as ${finding.examples.slice(0, 3).map((e) => `"${e}"`).join(" and ")}` : "";
      return `a type mismatch in ${finding.column}: ${cells(finding.count)} ${plural(finding.count, "holds", "hold")} something that is not a number${shown}, which is a broken producer rather than a measurement`;
    }
    case "missing":
      return `missing values in ${finding.column}: ${cells(finding.count)} ${plural(finding.count, "is", "are")} empty, which is usually a pipeline that dropped a value and is usually benign`;
  }
}

/**
 * SYNTHESIZE. One paragraph, and every clause in it traceable to a number.
 */
export function synthesize(input: SynthesisInput): ExecutiveSummary {
  const findings = collect(input);
  const byName = new Map(input.columns.map((c) => [c.column, c]));

  // A DEFECT is something the reader must act on: an extreme anomaly or a type
  // mismatch. Ordinary variation and missing cells are NOT defects, and folding
  // them into the count is how a summary ends up saying "severely compromised
  // by 14 problems" and then explaining that ten of them are expected.
  const defects = findings.filter((f) => f.kind === "extreme" || f.kind === "type-mismatch");
  const benign = findings.filter((f) => f.kind === "marginal" || f.kind === "missing");
  const extreme = findings.find((f) => f.kind === "extreme");

  const cells_total = input.totalRows * Math.max(1, input.columns.length);
  const defectCells = defects.reduce((total, f) => total + f.count, 0);
  const share = cells_total > 0 ? defectCells / cells_total : 0;

  const verdict: Verdict = defects.length === 0
    ? findings.length === 0 ? "clean" : "minor"
    : share >= COMPROMISED_SHARE
      ? "unusable"
      : "compromised";

  const parts: string[] = [];
  const columnWord = plural(input.columns.length, "one numeric column", `${input.columns.length} numeric columns`);
  const scope = verdict === "unusable" ? "broadly" : "severely";

  if (findings.length === 0) {
    parts.push(`No structural defects were found across ${num(input.totalRows)} row(s) and ${columnWord}.`);
  } else if (defects.length === 0) {
    parts.push(`The dataset is broadly sound across ${num(input.totalRows)} row(s), with nothing that needs fixing.`);
  } else if (verdict === "unusable") {
    parts.push(`The dataset is not sound as a whole: ${num(defectCells)} of its ${num(cells_total)} measured ${plural(cells_total, "cell", "cells")} are affected by ${plural(defects.length, "one defect", `${defects.length} defects`)}.`);
  } else {
    parts.push(`The dataset is generally stable, but it is ${scope} compromised by ${plural(defects.length, "one defect", `${defects.length} defects`)}.`);
  }

  // THE CROSS-COLUMN LINE.
  //
  // Every other part of this summary is a per-column statement, and that is the
  // blind spot this addresses: a row can be perfectly ordinary in each column
  // separately and still be impossible -- high latency with a tiny payload, for
  // instance. Nothing above can see that, because nothing above looks at two
  // columns at once.
  const cross = input.crossColumn;
  if (cross !== undefined) {
    const described = describeCrossColumn(cross);
    if (described !== null) parts.push(described);
  }
  // The worst defect, described in full. Never omitted for being dramatic: an
  // enormous factor is more reason to state the finding, not less.
  const lead = defects[0];
  if (lead !== undefined) parts.push(`The most serious is ${clause(lead)}.`);

  // THE MEAN WARNING, which is the part no single field gives you.
  if (extreme !== undefined && meanIsContaminated(byName.get(extreme.column), extreme.value)) {
    const stat = byName.get(extreme.column);
    const meanText = stat === undefined || stat.mean === null ? "unknown" : num(stat.mean);
    parts.push(`Note that the mean of ${extreme.column} (${meanText}) is unreliable: it is dominated by that single value and does not describe any row in the file.`);
  }

  // Any REMAINING defects, named briefly. Bounded, because a file with twenty
  // type-mismatched columns needs a list, not a paragraph.
  const rest = defects.filter((f) => f !== lead).slice(0, 3);
  if (rest.length > 0) {
    const named = rest.map((f) => clause(f));
    const more = defects.length - 1 - rest.length;
    parts.push(`Also affected: ${named.join("; ")}${more > 0 ? `; and ${num(more)} further column(s) of the same kinds` : ""}.`);
  }

  // The benign findings, GROUPED. One clause per column turns a summary into a
  // wall and buries the finding that mattered, which is the failure this whole
  // module exists to avoid.
  if (benign.length > 0) {
    const marginal = benign.filter((f) => f.kind === "marginal");
    const missing = benign.filter((f) => f.kind === "missing");
    const notes: string[] = [];
    if (marginal.length > 0) {
      const values = marginal.reduce((total, f) => total + f.count, 0);
      notes.push(`${num(values)} ${plural(values, "value", "values")} across ${plural(marginal.length, "one column", `${marginal.length} columns`)} sit past the 1.5x fence, which is ordinary variation in a normal distribution and is not a defect`);
    }
    if (missing.length > 0) {
      const blank = missing.reduce((total, f) => total + f.count, 0);
      notes.push(`${cells(blank)} are empty, which is usually a pipeline that dropped a value and is usually benign`);
    }
    parts.push(`For completeness: ${notes.join("; and ")}.`);
  }

  const paragraph = parts.join(" ");
  const headline = findings.length === 0
    ? `No structural defects found across ${num(input.totalRows)} rows.`
    : defects.length === 0
      ? `Sound: ${num(input.totalRows)} rows, nothing to fix.`
      : `${verdict === "unusable" ? "Unusable" : "Compromised"}: ${plural(defects.length, "1 defect", `${defects.length} defects`)}, led by ${lead?.column ?? "the profiler"}.`;

  return { paragraph, headline, verdict, findings };
}
