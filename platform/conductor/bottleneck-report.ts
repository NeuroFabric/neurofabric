import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { analyseBottlenecks, type BottleneckAnalysis } from "./bottlenecks.ts";
import type { ToolDescriptor } from "../core/types.ts";
import type { CsvReadResult } from "./capabilities.ts";

/**
 * THE STAGE 2 ARTIFACT: a bottleneck report page.
 *
 * Same shape as the Stage 1 dashboard -- self-contained, no network, no script
 * from anywhere else -- but the content is the PRODUCT rather than a chart. The
 * ranking is the thing a reader argues with, so:
 *
 *   - every row of every table cites the file rows it was computed from, and
 *   - the numbers a reader cannot check without opening the source are not
 *     printed without those citations.
 *
 * A report that says "checkout-api is the bottleneck" without saying from where
 * is an assertion. This one says it and shows its receipts.
 */

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

/** Citations are the point, so they are collapsed only when there are many. */
function cite(rows: readonly number[], limit = 8): string {
  if (rows.length === 0) return "";
  const shown = rows.slice(0, limit).join(", ");
  return rows.length > limit ? `${shown} (+${rows.length - limit} more)` : shown;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function bottleneckTable(rows: readonly BottleneckAnalysis["bySource"][number][], title: string, keyHeader: string): string {
  if (rows.length === 0) return `<h2>${escapeHtml(title)}</h2>\n<p class="none">Nothing to rank.</p>`;
  const body = rows.map((b, i) => `    <tr>
      <td class="rank">${i + 1}</td>
      <td>${escapeHtml(b.key)}</td>
      <td class="num">${b.errorCount}</td>
      <td class="num">${b.count}</td>
      <td class="num">${pct(b.errorRate)}</td>
      <td class="cite">rows ${escapeHtml(cite(b.rows))}</td>
    </tr>`).join("\n");
  return `<h2>${escapeHtml(title)}</h2>
<table>
  <thead><tr><th>#</th><th>${escapeHtml(keyHeader)}</th><th>errors</th><th>total</th><th>rate</th><th>evidence</th></tr></thead>
  <tbody>
${body}
  </tbody>
</table>`;
}

function latencyTable(a: BottleneckAnalysis): string {
  if (a.latency.length === 0) return "";
  const body = a.latency.map((b) => `    <tr>
      <td>${escapeHtml(b.label)}</td>
      <td class="num">${b.count}</td>
      <td class="cite">rows ${escapeHtml(cite(b.rows))}</td>
    </tr>`).join("\n");
  return `<h2>Latency distribution</h2>
<table>
  <thead><tr><th>band</th><th>rows</th><th>evidence</th></tr></thead>
  <tbody>
${body}
  </tbody>
</table>`;
}

/** Render the report. Writes nothing when the CSV reported structural problems. */
export async function renderBottleneckReport(input: {
  path: string;
  title?: string;
  csv: CsvReadResult;
}): Promise<{ path: string; bytes: number; rendered: boolean; problems: readonly string[] }> {
  const analysis = analyseBottlenecks(input.csv);
  const title = String(input.title ?? "Bottleneck report");

  // A report drawn from a file the reader already called malformed is a lie with
  // a chart on it. Refusing is the same contract as the Stage 1 reader: report
  // the structure, render nothing.
  if (analysis.problems.length > 0) {
    return { path: input.path, bytes: 0, rendered: false, problems: analysis.problems };
  }

  const top = analysis.recurring[0];
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem; color: #16181d; background: #fff; max-width: 60rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .meta { color: #5b616e; margin: 0 0 1.5rem; }
  h2 { font-size: 1rem; margin: 2rem 0 .5rem; padding-bottom: .25rem; border-bottom: 1px solid #d8dbe2; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #eef0f4; vertical-align: top; }
  th { font-weight: 600; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: #5b616e; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .rank { color: #8a909c; width: 2rem; }
  .cite { color: #5b616e; font-size: .8rem; font-variant-numeric: tabular-nums; }
  .none { color: #8a909c; }
  .lead { border-left: 3px solid #16181d; padding: .1rem 0 .1rem .75rem; margin: 0 0 1.5rem; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="meta">${analysis.totalRows} row(s) &middot; ${analysis.errorRows} error(s) &middot; overall error rate ${pct(analysis.errorRate)}</p>
${top === undefined ? "" : `<p class="lead"><strong>Leading recurring failure:</strong> ${escapeHtml(top.key)} &mdash; ${top.errorCount} occurrence(s) across rows ${escapeHtml(cite(top.rows))}.</p>`}
${bottleneckTable(analysis.bySource, "Bottlenecks by source", "source")}
${bottleneckTable(analysis.recurring, "Recurring error signatures", "signature")}
${bottleneckTable(analysis.byHour, "Errors by hour", "hour (UTC)")}
${latencyTable(analysis)}
${analysis.unreadableTimestamps.length > 0 ? `<h2>Excluded from the hourly view</h2>
<p class="none">${analysis.unreadableTimestamps.length} row(s) carried an unreadable timestamp: rows ${escapeHtml(cite(analysis.unreadableTimestamps))}. They are counted everywhere else and excluded only from the hourly buckets.</p>` : ""}
</body>
</html>
`;
  const out = String(input.path);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, html, "utf8");
  return { path: out, bytes: Buffer.byteLength(html, "utf8"), rendered: true, problems: [] };
}

export const ANALYSE_BOTTLENECKS: ToolDescriptor = {
  name: "analyse_bottlenecks",
  version: "stage2",
  description: "Rank error sources, recurring signatures, hourly volume and latency from a parsed CSV export",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  capabilities: ["csv.read"],
  permissions: ["tool:analyse_bottlenecks"],
  riskLevel: "READ_ONLY",
  idempotency: "IDEMPOTENT",
  sideEffect: "PURE",
  timeoutMs: 10_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
};

export const RENDER_BOTTLENECK_REPORT: ToolDescriptor = {
  name: "render_bottleneck_report",
  version: "stage2",
  description: "Render a self-contained bottleneck report page with row-level evidence for every figure",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, title: { type: "string" }, csv: { type: "object" } },
    required: ["path", "csv"],
  },
  outputSchema: { type: "object" },
  capabilities: ["artifact.page"],
  permissions: ["tool:render_bottleneck_report"],
  riskLevel: "WRITE",
  idempotency: "IDEMPOTENT",
  sideEffect: "SIDE_EFFECTING",
  timeoutMs: 10_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
};

export const STAGE2_CAPABILITIES: ToolDescriptor[] = [ANALYSE_BOTTLENECKS, RENDER_BOTTLENECK_REPORT];