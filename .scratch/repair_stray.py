"""Last uniform artifact: `await (analyseBottlenecks(...))` -- a redundant paren
the previous pass left between the `await` and the call. The wrap's opening paren
is already in place ahead of the `await`, so removing this one restores
`(await analyseBottlenecks(...)).property`.
"""

import pathlib

NL = chr(10)
BROKEN = "await (analyseBottlenecks("
FIXED = "await analyseBottlenecks("

changed = []
for path in sorted(pathlib.Path("platform").rglob("*.test.ts")):
    source = path.read_text(encoding="utf-8")
    if BROKEN not in source:
        continue
    result = source.replace(BROKEN, FIXED).replace("=(await ", "= (await ")
    path.write_text(result, encoding="utf-8")
    changed.append(path.name)

print("repaired files:", len(changed))