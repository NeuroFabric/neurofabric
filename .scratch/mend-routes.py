"""Mend the tail of memory-routes.ts.

Three separate breakages, each from a refactor that was only half applied:
  1. a stray `return { handle, hub, openStream };` at line 379, before openStream
     is even defined;
  2. `request_` / `attachRequest`, the late-bound request handle that the final
     refactor replaced with a parameter but never removed;
  3. the trailing return still exporting `attachRequest`.

Every anchor is asserted before anything is written, so the script refuses rather
than damaging a region it did not expect.
"""

path = "platform/memory/memory-routes.ts"
lines = open(path, encoding="utf-8").read().split("\n")


def at(n: int) -> str:
    """File line n, 1-indexed, as `grep -n` reports it."""
    return lines[n - 1]


# 1. The stray early return.
assert at(379).strip() == "return { handle, hub, openStream };", repr(at(379))
assert at(378).strip() == "", repr(at(378))
assert "OPEN THE STREAM" in at(382), repr(at(382))

# 2. The old handle wiring, and 3. the return that still exports it.
assert "Three ways a stream ends" in at(488), repr(at(488))
assert at(491).strip() == "request_?.on?.(\"close\", close);", repr(at(491))
assert at(492).strip() == "return true;", repr(at(492))
assert at(503).strip().startswith("let request_"), repr(at(503))
assert at(509).strip() == "return { handle, hub, openStream, attachRequest };", repr(at(509))
assert at(510).strip() == "}", repr(at(510))
# ...and the `write` helper after it, which must SURVIVE the mend.
assert "Write a refusal" in at(512), repr(at(512))

closing = [
    "    // THREE WAYS A STREAM ENDS, all of them clearing the same handles.",
    "    response.on(\"close\", close);",
    "    response.on(\"error\", close);",
    "    /**",
    "     * THE CLIENT GOING AWAY.",
    "     *",
    "     * Without this, a consumer whose browser has closed the tab stays subscribed",
    "     * until the socket times out, and every alert in the meantime is written to a",
    "     * dead consumer. Not a leak anybody would notice, and exactly the \"a handle",
    "     * that outlived the thing that owned it\" shape this repository has been bitten",
    "     * by once already.",
    "     */",
    "    request?.on?.(\"close\", close);",
    "    return true;",
    "  }",
    "",
    "  return { handle, hub, openStream };",
    "}",
]

# Replace 379..510 inclusive with just the closing block, keeping everything before.
out = lines[:378] + closing
open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
print(f"file is now {len(out)} lines")
