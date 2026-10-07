import { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Conductor, STAGE4_CAPABILITIES } from "./conductor.ts";
import { PILOT_RECORD, pilotRecord } from "./capabilities.ts";
import { WorkspaceBoundary } from "../core/workspace.ts";

describe("Stage 4 omni pilot", () => {
  it("publishes a persistence capability for pilot evidence", () => {
    assert.deepEqual(STAGE4_CAPABILITIES.map((tool) => tool.name), ["pilot_record"]);
    assert.strictEqual(PILOT_RECORD.riskLevel, "WRITE");
    assert.strictEqual(PILOT_RECORD.sideEffect, "SIDE_EFFECTING");
  });

  it("refuses to persist a pilot record outside the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "stage4-boundary-"));
    await assert.rejects(
      pilotRecord({
        path: join(root, "..", "pilot-record.json"),
        request: "pilot",
        source: "sales.csv",
        artifacts: [],
        rowCount: 0,
        userCount: 1,
      }, { boundary: new WorkspaceBoundary([root]) }),
      /outside the workspace boundary/
    );
  });

  it("chains ingest, chart, table query, report, landing page, and pilot persistence", async () => {
    const root = mkdtempSync(join(tmpdir(), "stage4-omni-"));
    const csvPath = join(root, "sales.csv");
    const output = join(root, "pilot-output");
    writeFileSync(csvPath, "customer,revenue,status\nA,10,signed\nB,25,trial\nC,40,signed\nD,5,trial\nE,55,signed\n", "utf8");

    const conductor = new Conductor({ cwd: root, projectConfig: { policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] } });
    const result = await conductor.run("stage4 omni pilot package; input=sales.csv", { mode: "omni", output, title: "Sales pilot" });

    assert.strictEqual(result.status, "DELIVERED");
    assert.ok(result.report?.markdown.includes("Stage 4 omni pilot package delivered"));
    for (const detail of ["csv_read", "chart_render", "table_query", "report_write", "landing_page", "pilot_record"]) {
      assert.ok(result.progress.some((event) => event.detail === detail));
    }

    const chart = join(output, "pilot-chart.svg");
    const report = join(output, "pilot-report.md");
    const landing = join(output, "pilot-landing.html");
    const record = join(output, "pilot-record.json");
    for (const artifact of [chart, report, landing, record]) assert.ok(existsSync(artifact));
    
    // Check artifacts
    const expectedArtifacts = [chart, report, landing, record];
    assert.ok(expectedArtifacts.every(art => result.artifacts.includes(art)));

    const persisted = JSON.parse(readFileSync(record, "utf8")) as { stage: number; status: string; userCount: number; artifacts: string[] };
    assert.strictEqual(persisted.stage, 4);
    assert.strictEqual(persisted.status, "loi-ready");
    assert.strictEqual(persisted.userCount, 5);
    assert.deepEqual(persisted.artifacts, [chart, report, landing]);
    assert.ok(readFileSync(report, "utf8").includes("Stage 4 omni run read 5 row(s)"));
  });
});
