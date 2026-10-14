import fs from "node:fs";
import path from "node:path";
import { startWedgeServer } from "../platform/web/server.ts";
import { makeTempWorkspace } from "../platform/test-support/temp-workspace.ts";

const DIR = path.join(process.cwd(), "test-fixtures", "synthetic");
const FILES = ["e-commerce-transactions.csv", "service-mesh-access.csv", "financial-ledger.csv"];

const cwd = await makeTempWorkspace("nf-demo-");
for (const f of FILES) {
  const dest = path.join(cwd, f);
  fs.copyFileSync(path.join(DIR, f), dest);

}
const s = await startWedgeServer({ cwd, port: 0 });

let ok = true;
for (const f of FILES) {
  console.log(`\n=== ${f} ===`);
  const res = await fetch(`${s.url}/api/dashboard?path=${encodeURIComponent(f)}`);
  console.log(`  HTTP ${res.status}`);
  if (res.status !== 200) { ok = false; console.log("  FAIL: dashboard refused"); continue; }
  const html = await res.text();

  const o = html.indexOf('type="application/json"');
  const f2 = html.indexOf(">", o) + 1;
  const p = JSON.parse(html.slice(f2, html.indexOf("</script>", f2)));

  console.log(`  title      : ${p.title}`);
  console.log(`  rows       : ${p.totalRows}`);
  console.log(`  numeric cols: ${p.columns.map((c) => c.name).join(", ")}`);
  console.log(`  timeline   : ${Array.isArray(p.timeline) ? p.timeline.length : 0} buckets`);
  console.log(`  anomalies  : ${p.anomalies.length}`);
  console.log(`  forecast   : ${p.forecast ? "present" : "null"}`);
  console.log(`  purpose    : ${String(p.purpose).slice(0, 110)}`);
  for (const a of p.anomalies.slice(0, 3)) console.log(`    - [${a.severity}] ${a.column}: ${String(a.note ?? a.message ?? "").slice(0, 80)}`);

  if (p.totalRows < 1000) { ok = false; console.log("  FAIL: too few rows parsed"); }
  if (p.columns.length < 2) { ok = false; console.log("  FAIL: too few NUMERICAL columns parsed"); }
}

await s.close();
console.log(`\n${ok ? "ALL THREE FILES ARE READABLE BY THE PRODUCT" : "SOME FILES FAILED TO ANALYSE"}`);
if (!ok) process.exitCode = 1;
