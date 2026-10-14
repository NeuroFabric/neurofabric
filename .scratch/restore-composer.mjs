import { readFileSync, writeFileSync } from "node:fs";

const FILE = "platform/web/react-report.ts";
const src = readFileSync(FILE, "utf8");

const from = src.indexOf('.split("__COMPOSER__").join(live');
const to = src.indexOf("// THE ENDPOINTS ARE SPLICED");
if (from < 0 || to < 0 || to < from) throw new Error(`bounds not found: ${from}, ${to}`);

const repaired = [
  '.split("__COMPOSER__").join(live',
  '      ? h("div", { className: "sticky bottom-0 border-t border-slate-200 bg-white" },',
  '          h("form", {',
  '            className: "mx-auto max-w-3xl px-4 py-3 flex gap-2",',
  '            onSubmit: function (e) { e.preventDefault(); ask(); }',
  '          },',
  '            h("input", {',
  '              type: "text",',
  '              value: text,',
  '              placeholder: "Ask about this file, or say \\u201ccol_1 is the duration\\u201d",',
  '              "aria-label": "Ask a question, or correct a column",',
  '              onChange: function (e) { setText(e.target.value); }',
  '            }),',
  '            h("button", { type: "submit", disabled: busy },',
  '              busy ? "..." : "Ask")',
  '          )',
  '        )',
  '      : h("div", { className: "sticky bottom-0 border-t border-slate-200 bg-white" },',
  '          h("p", { className: "mx-auto max-w-3xl px-4 py-3 text-xs text-slate-500" },',
  '            "This is a standalone export: it was generated as a file, not served, so it cannot be " +',
  '            "queried or take corrections. The conversation above is preserved; the analysis it refers " +',
  '            "to is fixed at export time.")',
  '        ))',
  '    ',
  '',
].join("\n");

const out = src.slice(0, from) + repaired + src.slice(to);
writeFileSync(FILE, out, "utf8");
console.log("composer expression restored;", to - from, "chars replaced");