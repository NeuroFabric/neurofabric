import path from "node:path";
import { startWedgeServer } from "../platform/web/server.ts";
import { makeTempWorkspace } from "../platform/test-support/temp-workspace.ts";

const cwd = await makeTempWorkspace("nf-v2ux-");
const lines = ["_time,category,amount_usd,latency_ms,total_bytes"];
for (let h = 0; h < 40; h++) {
  for (let i = 0; i < 5; i++) {
    lines.push(`2026-09-01T${String(h).padStart(2, "0")}:${String(i * 5).padStart(2, "0")}:00.000Z,` +
      `${i % 2 === 0 ? "web" : "ios"},${100 + i * 9},${20 + i},${5000 + i * 100}`);
  }
}
const { writeFixture } = await import("../platform/test-support/temp-workspace.ts");
await writeFixture(cwd, "sales.csv", lines.join("\n"));
const s = await startWedgeServer({ cwd, port: 0 });

const ask = async (m) => (await (await fetch(`${s.url}/api/chat`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: "sales.csv", message: m }),
})).json()).reply?.text;

for (const q of [
  "how many cost are over 500?",
  "what is the average of latancy?",
  "how many balnce are over 1000?",
  "how many amount_usd are over 500?",
  "how many rows are over 500?",
  "tell me a story about this file",
]) {
  console.log(`\nQ: ${q}`);
  console.log(`A: ${await ask(q)}`);
}
await s.close();
