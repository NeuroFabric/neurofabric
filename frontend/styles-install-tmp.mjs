import { readFileSync, writeFileSync } from "node:fs";

/** ONE-OFF. Appends the install-form styles. Never runs twice. */
const P = "src/styles.css";
const css = readFileSync(P, "utf8");

if (css.includes("=== INSTALL AN AGENT")) {
  console.log("already present");
  process.exit(0);
}

const add = [
  "",
  "/* === INSTALL AN AGENT =====================================================",
  " *",
  " * The primary authoring action. It sits under the agent list because that is",
  " * where its result appears -- an agent installed here shows up directly above,",
  " * selected, with its rules loaded.",
  " */",
  ".install { display: grid; gap: 0.6rem; margin: 0.9rem 0; max-width: 34rem; }",
  ".install__field { display: grid; gap: 0.25rem; }",
  ".install__field span { font-size: 0.9rem; color: var(--muted); }",
  ".install__field input {",
  "  padding: 0.5rem 0.6rem;",
  "  border: 1px solid var(--line);",
  "  border-radius: 6px;",
  "  background: var(--bg);",
  "  color: var(--text);",
  "}",
  ".install__field input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }",
  ".install__button {",
  "  justify-self: start;",
  "  padding: 0.55rem 1rem;",
  "  font-weight: 600;",
  "  border-radius: 8px;",
  "  background: var(--accent);",
  "  color: var(--bg);",
  "  border-color: var(--accent);",
  "  cursor: pointer;",
  "}",
  ".install__button:hover:not(:disabled) { filter: brightness(1.08); }",
  ".install__button:disabled { opacity: 0.6; cursor: progress; }",
  ".install__note { margin: 0; font-size: 0.85rem; color: var(--muted); }",
  ".install__error { margin: 0; color: var(--critical); font-weight: 600; }",
  ".install--done {",
  "  padding: 0.75rem 1rem;",
  "  border: 1px solid color-mix(in srgb, var(--good) 40%, var(--line));",
  "  border-radius: 8px;",
  "  background: color-mix(in srgb, var(--good) 8%, var(--panel-2));",
  "}",
  ".install--done strong { color: var(--good); }",
  ".install__again {",
  "  margin-left: 0.8rem;",
  "  background: transparent;",
  "  border: 1px solid var(--line);",
  "  border-radius: 6px;",
  "  color: var(--text);",
  "  cursor: pointer;",
  "}",
  "",
].join("\n");

writeFileSync(P, css.trimEnd() + "\n" + add);
console.log("added install-form styles");