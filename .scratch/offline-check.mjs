import { toReactDashboard } from "../platform/web/react-report.ts";
import { buildAnalysis } from "../platform/web/react-report.test-support.ts";

const analysis = await buildAnalysis();
for (const [label, opts] of [["LIVE", { live: { path: "x.csv" } }], ["OFFLINE", {}]]) {
  const html = toReactDashboard(analysis, opts);
  const o = html.indexOf('<script type="text/babel"');
  const src = html.slice(html.indexOf(">", o) + 1, html.indexOf("</script>", o));
  console.log(`--- ${label} ---`);
  for (const pat of ["__REPORT_URL__", "__DASH_URL__", "/api/report", "/api/dashboard", "about:blank#offline", "type=\"file\""]) {
    const n = src.split(pat).length - 1;
    console.log("  " + pat.padEnd(24) + n);
  }
}