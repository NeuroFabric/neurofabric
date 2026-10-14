"""Final repair: the four shapes the line-based passes could not see.

1. A helper whose body holds `return await analyseBottlenecks(...)` was never made
   async, because the declaration and the return are on different lines. Making
   it async changes its callers, so those are rewritten too.

2. A wrap that lost its OPENING paren, because the call began on one line and the
   property access on the next. The closing paren is still there, so the fix is a
   single inserted character -- and it is detected by paren matching rather than
   by looking for a pattern that is identical in both the broken and the correct
   line.

Both are checked against the real text before anything is written.
"""

import pathlib
import re

NL = chr(10)
CALL = "analyseBottlenecks("
DECL = re.compile(r"^(\s*)function (\w+)\(([^)]*)\)(\s*:\s*[^{]+)?\s*\{")


def close_paren(text: str, start: int) -> int:
    depth = 0
    index = start
    while index < len(text):
        char = text[index]
        if char in "\"'`":
            quote = char
            index += 1
            while index < len(text) and text[index] != quote:
                if text[index] == "\\":
                    index += 1
                index += 1
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return -1


def restore_open_paren(line: str) -> str:
    """A wrap missing only its opening paren: `await f(...)).prop` -> `(await f(...)).prop`."""
    index = line.find(CALL)
    if index < 0:
        return line
    lead = line[:index].rstrip()
    # Already wrapped correctly when the character before the call is `(`.
    # An `await` alone is NOT evidence of that: a wrap that lost its opening
    # paren still reads as `await analyse(...)`, because the closing one survived.
    if lead.endswith("("):
        return line
    close = close_paren(line, index + len(CALL) - 1)
    if close < 0:
        return line
    if line[close + 1:close + 2] == ")" and line[close + 2:close + 3] == ".":
        # The paren goes BEFORE the `await`, not after it: `(await f(x)).prop`.
        # Placing it after produced `await (f(x)).prop`, which awaits nothing.
        if lead.endswith("await"):
            return lead[: -len("await")].rstrip() + " (await" + line[index:].lstrip()
        return lead + " (" + line[index:].lstrip()
    return line


def body_contains(lines: list, start: int, needle: str) -> bool:
    """Whether the function declared at `start` has `needle` in its body."""
    depth = 0
    for line in lines[start:]:
        depth += line.count("{") - line.count("}")
        if needle in line:
            return True
        if depth <= 0:
            return False
    return False


changed = []
for path in sorted(pathlib.Path("platform").rglob("*.test.ts")):
    source = path.read_text(encoding="utf-8")
    if CALL not in source:
        continue

    lines = source.split(NL)
    # 1. Restore the opening paren of a wrap whose closing paren survived.
    lines = [restore_open_paren(line) if not line.strip().startswith("*") else line for line in lines]

    # 2. Promote ONLY the functions whose own body awaits the analysis. Promoting
    #    every declaration would add a return type to helpers that have nothing to
    #    do with it, and would make functions async for no reason.
    promoted = []
    result = []
    for position, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("*") or stripped.startswith("//"):
            result.append(line)
            continue
        match = None if "async function" in line else DECL.match(line)
        if match and body_contains(lines, position, "await analyseBottlenecks("):
            name = match.group(2)
            promoted.append(name)
            if match.group(4):
                line = DECL.sub(r"\1async function \2(\3)\4 {", line, count=1)
            else:
                line = DECL.sub(r"\1async function \2(\3): Promise<BottleneckAnalysis> {", line, count=1)
        else:
            for name in promoted:
                line = re.sub(r"(?<!await )(?<!function )\b" + name + r"\(", "await " + name + "(", line)
        result.append(line)

    new_source = NL.join(result)
    if new_source != source:
        path.write_text(new_source, encoding="utf-8")
        changed.append(path.name)

print("repaired files:", len(changed))