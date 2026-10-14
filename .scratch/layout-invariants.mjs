import { readFileSync, writeFileSync } from "node:fs";

/**
 * ONE-OFF EDIT. Not a deliverable.
 *
 * The collapsed-panel bug was a CSS class collision: `.live` was owned by
 * LiveStreamView's telemetry panel, and the Slice 2 strip reused it. The rule
 * that followed -- `display: flex` with no wrap -- therefore applied to the
 * telemetry panel and turned it into one row of shrinking items.
 *
 * The rename is in `rename-liveness.mjs`. This adds the invariants that stop the
 * *class* of bug, not the instance: nothing in this layout may size itself from
 * its content without being told it can shrink.
 */
const PATH = "frontend/src/styles.css";
const css = readFileSync(PATH, "utf8");

if (css.includes("LAYOUT INVARIANTS")) {
  console.log("already present");
  process.exit(0);
}

const add = `
/* === LAYOUT INVARIANTS ==================================================
 *
 * The collapsed-panel bug was a CSS class collision, and the real lesson is
 * that nothing in this layout was allowed to size itself from its content
 * without being told it could shrink. These declarations are cheap and they
 * make that structural rather than a matter of remembering.
 *
 *  - \`.app__side\` is an <aside> with no rule of its own, so it was sized purely
 *    by whatever it contained.
 *  - every flex row can wrap rather than crush
 *  - \`overflow-wrap: anywhere\` on prose panels, so a long sentence cannot set a
 *    minimum width wider than the viewport
 *
 * One character per line is what a flex item looks like when its min-content
 * width exceeds its track. Every line below targets that one mechanism.
 */
.app__side { min-width: 0; }

.app__main > * { min-width: 0; }

.live, .card, .panel { overflow-wrap: anywhere; }

/* A flex row of status chips wraps rather than compressing its children to
   nothing. \`flex-wrap: wrap\` is the difference between "wraps to a second line"
   and "one character per line", and it costs one declaration. */
.liveness { flex-wrap: wrap; }
`;

writeFileSync(PATH, css.replace(/\.live abbr/g, ".liveness abbr").trimEnd() + "\n" + add);
console.log("added layout invariants and fixed .live abbr");