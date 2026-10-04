import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DynamicDashboard } from "./components/DynamicDashboard";
import { AgentList } from "./components/AgentList";
import { AlertCenter } from "./components/AlertCenter";
import { LivenessStrip } from "./components/LivenessStrip";
import { DIAGNOSTIC_MARKERS_FOR_TESTS } from "./diagnostics-flag";
import type { AgentDescriptor, AgentSchema, PortalConfig } from "./api/contracts";

/**
 * THE STRANGER TEST, AS AN ASSERTION.
 *
 * === THREE PROJECT LAWS, ratified 2026-10-04 ===
 *
 * **1. A test that pins jargon defends jargon.**
 *
 * Every one of the seven lines the operator enumerated on a customer screen was
 * asserted PRESENT by a test in this repository. They did not survive by
 * accident and they did not appear because nobody looked: they were protected.
 * Seven fixes would have fixed seven lines and found an eighth the following week.
 *
 * **2. Inversion, not deletion.**
 *
 * The same event as law 1 seen from the other side: a removed string's test
 * becomes its permanent NEGATIVE assertion. Deleting it leaves the door open;
 * inverting it makes the reintroduction loud.
 *
 * **3. Guards assert on what the USER PERCEIVES, not what the machine stores.**
 *
 * Derived from an assertion this suite deliberately WEAKENED. An
 * `<option value="dev/sla-monitor">` MUST carry the real composite id, or
 * selecting the agent breaks -- that is a bug, not jargon. The same string must
 * NEVER be spoken or displayed, because a reader cannot act on it.
 *
 *     expect(html).toContain('value="dev/sla-monitor"');     // machine: present
 *     expect(spoken(html)).not.toContain("dev/sla-monitor"); // user: absent
 *
 * The obvious tightening -- demand the string be absent from the markup -- would
 * have been **demanding a bug**. A guard that cannot tell a stored value from a
 * displayed one will eventually push a real defect out of the code to satisfy it.
 * That is the failure this law exists to prevent.
 *
 * === WHY THIS FILE EXISTS ===
 *
 * The census is now a test, over the whole default view, against a list kept in
 * ONE place. A copy of the list is a second thing to forget, and this list exists
 * precisely because these strings were forgotten once.
 *
 * === WHAT IT DOES NOT COVER, STATED RATHER THAN IMPLIED ===
 *
 * It renders components in isolation. **The assembled page is a separate test**
 * (`app-default-view.test.tsx`), added because this file's own limit was called
 * out: a string added to a component this file forgets would otherwise ship. Two
 * tests, neither pretending to be the other.
 *
 * And neither settles whether the page *looks* like a product. That is the
 * operator's eyes and it is marked unverified, never claimed.
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
    renderToStaticMarkup(<AgentList agents={[descriptor, stubDescriptor]} selectedAgentId={null} loading={false} onSelect={() => {}} />),
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