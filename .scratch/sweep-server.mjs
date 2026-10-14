import { startWedgeServer } from "../platform/web/server.ts";
import { makeTempWorkspace, writeFixture } from "../platform/test-support/temp-workspace.ts";

function build(rows) {
  const lines = ["_time,channel,amount_usd,latency_ms"];
  for (let i = 0; i < rows; i++) {
    const h = i % 24;
    const m = Math.floor((i / 24) % 60);
    lines.push(`2026-09-01T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z,` +
      `${i % 2 === 0 ? "web" : "ios"},${100 + (i % 50)},${20 + (i % 30)}`);
  }
  return lines.join("\n");
}

for (const n of [120, 200, 250, 400]) {
  const cwd = await makeTempWorkspace("nf-c-");
  await writeFixture(cwd, "sales.csv", build(n));
  const s = await startWedgeServer({ cwd, port: 0 });
  const r = await (await fetch(`${s.url}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "sales.csv", message: "what are the top categories" }),
  })).json();
  console.log(`rows=${String(n).padStart(4)}  ${String(r.reply?.text).slice(0, 95)}`);
  await s.close();
}
