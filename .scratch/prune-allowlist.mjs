/** ONE-OFF. Prunes the guard's allowlist down to entries that are genuinely shared. */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve("src");
const file = path.join(SRC, "css-collision-guard.test.ts");
const source = readFileSync(file, "utf8");

const start = source.indexOf("const SHARED_UTILITY_CLASSES");
const end = source.indexOf("]);", start);
if (start < 0 || end < 0) throw new Error("allowlist not found");

function componentFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...componentFiles(full));
    else if (entry.endsWith(".tsx") && !entry.includes(".test.")) out.push(full);
  }
  return out;
}

function classRoots(text) {
  const roots = new Set();
  for (const pattern of [/className=\{?"([a-z][a-z0-9_-]*)/g, /className=\{`([a-z][a-z0-9_-]*)/g]) {
    for (const m of text.matchAll(pattern)) {
      const root = (m[1] ?? "").split(/__|--/)[0];
      if (root) roots.add(root);
    }
  }
  return roots;
}

const claims = new Map();
for (const f of componentFiles(SRC)) {
  for (const root of classRoots(readFileSync(f, "utf8"))) {
    const list = claims.get(root) ?? [];
    list.push(f);
    claims.set(root, list);
  }
}

const current = source
  .slice(start, end)
  .split("\n")
  .map((line) => line.match(/^\s*"(?:[a-z][a-z0-9_-]*)",/))
  .filter(Boolean)
  .map((m) => m[0].match(/"([a-z][a-z0-9_-]*)"/)[1]);

const kept = [];
const dropped = [];
for (const name of current) {
  const files = claims.get(name);
  if (files !== undefined && files.length >= 2) kept.push(name);
  else dropped.push(`${name} (${files === undefined ? "unused" : `${files.length} file`})`);
}

const block = [
  "const SHARED_UTILITY_CLASSES: ReadonlySet<string> = new Set([",
  ...kept.map((n) => `  "${n}",`),
  "",
  "  // The first entry below was added by the guard CATCHING something: `topkeys`",
  "  // was claimed by both AlertCenter and LiveStreamView, which render the same",
  "  // data in the same presentation. Unlike the `.live` collision -- where a whole",
  "  // PANEL was captured by a rule meant for a strip -- this is a leaf style with no",
  "  // layout rules, so it cannot capture anything. Splitting the CSS would",
  "  // duplicate a rule for no behavioural difference.",
  '  "topkeys",',
  "]);",
].join("\n");

writeFileSync(file, source.slice(0, start) + block + source.slice(end + 3));
console.log("KEPT:", kept.join(", "));
console.log("DROPPED (not genuinely shared):", dropped.join(", ") || "none");