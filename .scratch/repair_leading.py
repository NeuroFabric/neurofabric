"""Final shape: a line that BEGINS with `await analyseBottlenecks(` and continues
`.property` after the call. The wrap's closing paren survived and its opening one
did not, because the call started the line -- so the fix is one inserted `(` at
the very front, before the `await`, and never after it.
"""

import pathlib

NL = chr(10)
CALL = "analyseBottlenecks("


def close_paren(text: str, start: int) -> int:
    depth = 0
    index = start
    while index < len(text):
        char = text[index]
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return -1


changed = []
for path in sorted(pathlib.Path("platform").rglob("*.test.ts")):
    source = path.read_text(encoding="utf-8")
    if CALL not in source:
        continue
    out = []
    for line in source.split(NL):
        stripped = line.lstrip()
        if stripped.startswith("await " + CALL):
            index = line.find(CALL)
            close = close_paren(line, index + len(CALL) - 1)
            if close > 0 and line[close + 1:close + 2] == ")" and line[close + 2:close + 3] == ".":
                line = line[:index].rstrip()[: -len("await")] + " (await" + line[index:]
        out.append(line)
    result = NL.join(out)
    if result != source:
        path.write_text(result, encoding="utf-8")
        changed.append(path.name)

print("repaired files:", len(changed))