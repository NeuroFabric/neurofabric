import fs from "node:fs";
import path from "node:path";
import { startWedgeServer } from "../platform/web/server.ts";
import { makeTempWorkspace } from "../platform/test-support/temp-workspace.ts";

const DIR = path.join(process.cwd(), "test-fixtures", "synthetic");
const cwd = await makeTempWorkspace("nf-quote-");
for (const f of ["e-commerce-transactions.csv", "service-mesh-access.csv"]) {
  fs.copyFileSync(path.join(DIR, f), path.join(cwd, f));
}
const s = await startWedgeServer({ cwd, port: 0 });

const ask = async (file, message) => {
  const r = await (await fetch(`${s.url}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: file, message }),
  })).json();
  return r.reply?.text ?? r.failure?.reason;
};

for (const [file, q] of [
  ["service-mesh-access.csv", "show me the busiest hour"],
  ["service-mesh-access.csv", "what is the average latency_ms?"],
  ["service-mesh-access.csv", "how many latency_ms values exceed 1000?"],
  ["service-mesh-access.csv", "which column has the most missing values?"],
  ["e-commerce-transactions.csv", "what is wrong with this file?"],
  ["e-commerce-transactions.csv", "What are the top categories?"],
  ["e-commerce-transactions.csv", "how did you read the columns?"],
]) {
  console.log(`\nQ [${file}]: ${q}`);
  console.log(`A: ${await ask(file, q)}`);
}
await s.close();
