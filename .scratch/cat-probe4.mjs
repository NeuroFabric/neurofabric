import fs from "node:fs";
import path from "node:path";
import { startWedgeServer } from "../platform/web/server.ts";
import { makeTempWorkspace, writeFixture } from "../platform/test-support/temp-workspace.ts";

const lines = ["_time,channel,amount_usd,latency_ms"];
for (let h = 0; h < 30; h++) {
  for (let i = 0; i < 4; i++) {
    lines.push(`2026-09-01T${String(h).padStart(2, "0")}:00:00.000Z,${i % 2 === 0 ? "web" : "ios"},${100 + i * 7},${20 + i}`);
  }
}
const cwd = await makeTempWorkspace("nf-c4-");
await writeFixture(cwd, "sales.csv", lines.join("\n"));
const s = await startWedgeServer({ cwd, port: 0 });
const post = async (p, b) => (await fetch(`${s.url}${p}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
})).json();
const ask = async (m) => (await post("/api/chat", { path: "sales.csv", message: m })).reply?.text;

console.log("BEFORE :", String(await ask("what are the top categories")).slice(0, 90));
await post("/api/feedback", { path: "sales.csv", column: "channel", role: "category" });
console.log("ARCHIVE:", fs.readFileSync(path.join(cwd, ".session-archive", "schema-memory.json"), "utf8").replace(/\s+/g, " "));
console.log("\nREADING:", String(await ask("how did you read the columns?")).slice(0, 600));
console.log("\nAFTER  :", String(await ask("what are the top categories")).slice(0, 130));
await s.close();
