import { readFileSync, writeFileSync } from "node:fs";

const FILE = "platform/web/react-report.ts";
let src = readFileSync(FILE, "utf8");

// Wrap the composer's live branch in a marker, so an offline artifact -- and
// every export is one -- does not carry it at all.
const startMarker = '    // THE COMPOSER, where a composer belongs -- AND ONLY WHERE THERE IS';
const endMarker = '    D.live\n      ? h("div", { className: "sticky bottom-0 border-t border-slate-200 bg-white" },';
if (!src.includes(startMarker)) throw new Error("composer start not found");
if (!src.includes(endMarker)) throw new Error("composer live branch not found");

const startAt = src.indexOf(startMarker);
const endAt = src.indexOf(endMarker);
if (endAt < startAt) throw new Error("composer markers out of order");

src = src.slice(0, startAt) + "__COMPOSER__\n" + src.slice(endAt);

// Now the splice: offline artifacts get the explanation instead of the composer.
const spliceAnchor = '.split("__CHAT__").join("null")';
if (!src.includes(spliceAnchor)) throw new Error("splice anchor not found");

src = src.replace(spliceAnchor, `${spliceAnchor}
    // THE COMPOSER IS SPLICED OUT, NOT HIDDEN.
    //
    // The composer is already gated on D.live at runtime, so an offline artifact
    // never renders it. But "never rendered" is not "not there": the export
    // would still carry the markup, the placeholder text and the handler, and a
    // recipient reading the source would find a chat widget in a document with
    // no server. An export is a thing you send to somebody, so what it contains
    // matters as much as what it shows.
    .split("__COMPOSER__").join(live
      ? COMPOSER_SOURCE
      : '"This is a standalone export: it was generated as a file, not served, so it cannot be queried. " +\\n        "Open the analysis through the agent to ask questions."')`);

// The composer text, lifted out so it can be re-inserted verbatim.
const COMPOSER = `h("div", { className: "sticky bottom-0 border-t border-slate-200 bg-white" },
          h("form", {
            className: "mx-auto max-w-3xl px-4 py-3 flex gap-2",
            onSubmit: function (e) { e.preventDefault(); ask(); }
          },
            h("input", {
              type: "text",
              value: text,
              placeholder: "Ask about this file, or say \\u201ccol_1 is the duration\\u201d",
              "aria-label": "Ask a question, or correct a column",
              onChange: function (e) { setText(e.target.value); }
            }),
            h("button", { type: "submit", disabled: busy },
              busy ? "..." : "Ask")
          )
        )
      : `;

// Turn the captured composer into a module-level constant of the expression.
const composerStart = src.indexOf(endMarker) + endMarker.length;
const composerEnd = src.indexOf("      : h(\"div\", { className: \"sticky bottom-0 border-t border-slate-200 bg-white\" },", composerStart);
if (composerEnd < composerStart) throw new Error("composer else-branch not found");

const composerExpr = src.slice(composerStart, composerEnd);
src = src.slice(0, composerStart) + "OFFLINE_NOTE" + src.slice(composerEnd);

const constant = [
  "/**",
  " * THE COMPOSER, held as a constant so it can be spliced IN or left OUT.",
  " *",
  " * An offline artifact does not merely hide the composer; it does not contain",
  " * it. See the splice in toReactDashboard.",
  " */",
  "const COMPOSER_SOURCE = " + composerExpr.trim().replace(/\n\s*/g, "\n  ") + ";",
  "",
].join("\n");

const declAnchor = "const CHART_VERSION = \"4.4.1\";";
if (!src.includes(declAnchor)) throw new Error("decl anchor not found");
src = src.replace(declAnchor, constant + "\n" + declAnchor);

writeFileSync(FILE, src, "utf8");
console.log("composer spliced out of offline artifacts");