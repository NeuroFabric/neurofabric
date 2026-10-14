"""Add the `await` that the async analysis now requires, in the test suite.

Mechanical and deliberately conservative: a line is only rewritten when the match
is unambiguous, and anything inside a comment or an import is left alone. The
helper functions that RETURN an analysis are handled by hand afterwards, because
making one async ripples into every caller and a regex cannot know which.
"""

import pathlib
import re

ASSIGN = re.compile(r"^(\s*(?:const|let)\s+\w+\s*=\s*)analyseBottlenecks\(")
MARKDOWN = re.compile(r"toBottleneckMarkdown\(analyseBottlenecks\(")
PROPERTY = re.compile(r"analyseBottlenecks\((.*)\)\.(\w+);\s*$")

NL = chr(10)

changed = []
for path in sorted(pathlib.Path("platform").rglob("*.test.ts")):
    source = path.read_text(encoding="utf-8")
    if "analyseBottlenecks" not in source:
        continue
    lines = source.split(NL)
    out = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("import ") or stripped.startswith("*") or stripped.startswith("//"):
            out.append(line)
            continue
        rewritten = ASSIGN.sub(r"\1await analyseBottlenecks(", line)
        if rewritten != line:
            out.append(rewritten)
            continue
        rewritten = MARKDOWN.sub("toBottleneckMarkdown(await analyseBottlenecks(", line)
        if rewritten != line:
            out.append(rewritten)
            continue
        rewritten = PROPERTY.sub(r"(await analyseBottlenecks(\1)).\2;", line)
        if rewritten != line:
            out.append(rewritten)
            continue
        out.append(line)
    result = NL.join(out)
    if result != source:
        path.write_text(result, encoding="utf-8")
        changed.append(path.name)

print("rewritten files:", len(changed))
for name in changed:
    print("  ", name)