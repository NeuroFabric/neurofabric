"""Splice the restored `openStream` back into memory-routes.ts.

The previous mend used a line range that also swallowed the function body, so
this one splices by ANCHOR: the body's last line is inserted immediately before
the file's final `return { handle, hub, openStream };`.
"""

path = "platform/memory/memory-routes.ts"
lines = open(path, encoding="utf-8").read().split("\n")
body = open(".scratch/openstream-body.ts.txt", encoding="utf-8").read().rstrip("\n").split("\n")

# The dangling tail left behind, which we are replacing with the real function.
assert lines[-2].strip() == "}", repr(lines[-2])
assert lines[-3].strip() == "return { handle, hub, openStream };", repr(lines[-3])
assert "THREE WAYS A STREAM ENDS" in lines[-19], repr(lines[-19])
# ...and `handle` still closes cleanly above it.
assert lines[-21].strip() == "}", repr(lines[-21])

out = lines[:-19] + body + ["", "  return { handle, hub, openStream };", "}"]
open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
print(f"file is now {len(out)} lines")
