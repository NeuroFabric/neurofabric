import { profileGenericColumns, inferGenericRoles } from "../platform/conductor/schema-memory.ts";
import { analyseBottlenecks } from "../platform/conductor/bottlenecks.ts";

/**
 * Where is the boundary, and is it a ROW COUNT at all?
 * Sweep rows while holding the distinct-value shape constant, then sweep the
 * shape while holding rows constant. That distinguishes the two hypotheses.
 */
function build(rows, distinct) {
  const lines = ["_time,channel,amount_usd,latency_ms"];
  for (let i = 0; i < rows; i++) {
    const h = i % 24;
    const m = Math.floor((i / 24) % 60);
    lines.push(`2026-09-01T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z,` +
      `ch${i % distinct},${100 + (i % 50)},${20 + (i % 30)}`);
  }
  return lines.join("\n");
}

function resolve(csvText) {
  const parsed = csvText.split("\n");
  const headers = parsed[0].split(",");
  const rows = parsed.slice(1).filter(Boolean).map((l) =>
    Object.fromEntries(l.split(",").map((c, i) => [headers[i], c])));
  const profile = profileGenericColumns(headers, rows);
  const inferred = inferGenericRoles(profile);
  const csv = { path: "t.csv", headers, rowCount: rows.length, columns: [], sample: [], rows, problems: [] };
  const a = analyseBottlenecks(csv, undefined);
  return { inferred, categoryColumn: a.categoryColumn, categories: a.categories.length };
}

console.log("=== A: rows swept, 2 distinct values held constant ===");
for (const n of [50, 100, 120, 150, 180, 199, 200, 201, 250, 400]) {
  const r = resolve(build(n, 2));
  console.log(`rows=${String(n).padStart(4)}  inferred.category=${String(r.inferred.category).padEnd(10)} categoryColumn=${String(r.categoryColumn).padEnd(8)} categories=${r.categories}`);
}

console.log("\n=== B: rows held at 250, distinct values swept ===");
for (const d of [2, 3, 5, 10, 25, 60, 120, 250]) {
  const r = resolve(build(250, d));
  console.log(`distinct=${String(d).padStart(4)}  inferred.category=${String(r.inferred.category).padEnd(10)} categoryColumn=${String(r.categoryColumn).padEnd(8)} categories=${r.categories}`);
}
