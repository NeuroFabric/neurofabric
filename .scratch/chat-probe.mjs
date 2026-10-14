import fs from "node:fs";
import path from "node:path";
import { startWedgeServer } from "../platform/web/server.ts";
import { makeTempWorkspace } from "../platform/test-support/temp-workspace.ts";

const DIR = path.join(process.cwd(), "test-fixtures", "synthetic");
const FILE = "service-mesh-access.csv";
const cwd = await makeTempWorkspace("nf-guide-");
fs.copyFileSync(path.join(DIR, FILE), path.join(cwd, FILE));
const s = await startWedgeServer({ cwd, port: 0 });

const QUESTIONS = [
  // The directive's own examples.
  "What are the top categories?",
  "col_15 is the duration",
  // Intent 1: worst hour.
  "What was the worst hour?",
  "show me the busiest hour",
  "what is the peak time",
  // Intent 2: most missing.
  "which column has the most missing values?",
  "which column has the most blanks?",
  // Intent 3: mean.
  "what is the average latency_ms?",
  "mean of request_bytes",
  // Intent 4: threshold counts.
  "how many rows are over 1000?",
  "how many rows are below 50?",
  "how many rows are at least 200?",
  "how many latency_ms values exceed 1000?",
  // Refusals / unanswerable.
  "how many rows are over banana?",
  "how many rows are over 5000?",
  "tell me a story about this file",
];

console.log(`FILE: ${FILE}\n`);
for (const q of QUESTIONS) {
  const res = await fetch(`${s.url}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: FILE, message: q }),
  });
  const j = await res.json();
  if (j.status === "FAILED") {
    console.log(`[${res.status}] "${q}"\n     FAILED: ${j.failure?.reason}\n`);
    continue;
  }
  const turns = j.turns ?? j.messages ?? [];
  const last = turns[turns.length - 1];
  const answer = last === undefined ? JSON.stringify(j) : (typeof last === "string" ? last : (last.text ?? JSON.stringify(last)));
  console.log(`Q: ${q}`);
  console.log(`A: ${answer.slice(0, 300)}`);
  console.log(`   keys: ${Object.keys(j).join(", ")}\n`);
}
await s.close();
