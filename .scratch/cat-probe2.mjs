import fs from "node:fs";
import path from "node:path";
import { startWedgeServer } from "../platform/web/server.ts";
import { makeTempWorkspace, writeFixture } from "../platform/test-support/temp-workspace.ts";

const lines = ["_time,channel,amount_usd,latency_ms"];
for (let h = 0; h < 30; h++) {
  for (let i = 0; i < 4; i++) {
    const ch = i % 2 === 0 ? "web" : "ios";
    lines.push(`2026-09-01T${String(h).padStart(2, "0")}:00:00.000Z,${ch},${100 + i * 7},${20 + i}`);
  }
}
const cwd = await makeTempWorkspace("nf-cat3-");
await writeFixture(cwd, "sales.csv", lines.join("\n"));
const s = await startWedgeServer({ cwd, port: 0 });

const post = async (p, body) => (await fetch(`${s.url}${p}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
})).json();
const ask = async (m) => (await post("/api/chat", { path: "sales.csv", message: m })).reply?.text;

const walk = (d, dep = 0) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (dep < 3) { console.log(`    DIR  ${path.relative(cwd, p)}`); walk(p, dep + 1); }
    } else if (e.name !== "sales.csv") {
      console.log(`    FILE ${path.relative(cwd, p)} :: ${fs.readFileSync(p, "utf8").slice(0, 200)}`);
    }
  }
};

console.log("1. BEFORE:", String(await ask("What are the top categories?")).slice(0, 100));
console.log("\n2. feedback:", (await post("/api/feedback", { path: "sales.csv", column: "channel", role: "category" })).status);
console.log("\n3. disk after feedback:");
walk(cwd);
console.log("\n4. AFTER :", String(await ask("What are the top categories?")).slice(0, 130));
await s.close();
