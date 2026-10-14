"""Remove the CSS that styled the removed `<select>`, and the orphaned wrapper rule.

Dead CSS is the same trap as dead code: unreachable, passing every assertion, and
the next person to add a control of the same name inherits a layout nobody
chose. Removing it is an EDIT to a stylesheet, not a file deletion, so it is done
here rather than by hand.

Anchors are asserted before anything is written.
"""

path = "frontend/src/styles.css"
text = open(path, encoding="utf-8").read()

selector_block = """/* ---- SELECTOR ---- */

.selector { display: inline-flex; align-items: center; gap: 0.6rem; }
.selector__label { font-size: 0.85rem; color: var(--muted); }
.selector__input {
  font: inherit; color: var(--ink); background: var(--panel-2);
  border: 1px solid var(--line); border-radius: 8px; padding: 0.35rem 0.6rem; min-width: 260px;
}

"""

replacement = """/* ---- SELECTOR: REMOVED WITH THE CONTROL ----
 *
 * These three rules styled the dropdown that Slice 4 replaced with the agent
 * list. They are gone rather than left behind, because orphaned CSS is the same
 * trap as orphaned code: unreachable, passing every assertion, and the next
 * person to add a control of this name inherits a layout nobody chose.
 * `.agentlist` is now the only selector styling in this file, so if it is wrong
 * it is wrong visibly.
 */

"""

assert selector_block in text, "the selector block was not found verbatim"
text = text.replace(selector_block, replacement)

wrapper = ".app__select { padding: 0.9rem 1.4rem; border-bottom: 1px solid var(--line); background: var(--panel); }\n"
assert wrapper in text, "the app__select wrapper rule was not found"
text = text.replace(wrapper, "")

open(path, "w", encoding="utf-8").write(text)
print("dead selector CSS removed")
