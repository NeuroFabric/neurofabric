import fs from "node:fs";
import path from "node:path";
import { startWedgeServer } from "../platform/web/server.ts";
import { makeTempWorkspace } from "../platform/test-support/temp-workspace.ts";

const DIR = path.join(process.cwd(), "test-fixtures", "synthetic");
const FILE = "e-commerce-transactions.csv";
const cwd = await makeTempWorkspace("nf-v2-");
fs.copyFileSync(path.join(DIR, FILE), path.join(cwd, FILE));
const s = await startWedgeServer({ cwd, port: 0 });

for (const q of [
  "what is the average?",
  "what is the mean?",
  "average",
  "average of banana?",
  "what is the average of order_value_usd",
  "mean of banana",
  "how many banana are over 5?",
  "how many order_value_usd are over 5?",
]) {
  const r = await (await fetch(`${s.url}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: FILE, message: q }),
  })).json();
  console.log(`Q: ${q}\n   ${String(r.reply?.text ?? r.failure?.reason).slice(0, 170)}\n`);
}
await s.close();
