import { readFileSync, writeFileSync } from "node:fs";

const FILE = "platform/web/react-report.ts";
const lines = readFileSync(FILE, "utf8").split("\n");

// Two pairs of BarChart/LineChart ended up inside APP_SOURCE: the pre-pivot
// versions (which read D.ranking / D.timeline directly) and the widget versions
// the chat-first rewrite introduced. Both pairs are function DECLARATIONS in the
// same scope, so the later pair wins and the earlier pair is unreachable --
// dead code shipped to every browser, roughly 180 lines of it.
//
// The first pair starts at the first "function BarChart(props) {" and ends just
// before the second one.
const starts = [];
lines.forEach((l, i) => { if (l === "function BarChart(props) {") starts.push(i); });
if (starts.length !== 2) throw new Error("expected exactly two BarChart declarations, found " + starts.length);

const from = starts[0];
const to = starts[1];
console.log(`removing dead lines ${from + 1}..${to} (${to - from} lines)`);

// The blank line before the survivor is the separator; keep it.
lines.splice(from, to - from);

const src = lines.join("\n");

// Prove it: one BarChart, one LineChart.
const bar = (src.match(/^function BarChart\(props\) \{$/gm) ?? []).length;
const line = (src.match(/^function LineChart\(props\) \{$/gm) ?? []).length;
console.log(`after: BarChart=${bar} LineChart=${line}`);
if (bar !== 1 || line !== 1) throw new Error("removal did not leave exactly one of each");

writeFileSync(FILE, src, "utf8");