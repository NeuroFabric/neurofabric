import { toReactDashboard } from "../platform/web/react-report.ts";
import { buildAnalysis } from "../platform/web/react-report.test-support.ts";

const analysis = await buildAnalysis();
for (const [label, opts] of [["LIVE", { live: { path: "x.csv" } }], ["OFFLINE", {}]]) {
  const html = toReactDashboard(analysis, opts);
  const o = html.indexOf('<script type="text/babel"');
  const src = html.slice(html.indexOf(">", o) + 1, html.indexOf("</script>", o));
  console.log(`--- ${label} --- /api/dashboard:`, src.split("/api/dashboard").length - 1,
    "| /api/report:", src.split("/api/report").length - 1,
    "| loadFile:", src.split("loadFile").length - 1);
  try {
    new Function(src);
    console.log("  parses OK");
  } catch (e) {
    console.log("  SYNTAX:", e.message);
    // Narrow it down by finding the first prefix that fails.
    const lines = src.split("\n");
    let last = 0;
    for (let n = 1; n <= lines.length; n++) {
      try { new Function(lines.slice(0, n).join("\n") + "\n".repeat(0)); last = n; } catch { break; }
    }
    console.log("  last good prefix line:", last);
    for (let k = Math.max(0, last - 2); k < Math.min(lines.length, last + 6); k++) {
      console.log(`   ${k + 1}: ${lines[k]}`);
    }
  }
}