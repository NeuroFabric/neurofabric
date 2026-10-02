import type { CategoryStat, HourStat } from "./bottlenecks.ts";

/**
 * INLINE SVG, GENERATED IN-PROCESS. NO CDN, AND THAT IS THE WHOLE ARGUMENT.
 *
 * The obvious way to draw a chart in a self-contained page is a script tag
 * pointing at a CDN. For a security product that is the wrong trade three times
 * over, and each reason is sufficient on its own.
 *
 * IT BREAKS THE INVARIANT. The Stage 2 artifact was verified to contain no
 * remote references, and the wedge server sends default-src 'none' precisely so
 * that a later edit adding a CDN fails that header's intent. A report that
 * silently stops working without a network fails in exactly the situation a
 * report is most needed.
 *
 * IT IS A SUPPLY CHAIN. The page would execute third-party JavaScript supplied at
 * render time, on a machine that just handed it a data file. A compromised CDN
 * is arbitrary code execution inside the analysis surface, and no amount of
 * escaping in our own code prevents that.
 *
 * IT IS A BIGGER FOOTPRINT THAN THE CHART. A bar chart is a handful of rect
 * elements. A charting library is megabytes to save forty lines of arithmetic.
 *
 * HORIZONTAL BARS, NOT VERTICAL, and that is a readability decision. The labels
 * are arbitrary strings from an arbitrary file: "PEGA0001 (HttpAPI)" is long,
 * and a vertical axis gives each label a few pixels of width. Horizontal bars
 * give the label the whole left margin, and a long one is truncated with a
 * visible ellipsis rather than rotated, shrunk, or silently overlapped.
 *
 * AN EMPTY CHART IS NOT DRAWN. A frame with nothing in it reads as a finding --
 * "we looked and there was nothing" -- which is a stronger and different claim
 * from "this file has nothing to chart". Every function here returns the empty
 * string rather than an empty canvas.
 */

/** The XML five. Text inside SVG can contain markup, so this is not optional. */
export function escapeXmlText(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c] ?? c));
}

/**
 * Truncation is VISIBLE.
 *
 * A silently cut label is a lie about what the chart contains: a reader cannot
 * tell a shortened "PEGA0001 (HttpAP..." from a column genuinely named that. The
 * ellipsis is the difference between a chart that is honest about its own edges
 * and one that is not.
 */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Numbers are formatted WITHOUT locale grouping.
 *
 * toLocaleString would emit "10,000" or "10.000" depending on the host's locale,
 * which is a non-deterministic committed artifact: the same input produces a
 * different report on a different machine. A report that diffs differently on
 * two people's laptops is a report nobody trusts in review.
 */
function num(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "0";
  return String(Number(value.toFixed(digits)));
}

const PALETTE = {
  ink: "#16181d",
  muted: "#5b616e",
  rule: "#d8dbe2",
  bar: "#3d5a80",
  spike: "#b23c17",
  mean: "#8a909c",
  surface: "#f6f7f9",
} as const;

const TITLE_H = 26;
const PAD_TOP = 34;
const PAD_BOTTOM = 26;
const LABEL_W = 150;
const PAD_RIGHT = 46;
const BAR_H = 20;
const BAR_GAP = 10;
const TOP_N = 5;

/**
 * TOP CATEGORIES BY FREQUENCY, as horizontal bars.
 *
 * Returns "" when there is nothing to draw, so a caller can place it without a
 * conditional of its own.
 */
export function barChart(categories: readonly CategoryStat[], options: { readonly max?: number } = {}): string {
  const ranked = [...categories].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  if (ranked.length === 0) return "";
  const shown = ranked.slice(0, options.max ?? TOP_N);
  const hidden = ranked.length - shown.length;

  const width = 640;
  const plotW = width - LABEL_W - PAD_RIGHT;
  const height = PAD_TOP + shown.length * (BAR_H + BAR_GAP) + PAD_BOTTOM;
  // A zero maximum would divide to Infinity and produce NaN geometry, which
  // renders as nothing at all. The floor keeps the chart drawable and honest.
  const max = Math.max(1, shown[0].count);

  const rows = shown.map((c, i) => {
    const y = PAD_TOP + i * (BAR_H + BAR_GAP);
    const w = Math.max(1, (c.count / max) * plotW);
    const label = truncate(escapeXmlText(c.label), 26);
    return `  <g>
    <text class="label" x="${LABEL_W - 8}" y="${y + BAR_H * 0.72}" text-anchor="end">${label}</text>
    <rect x="${LABEL_W}" y="${y}" width="${num(w)}" height="${BAR_H}" fill="${PALETTE.bar}" rx="2"></rect>
    <text class="value" x="${LABEL_W + w + 6}" y="${y + BAR_H * 0.72}">${c.count}</text>
  </g>`;
  }).join("\n");

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Top categories by frequency" xmlns="http://www.w3.org/2000/svg">
  <title>Top ${shown.length} categories by frequency</title>
  <text class="chart-title" x="0" y="16">Top ${shown.length} categor${shown.length === 1 ? "y" : "ies"} by frequency</text>${hidden > 0 ? `<text class="chart-note" x="${width}" y="16" text-anchor="end">${hidden} more not shown</text>` : ""}
${rows}
</svg>`;
}

export interface HourlyChartOptions {
  /** The hourly mean, drawn as a visible baseline. A spike with no baseline is an assertion. */
  readonly mean?: number;
  readonly width?: number;
  readonly height?: number;
}

/**
 * ROWS BY HOUR, as a line with a marker per bucket, spikes called out.
 *
 * A LINE and not a scatter, because the question the reader is answering is "when
 * did it jump", and a connected series shows the shape of the change while a
 * scatter shows only where the points happen to be. Hours are placed at even
 * intervals and LABELLED with their key, so a gap of missing hours reads as a
 * gap rather than compressing the axis.
 *
 * ONE BUCKET DRAWS NO LINE. A single point is not a trend, and drawing a
 * degenerate line through it would imply one.
 */
export function hourlyChart(hours: readonly HourStat[], options: HourlyChartOptions = {}): string {
  if (hours.length === 0) return "";
  const width = options.width ?? 640;
  const height = options.height ?? 220;
  const padLeft = 42;
  const padRight = 16;
  const padTop = 34;
  const padBottom = 40;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const max = Math.max(1, ...hours.map((h) => h.count));
  // Even spacing, not a time scale: hour keys are ISO strings and an absent
  // hour is genuinely absent data, not a compressed interval.
  const step = hours.length === 1 ? 0 : plotW / (hours.length - 1);
  const x = (i: number) => padLeft + (hours.length === 1 ? plotW / 2 : i * step);
  const y = (count: number) => padTop + plotH - (count / max) * plotH;

  const points = hours.map((h, i) => `${num(x(i))},${num(y(h.count))}`).join(" ");

  const markers = hours.map((h, i) => {
    const fill = h.isSpike ? PALETTE.spike : PALETTE.bar;
    const radius = h.isSpike ? 5 : 3;
    const flag = h.isSpike ? `<text class="spike-label" x="${num(x(i))}" y="${num(y(h.count) - 10)}" text-anchor="middle">SPIKE</text>` : "";
    return `  <circle cx="${num(x(i))}" cy="${num(y(h.count))}" r="${radius}" fill="${fill}"></circle>${flag}`;
  }).join("\n");

  const labels = hours.map((h, i) => {
    // Every Nth label, so they never overlap. The full set is in the table
    // beneath; the axis exists to orient, not to be read exhaustively.
    const every = Math.max(1, Math.ceil(hours.length / 8));
    if (i % every !== 0 && i !== hours.length - 1) return "";
    const short = h.key.length > 11 ? h.key.slice(5) : h.key;
    return `  <text class="axis" x="${num(x(i))}" y="${height - 14}" text-anchor="middle">${escapeXmlText(truncate(short, 11))}</text>`;
  }).join("\n");

  const meanLine = options.mean === undefined ? "" : `  <line class="mean" x1="${padLeft}" y1="${num(y(options.mean))}" x2="${width - padRight}" y2="${num(y(options.mean))}" stroke="${PALETTE.mean}" stroke-width="1" stroke-dasharray="4 3"></line>
  <text class="axis" x="${width - padRight}" y="${num(y(options.mean) - 4)}" text-anchor="end">avg ${num(options.mean, 1)}</text>`;

  const spikes = hours.filter((h) => h.isSpike).length;

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Rows by hour" xmlns="http://www.w3.org/2000/svg">
  <title>Rows by hour${spikes > 0 ? `, ${spikes} spike${spikes === 1 ? "" : "s"} flagged` : ""}</title>
  <text class="chart-title" x="0" y="16">Rows by hour</text>${spikes > 0 ? `<text class="chart-note" x="${width}" y="16" text-anchor="end" fill="${PALETTE.spike}">${spikes} spike${spikes === 1 ? "" : "s"}</text>` : ""}
  <line x1="${padLeft}" y1="${padTop + plotH}" x2="${width - padRight}" y2="${padTop + plotH}" stroke="${PALETTE.rule}" stroke-width="1"></line>
  <text class="axis" x="${padLeft - 6}" y="${padTop + 4}" text-anchor="end">${max}</text>
  <text class="axis" x="${padLeft - 6}" y="${padTop + plotH}" text-anchor="end">0</text>
${meanLine}${hours.length > 1 ? `  <polyline points="${points}" fill="none" stroke="${PALETTE.bar}" stroke-width="2" stroke-linejoin="round"></polyline>` : ""}
${markers}
${labels}
</svg>`;
}

/** The small stylesheet the two charts share, inlined so the page stays single-origin. */
export const SVG_STYLE = `.chart-title { font: 600 13px system-ui, sans-serif; fill: ${PALETTE.ink}; }
.chart-note { font: 12px system-ui, sans-serif; fill: ${PALETTE.muted}; }
.label { font: 12px system-ui, sans-serif; fill: ${PALETTE.ink}; }
.value { font: 12px system-ui, sans-serif; fill: ${PALETTE.muted}; font-variant-numeric: tabular-nums; }
.axis { font: 10px system-ui, sans-serif; fill: ${PALETTE.muted}; }
.spike-label { font: 700 9px system-ui, sans-serif; fill: ${PALETTE.spike}; letter-spacing: .04em; }
svg { display: block; margin: 0 0 1rem; background: ${PALETTE.surface}; border: 1px solid ${PALETTE.rule}; border-radius: 3px; padding: .5rem; }`;
