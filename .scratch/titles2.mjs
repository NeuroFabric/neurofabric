import { readFileSync, writeFileSync } from "node:fs";

const FILE = "platform/web/server.ts";
let src = readFileSync(FILE, "utf8");

// Every one of these four sites is an argument to `conductor.run(...)`, and
// `result` does not exist until that call returns. Referencing the analysis
// there is a use-before-declaration, which is exactly the kind of thing a title
// helper makes easy to write by accident.
//
// So the run options get the filename-only title -- the purpose is not knowable
// yet, and pretending otherwise would be the same mistake the old hardcoded
// title made. The title handed to the DASHBOARD, which is built after the run,
// does use the real purpose, because by then the engine has read the file.
src = src.replace(
  /title: titleFor\(\{ fileName: path\.basename\(target\), purpose: result\.report\?\.analysis\.purpose \?\? UNKNOWN_PURPOSE \}\),/g,
  "title: titleFor({ fileName: path.basename(target), purpose: UNKNOWN_PURPOSE }),",
);

// Now upgrade the DASHBOARD call sites, which genuinely run after the analysis.
const RUNS = [
  'const html = toReactDashboard(result.report.analysis, {\n            title: titleFor({ fileName: path.basename(target), purpose: UNKNOWN_PURPOSE }),',
];
for (const anchor of RUNS) {
  if (src.includes(anchor)) {
    src = src.replace(anchor, anchor.replace("purpose: UNKNOWN_PURPOSE", "purpose: result.report.analysis.purpose"));
  }
}

writeFileSync(FILE, src, "utf8");

const stillUnknown = (src.match(/purpose: UNKNOWN_PURPOSE/g) ?? []).length;
const real = (src.match(/purpose: result\.report\.analysis\.purpose/g) ?? []).length;
console.log("filename-only sites:", stillUnknown, " purpose-aware sites:", real);