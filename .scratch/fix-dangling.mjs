import { readFileSync, writeFileSync } from "node:fs";

const FILE = "platform/web/react-report.ts";
const lines = readFileSync(FILE, "utf8").split("\n");

// Lines 857..871 (1-based) are the tail of the OLD LineChart body, left dangling
// after the replacement closed its own useChart at line 856. It is unreachable
// dead code inside a function, and `x` is not even declared in the new scope --
// which is why tsc stayed quiet: it is inside a callback that is never invoked.
const firstEnd = 855; // 0-based index of "  }, props.version);" at 1-based 856
const secondEnd = lines.findIndex((l, i) => i > firstEnd && l === "  }, props.version);");

if (lines[firstEnd] !== "  }, props.version);") {
  throw new Error("unexpected line at the first close: " + lines[firstEnd]);
}
if (secondEnd < 0) throw new Error("second close not found");

console.log("removing dangling lines", firstEnd + 2, "to", secondEnd + 1);
lines.splice(firstEnd + 1, secondEnd - firstEnd);

const src = lines.join("\n");
const closes = (src.match(/^\}, props\.version\);$/gm) ?? []).length;
console.log("remaining useChart closes in the file:", closes);

writeFileSync(FILE, src, "utf8");