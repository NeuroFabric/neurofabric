"""Splice the rewritten AgentList describe block into components.test.tsx.

Replaces the block by anchors rather than by line numbers, because the file has
been edited between runs and a stale index would delete the wrong region. Every
anchor is asserted before anything is written.
"""

path = "frontend/src/components/components.test.tsx"
lines = open(path, encoding="utf-8").read().split("\n")
block = open(".scratch/agent-list-tests.tsx.txt", encoding="utf-8").read().rstrip("\n").split("\n")


def at(n: int) -> str:
    return lines[n - 1]


start = None
end = None
for index, line in enumerate(lines):
    if line.startswith('describe("AgentList"'):
        start = index
        break
assert start is not None, "the AgentList describe block was not found"
# The block runs to the end of the file -- it is the last describe in this file.
assert lines[start].strip() == 'describe("AgentList", () => {', repr(lines[start])
assert lines[-1].strip() == "});", repr(lines[-1])
end = len(lines)

out = lines[:start] + block + [""]
open(path, "w", encoding="utf-8").write("\n".join(out))
print(f"replaced {end - start} lines with {len(block)}")
