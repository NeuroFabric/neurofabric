import fs from "node:fs";
import path from "node:path";
import { startWedgeServer } from "../platform/web/server.ts";
import { makeTempWorkspace } from "../platform/test-support/temp-workspace.ts";

const DIR = path.join(process.cwd(), "test-fixtures", "synthetic");
const FILE = "e-commerce-transactions.csv";
const cwd = await makeTempWorkspace("nf-cat-");
fs.copyFileSync(path.join(DIR, FILE), path.join(cwd, FILE));
const s = await startWedgeServer({ cwd, port: 0 });

const post = async (p, body) => (await fetch(`${s.url}${p}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
})).json();

const ask = async (m) => (await post("/api/chat", { path: FILE, message: m })).reply?.text;

console.log("1. before:", String(await ask("What are the top categories?")).slice(0, 110));

console.log("\n2. storing the mapping channel -> category via /api/feedback");
console.log("   ", JSON.stringify(await post("/api/feedback", { path: FILE, column: "channel", role: "category" })).slice(0, 200));

console.log("\n3. after :", String(await ask("What are the top categories?")).slice(0, 160));

console.log("\n4. what is on disk?");
const walk = (d, depth = 0) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === "e-commerce-transactions.csv") continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1); }
    else console.log(`   ${path.relative(cwd, p)}  ${fs.statSync(p).size}b`);
  }
};
walk(cwd);
await s.close();
