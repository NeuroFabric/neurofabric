import test from "node:test";
import assert from "node:assert/strict";
import { barChart, hourlyChart, escapeXmlText } from "./svg-charts.ts";
import type { CategoryStat, HourStat } from "./bottlenecks.ts";

/**
 * INLINE SVG, GENERATED IN-PROCESS. NO CDN, AND THAT IS THE WHOLE ARGUMENT.
 *
 * The obvious way to draw a chart in a self-contained page is a script tag
 * pointing at a CDN. For a security product that is the wrong trade in three
 * separate ways, and each is enough on its own:
 *
 *   1. IT BREAKS THE INVARIANT. The Stage 2 artifact was verified to contain no
 *      remote references, and the wedge server sends
 *      default-src 'none' precisely so that a later edit adding a CDN fails the
 *      header's intent. A report that silently stops working without a network
 *      is a report that fails in exactly the situation a report is needed.
 *   2. IT IS A SUPPLY CHAIN. The page would execute third-party JavaScript
 *      supplied at render time, on a machine that just handed it a data file. A
 *      compromised CDN is arbitrary code execution inside the analysis surface,
 *      and no amount of escaping in our own code prevents that.
 *   3. IT IS A BIGGER FOOTPRINT THAN THE CHART. A bar chart is a handful of
 *      rect elements. A charting library is megabytes to save forty lines of
 *      arithmetic.
 *
 * So the charts are generated here, as strings, with no dependency and no
 * network. Everything below is arithmetic and escaping.
 *
 * HORIZONTAL BARS, NOT VERTICAL, and that is a readability decision rather than
 * a preference. The labels are arbitrary strings from an arbitrary file:
 * "PEGA0001 (HttpAPI)" is thirty characters of long, and a vertical axis gives
 * each label a few pixels of width. Horizontal bars give the label the whole
 * left margin, and a long one is truncated with a visible ellipsis rather than
 * being rotated, shrunk, or silently overlapped.
 */

const cat = (key: string, label: string, count: number, extra: Partial<CategoryStat> = {}): CategoryStat => ({
  key, label, count, totalElapsed: null, meanElapsed: null, medianElapsed: null, p95Elapsed: null,
  breachCount: 0, rows: [], ...extra,
});

const hour = (key: string, count: number, extra: Partial<HourStat> = {}): HourStat => ({
  key, count, share: 0, multiple: null, isSpike: false, rule: null, ...extra,
});

// === SHAPE ================================================================

test("a bar chart is real SVG with one bar per category", () => {
  const svg = barChart([cat("a", "A", 10), cat("b", "B", 5), cat("c", "C", 1)]);
  assert.match(svg, /^<svg /, "it is an svg element, not a paragraph about one");
  assert.match(svg, /<\/svg>$/);
  assert.equal((svg.match(/<rect/g) ?? []).length, 3, "one bar per category");
  assert.match(svg, /viewBox/, "and it scales rather than being fixed-pixel");
  assert.match(svg, /role="img"/, "with an accessible role, so it is not invisible to a screen reader");
});

test("only the top five are drawn, and the truncation is stated", () => {
  const many = Array.from({ length: 12 }, (_, i) => cat(`c${i}`, `Column ${i}`, 12 - i));
  const svg = barChart(many);
  assert.equal((svg.match(/<rect/g) ?? []).length, 5, "five bars, not twelve");
  assert.match(svg, /7 more/, "and the report says what it left out rather than implying completeness");
});

test("bar WIDTHS are proportional, so the chart is not decorative", () => {
  // Widths, not heights. These are HORIZONTAL bars, so the length carries the
  // magnitude and the height is constant. An earlier version of this test
  // asserted on heights, which are all equal by construction -- it passed
  // vacuously at first and only failed once the arithmetic was checked.
  const svg = barChart([cat("a", "A", 100), cat("b", "B", 50), cat("c", "C", 1)]);
  const widths = [...svg.matchAll(/<rect[^>]*width="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.equal(widths.length, 3);
  assert.ok(widths[0] > widths[1] && widths[1] > widths[2], `descending: ${widths.join(",")}`);
  // A zero must not divide the scale to NaN.
  const flat = barChart([cat("a", "A", 0), cat("b", "B", 0)]);
  assert.ok(!flat.includes("NaN"), "an all-zero column set produces a chart, not NaN geometry");
});

test("the hourly chart draws one point per bucket and a line between them", () => {
  const svg = hourlyChart([hour("h1", 1), hour("h2", 5), hour("h3", 3)]);
  assert.match(svg, /<polyline/, "the points are joined, so it reads as a trend rather than a scatter");
  assert.equal((svg.match(/<circle/g) ?? []).length, 3, "with a marker per bucket");
});

test("a SPIKE is drawn differently, which is the entire point of the chart", () => {
  const plain = hourlyChart([hour("h1", 5), hour("h2", 6)]);
  const spiked = hourlyChart([hour("h1", 5), hour("h2", 6), hour("h3", 900, { isSpike: true, rule: "150x the hourly average" })]);
  assert.ok(!plain.includes("spike"), "no spike, no spike styling");
  assert.match(spiked, /spike/, "a spike is marked");
  assert.match(spiked, /900/, "and the count is shown next to it");
  // The two charts must genuinely differ in a way a reader can see.
  assert.notEqual(plain, spiked);
});

test("the mean is drawn, so the reader can see WHY something is a spike", () => {
  const svg = hourlyChart([hour("h1", 5), hour("h2", 5), hour("h3", 90, { isSpike: true })], { mean: 33.3 });
  assert.match(svg, /<line[^>]*class="mean/, "the baseline is a visible line, not a footnote");
  assert.match(svg, /33\.3/, "labelled with its value");
});

// === THE EMPTY CASES, WHICH ARE MOST OF THE FILES THE PRODUCT SEES ========

test("no categories renders NOTHING, and does not render an empty frame", () => {
  assert.equal(barChart([]), "", "an empty chart is worse than no chart: it looks like a finding");
});

test("a single hour bucket is not a trend, so no line is drawn", () => {
  const svg = hourlyChart([hour("h1", 5)]);
  assert.ok(!svg.includes("<polyline"), "one point is not a line");
  assert.equal((svg.match(/<circle/g) ?? []).length, 1, "but the point itself is still shown");
});

test("all-zero counts still produce a chart rather than dividing by zero", () => {
  const svg = hourlyChart([hour("h1", 0), hour("h2", 0)]);
  assert.ok(!svg.includes("NaN"));
  assert.match(svg, /<svg /);
});

// === ESCAPING, WHICH IS THE PART THAT MATTERS ============================

test("hostile labels cannot break out of the SVG", () => {
  // Every one of these is a real way to escape SVG text into markup. A report
  // renders values that came from a file a stranger uploaded, and a chart is a
  // NEW CONTEXT for them: text inside <text> can contain markup, so escaping
  // that the table got right has to be re-established here.
  const svg = barChart([cat("k", `</text><script>alert(1)</script><text x="0">&<>`, 1)]);
  assert.ok(!svg.includes("<script>"), "no script element survives");
  assert.ok(!svg.includes("</text><script"), "and no early close that would let one in");
  assert.ok(svg.includes("&lt;"), "the markup is escaped rather than deleted");
  // The ampersand is checked on its OWN short label, because truncation runs
  // AFTER escaping and this label's ampersand is past the cut. Asserting it here
  // would be testing the ellipsis, not the escaping.
  assert.ok(barChart([cat("k", "a & b", 1)]).includes("a &amp; b"), "the ampersand is escaped too");
});

test("escapeXmlText handles the XML five and leaves nothing live", () => {
  assert.equal(escapeXmlText(`&<>"'`), "&amp;&lt;&gt;&quot;&apos;");
  assert.equal(escapeXmlText("plain"), "plain");
});

test("a label long enough to break the layout is truncated VISIBLY", () => {
  const svg = barChart([cat("k", "x".repeat(400), 1)]);
  assert.ok(svg.includes("…"), "an ellipsis, so the reader knows something was cut");
  assert.ok(!svg.includes("x".repeat(200)), "and the raw text does not run across the chart");
});

test("a numeric-looking key cannot smuggle markup through an attribute", () => {
  const svg = barChart([cat(`" onload="alert(1)`, "A", 1)]);
  assert.ok(!svg.includes(`onload="alert(1)"`), "an attribute break does not become an attribute");
});

test("the chart is self-contained: no external RESOURCE of any kind", () => {
  // The XML NAMESPACE DECLARATION IS NOT A RESOURCE. xmlns="http://www.w3.org/
  // 2000/svg" contains an http string, and an earlier version of this test
  // failed on exactly that. The URI is a NAME that identifies the SVG
  // vocabulary -- it is never dereferenced, browsers require nothing by it, and
  // an inline SVG without it stops being valid XML the moment anyone extracts
  // it. Forbidding it would forbid correct markup. So the check is for things
  // that are actually FETCHED, with the namespace carved out explicitly rather
  // than by loosening the pattern until it stops firing.
  const svg = barChart([cat("a", "A", 1)]);
  for (const forbidden of ["<script", "xlink:href", "url(", "@import", "src="]) {
    assert.ok(!svg.includes(forbidden), `the chart must not contain ${forbidden}`);
  }
  const stripped = svg.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "");
  assert.ok(!stripped.includes("http"), "and with the namespace declaration removed, no URI remains at all");
});
