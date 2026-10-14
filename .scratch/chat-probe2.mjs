import fs from "node:fs";
import path from "node:path";
import { startWedgeServer } from "../platform/web/server.ts";
import { makeTempWorkspace } from "../platform/test-support/temp-workspace.ts";

const DIR = path.join(process.cwd(), "test-fixtures", "synthetic");
const cwd = await makeTempWorkspace("nf-guide2-");
for (const f of ["e-commerce-transactions.csv", "financial-ledger.csv"]) {
  fs.copyFileSync(path.join(DIR, f), path.join(cwd, f));
}
const s = await startWedgeServer({ cwd, port: 0 });

const CASES = [
  ["e-commerce-transactions.csv", "What are the top categories?"],
  ["e-commerce-transactions.csv", "what is wrong with this file?"],
  ["e-commerce-transactions.csv", "what are the top channels?"],
  ["e-commerce-transactions.csv", "how many order_value_usd are over 1000?"],
  ["e-commerce-transactions.csv", "what is the average order_value_usd?"],
  ["financial-ledger.csv", "What are the top categories?"],
  ["financial-ledger.csv", "what is wrong with this file?"],
  ["financial-ledger.csv", "show me the worst hour"],
];

for (const [file, q] of CASES) {
  const res = await fetch(`${s.url}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: file, message: q }),
  });
  const j = await res.json();
  const r = j.reply ?? {};
  console.log(`${file}  |  "${q}"`);
  console.log(`   kind: ${r.kind}`);
  console.log(`   text: ${String(r.text).slice(0, 240)}`);
  console.log(`   suggestions: ${JSON.stringify(r.suggestions ?? [])}`);
  console.log();
}
await s.close();
