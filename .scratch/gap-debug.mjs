import fs from "node:fs";
import path from "node:path";
import { startWedgeServer } from "../platform/web/server.ts";
import { makeTempWorkspace } from "../platform/test-support/temp-workspace.ts";

const DIR = path.join(process.cwd(), "test-fixtures", "synthetic");
const FILE = "e-commerce-transactions.csv";
const cwd = await makeTempWorkspace("nf-dbg-");
fs.copyFileSync(path.join(DIR, FILE), path.join(cwd, FILE));
const s = await startWedgeServer({ cwd, port: 0 });

const html = await (await fetch(`${s.url}/api/dashboard?path=${encodeURIComponent(FILE)}`)).text();
const o = html.indexOf('type="application/json"');
const f = html.indexOf(">", o) + 1;
const p = JSON.parse(html.slice(f, html.indexOf("</script>", f)));

// What the FILE actually contains, hour by hour.
const text = fs.readFileSync(path.join(cwd, FILE), "utf8");
const fileHours = new Map();
for (const line of text.split("\n").slice(1)) {
  if (!line) continue;
  const h = line.split(",")[0].slice(0, 13);
  fileHours.set(h, (fileHours.get(h) ?? 0) + 1);
}
const fileSorted = [...fileHours.keys()].sort();

// What the ENGINE believes the timeline is.
const engHours = p.timeline.map((t) => t.hour);

console.log(`file distinct hours : ${fileSorted.length}`);
console.log(`file first / last   : ${fileSorted[0]} .. ${fileSorted[fileSorted.length - 1]}`);
console.log(`engine timeline len : ${engHours.length}`);
console.log(`engine first / last : ${engHours[0]} .. ${engHours[engHours.length - 1]}`);

// Where do they disagree?
const fileSet = new Set(fileSorted);
const engSet = new Set(engHours);
const inFileNotEngine = fileSorted.filter((h) => !engSet.has(h));
const inEngineNotFile = engHours.filter((h) => !fileSet.has(h));
console.log(`\nhours in FILE but not in engine timeline: ${inFileNotEngine.length}`);
console.log(`  ${inFileNotEngine.slice(0, 8).join(", ")}`);
console.log(`hours in ENGINE but not in file        : ${inEngineNotFile.length}`);
console.log(`  ${inEngineNotFile.slice(0, 8).join(", ")}`);

// Gaps in the engine's own timeline.
const engIdx = engHours.map((h) => new Date(`${h}:00:00.000Z`).getTime() / 3_600_000).sort((a, b) => a - b);
const gaps = [];
for (let i = 1; i < engIdx.length; i++) {
  if (engIdx[i] - engIdx[i - 1] !== 1) {
    gaps.push(`${new Date(engIdx[i - 1] * 3_600_000).toISOString().slice(0, 13)} -> ${new Date(engIdx[i] * 3_600_000).toISOString().slice(0, 13)}`);
  }
}
console.log(`\ngaps in the ENGINE timeline: ${gaps.length}`);
console.log(`  ${gaps.slice(0, 10).join("\n  ")}`);

await s.close();
