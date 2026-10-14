import path from "node:path";
import { profileGenericColumns, inferGenericRoles, resolveSchemaMemory } from "../platform/conductor/schema-memory.ts";
import { analyseBottlenecks } from "../platform/conductor/bottlenecks.ts";
import { makeTempWorkspace } from "../platform/test-support/temp-workspace.ts";

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

const defaultsRoot = path.resolve(process.cwd(), "configs");

async function resolveAll(csvText) {
  const parsed = csvText.split("\n");
  const headers = parsed[0].split(",");
  const rows = parsed.slice(1).filter(Boolean).map((l) =>
    Object.fromEntries(l.split(",").map((c, i) => [headers[i], c])));
  const csv = { path: "t.csv", headers, rowCount: rows.length, columns: [], sample: [], rows, problems: [] };

  const cwd = await makeTempWorkspace("nf-b-");
  const schema = await resolveSchemaMemory({ cwd, headers, rows, defaultsRoot });
  const a = analyseBottlenecks(csv, schema);
  return {
    schemaRoles: schema === undefined ? "UNDEFINED" : JSON.stringify(schema.roles),
    source: schema?.source ?? "-",
    categoryColumn: a.categoryColumn,
    categories: a.categories.length,
    rows,
  };
}

console.log("=== the REAL server path: resolveSchemaMemory -> analyseBottlenecks ===");
for (const n of [50, 100, 120, 150, 199, 200, 201, 250, 400]) {
  const r = await resolveAll(build(n, 2));
  console.log(`rows=${String(n).padStart(4)} src=${String(r.source).padEnd(14)} cat=${String(r.categoryColumn).padEnd(8)} n=${r.categories}  ${r.schemaRoles}`);
}
