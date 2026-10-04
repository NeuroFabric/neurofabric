import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DynamicDashboard } from "./components/DynamicDashboard";
import { AgentSelector } from "./components/AgentSelector";
import { AlertCenter } from "./components/AlertCenter";
import { LivenessStrip } from "./components/LivenessStrip";
import { DIAGNOSTIC_MARKERS_FOR_TESTS } from "./diagnostics-flag";
import type { AgentDescriptor, AgentSchema, PortalConfig } from "./api/contracts";

/**
 * THE STRANGER TEST, AS AN ASSERTION.
 *
 * === WHY THIS FILE EXISTS ===
 *
 * The operator enumerated seven lines of internal vocabulary on a screen a
 * stranger was looking at: a dev-diagnostics block, "layout version
 * 0.0.0.dev+derived", "(1 READY, 0 STUB)", "tenant dev", "fed by dev/sla-monitor",
 * "recs 240", and "from the live verdict, not a dispatched alert".
 *
 * **Seven fixes would have fixed seven lines and found an eighth next week.**
 * Every one of them was a test asserting the jargon was PRESENT — a test that
 * defends what it should be eliminating. So the census is now a test, over the
 * whole default view, against a list kept in ONE place.
 *
 * === WHAT IT DOES NOT COVER ===
 *
 * It renders components in isolation, not the assembled application. That is a
 * real gap: a string added to a component this file forgets would ship. The
 * honest claim is that the default view of the **panels** is clean, and the
 * operator's screenshot is still the check that the assembled page is.
 */

const descriptor: AgentDescriptor = {
  id: "sla-monitor",
  title: "SLA monitor",
  domain: "anomaly",
  maturity: "ready",
  version: "0.0.0.dev+derived",
  capabilities: ["Flags a breached service level"],
};

const stubDescriptor: AgentDescriptor = { ...descriptor, id: "placeholder", title: "Placeholder", maturity: "stub" };

const schema: AgentSchema = {
  id: "sla-monitor",
  title: "SLA monitor",
  domain: "anomaly",
  version: "0.0.0.dev+derived",
  capabilities: ["Flags a breached service level"],
  streams: ["elapsed_time", "threshold"],
  rules: [{ id: "r", kind: "missing-field", severity: "info", message: "m", field: "x" }],
};

const config: PortalConfig = {
  tenant: "dev",
  title: "demo diagnostics",
  version: "0.0.0.dev+derived",
  widgets: [{ id: "w", kind: "metric", title: "Elapsed time", agentId: "dev/sla-monitor", span: "recent" }],
  forms: [{ id: "new", title: "Add an agent", fields: [{ name: "id", label: "Agent id", type: "text", required: true }] }],
  dashboards: [{ agentId: "dev/sla-monitor", title: "SLA", layout: "grid", columns: 2 }],
};

const verdict = {
  at: "2026-10-04T09:00:00.000Z",
  records: 240,
  open: true,
  breachedColumns: 1,
  busiestHour: null,
  topKeys: [{ key: "checkout", count: 40 }],
  synthetic: false,
  columns: [
    { column: "elapsed_time", partition: "p", measured: 8541, min: 100, max: 8541, q1: 300, q3: 900, quantilesSampled: true, fenceLower: 0, fenceUpper: 961, extremeLower: 0, extremeUpper: 961, extremeMultiple: 4, breached: true, partitions: 1, breachedEverywhere: true },
    { column: "threshold", partition: "p", measured: 699, min: 400, max: 699, q1: 500, q3: 700, quantilesSampled: true, fenceLower: 0, fenceUpper: 1093, extremeLower: 0, extremeUpper: 1093, extremeMultiple: null, breached: false, partitions: 1, breachedEverywhere: false },
  ],
};

/** Every panel, rendered with the WORST-CASE data: a dev tenant, stub agents, a derived layout. */
function wholeDefaultView(): string {
  const store = {
    title: config.title, tenant: config.tenant, version: config.version, derived: true,
    widgets: config.widgets, forms: config.forms, dashboards: config.dashboards,
    agents: [descriptor, stubDescriptor], readyCount: 1, stubCount: 1,
    selectedAgentId: null, schema, issues: [], error: null,
  };
  return [
    renderToStaticMarkup(<DynamicDashboard config={store as never} readings={[{ ruleId: "r", value: 8541 }]} />),
    renderToStaticMarkup(<AgentSelector agents={[descriptor, stubDescriptor]} selectedAgentId={null} loading={false} onSelect={() => {}} />),
    renderToStaticMarkup(<AlertCenter alerts={[]} verdict={verdict as never} />),
    renderToStaticMarkup(<LivenessStrip liveness="live" lastUpdated="2026-10-04T08:59:59.000Z" now={Date.parse("2026-10-04T09:00:00.000Z")} records={240} />),
  ].join("\n");
}

/** Text as a person receives it: tags stripped, entities decoded. */
const spoken = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

describe("the default view, to a stranger", () => {
  const view = wholeDefaultView();

  it("contains none of the internal vocabulary the operator enumerated", () => {
    for (const marker of DIAGNOSTIC_MARKERS_FOR_TESTS) {
      expect(spoken(view).toLowerCase(), `the default view still contains "${marker}"`).not.toContain(marker.toLowerCase());
    }
  });

  it("names no tenant, no layout version and no internal classification", () => {
    const text = spoken(view).toLowerCase();
    // The three the operator read off the screen by name.
    expect(text).not.toContain("layout version");
    expect(text).not.toContain("0.0.0.dev+derived");
    expect(text).not.toContain("ready,");
    expect(text).not.toContain("stub");
  });

  it("still says what it is doing — the sweep must not delete the product", () => {
    // The failure mode of a jargon sweep is an empty screen. Asserted explicitly:
    // a screen with no jargon and no information is not a cleaner product.
    const text = spoken(view);
    expect(text).toContain("SLA monitor");
    expect(text.length).toBeGreaterThan(80);
  });

  it("does not announce internal vocabulary to a screen reader either", () => {
    // The class may keep the machine value; the ANNOUNCED label may not. This was
    // the same complaint in a channel fewer people check.
    expect(view).not.toContain('aria-label="stub"');
    expect(view).not.toContain('aria-label="ready"');
  });

  it("keeps the raw markup free of the strings, not just the rendered text", () => {
    // Belt and braces: an aria-label or a title attribute is spoken and is not
    // produced by stripping tags from the body.
    for (const marker of ["0.0.0.dev+derived", "dev/sla-monitor", "dispatched alert", "recs"]) {
      expect(view.toLowerCase(), `markup still contains "${marker}"`).not.toContain(marker.toLowerCase());
    }
  });
});