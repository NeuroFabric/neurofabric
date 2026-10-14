import fs from "node:fs";
import path from "node:path";
import { resolveSchemaMemory } from "../platform/conductor/schema-memory.ts";
import { analyseBottlenecks } from "../platform/conductor/bottlenecks.ts";
import { parseCsv } from "../platform/conductor/capabilities.ts";
import { makeTempWorkspace, writeFixture } from "../platform/test-support/temp-workspace.ts";

const lines = ["_time,channel,amount_usd,latency_ms"];
for (let h = 0; h < 30; h++) {
  for (let i = 0; i < 4; i++) {
    lines.push(`2026-09-01T${String(h).padStart(2, "0")}:00:00.000Z,${i % 2 === 0 ? "web" : "ios"},${100 + i * 7},${20 + i}`);
  }
}
const cwd = await makeTempWorkspace("nf-iso-");
await writeFixture(cwd, "sales.csv", lines.join("\n"));

// Write the archive exactly as feedback.ts does.
fs.mkdirSync(path.join(cwd, ".session-archive"), { recursive: true });
fs.writeFileSync(
  path.join(cwd, ".session-archive", "schema-memory.json"),
  JSON.stringify([{ id: "user-corrections", roles: { category: "channel" } }], null, 2),
  "utf8",
);

const file = path.join(cwd, "sales.csv");
const parsed0 = parseCsv(fs.readFileSync(file, "utf8"));
const csv = { path: file, headers: parsed0.headers, rowCount: parsed0.rows.length, columns: [], sample: [], rows: parsed0.rows.map((c) => Object.fromEntries(parsed0.headers.map((h, i) => [h, c[i] ?? ""]))), problems: parsed0.problems };
console.log("headers:", csv.headers.join(", "));
console.log("rows:", csv.rows.length);

const rows = csv.rows;
const schema = await resolveSchemaMemory({ cwd, headers: csv.headers, rows, defaultsRoot: path.resolve(process.cwd(), "configs") });
console.log("\nresolved schema:", schema === undefined ? "UNDEFINED" : JSON.stringify({ id: schema.id, roles: schema.roles, source: schema.source, learnedRoles: schema.learnedRoles }));

const a = analyseBottlenecks(csv, schema);
console.log("\ncategoryColumn :", a.categoryColumn);
console.log("categories     :", a.categories.map((c) => `${c.key}=${c.count}`).join(", "));
console.log("ranking        :", a.categoriesByElapsed.map((c) => `${c.key}=${c.count}`).join(", "));
