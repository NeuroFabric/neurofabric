import { readFileSync, writeFileSync } from "node:fs";

const FILE = "platform/web/react-report.ts";
let src = readFileSync(FILE, "utf8");

// --- 1. Remove the mangled module-level constant. ---------------------------
const constStart = src.indexOf("/**\n * THE COMPOSER, held as a constant so it can be spliced IN or left OUT.");
const constEnd = src.indexOf('const CHART_VERSION = "4.4.1";');
if (constStart < 0 || constEnd < constStart) throw new Error("constant block not found");
src = src.slice(0, constStart) + src.slice(constEnd);

// --- 2. Repair the APP return: one marker around the whole conditional. -----
const markerAt = src.indexOf("__COMPOSER__\n");
if (markerAt < 0) throw new Error("composer marker not found");

// The conditional runs from that marker to the line closing the App return.
const conditionalStart = markerAt + "__COMPOSER__\n".length;
const appEnd = src.indexOf("  );\n}\n\nReactDOM.createRoot", conditionalStart);
if (appEnd < 0) throw new Error("App return end not found");
const conditional = src.slice(conditionalStart, appEnd);

// Repair the splice: the whole conditional is kept when live, replaced when not.
const liveBranch = conditional
  // Drop the OFFLINE_NOTE placeholder left by the previous attempt.
  .replace("OFFLINE_NOTE", "")
  // Keep only the live half: everything up to the " : " that starts the note.
  .split("      : h(\"div\", { className: \"sticky bottom-0 border-t border-slate-200 bg-white\" },\n          h(\"p\", { className: \"mx-auto max-w-3xl px-4 py-3 text-xs text-slate-500\" },\n            \"This is a standalone report")[0];

src = src.slice(0, markerAt) + "__COMPOSER__\n" + src.slice(appEnd);

const oldSplice = src.match(/\.split\("__COMPOSER__"\)\.join\(live[\s\S]*?\)\n/);
if (oldSplice === null) throw new Error("composer splice not found");

src = src.replace(oldSplice[0], `.split("__COMPOSER__").join(live
      ? ${liveBranch.trim()}
      : h("div", { className: "sticky bottom-0 border-t border-slate-200 bg-white" },
          h("p", { className: "mx-auto max-w-3xl px-4 py-3 text-xs text-slate-500" },
            "This is a standalone export: it was generated as a file, not served, so it cannot be " +
            "queried or take corrections. The conversation above is preserved; the analysis it refers " +
            "to is fixed at export time.")
        ))
`);

writeFileSync(FILE, src, "utf8");
console.log("composer marker repaired");