import { startWedgeServer } from "../platform/web/server.ts";
import { makeTempWorkspace, writeFixture } from "../platform/test-support/temp-workspace.ts";

const lines = ["_time,channel,amount_usd,latency_ms"];
for (let h = 0; h < 40; h++) {
  for (let i = 0; i < 5; i++) {
    lines.push(`2026-09-01T${String(h).padStart(2, "0")}:${String(i * 5).padStart(2, "0")}:00.000Z,` +
      `${i % 2 === 0 ? "web" : "ios"},${100 + i * 9},${20 + i}`);
  }
}
const cwd = await makeTempWorkspace("nf-t-");
await writeFixture(cwd, "sales.csv", lines.join("\n"));
const s = await startWedgeServer({ cwd, port: 0 });
const post = async (r, b) => (await fetch(`${s.url}${r}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
})).json();
const ask = async (m) => (await post("/api/chat", { path: "sales.csv", message: m })).reply?.text;

console.log("rows:", lines.length - 1);
console.log("BEFORE:", String(await ask("what are the top categories")).slice(0, 120));
console.log("\nfeedback:", (await post("/api/feedback", { path: "sales.csv", column: "channel", role: "category" })).status);
console.log("AFTER :", String(await ask("what are the top categories")).slice(0, 120));
await s.close();
