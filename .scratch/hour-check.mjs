import fs from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "test-fixtures", "synthetic");
const FILE = "e-commerce-transactions.csv";
const text = fs.readFileSync(path.join(DIR, FILE), "utf8");
const lines = text.split("\n").filter(Boolean);

const counts = new Map();
for (const l of lines.slice(1)) {
  const h = l.split(",")[0].slice(0, 13);
  counts.set(h, (counts.get(h) ?? 0) + 1);
}

console.log("rows in file hour 2026-09-19T02 :", counts.get("2026-09-19T02") ?? "ABSENT");
console.log("rows in file hour 2026-09-18T20 :", counts.get("2026-09-18T20") ?? "ABSENT");
console.log("total distinct hours            :", counts.size);

// The hour the ENGINE called the gap, mapped back through the observed -6h shift.
const shifted = "2026-09-19T02";
console.log(`\nneighbourhood of ${shifted}:`);
const sorted = [...counts.keys()].sort();
const i = sorted.indexOf(shifted);
for (let k = Math.max(0, i - 3); k <= Math.min(sorted.length - 1, i + 3); k++) {
  console.log(`  ${sorted[k]}  rows=${counts.get(sorted[k])}`);
}

// Distribution of per-hour counts, to see how sparse the quiet hours get.
const vals = [...counts.values()].sort((a, b) => a - b);
console.log(`\nper-hour rows: min=${vals[0]} p10=${vals[Math.floor(vals.length * 0.1)]} median=${vals[Math.floor(vals.length / 2)]} max=${vals[vals.length - 1]}`);
console.log(`hours with only 1 row: ${vals.filter((v) => v === 1).length}`);

// Any duplicate hour labels / malformed timestamps?
const bad = lines.slice(1).filter((l) => !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3},/.test(l));
console.log(`rows not matching the expected timestamp shape: ${bad.length}`);
if (bad.length) console.log(`  first: ${bad[0]}`);
