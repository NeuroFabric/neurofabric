import fs from "node:fs";
import path from "node:path";
import { startWedgeServer } from "../platform/web/server.ts";
import { makeTempWorkspace } from "../platform/test-support/temp-workspace.ts";

const DIR = path.join(process.cwd(), "test-fixtures", "synthetic");
const FILES = ["e-commerce-transactions.csv", "service-mesh-access.csv", "financial-ledger.csv"];
const cwd = await makeTempWorkspace("nf-guide4-");
for (const f of FILES) fs.copyFileSync(path.join(DIR, f), path.join(cwd, f));
const s = await startWedgeServer({ cwd, port: 0 });

const payload = (html) => {
  const o = html.indexOf('type="application/json"');
  const f = html.indexOf(">", o) + 1;
  return JSON.parse(html.slice(f, html.indexOf("</script>", f)));
};

console.log("=== FORECAST, per demo file ===");
for (const f of FILES) {
  const html = await (await fetch(`${s.url}/api/dashboard?path=${encodeURIComponent(f)}`)).text();
  const p = payload(html);
  const fc = p.forecast ?? {};
  console.log(`\n${f}`);
  console.log(`  ok       : ${fc.ok}`);
  console.log(`  method   : ${fc.method}`);
  console.log(`  points   : ${Array.isArray(fc.points) ? fc.points.length : 0}`);
  console.log(`  reason   : ${String(fc.reason ?? "(none)").slice(0, 170)}`);
  if (fc.ok) console.log(`  explain  : ${String(fc.explanation).slice(0, 200)}`);
}

console.log("\n\n=== EXPORT, end to end ===");
const thread = [
  { role: "agent", text: "I read 6,386 rows (e-commerce-transactions.csv). This file looks like order data.", widgets: [], suggestions: [] },
  { role: "user", text: "what is wrong with this file?", widgets: [], suggestions: [] },
  { role: "agent", text: "1 severe finding: order_value_usd 250,000 against a fence of 156.", widgets: [], suggestions: [] },
];
const ex = await fetch(`${s.url}/api/export`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: "e-commerce-transactions.csv", thread }),
});
const text = await ex.text();
console.log(`  status        : ${ex.status}`);
console.log(`  content-type  : ${ex.headers.get("content-type")}`);
console.log(`  disposition   : ${ex.headers.get("content-disposition")}`);
console.log(`  bytes         : ${text.length}`);
const p = payload(text);
console.log(`  source        : ${JSON.stringify(p.source)}`);
console.log(`  live          : ${p.live}`);
console.log(`  transcript    : ${Array.isArray(p.transcript) ? p.transcript.length + " turns" : "ABSENT"}`);
console.log(`  forecast ok   : ${p.forecast?.ok}`);
const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(text)?.[1] ?? "";
console.log(`  csp           : ${csp.replace(/script-src[^;]*;?/, "script-src...;").replace(/style-src[^;]*;?/, "")}`);
const o = text.indexOf('<script type="text/babel"');
const bb = text.slice(text.indexOf(">", o) + 1, text.indexOf("</script>", o));
console.log(`  contains /api/chat     : ${text.includes("/api/chat")}`);
console.log(`  contains composer      : ${text.includes("Ask a question")}`);
console.log(`  fetch() targets        : ${JSON.stringify([...new Set([...bb.matchAll(/fetch\s*\(\s*"([^"]*)"/g)].map((m) => m[1]))])}`);

console.log("\n  path boundary on export:");
const evil = await fetch(`${s.url}/api/export`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: "../../../etc/passwd", thread: [] }),
});
console.log(`    status ${evil.status}  ${JSON.stringify((await evil.json()).failure?.code)}`);

await s.close();
