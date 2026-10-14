import { readFileSync, writeFileSync } from "node:fs";

/** ONE-OFF. Appends the front-door styles; never runs twice. */
const P = "frontend/src/styles.css";
const css = readFileSync(P, "utf8");

if (css.includes("=== THE FRONT DOOR")) {
  console.log("already present");
  process.exit(0);
}

const add = [
  "",
  "/* === THE FRONT DOOR =====================================================",
  " *",
  " * One button, and it is the first thing an empty screen offers. It carries",
  " * weight on purpose: this is the primary action on a blank page and it should",
  " * look like one rather than like a utility control.",
  " */",
  ".demo {",
  "  display: grid;",
  "  gap: 0.6rem;",
  "  margin-top: 0.9rem;",
  "  padding: 1rem;",
  "  border: 1px solid var(--line);",
  "  border-radius: 10px;",
  "  background: var(--panel-2);",
  "}",
  "",
  ".demo__button {",
  "  justify-self: start;",
  "  padding: 0.6rem 1.1rem;",
  "  font-weight: 600;",
  "  border-radius: 8px;",
  "  background: var(--accent);",
  "  color: var(--bg);",
  "  border-color: var(--accent);",
  "  cursor: pointer;",
  "  transition: filter 120ms ease;",
  "}",
  "",
  '.demo__button:hover:not(:disabled) { filter: brightness(1.08); }',
  ".demo__button:disabled { opacity: 0.6; cursor: progress; }",
  ".demo__button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
  "",
  ".demo__note { margin: 0; font-size: 0.85rem; color: var(--muted); }",
  ".demo__step { margin: 0; color: var(--muted); }",
  ".demo__error { margin: 0; color: var(--critical); font-weight: 600; }",
  "",
  ".demo--done {",
  "  border-color: color-mix(in srgb, var(--good) 40%, var(--line));",
  "  background: color-mix(in srgb, var(--good) 8%, var(--panel-2));",
  "}",
  ".demo--done strong { color: var(--good); }",
  "",
].join("\n");

writeFileSync(P, css.trimEnd() + "\n" + add);
console.log("added front-door styles");