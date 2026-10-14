import io

PATH = "scripts/live-proof-of-life.ts"
lines = io.open(PATH, encoding="utf-8").read().split("\n")

for n, line in enumerate(lines):
    if "one event in the frame" in line:
        print("line", n + 1, "backslash count:", line.count("\\"))
        lines[n] = (
            "      `one SSE event in the frame: "
            "${(frame.match(/" + chr(92) + "n" + chr(92) + "n/g) ?? []).length === 1}`,"
        )
        print("new  :", lines[n])

io.open(PATH, "w", encoding="utf-8").write("\n".join(lines))
print("done")