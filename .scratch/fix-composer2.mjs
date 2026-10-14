import { readFileSync, writeFileSync } from "node:fs";

const FILE = "platform/web/react-report.ts";
let src = readFileSync(FILE, "utf8");

const from = src.indexOf('.split("__COMPOSER__").join(live');
const to = src.indexOf("// THE ENDPOINTS ARE SPLICED");
if (from < 0 || to < 0 || to < from) throw new Error("bounds not found");

// The splice runs at GENERATION time, in Node, where `h` does not exist -- it is
// declared inside the browser source. So the spliced value must be SOURCE TEXT,
// not a live expression. Two String.raw constants, spliced in.
const repaired = [
  '.split("__COMPOSER__").join(live ? COMPOSER_SOURCE : OFFLINE_SOURCE)',
  '    ',
  '',
].join("\n");

src = src.slice(0, from) + repaired + src.slice(to);

// The two fragments, as text.
const constants = [
  "/**",
  " * THE COMPOSER AND ITS OFFLINE REPLACEMENT, AS TEXT.",
  " *",
  " * Both are spliced into the browser source at generation time, so they must be",
  " * strings rather than expressions: `h` is declared INSIDE the emitted source and",
  " * does not exist in this module. Building them here also means an offline",
  " * artifact does not merely HIDE the composer -- it does not contain it, which",
  " * is what an export needs. An export gets emailed and opened by people with no",
  " * server, so what the document contains matters as much as what it shows.",
  " */",
  "const COMPOSER_SOURCE = String.raw`",
  'h("div", { className: "sticky bottom-0 border-t border-slate-200 bg-white" },',
  '  h("form", {',
  '    className: "mx-auto max-w-3xl px-4 py-3 flex gap-2",',
  '    onSubmit: function (e) { e.preventDefault(); ask(); }',
  "  },",
  '    h("input", {',
  '      type: "text",',
  "      value: text,",
  '      placeholder: "Ask about this file, or say \\u201ccol_1 is the duration\\u201d",',
  '      "aria-label": "Ask a question, or correct a column",',
  '      onChange: function (e) { setText(e.target.value); }',
  "    }),",
  '    h("button", { type: "submit", disabled: busy }, busy ? "..." : "Ask")',
  "  )",
  ")",
  "`;",
  "",
  "const OFFLINE_SOURCE = String.raw`",
  'h("div", { className: "sticky bottom-0 border-t border-slate-200 bg-white" },',
  '  h("p", { className: "mx-auto max-w-3xl px-4 py-3 text-xs text-slate-500" },',
  '    "This is a standalone export: it was generated as a file, not served, so it cannot be " +',
  '    "queried or take corrections. The conversation above is preserved; the analysis it refers " +',
  '    "to is fixed at export time.")',
  ")",
  "`;",
  "",
].join("\n");

const anchor = 'const CHART_VERSION = "4.4.1";';
if (!src.includes(anchor)) throw new Error("anchor not found");
src = src.replace(anchor, constants + "\n" + anchor);

writeFileSync(FILE, src, "utf8");
console.log("composer fragments defined as source text");