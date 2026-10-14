"""Repair the lines the previous pass corrupted, and finish them correctly.

The damage is uniform and mechanical: `analyseBottlenecks(########`, where the run
of hashes stands where the argument list begins. Two shapes need two repairs:

  const a = analyseBottlenecks(csvOf(SPIKE));
      -> const a = await analyseBottlenecks(csvOf(SPIKE));          (already right)

  const h = analyseBottlenecks(csvOf(SPIKE)).hourly;
      -> const h = (await analyseBottlenecks(csvOf(SPIKE))).hourly;  (wrap needed)

This version rebuilds each line by scanning forward with a paren counter and
records where to resume, rather than blanking text out and putting it back. The
previous attempt did the latter and corrupted 28 files; a marker that has to be
found again is a marker that can be put in the wrong place.
"""

import pathlib

NL = chr(10)
CALL = "analyseBottlenecks("
MARKER = CALL + "#" * 8


def is_comment(line: str) -> bool:
    stripped = line.strip()
    return stripped.startswith("*") or stripped.startswith("//") or stripped.startswith("/*")


def close_paren(text: str, start: int) -> int:
    """Index of the paren closing the one at `start`, or -1."""
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


def fix_line(line: str) -> str:
    # Drop the corruption marker first, so the rest of the scan sees real text.
    result = line.replace(MARKER, CALL)
    cursor = 0
    while True:
        index = result.find(CALL, cursor)
        if index < 0:
            return result
        open_paren = index + len(CALL) - 1
        close = close_paren(result, open_paren)
        before = result[:index].rstrip()
        property = result[close + 1:close + 2] == "." if close >= 0 else False
        if before.endswith("await") and not property:
            cursor = index + len(CALL)
            continue
        if close < 0:
            cursor = index + len(CALL)
            continue
        if property:
            # Property access: the await belongs to the CALL, not the property.
            # This also repairs `await analyse(x).prop`, where a previous pass
            # inserted the await but lost the wrapping parens -- awaiting a
            # property of a Promise is a runtime TypeError, not a type error.
            call = result[index:close + 1]
            if before.endswith("await"):
                result = result[:index].rstrip()[: -len("await")].rstrip() + "(await " + call + ")" + result[close + 1:]
                cursor = 0
                continue
            result = result[:index] + "(await " + call + ")" + result[close + 1:]
            cursor = index + len("(await ") + len(call) + 1
            continue
        result = result[:index] + "await " + result[index:]
        cursor = index + len("await ") + len(CALL)


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
        out.append(fix_line(line))
    result = NL.join(out)
    if result != source:
        path.write_text(result, encoding="utf-8")
        changed.append(path.name)

print("repaired files:", len(changed))