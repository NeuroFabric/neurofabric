import fs from "node:fs";
import path from "node:path";
import { startWedgeServer } from "../platform/web/server.ts";
import { makeTempWorkspace } from "../platform/test-support/temp-workspace.ts";

const DIR = path.join(process.cwd(), "test-fixtures", "synthetic");
const FILES = ["e-commerce-transactions.csv", "service-mesh-access.csv", "financial-ledger.csv"];
const cwd = await makeTempWorkspace("nf-demo-v2-");
for (const f of FILES) fs.copyFileSync(path.join(DIR, f), path.join(cwd, f));
const s = await startWedgeServer({ cwd, port: 0 });

const payload = (html) => {
  const o = html.indexOf('type="application/json"');
  const f = html.indexOf(">", o) + 1;
  return JSON.parse(html.slice(f, html.indexOf("</script>", f)));
};

console.log("=== 1. TOP CATEGORIES (the previously-failing flagship) ===");
for (const f of FILES) {
  const r = await (await fetch(`${s.url}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: f, message: "What are the top categories?" }),
  })).json();
  console.log(`\n${f}`);
  console.log(`  ${String(r.reply?.text).slice(0, 230)}`);
}

console.log("\n\n=== 2. FORECAST (previously refused on 2 of 3) ===");
for (const f of FILES) {
  const p = payload(await (await fetch(`${s.url}/api/dashboard?path=${encodeURIComponent(f)}`)).text());
  const fc = p.forecast ?? {};
  console.log(`\n${f}`);
  console.log(`  ok=${fc.ok}  points=${fc.points?.length ?? 0}`);
  console.log(`  ${String(fc.ok ? fc.explanation : fc.reason).slice(0, 220)}`);
}

console.log("\n\n=== 3. THE OTHER QUERIES STILL WORK ===");
for (const [f, q] of [
  ["e-commerce-transactions.csv", "what is wrong with this file?"],
  ["e-commerce-transactions.csv", "show me the busiest hour"],
  ["e-commerce-transactions.csv", "how many order_value_usd are over 1000?"],
  ["service-mesh-access.csv", "which column has the most missing values?"],
  ["financial-ledger.csv", "what is the average amount_usd?"],
]) {
  const r = await (await fetch(`${s.url}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: f, message: q }),
  })).json();
  console.log(`\n"${q}"`);
  console.log(`  ${String(r.reply?.text).slice(0, 200)}`);
}

await s.close();
