import { readFileSync, writeFileSync } from "node:fs";

/**
 * ONE-OFF RENAME. Not a deliverable, not a test, and not part of the suite.
 *
 * `.live` was owned by LiveStreamView's telemetry panel BEFORE Slice 2, and
 * Slice 2 reused it for the liveness strip. The stylesheet rule that followed
 * -- `display: flex` on a whole panel with no wrap -- therefore applied to the
 * telemetry panel, turning it into one row of shrinking flex items. That is the
 * collapsed-panel report, character by character.
 *
 * The strip's own selectors are renamed to `.liveness`. LiveStreamView keeps
 * `.live`, which is what it had.
 */
const PATH = "frontend/src/styles.css";
const css = readFileSync(PATH, "utf8");

const START = css.indexOf("/* === THE LIVENESS STRIP");
const END = css.indexOf("/* === SEVERITY AS A SIGNAL");
if (START < 0 || END < 0 || END <= START) throw new Error("markers not found");

const block = css.slice(START, END);
const renamed = block
  .replace(/\.live__/g, ".liveness__")
  .replace(/\.live--/g, ".liveness--")
  .replace(/\.live \{/g, ".liveness {")
  .replace(/\.live \n/g, ".liveness \n")
  .replace(/\.live \{/g, ".liveness {");

writeFileSync(PATH, css.slice(0, START) + renamed + css.slice(END));
console.log("renamed. liveness rules:", (renamed.match(/\.liveness/g) ?? []).length, "| leftover .live rules:", (renamed.match(/^\.live[ _]/gm) ?? []).length);