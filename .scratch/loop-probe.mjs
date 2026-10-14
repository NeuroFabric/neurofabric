import fs from "node:fs";
import path from "node:path";
import { startWedgeServer } from "../platform/web/server.ts";
import { makeTempWorkspace } from "../platform/test-support/temp-workspace.ts";

const DIR = path.join(process.cwd(), "test-fixtures", "synthetic");
const FILE = "e-commerce-transactions.csv";
const cwd = await makeTempWorkspace("nf-guide3-");
fs.copyFileSync(path.join(DIR, FILE), path.join(cwd, FILE));
const s = await startWedgeServer({ cwd, port: 0 });

const ask = async (message) => {
  const res = await fetch(`${s.url}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: FILE, message }),
  });
  const j = await res.json();
  return j.reply ?? j.failure;
};

console.log("STEP 1: ask before any correction");
let r = await ask("What are the top categories?");
console.log("  " + String(r.text).slice(0, 150) + "\n");

console.log("STEP 2: correct the column -- 'channel is the category'");
r = await ask("channel is the category");
console.log(`  kind=${r.kind}  text=${String(r.text).slice(0, 200)}\n`);

console.log("STEP 3: ask the same question again");
r = await ask("What are the top categories?");
console.log(`  kind=${r.kind}`);
console.log(`  text: ${String(r.text).slice(0, 320)}`);
console.log(`  widgets: ${JSON.stringify(r.widgets ?? []).slice(0, 200)}\n`);

console.log("STEP 4: is the correction remembered on disk?");
const learned = fs.existsSync(path.join(cwd, ".neurofebric", "schema-memory.json"))
  ? fs.readFileSync(path.join(cwd, ".neurofebric", "schema-memory.json"), "utf8")
  : "(no schema-memory.json at that path)";
console.log("  " + String(learned).slice(0, 300));

console.log("\nSTEP 5: forecast in the dashboard payload");
const html = await (await fetch(`${s.url}/api/dashboard?path=${encodeURIComponent(FILE)}`)).text();
const o = html.indexOf('type="application/json"');
const f = html.indexOf(">", o) + 1;
const p = JSON.parse(html.slice(f, html.indexOf("</script>", f)));
console.log(`  forecast: ${JSON.stringify(p.forecast).slice(0, 400)}`);
console.log(`  purpose : ${String(p.purpose).slice(0, 160)}`);

await s.close();
