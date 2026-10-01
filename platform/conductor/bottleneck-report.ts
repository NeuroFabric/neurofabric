import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { analyseBottlenecks, type BottleneckAnalysis, type CategoryStat } from "./bottlenecks.ts";
import { resolveSchemaMemory } from "./schema-memory.ts";
import type { ToolDescriptor } from "../core/types.ts";
import type { CsvReadResult } from "./capabilities.ts";
import type { ResolvedSchema } from "./schema-memory.ts";

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
 *
 * WHAT IS DELIBERATELY NOT PRINTED. The by-source ranking is computed and
 * returned in the analysis, but NOT rendered. Its values are infrastructure
 * hostnames, and a bottleneck report about alert categories does not need them;
 * committing them would publish environment naming into version control for no
 * gain. Alert CODES are printed, because ranking alert categories IS the
 * product and a ranking cannot name what it ranks.
 */

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}

/**
 * Citations are the point, so they are collapsed only when there are many.
 * Five keeps a citation inside the 40-character budget the committed report is
 * held to, and the "(+N more)" keeps it honest that the list is truncated.
 */
function cite(rows: readonly number[], limit = 5): string {
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

function categoryTable(rows: readonly CategoryStat[], title: string, order: "frequency" | "elapsed"): string {
  if (rows.length === 0) return "";
  const body = rows.map((c, i) => `    <tr${i === 0 ? ' class="top"' : ""}>
      <td class="rank">${i === 0 ? "<strong>1</strong>" : i + 1}</td>
      <td${i === 0 ? ' class="lead-key"' : ""}>${escapeHtml(c.label)}</td>
      <td class="num">${c.count}</td>
      ${order === "elapsed" ? `<td class="num">${c.totalElapsed === null ? "&mdash;" : c.totalElapsed.toLocaleString()}</td>` : ""}
      <td class="num">${c.breachCount}</td>
      <td class="cite">rows ${escapeHtml(cite(c.rows))}</td>
    </tr>`).join("\n");
  const extra = order === "elapsed" ? "<th>total elapsed</th>" : "";
  return `<h2>${escapeHtml(title)}</h2>
<table>
  <thead><tr><th>#</th><th>category (${escapeHtml(order === "elapsed" ? "by total elapsed" : "by frequency")})</th><th>rows</th>${extra}<th>over threshold</th><th>evidence</th></tr></thead>
  <tbody>
${body}
  </tbody>
</table>`;
}

/**
 * R9 ON THE PAGE. Every column reading is printed with whether it was inferred
 * from a name alone, because a number nobody can trace back to a decision is a
 * number nobody can challenge.
 */
function mappingsSection(a: BottleneckAnalysis): string {
  if (a.mappings.length === 0 && a.degenerateColumns.length === 0 && a.missing.length === 0) return "";
  const mapped = a.mappings.map((m) => `    <tr>
      <td>${escapeHtml(m.role)}</td>
      <td>${escapeHtml(m.column)}</td>
      <td>${m.hypothesis ? "hypothesis" : "established"}</td>
      <td class="cite">${escapeHtml(m.note)}</td>
    </tr>`).join("\n");
  const dropped = a.degenerateColumns.map((d) => `    <li><strong>${escapeHtml(d.column)}</strong> &mdash; ${escapeHtml(d.note)} (${d.distinctValues} distinct value(s)).</li>`).join("\n");
  const absent = a.missing.length === 0 ? "" : `<p class="gap"><strong>This page cannot answer anything requiring:</strong> ${a.missing.map(escapeHtml).join(", ")}. No credible column for ${a.missing.length === 1 ? "it" : "those"} exists in this export, so nothing below is substituted for ${a.missing.length === 1 ? "it" : "them"}.</p>`;
  return `<h2>How this page was read</h2>
${provenanceNote(a)}
<table>
  <thead><tr><th>role</th><th>column</th><th>basis</th><th>note</th></tr></thead>
  <tbody>
${mapped}
  </tbody>
</table>
${dropped === "" ? "" : `<h2>Columns deliberately not ranked on</h2>
<ul class="none">
${dropped}
</ul>`}
${absent}`;
}

/**
 * The sentence that says where the column readings came from.
 *
 * This used to be a constant: "every column reading is inferred from the column
 * NAME alone". Once a stored schema can supply a verified mapping, that sentence
 * is false for the rows it describes, and a report that mislabels its own
 * evidence is worse than one that admits what it does not know. So the basis is
 * stated per source, and the counts are printed rather than asserted.
 */
function provenanceNote(a: BottleneckAnalysis): string {
  const verifiedCount = a.verifiedRoles?.length ?? 0;
  if (verifiedCount === 0) {
    return `<p class="none">No stored schema matched this file, so every column reading below is inferred from the column NAME alone and awaits owner confirmation. A name describes intent; it does not prove semantics.</p>`;
  }
  const where = a.schemaSource === "SESSION_ARCHIVE"
    ? "this checkout's own learned schema (<code>.session-archive</code>)"
    : "a core schema shipped with the product (<code>configs/default-schemas.json</code>)";
  const rest = a.mappings.length - verifiedCount;
  return `<p class="none">${verifiedCount} of ${a.mappings.length} column reading(s) come from ${escapeHtml(where)}, verified against a real export of this shape.${rest > 0
    ? ` The remaining ${rest} ${rest === 1 ? "is" : "are"} inferred from the column NAME alone and awaits owner confirmation.`
    : ""}</p>`;
}

/**
 * The same findings as Markdown, for the web wedge and for pasting into a ticket.
 *
 * CELL ESCAPING. Every value here came out of a CSV a stranger uploaded, so it
 * is treated as hostile: a pipe would break the table it sits in, a newline would
 * invent a row, and backticks would open a code span. The values are neutralised
 * for the TABLE STRUCTURE here, and the browser escapes them again for HTML
 * before rendering. Two layers, because one layer is a bet about which renderer
 * will eventually see this text.
 */
function mdCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[`*_[\]<>]/g, "").replace(/\r?\n/g, " ").trim();
}

function mdRows(rows: readonly number[], limit = 12): string {
  const shown = rows.slice(0, limit).join(", ");
  return rows.length > limit ? `${shown} (+${rows.length - limit} more)` : shown;
}

function mdCategoryTable(stats: readonly CategoryStat[], heading: string, measure: string): string {
  if (stats.length === 0) return `## ${heading}\n\n_No rows carried a credible category column, so this ranking is empty. That is a fact about the file, not a finding._\n`;
  const lines = [
    `## ${heading}`,
    "",
    "| # | category | alerts | over threshold | total elapsed | source rows |",
    "|---|---|---|---|---|---|",
  ];
  stats.forEach((s, index) => {
    lines.push(`| ${index + 1} | ${mdCell(s.key)} | ${s.count} | ${s.breachCount} | ${s.totalElapsed === null ? "not measurable" : s.totalElapsed.toLocaleString()} | ${mdRows(s.rows)} |`);
  });
  lines.push("", `_Ranked by ${measure}._`, "");
  return lines.join("\n");
}

/** The Markdown rendering of an analysis. Pure: no I/O, no policy, no kernel. */
export function toBottleneckMarkdown(analysis: BottleneckAnalysis, title = "Bottleneck report"): string {
  const topCategory = analysis.categories[0];
  const topElapsed = analysis.categoriesByElapsed[0];
  const out: string[] = [`# ${mdCell(title)}`, ""];

  out.push(`${analysis.totalRows} row(s) · ranked by **${mdCell(analysis.categoryColumn ?? "no credible column")}**`);
  if (analysis.mappings.some((m) => m.role === "status")) {
    out.push(`· ${analysis.errorRows} error(s) · error rate ${pct(analysis.errorRate)}`);
  } else {
    out.push("· no status column, so no error rate is claimed");
  }
  out.push("");

  if (topCategory !== undefined) {
    let lead = `**#1 by frequency:** ${mdCell(topCategory.key)} — ${topCategory.count} alert(s), ${topCategory.breachCount} over threshold, rows ${mdRows(topCategory.rows)}.`;
    if (topElapsed !== undefined && topElapsed.key !== topCategory.key) {
      lead += ` **#1 by total elapsed:** ${mdCell(topElapsed.key)} (${topElapsed.totalElapsed?.toLocaleString() ?? "not measurable"}).`;
    }
    out.push(`> ${lead}`, "");
  }

  if (analysis.mappings.length > 0 || analysis.missing.length > 0) {
    const verifiedCount = analysis.verifiedRoles?.length ?? 0;
    out.push("## How this report was read", "");
    out.push(verifiedCount === 0
      ? "_No stored schema matched this file, so every column reading below is inferred from the column NAME alone and awaits owner confirmation._"
      : `_${verifiedCount} of ${analysis.mappings.length} column reading(s) come from ${analysis.schemaSource === "SESSION_ARCHIVE" ? "this checkout's own learned schema" : "a core schema shipped with the product"}, verified against a real export of this shape._`);
    out.push("");
    out.push("| role | column | basis | note |", "|---|---|---|---|");
    for (const m of analysis.mappings) {
      out.push(`| ${mdCell(m.role)} | ${mdCell(m.column)} | ${m.hypothesis ? "hypothesis" : "established"} | ${mdCell(m.note)} |`);
    }
    out.push("");
  }

  if (analysis.degenerateColumns.length > 0) {
    out.push("## Columns deliberately not ranked on", "");
    for (const d of analysis.degenerateColumns) {
      out.push(`- **${mdCell(d.column)}** — ${mdCell(d.note)} (${d.distinctValues} distinct value(s)).`);
    }
    out.push("");
  }

  if (analysis.missing.length > 0) {
    out.push(`> **This report cannot answer anything requiring:** ${analysis.missing.map(mdCell).join(", ")}. No credible column for ${analysis.missing.length === 1 ? "it" : "those"} exists in this export, so nothing below is substituted.`, "");
  }

  out.push(mdCategoryTable(analysis.categories, "Alert categories by frequency", "frequency"));
  out.push(mdCategoryTable(analysis.categoriesByElapsed, "Alert categories by total elapsed time", "total elapsed time"));

  if (analysis.byHour.length > 0) {
    out.push(`## Rows by hour (${analysis.timestampsAreNaive ? "host-local; these timestamps carry no zone" : "UTC"})`, "");
    out.push("| hour | rows | error rows |", "|---|---|---|");
    for (const h of analysis.byHour) out.push(`| ${mdCell(h.key)} | ${h.count} | ${h.errorCount} |`);
    out.push("");
  }

  if (analysis.unreadableTimestamps.length > 0) {
    out.push(`## Excluded from the hourly view`, "", `${analysis.unreadableTimestamps.length} row(s) carried an unreadable timestamp: rows ${mdRows(analysis.unreadableTimestamps)}.`, "");
  }
  if (analysis.problems.length > 0) {
    out.push("## Structural problems in the source file", "");
    for (const p of analysis.problems) out.push(`- ${mdCell(p)}`);
    out.push("");
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

/** Render the report. Writes nothing when the CSV reported structural problems. */
export async function renderBottleneckReport(input: {
  path: string;
  title?: string;
  csv: CsvReadResult;
  /** A stored mapping for this file, when one resolved. See `schema-memory.ts`. */
  schema?: ResolvedSchema;
  /**
   * Where the workspace is, and where the shipped schemas live.
   *
   * THE SCHEMA IS RESOLVED HERE WHEN IT IS NOT SUPPLIED, and that is not a
   * convenience. The governed tool input is walked by the kernel and any string
   * sitting under a path-shaped KEY is taken to be a file this call produces.
   * A resolved schema carries `source` (its provenance) and a `roles` map keyed
   * by column role, and one of those roles is legitimately called `source`, so
   * handing the mapping in asserted two files that do not exist. Those phantom
   * artifacts can never verify, so the task can never leave PLANNING and every
   * clean run ended TASK_NOT_COMPLETED.
   *
   * So the tool resolves its own memory from the workspace it is already
   * governed on. The keys below are named so they are not path operands, which
   * is naming a value for what it is rather than disguising one as another.
   */
  workspaceCwd?: string;
  defaultsRoot?: string;
  /**
   * `html` (default) writes the self-contained page. `markdown` writes the same
   * findings as Markdown, which is what the web wedge returns to a browser and
   * what a person can paste into a ticket. The FIGURES are identical: one
   * analysis, two renderings, so the two can never disagree.
   */
  format?: "html" | "markdown";
}): Promise<{ path: string; bytes: number; rendered: boolean; problems: readonly string[]; markdown?: string }> {
  const schema = input.schema ?? (input.workspaceCwd === undefined ? undefined : await resolveSchemaMemory({
    cwd: input.workspaceCwd, headers: input.csv.headers, defaultsRoot: input.defaultsRoot,
  }));
  const analysis = analyseBottlenecks(input.csv, schema);
  const title = String(input.title ?? "Bottleneck report");

  // A report drawn from a file the reader already called malformed is a lie with
  // a chart on it. Refusing is the same contract as the Stage 1 reader: report
  // the structure, render nothing.
  if (analysis.problems.length > 0) {
    return { path: input.path, bytes: 0, rendered: false, problems: analysis.problems };
  }

  if (input.format === "markdown") {
    const markdown = toBottleneckMarkdown(analysis, title);
    const out = String(input.path);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, markdown, "utf8");
    return { path: out, bytes: Buffer.byteLength(markdown, "utf8"), rendered: true, problems: [], markdown };
  }

  const top = analysis.recurring[0];
  const topCategory = analysis.categories[0];
  const topElapsed = analysis.categoriesByElapsed[0];
  const lead = topCategory === undefined ? "" : `<p class="lead"><strong>#1 by frequency:</strong> ${escapeHtml(topCategory.key)} &mdash; ${topCategory.count} alert(s), ${topCategory.breachCount} over threshold, rows ${escapeHtml(cite(topCategory.rows))}.${topElapsed !== undefined && topElapsed.key !== topCategory.key ? ` <strong>#1 by total elapsed:</strong> ${escapeHtml(topElapsed.key)} (${topElapsed.totalElapsed?.toLocaleString()}).` : ""}</p>`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem; color: #16181d; background: #fff; max-width: 62rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .meta { color: #5b616e; margin: 0 0 1.25rem; }
  h2 { font-size: 1rem; margin: 2rem 0 .5rem; padding-bottom: .25rem; border-bottom: 1px solid #d8dbe2; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #eef0f4; vertical-align: top; }
  th { font-weight: 600; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: #5b616e; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .rank { color: #8a909c; width: 2.5rem; }
  .cite { color: #5b616e; font-size: .8rem; font-variant-numeric: tabular-nums; }
  .none { color: #5b616e; }
  .lead { border-left: 3px solid #16181d; padding: .35rem 0 .35rem .75rem; margin: 0 0 1.25rem; }
  .gap { border-left: 3px solid #b23c17; padding: .35rem 0 .35rem .75rem; background: #fdf6f3; }
  .banner { border: 2px solid #16181d; padding: .75rem 1rem; margin: 0 0 1.5rem; }
  .banner p { margin: .3rem 0; }
  .banner-title { font-weight: 700; text-transform: uppercase; letter-spacing: .04em; font-size: .8rem; }
  .banner-note { color: #5b616e; font-size: .85rem; }
  tr.top td { font-weight: 600; }
  .lead-key { font-weight: 700; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="meta">${analysis.totalRows} row(s) &middot; ranked by <strong>${escapeHtml(analysis.categoryColumn ?? "no credible column")}</strong>${analysis.mappings.some((m) => m.role === "status")
    ? ` &middot; ${analysis.errorRows} error(s) &middot; error rate ${pct(analysis.errorRate)}`
    : " &middot; no status column, so no error rate is claimed"}</p>
${lead}
${divergenceBanner(analysis)}
${mappingsSection(analysis)}
${categoryTable(analysis.categories, "Alert categories by frequency", "frequency")}
${categoryTable(analysis.categoriesByElapsed, "Alert categories by total elapsed time", "elapsed")}
${bottleneckTable(analysis.byHour, analysis.timestampsAreNaive
    ? "Rows by hour (host-local -- these timestamps carry no zone)"
    : "Rows by hour (UTC)", "hour")}
${latencyTable(analysis)}
${analysis.unreadableTimestamps.length > 0 ? `<h2>Excluded from the hourly view</h2>
<p class="none">${analysis.unreadableTimestamps.length} row(s) carried an unreadable timestamp: rows ${escapeHtml(cite(analysis.unreadableTimestamps))}.</p>` : ""}
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
    properties: {
      path: { type: "string" }, title: { type: "string" }, csv: { type: "object" },
      // Every real input is declared. The schema is resolved by the renderer
      // from the workspace rather than handed in here, because a mapping
      // carries a `source` key and a role named `source`, and both would be
      // read as output files that do not exist.
      workspaceCwd: { type: "string" }, defaultsRoot: { type: "string" },
      format: { type: "string" },
    },
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