import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Conductor, STAGE4_CAPABILITIES } from "./conductor.ts";
import { PILOT_RECORD, pilotRecord } from "./capabilities.ts";
import { WorkspaceBoundary } from "../core/workspace.ts";

describe("Stage 4 omni pilot", () => {
  it("publishes a persistence capability for pilot evidence", () => {
    expect(STAGE4_CAPABILITIES.map((tool) => tool.name)).toEqual(["pilot_record"]);
    expect(PILOT_RECORD.riskLevel).toBe("WRITE");
    expect(PILOT_RECORD.sideEffect).toBe("SIDE_EFFECTING");
  });

  it("refuses to persist a pilot record outside the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "stage4-boundary-"));
    await expect(pilotRecord({
      path: join(root, "..", "pilot-record.json"),
      request: "pilot",
      source: "sales.csv",
      artifacts: [],
      rowCount: 0,
      userCount: 1,
    }, { boundary: new WorkspaceBoundary([root]) })).rejects.toThrow(/outside the workspace boundary/);
  });

  it("chains ingest, chart, table query, report, landing page, and pilot persistence", async () => {
    const root = mkdtempSync(join(tmpdir(), "stage4-omni-"));
    const csvPath = join(root, "sales.csv");
    const output = join(root, "pilot-output");
    writeFileSync(csvPath, "customer,revenue,status\nA,10,signed\nB,25,trial\nC,40,signed\nD,5,trial\nE,55,signed\n", "utf8");

    const conductor = new Conductor({ cwd: root, projectConfig: { policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] } });
    const result = await conductor.run("stage4 omni pilot package; input=sales.csv", { mode: "omni", output, title: "Sales pilot" });

    expect(result.status).toBe("DELIVERED");
    expect(result.report?.markdown).toContain("Stage 4 omni pilot package delivered");
    for (const detail of ["csv_read", "chart_render", "table_query", "report_write", "landing_page", "pilot_record"]) {
      expect(result.progress.some((event) => event.detail === detail)).toBe(true);
    }

    const chart = join(output, "pilot-chart.svg");
    const report = join(output, "pilot-report.md");
    const landing = join(output, "pilot-landing.html");
    const record = join(output, "pilot-record.json");
    for (const artifact of [chart, report, landing, record]) expect(existsSync(artifact)).toBe(true);
    expect(result.artifacts).toEqual(expect.arrayContaining([chart, report, landing, record]));

    const persisted = JSON.parse(readFileSync(record, "utf8")) as { stage: number; status: string; userCount: number; artifacts: string[] };
    expect(persisted.stage).toBe(4);
    expect(persisted.status).toBe("loi-ready");
    expect(persisted.userCount).toBe(5);
    expect(persisted.artifacts).toEqual([chart, report, landing]);
    expect(readFileSync(report, "utf8")).toContain("Stage 4 omni run read 5 row(s)");
  });
});
