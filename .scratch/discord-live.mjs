import { startWedgeServer } from "../platform/web/server.ts";
import { makeTempWorkspace, writeFixture } from "../platform/test-support/temp-workspace.ts";

const lines = ["_time,channel,amount_usd,latency_ms,total_bytes"];
for (let i = 0; i < 200; i++) {
  const x = 100 + ((i * 37) % 90);
  lines.push(`2026-09-01T${String(i % 24).padStart(2, "0")}:${String(Math.floor(i / 24)).padStart(2, "0")}:00.000Z,` +
    `ch${i % 2},${500 + (i % 40)},${x},${5000 + x * 10 + ((i * 13) % 40)}`);
}
lines[45] = "2026-09-01T21:45:00.000Z,ch1,533,1000,20";

const cwd = await makeTempWorkspace("nf-disc-");
await writeFixture(cwd, "sales.csv", lines.join("\n"));
const s = await startWedgeServer({ cwd, port: 0 });
const ask = async (m) => (await (await fetch(`${s.url}/api/chat`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: "sales.csv", message: m }),
})).json()).reply?.text;

for (const q of [
  "are there any complex anomalies?",
  "what is discordant?",
  "what is wrong with this file?",
  "what are the top categories",
  "show me the worst hour",
]) {
  console.log(`\nQ: ${q}\nA: ${await ask(q)}`);
}
await s.close();
