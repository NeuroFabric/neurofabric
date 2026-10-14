"""Second pass: the helpers that RETURN an analysis, and the callbacks that await.

The mechanical pass added `await` to direct calls. These two shapes need
understanding rather than pattern-matching:

  1. A module-level helper whose declared return type is
     `ReturnType<typeof analyseBottlenecks>`. That type is now a Promise, so the
     helper becomes async and every CALLER of it has to await in turn. Each such
     helper's name is collected first, so its call sites can be rewritten
     precisely rather than by guessing.

  2. `test("...", () => {...})` callbacks that now contain an `await`. node:test
     handles a promise-returning test, so making them async is the fix.

Comment lines are skipped throughout: this repository's tests are heavily
commented, and a `await` inserted into prose would be a silent corruption.
"""

import pathlib
import re

NL = chr(10)

HELPER_SIGNATURE = re.compile(
    r"function (\w+)\(([^)]*)\): ReturnType<typeof analyseBottlenecks> \{")

TEST_CALLBACK = re.compile(r"(, )\( ?(t?) ?\) =>")

IMPORT_OLD = 'import { analyseBottlenecks } from "../conductor/bottlenecks.ts";'
IMPORT_NEW = 'import { analyseBottlenecks, type BottleneckAnalysis } from "../conductor/bottlenecks.ts";'


def is_comment(line: str) -> bool:
    stripped = line.strip()
    return stripped.startswith("*") or stripped.startswith("//") or stripped.startswith("/*")


changed = []
for path in sorted(pathlib.Path("platform").rglob("*.test.ts")):
    source = path.read_text(encoding="utf-8")
    if "analyseBottlenecks" not in source:
        continue

    helpers = [name for name, _args in HELPER_SIGNATURE.findall(source)]
    out = []
    for line in source.split(NL):
        if is_comment(line):
            out.append(line)
            continue
        # The helper's own declaration becomes async, with an awaited return type.
        line = HELPER_SIGNATURE.sub(r"async function \1(\2): Promise<BottleneckAnalysis> {", line)
        if "return analyseBottlenecks(" in line:
            line = line.replace("return analyseBottlenecks(", "return await analyseBottlenecks(")
        if IMPORT_OLD in line:
            line = line.replace(IMPORT_OLD, IMPORT_NEW)
        # Call sites of the collected helpers.
        for name in helpers:
            line = re.sub(r"(?<!await )(?<!function )\b" + name + r"\(", "await " + name + "(", line)
        out.append(line)

    result = NL.join(out)
    # Test callbacks that now hold an await become async. Applied to every test()
    # declaration in the affected files: node:test handles a promise-returning
    # test, and an async callback that awaits nothing is still a passing test.
    lines = []
    for line in result.split(NL):
        if is_comment(line) or "test(" not in line:
            lines.append(line)
            continue
        lines.append(TEST_CALLBACK.sub(r"\1async (\2) =>", line))
    result = NL.join(lines)

    if result != source:
        path.write_text(result, encoding="utf-8")
        changed.append(path.name)

print("rewritten files:", len(changed))