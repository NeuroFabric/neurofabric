import { readFileSync, writeFileSync } from "node:fs";

const FILE = "platform/web/server.ts";
let src = readFileSync(FILE, "utf8");
const before = src;

// The replacement carries NO backticks. A template literal in this script would
// terminate on the template literal in the replacement -- which is the third
// time in this codebase that a backtick inside a spliced string has cost a
// cycle, and the reason it keeps happening is that backticks are the natural
// quoting for a TypeScript template and so they get written inside other
// strings without a second thought.
const NOTE = [
  "// ONE TITLE, FROM THE ENGINE'S OWN READING OF THE FILE.",
  "// titleFor names the FILE, which is always true; the purpose travels",
  "// separately, in the greeting, as a hypothesis with its evidence.",
].join("\n            ");

const pattern = /title: `Bottleneck report: \$\{path\.basename\(target\)\}`,/g;
const matches = src.match(pattern) ?? [];
if (matches.length === 0) throw new Error("no title sites found");

src = src.replace(
  pattern,
  NOTE + "\n            title: titleFor({ fileName: path.basename(target), purpose: result.report?.analysis.purpose ?? UNKNOWN_PURPOSE }),",
);

if (src.includes("Bottleneck report: ")) throw new Error("a title site survived");
if (src === before) throw new Error("nothing changed");

// The import, and a shared fallback so titleFor is total.
src = src.replace(
  'import { applyFeedback } from "./feedback.ts";',
  'import { applyFeedback } from "./feedback.ts";\nimport { titleFor, type Purpose } from "../conductor/semantics.ts";',
);

const FALLBACK = [
  "/**",
  " * What the title helper falls back to before an analysis exists.",
  " *",
  " * A `Purpose` of \"unknown\" is the honest default, and it is used because",
  " * some call sites need a title BEFORE the kernel has run: the file name is",
  " * known and nothing else is. Building a Purpose-shaped value rather than",
  " * passing undefined keeps `titleFor` total, because a helper that can be",
  " * called in the wrong order is a helper that eventually will be.",
  " */",
  "const UNKNOWN_PURPOSE: Purpose = {",
  '  kind: "unknown",',
  '  statement: "This file has not been read yet.",',
  '  confidence: "none",',
  "  evidence: [],",
  "  columns: [],",
  "};",
  "",
  "export interface WedgeOptions {",
].join("\n");

src = src.replace("export interface WedgeOptions {", FALLBACK);

writeFileSync(FILE, src, "utf8");
console.log("replaced", matches.length, "title sites");