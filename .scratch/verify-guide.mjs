import fs from "node:fs";
import path from "node:path";
import { startWedgeServer } from "../platform/web/server.ts";
import { makeTempWorkspace } from "../platform/test-support/temp-workspace.ts";

const DIR = path.join(process.cwd(), "test-fixtures", "synthetic");
const FILE = "e-commerce-transactions.csv";
const cwd = await makeTempWorkspace("nf-v-");
fs.copyFileSync(path.join(DIR, FILE), path.join(cwd, FILE));
const s = await startWedgeServer({ cwd, port: 0 });

for (const q of ["how did you read the columns?", "what is wrong with this file?", "what is the average?"]) {
  const r = await (await fetch(`${s.url}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: FILE, message: q }),
  })).json();
  const t = r.reply?.text ?? r.failure?.reason;
  console.log(`Q: ${q}\n   kind=${r.reply?.kind}  ${String(t).slice(0, 200)}\n`);
}
await s.close();
