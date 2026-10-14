"""Delete the unreachable duplicate tail of App.tsx.

WHY A SCRIPT RATHER THAN A TEXT EDIT: the block being removed is ~100 lines and
is character-for-character identical to live code earlier in the same file, so
every "small" text anchor is ambiguous and every unique anchor is the whole
block. Line markers are asserted before anything is written, so the script
refuses rather than deleting the wrong region.
"""

path = "frontend/src/App.tsx"
lines = open(path, encoding="utf-8").read().split("\n")


def at(n: int) -> str:
    """File line n, 1-indexed, as `grep -n` would report it."""
    return lines[n - 1]


# The first `return (` must be at 249 and the duplicate at 351.
assert at(249).strip() == "return (", repr(at(249))
assert at(351).strip() == "return (", repr(at(351))
# The live copy's refusal screen survives; the duplicate's does not.
assert "THE REFUSAL SCREEN" in at(202)
assert "THE REFUSAL SCREEN" in at(329)
# The duplicate ends the file.
assert at(427).strip() == ");", repr(at(427))
assert at(428).strip() == "}", repr(at(428))

note = [
    "",
    "  /*",
    "   * THE DUPLICATE BLOCK THIS REPLACES, AND WHY IT WAS HERE.",
    "   *",
    "   * This file ended with a SECOND verbatim copy of everything from the",
    "   * refusal screen to the closing `return` -- sitting after the first",
    "   * `return`, where nothing can reach it.",
    "   *",
    "   * Nothing caught it. `tsc` does not report unreachable code as an error by",
    "   * default (`allowUnreachableCode` is `undefined`, which is a suggestion),",
    "   * the tests render the LIVE copy, and both copies pass every assertion",
    "   * anybody wrote. So the next person to change this component had a fair",
    "   * chance of editing the copy that does not run -- and the record panel",
    "   * added in this MR would have been the third thing wired into one of the",
    "   * two, silently.",
    "   *",
    "   * It is deleted rather than left, because this is the third instance of the",
    "   * same shape in this repository (after the CSS class collision in !97 and",
    "   * the `StoreStatus` union drift) and the fix that keeps working is the one",
    "   * that removes the second copy.",
    "   */",
]

out = lines[:326] + note + [lines[427]]
open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
print(f"removed {len(lines) - len(out)} lines; file is now {len(out) - 1}")
