import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceBoundary } from "../core/workspace.ts";
import {
  APP_SCAFFOLD,
  CHART_RENDER,
  LANDING_PAGE,
  REPORT_WRITE,
  STAGE3_CAPABILITIES,
  TABLE_QUERY,
  appScaffold,
  chartRender,
  landingPage,
  reportWrite,
  tableQuery,
} from "./capabilities.ts";
import { Conductor } from "./conductor.ts";

describe("Stage 3 capabilities", () => {
  it("publishes governed skills with explicit risk levels", () => {
    assert.deepStrictEqual(STAGE3_CAPABILITIES.map((tool) => tool.name), [
      "chart_render", "table_query", "landing_page", "report_write", "app_scaffold",
    ]);
    assert.strictEqual(TABLE_QUERY.riskLevel, "READ_ONLY");
    assert.ok([CHART_RENDER, LANDING_PAGE, REPORT_WRITE, APP_SCAFFOLD].every((tool) => tool.riskLevel === "WRITE"));
  });

  it("rejects an output outside the workspace before writing", async () => {
    const root = mkdtempSync(join(tmpdir(), "stage3-boundary-"));
    try {
      const boundary = new WorkspaceBoundary([root]);
      await assert.rejects(landingPage({ path: join(root, "..", "outside.html"), title: "x", headline: "x", body: "x" }, { boundary }), /outside the workspace boundary/);
    } finally {
      rmdirSync(root);
    }
  });

  it("renders chart, landing page, report, and app scaffold artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "stage3-artifacts-"));
    const boundary = new WorkspaceBoundary([root]);
    const chartPath = join(root, "chart.svg");
    const landingPath = join(root, "landing.html");
    const reportPath = join(root, "report.md");
    const appPath = join(root, "app.html");
    try {
      const chart = await chartRender({ path: chartPath, title: "Revenue", points: [{ label: "Jan", value: 10 }, { label: "Feb", value: 20 }] }, { boundary });
      const landing = await landingPage({ path: landingPath, title: "Launch", headline: "Ship safely", body: "Governed output." }, { boundary });
      const report = await reportWrite({ path: reportPath, title: "Sales", summary: "Two rows.", columns: ["name", "amount"], rows: [{ name: "A", amount: "10" }] }, { boundary });
      const app = await appScaffold({ path: appPath, name: "Demo app" }, { boundary });
      assert.strictEqual(chart.points, 2);
      assert.ok(landing.bytes > 0);
      assert.ok(report.bytes > 0);
      assert.ok(app.bytes > 0);
      assert.ok(readFileSync(chartPath, "utf8").includes("<svg"));
      assert.ok(readFileSync(landingPath, "utf8").includes("Ship safely"));
      assert.ok(readFileSync(reportPath, "utf8").includes("| A | 10 |"));
      assert.ok(readFileSync(appPath, "utf8").includes("Demo app"));
    } finally {
      for (const file of [chartPath, landingPath, reportPath, appPath]) unlinkSync(file);
      rmdirSync(root);
    }
  });

  it("runs landing-page execution through the Conductor without an input file", async () => {
    const root = mkdtempSync(join(tmpdir(), "stage3-conductor-"));
    const output = join(root, "landing.html");
    try {
      const conductor = new Conductor({ cwd: root, projectConfig: { policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] } });
      const result = await conductor.run("create a landing page", { mode: "landing-page", output });
      assert.strictEqual(result.status, "DELIVERED");
      assert.ok(result.progress.some((event) => event.detail === "landing_page"));
      assert.ok(readFileSync(output, "utf8").includes("landing page"));
    } finally {
      unlinkSync(output);
      rmdirSync(root);
    }
  });

  it("runs a bounded read-only table query inside the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "stage3-query-"));
    const csvPath = join(root, "orders.csv");
    try {
      writeFileSync(csvPath, "name,amount\nA,10\nB,25\nC,40\n", "utf8");
      const result = await tableQuery({ path: csvPath, column: "amount", operator: ">", value: 20 }, { boundary: new WorkspaceBoundary([root]) });
      assert.strictEqual(result.matchedRows, 2);
      assert.deepStrictEqual(result.rows.map((row) => row.name), ["B", "C"]);
      assert.strictEqual(result.truncated, false);
    } finally {
      unlinkSync(csvPath);
      rmdirSync(root);
    }
  });
});
