import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { analyseBottlenecks, type BottleneckAnalysis, type CategoryStat, type ReportVocabulary, type HourlyProfile } from "./bottlenecks.ts";
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

/**
 * The by-source ranking is computed and returned but NOT rendered (R12): its
 * values are infrastructure hostnames and a report about alert categories does
 * not need them. Nothing here rendered it before the hourly table was replaced
 * by `hourlyTable`, and the generic renderers kept it out on the same grounds.
 */

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

/**
 * THE FOUR DURATION COLUMNS. Total, mean, median, p95 -- or a row of em-dashes.
 *
 * The four travel TOGETHER in both renderings and in both rank orders. The
 * frequency table used to omit cost entirely, which is a strange omission in a
 * product whose headline finding is that frequency and cost disagree: the reader
 * is shown the two rankings side by side and then asked to compare a number
 * from one with a number from the other, when both are in the other table.
 *
 * A measure the file cannot support is an em-dash and never a 0, for the same
 * reason the analysis returns null: 0 ms is a finding, "&mdash;" is a gap.
 */
function durationCells(c: CategoryStat, format: (n: number) => string): string {
  const cell = (v: number | null): string => `<td class="num">${v === null ? "&mdash;" : escapeHtml(format(v))}</td>`;
  return `${cell(c.totalElapsed)}${cell(c.meanElapsed)}${cell(c.medianElapsed)}${cell(c.p95Elapsed)}`;
}

function categoryTable(rows: readonly CategoryStat[], title: string, order: "frequency" | "elapsed", vocabulary: ReportVocabulary): string {
  if (rows.length === 0) return "";
  // THE BREACH COLUMN IS OPTIONAL, IN BOTH PLACES IT APPEARS. It is rendered
  // only when the file states a threshold, and when it is rendered the header
  // and every row carry the SAME conditional cell -- a header that can vanish
  // while rows keep a cell is how a dropped column silently misaligns a table.
  const breach = vocabulary.thresholdLabel === null
    ? { head: "", cell: () => "" }
    : { head: `<th>${escapeHtml(vocabulary.thresholdLabel)}</th>`, cell: (c: CategoryStat) => `<td class="num">${c.breachCount}</td>` };
  const body = rows.map((c, i) => `    <tr${i === 0 ? ' class="top"' : ""}>
      <td class="rank">${i === 0 ? "<strong>1</strong>" : i + 1}</td>
      <td${i === 0 ? ' class="lead-key"' : ""}>${escapeHtml(c.label)}</td>
      <td class="num">${c.count}</td>
      ${durationCells(c, (n) => n.toLocaleString())}
      ${breach.cell(c)}
      <td class="cite">rows ${escapeHtml(cite(c.rows))}</td>
    </tr>`).join("\n");
  return `<h2>${escapeHtml(title)}</h2>
<table>
  <thead><tr><th>#</th><th>${escapeHtml(vocabulary.unit)} (${escapeHtml(order === "elapsed" ? "by total elapsed" : "by frequency")})</th><th>rows</th><th>total elapsed (ms)</th><th>mean (ms)</th><th>median (ms)</th><th>p95 (ms)</th>${breach.head}<th>evidence</th></tr></thead>
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
 * RESTORED FROM MAIN AFTER THE MERGE, and the merge is why it is here.
 *
 * The template below renders `${divergenceBanner(analysis)}`, and the merge of
 * main into this branch kept that call while dropping the function that
 * satisfies it. A template literal is not type checked for an undefined
 * binding in the same way, so the file still built its HTML and still failed at
 * runtime, and two conductor tests went red on the divergence headline. The
 * body below is main's, brought back unchanged: reimplementing it here would
 * be a second, subtly different banner nobody had reviewed.
 */
function divergenceBanner(a: BottleneckAnalysis): string {
  const d = a.divergence;
  if (d === null) return "";
  const v = a.vocabulary;
  const elapsed = d.byElapsed.totalElapsed;
  const freq = d.byFrequency.totalElapsed;
  const ratio = d.totalRatio === undefined ? null : d.totalRatio;
  const pctOfCost = elapsed !== null && elapsed + (freq ?? 0) > 0 && elapsed > 0
    ? (elapsed / (elapsed + (freq ?? 0))) * 100 : null;

  const multiple = ratio === null ? null
    : ratio >= 10 ? Math.round(ratio) : Number(ratio.toFixed(1));
  const comparison = ratio === null ? "" : ratio >= 1
    ? `${multiple}x the total elapsed time`
    : `${(1 / ratio).toFixed(1)}x LESS total elapsed time`;

  return `<div class="banner">
  <p class="banner-title">The two rankings disagree. That is the finding.</p>
  <p><strong>Most frequent:</strong> ${escapeHtml(d.byFrequency.label)} &mdash; ${d.byFrequency.count} ${v.unitPlural}${freq === null ? "" : `, ${freq.toLocaleString()} ms total`}.</p>
  <p><strong>Most expensive:</strong> ${escapeHtml(d.byElapsed.label)} &mdash; ${d.byElapsed.count} ${v.unitPlural}${elapsed === null ? "" : `, ${elapsed.toLocaleString()} ms total`}, with ${comparison}${pctOfCost === null ? "" : ` and ${pctOfCost.toFixed(1)}% of all elapsed time in this export`}.</p>
  <p class="banner-note">Ranking by frequency alone would have pointed at ${escapeHtml(d.byFrequency.key)} and buried ${escapeHtml(d.byElapsed.key)}. Evidence rows are in the tables below.</p>
</div>`;
}

/**
 * THE DIVERGENCE IN MARKDOWN. The same finding as `divergenceBanner`, in the
 * rendering the web wedge hands back to a browser and a person pastes into a
 * ticket.
 *
 * RESTORED. The merge kept `divergenceBanner` because the HTML template calls it,
 * so nothing went red: HTML still shouted. The Markdown template simply never
 * had a block for it, and it degrades silently rather than failing -- which is
 * the worse failure, because a report that under-reports is still a report that
 * looks finished.
 *
 * It is a DEDICATED BLOCK rather than a clause appended to the lead sentence,
 * because the sentence that would have carried it is the one a reader skims.
 * The two rankings disagreeing is this product's entire claim, and a 158x cost
 * multiple buried mid-paragraph is read as trivia. A callout cannot be skimmed
 * past by accident.
 *
 * D2 STILL HOLDS: when both orderings agree this returns "", because a headline
 * that always shouts is one nobody reads.
 */
function markdownDivergenceBanner(a: BottleneckAnalysis): string {
  const d = a.divergence;
  if (d === null) return "";
  const v = a.vocabulary;
  const elapsed = d.byElapsed.totalElapsed;
  const freq = d.byFrequency.totalElapsed;
  const ratio = d.totalRatio ?? null;
  const pctOfCost = elapsed !== null && elapsed + (freq ?? 0) > 0 && elapsed > 0
    ? (elapsed / (elapsed + (freq ?? 0))) * 100 : null;
  const multiple = ratio === null ? null : ratio >= 10 ? Math.round(ratio) : Number(ratio.toFixed(1));
  const comparison = ratio === null ? "" : ratio >= 1
    ? ` with **${multiple}x the total elapsed time**`
    : ` at **${(1 / ratio).toFixed(1)}x LESS total elapsed time**`;

  return [
    "> [!WARNING]",
    "> **The two rankings disagree. That is the finding.**",
    ">",
    `> - **Most frequent:** ${mdCell(d.byFrequency.label)} — ${d.byFrequency.count} ${v.unitPlural}${freq === null ? "" : `, ${freq.toLocaleString()} ms total`}.`,
    `> - **Most expensive:** ${mdCell(d.byElapsed.label)} — ${d.byElapsed.count} ${v.unitPlural}${elapsed === null ? "" : `, ${elapsed.toLocaleString()} ms total`}${comparison}${pctOfCost === null ? "" : `, and ${pctOfCost.toFixed(1)}% of all elapsed time in this export`}.`,
    ">",
    `> Ranking by frequency alone would have pointed at ${mdCell(d.byFrequency.key)} and buried ${mdCell(d.byElapsed.key)}. Evidence rows are in the tables below.`,
    "",
  ].join("\n");
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
  if (a.schemaSource === "GENERIC") {
    // The honest sentence for an inferred profile. "Inferred from the column
    // NAME alone" would be wrong the moment a profiler has read the values, and
    // a report that mislabels its own evidence is worse than one that admits
    // what it does not know -- but the reverse mistake is just as bad, letting
    // an inference from a regex pass as a checked mapping.
    return `<p class="none">No stored schema matched this file, so every column reading below was <strong>inferred</strong> from the column names and from a statistical profile of the values themselves. None of it has been checked by a person: treat it as a first reading, not a verified mapping.</p>`;
  }
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
 *
 * EMPHASIS IS ESCAPED, NOT DELETED. This used to strip `*` and `_` outright, and
 * a column name is mostly underscores: `_time` printed as `time`, `alert_code`
 * as `alertcode`, `logger_name` as `loggername`. Those are not the columns in the
 * file. The report was renaming the evidence it cites, which is the one thing
 * this renderer exists not to do -- and it disagreed with the HTML rendering of
 * the same analysis, which has no such stripping. A backslash escape renders as
 * the literal character and cannot open emphasis, so the cell is both safe and
 * true. Backticks stay deleted: there is no escape that makes them inert in every
 * renderer, and a value carrying one is vanishingly rare.
 */
function mdCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[`*_]/g, (c) => `\\${c}`).replace(/[\[\]<>]/g, "").replace(/\r?\n/g, " ").trim();
}

function mdRows(rows: readonly number[], limit = 12): string {
  const shown = rows.slice(0, limit).join(", ");
  return rows.length > limit ? `${shown} (+${rows.length - limit} more)` : shown;
}

function mdCategoryTable(stats: readonly CategoryStat[], heading: string, measure: string, vocabulary: ReportVocabulary): string {
  if (stats.length === 0) return `## ${heading}\n\n_No rows carried a credible category column, so this ranking is empty. That is a fact about the file, not a finding._\n`;
  // Same contract as the HTML table: the breach column appears only when the
  // file states a threshold, and the header and the cells decide together.
  const breach = vocabulary.thresholdLabel;
  const lines = [
    `## ${heading}`,
    "",
    `| # | category | ${vocabulary.unitPlural} |${breach === null ? "" : ` ${breach} |`} total elapsed (ms) | mean (ms) | median (ms) | p95 (ms) | source rows |`,
    `|---|---|---|${breach === null ? "" : "---|"}---|---|---|---|---|`,
  ];
  stats.forEach((s, index) => {
    const cell = (v: number | null): string => (v === null ? "not measurable" : v.toLocaleString());
    // R13: the LABEL, not the bare key. The key alone says PEGA0001; the label
    // says PEGA0001 (HttpAPI), which is the row a person recognises. The key is
    // still a prefix of it, so anything matching on the code keeps working, and
    // an alias is only ever present when R13 proved the mapping unambiguous in
    // both directions -- one logger serving two codes is a coincidence, not a
    // label.
    lines.push(`| ${index + 1} | ${mdCell(s.label)} | ${s.count} |${breach === null ? "" : ` ${s.breachCount} |`} ${cell(s.totalElapsed)} | ${cell(s.meanElapsed)} | ${cell(s.medianElapsed)} | ${cell(s.p95Elapsed)} | ${mdRows(s.rows)} |`);
  });
  lines.push("", `_Ranked by ${measure}._`, "");
  return lines.join("\n");
}

/** The chronological, spike-aware hour table. Mirrors `hourlyTable` exactly. */
function hourlyMarkdown(a: BottleneckAnalysis): string {
  const h = a.hourly;
  const header = a.timestampsAreNaive ? "hour (host-local; these timestamps carry no zone)" : "hour (UTC)";
  const out: string[] = [];
  if (h.insufficient && h.buckets > 0) {
    out.push(`> Only ${h.buckets} hour bucket(s) carry rows, which is too few for the ${h.spikeMultiple}x test to mean anything. No hour is called abnormal.`, "");
  } else if (h.flagged > 0) {
    const worst = [...h.hours].filter((x) => x.isSpike).sort((a, b) => b.count - a.count)[0];
    out.push(`> [!WARNING]`, `> **${h.flagged} hour${h.flagged === 1 ? "" : "s"} above the average. That is the incident.**`, ">",
      `> Worst: **${mdCell(worst.key)}** carried **${worst.count} rows** of ${h.countedRows} — ${(worst.share * 100).toFixed(1)}% of the export in one hour, ${mdCell(worst.rule ?? "")}.`, ">",
      `> Mean ${h.meanPerHour.toFixed(1)} rows/hour over ${h.buckets} observed hour(s), population sigma ${h.sigma.toFixed(1)}. Flagged above ${h.spikeMultiple}x the mean.`, "");
  }
  out.push(`## Rows by ${header}`, "");
  out.push(`| hour | rows | share | vs avg | signal |`, `|---|---|---|---|---|`);
  for (const x of h.hours) {
    out.push(`| ${mdCell(x.key)} | ${x.count} | ${(x.share * 100).toFixed(1)}% | ${x.multiple === null ? "not measurable" : `${x.multiple.toFixed(1)}x`} | ${x.isSpike ? `**SPIKE** (${mdCell(x.rule ?? "")})` : ""} |`);
  }
  out.push("");
  return out.join("\n");
}

/** The Markdown rendering of an analysis. Pure: no I/O, no policy, no kernel. */
export /**
 * WHEN IT HAPPENED. Chronological, not ranked, because the question this table
 * answers is "which hour", and a table sorted by volume makes the reader hunt
 * for it.
 *
 * The SPIKE row is marked in the markup as well as in the words, so the page can
 * style it and so a reader scanning the column can find it without reading
 * every cell.
 */
function hourlyTable(a: BottleneckAnalysis): string {
  const h = a.hourly;
  if (h.hours.length === 0) return "";
  const body = h.hours.map((x) => `    <tr${x.isSpike ? ' class="spike"' : ""}>
      <td>${escapeHtml(x.key)}</td>
      <td class="num">${x.count}</td>
      <td class="num">${(x.share * 100).toFixed(1)}%</td>
      <td class="num">${x.multiple === null ? "&mdash;" : `${x.multiple.toFixed(1)}x`}</td>
      <td>${x.isSpike ? `<span class="badge">SPIKE</span> ${escapeHtml(x.rule ?? "")}` : ""}</td>
    </tr>`).join("\n");
  const header = a.timestampsAreNaive ? "hour (host-local -- these timestamps carry no zone)" : "hour (UTC)";
  return `${hourlyCalloutHtml(h)}
<h2>Rows by ${escapeHtml(header)}</h2>
<table>
  <thead><tr><th>hour</th><th>rows</th><th>share</th><th>vs avg (${h.meanPerHour.toFixed(1)})</th><th>signal</th></tr></thead>
  <tbody>
${body}
  </tbody>
</table>
<p class="none">Average ${h.meanPerHour.toFixed(1)} rows/hour across ${h.buckets} observed hour(s); population sigma ${h.sigma.toFixed(1)}. A row is flagged above ${h.spikeMultiple}x that average.</p>`;
}

function hourlyCalloutHtml(h: HourlyProfile): string {
  if (h.insufficient && h.buckets > 0) {
    return `<p class="none">Only ${h.buckets} hour bucket(s) carry rows, which is too few for the ${h.spikeMultiple}x test to mean anything. Hours are listed below; no hour is called abnormal.</p>`;
  }
  if (h.flagged === 0) return "";
  const worst = [...h.hours].filter((x) => x.isSpike).sort((a, b) => b.count - a.count)[0];
  return `<div class="banner spike-banner">
  <p class="banner-title">${h.flagged} hour${h.flagged === 1 ? "" : "s"} above the average. That is the incident.</p>
  <p>Worst: <strong>${escapeHtml(worst.key)}</strong> carried <strong>${worst.count}</strong> of ${h.countedRows} row(s) &mdash; ${(worst.share * 100).toFixed(1)}% of the export in one hour, ${escapeHtml(worst.rule ?? "")}.</p>
  <p class="banner-note">Mean ${h.meanPerHour.toFixed(1)} rows/hour over ${h.buckets} observed hour(s), population sigma ${h.sigma.toFixed(1)}. Flagged above ${h.spikeMultiple}x the mean.</p>
</div>`;
}

export function toBottleneckMarkdown(analysis: BottleneckAnalysis, title = "Bottleneck report"): string {
  const topCategory = analysis.categories[0];
  const topElapsed = analysis.categoriesByElapsed[0];
  const out: string[] = [`# ${mdCell(title)}`, ""];
  const vocab = analysis.vocabulary;

  out.push(`${analysis.totalRows} row(s) · ranked by **${mdCell(analysis.categoryColumn ?? "no credible column")}**`);
  if (analysis.mappings.some((m) => m.role === "status")) {
    out.push(`· ${analysis.errorRows} error(s) · error rate ${pct(analysis.errorRate)}`);
  } else {
    out.push("· no status column, so no error rate is claimed");
  }
  out.push("");

  if (topCategory !== undefined) {
    let lead = `**#1 by frequency:** ${mdCell(topCategory.key)} — ${topCategory.count} ${vocab.unitPlural}${vocab.thresholdLabel === null ? "" : `, ${topCategory.breachCount} ${vocab.thresholdLabel}`}, rows ${mdRows(topCategory.rows)}.`;
    if (topElapsed !== undefined && topElapsed.key !== topCategory.key) {
      lead += ` **#1 by total elapsed:** ${mdCell(topElapsed.key)} (${topElapsed.totalElapsed?.toLocaleString() ?? "not measurable"}).`;
    }
    out.push(`> ${lead}`, "");
  }

  // The divergence is the HEADLINE, and it leads. Same D2 guard as the HTML
  // banner: nothing is printed when the two orderings agree.
  const divergence = markdownDivergenceBanner(analysis);
  if (divergence !== "") out.push(divergence);

  if (analysis.mappings.length > 0 || analysis.missing.length > 0) {
    const verifiedCount = analysis.verifiedRoles?.length ?? 0;
    out.push("## How this report was read", "");
    out.push(analysis.schemaSource === "GENERIC"
      ? "_No stored schema matched this file, so every column reading below was **inferred** from the column names and from a statistical profile of the values. None of it has been checked by a person: treat it as a first reading, not a verified mapping._"
      : verifiedCount === 0
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

  out.push(mdCategoryTable(analysis.categories, `${vocab.headingUnit} categories by frequency`, "frequency", vocab));
  out.push(mdCategoryTable(analysis.categoriesByElapsed, `${vocab.headingUnit} categories by total elapsed time`, "total elapsed time", vocab));

  if (analysis.byHour.length > 0) {
    out.push(hourlyMarkdown(analysis));
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
    cwd: input.workspaceCwd, headers: input.csv.headers, rows: input.csv.rows, defaultsRoot: input.defaultsRoot,
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
  const lead = topCategory === undefined ? "" : `<p class="lead"><strong>#1 by frequency:</strong> ${escapeHtml(topCategory.key)} &mdash; ${topCategory.count} ${analysis.vocabulary.unitPlural}${analysis.vocabulary.thresholdLabel === null ? "" : `, ${topCategory.breachCount} ${escapeHtml(analysis.vocabulary.thresholdLabel)}`}, rows ${escapeHtml(cite(topCategory.rows))}.${topElapsed !== undefined && topElapsed.key !== topCategory.key ? ` <strong>#1 by total elapsed:</strong> ${escapeHtml(topElapsed.key)} (${topElapsed.totalElapsed?.toLocaleString()}).` : ""}</p>`;
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
  tr.spike { background: #fdf6f3; }
  tr.spike td { font-weight: 600; }
  .badge { display: inline-block; border: 1px solid #b23c17; color: #b23c17; padding: 0 .3rem; font-size: .7rem; font-weight: 700; letter-spacing: .04em; }
  .spike-banner { border-color: #b23c17; }
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
${categoryTable(analysis.categories, `${analysis.vocabulary.headingUnit} categories by frequency`, "frequency", analysis.vocabulary)}
${categoryTable(analysis.categoriesByElapsed, `${analysis.vocabulary.headingUnit} categories by total elapsed time`, "elapsed", analysis.vocabulary)}
${hourlyTable(analysis)}
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