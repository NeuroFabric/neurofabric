import fs from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "test-fixtures", "synthetic");
const text = fs.readFileSync(path.join(DIR, "financial-ledger.csv"), "utf8");
const lines = text.split("\n").filter(Boolean);
const header = lines[0].split(",");
const i = header.indexOf("category");
const vals = lines.slice(1).map((l) => l.split(",")[i]);
const set = new Set(vals);
console.log("header:", header.join(" | "));
console.log("category index:", i);
console.log("distinct values in the file:", set.size);
console.log("first 5 values:", vals.slice(0, 5));
const counts = new Map();
for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
console.log("top 6 by count:", [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6));
