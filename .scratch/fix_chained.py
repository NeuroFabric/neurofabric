"""Third pass: wrap `analyseBottlenecks(...)` that is immediately followed by a
property access, so the await applies to the analysis rather than to the property.

Handled with a paren-matching scan rather than a regex because the argument list
contains nested calls -- `analyseBottlenecks(csvOf(SPIKE)).hourly` -- and a regex
cannot know which `)` closes the call. Inserting the wrap at the wrong paren would
await the wrong expression, which type-checks in some shapes and fails in others.
"""

import pathlib

NL = chr(10)
CALL = "analyseBottlenecks("


def is_comment(line: str) -> bool:
    stripped = line.strip()
    return stripped.startswith("*") or stripped.startswith("//") or stripped.startswith("/*")


def wrap_calls(line: str) -> str:
    """Await every bare analyseBottlenecks call whose result is property-accessed."""
    out = line
    guard = 0
    while True:
        guard += 1
        if guard > 50:
            return out
        index = out.find(CALL)
        if index < 0:
            return out
        before = out[:index]
        if before.rstrip().endswith("await"):
            # Already awaited by an earlier pass; step past it.
            out = out[:index] + "#" * len(CALL) + out[index + len(CALL):]
            continue
        # Walk the argument list to the paren that closes the call.
        cursor = index + len(CALL)
        depth = 1
        while cursor < len(out) and depth > 0:
            char = out[cursor]
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
            elif char in "\"'`":
                quote = char
                cursor += 1
                while cursor < len(out) and out[cursor] != quote:
                    if out[cursor] == "\\":
                        cursor += 1
                    cursor += 1
            cursor += 1
        close = cursor - 1
        if out[close + 1:close + 2] != ".":
            # Not a property access -- the assignment passes already handled it.
            out = out[:index] + "#" * len(CALL) + out[index + len(CALL):]
            continue
        out = out[:index] + "await " + out[index:close + 1] + ")" + out[close + 1:]
        out = out[:index + len("await ")] + "#" * len(CALL) + out[index + len("await ") + len(CALL):]
    return out


changed = []
for path in sorted(pathlib.Path("platform").rglob("*.test.ts")):
    source = path.read_text(encoding="utf-8")
    if CALL not in source:
        continue
    out = []
    for line in source.split(NL):
        if is_comment(line) or CALL not in line:
            out.append(line)
            continue
        out.append(wrap_calls(line))
    result = NL.join(out).replace("###########", CALL)
    if result != source:
        path.write_text(result, encoding="utf-8")
        changed.append(path.name)

print("rewritten files:", len(changed))