import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import { SchemaStore, type PortalSource } from "./store/SchemaStore";
import { simulateVerdict } from "./api/live-contracts";
import { diagnosticsEnabled } from "./diagnostics-flag";
import { DIAGNOSTIC_MARKERS_FOR_TESTS } from "./diagnostics-flag";
import type { AgentDescriptor, AgentSchema, PortalConfig } from "./api/contracts";

/**
 * THE ASSEMBLED PAGE. Not the panels — the whole thing.
 *
 * === THE LIMIT THIS FILE CLOSES ===
 *
 * `jargon.test.tsx` renders each panel in isolation, and it says so: a string
 * added to a component that file forgets would still ship. That was my stated
 * gap and it was a real one, because "every component I remembered to check" is
 * not a boundary.
 *
 * So this mounts **App** — the real component, the real store, the real wiring —
 * and asserts on the whole rendered page.
 *
 * === BOTH DIRECTIONS, AND THE SECOND ONE MATTERS AS MUCH ===
 *
 * The operator verifies the flag in both directions, and the test does too. A
 * guard that only proves something is hidden is satisfied by a feature that has
 * been deleted: remove the internals permanently and every "is it absent?"
 * assertion passes forever. **Asserting they COME BACK is what makes the flag a
 * flag rather than a deletion.**
 *
 * === WHAT IT STILL CANNOT PROVE ===
 *
 * That the page looks like a product, that 60fps holds, or that the layout is
 * right at any width. `renderToStaticMarkup` does not lay out or paint. Those are
 * the operator's eyes and they are marked unverified wherever they are claimed.
 */

const AGENT: AgentDescriptor = {
  id: "dev/sla-monitor",
  title: "SLA monitor",
  domain: "anomaly",
  maturity: "ready",
  version: "0.0.0.dev+derived",
  capabilities: ["Flags a breached service level"],
};

const SCHEMA: AgentSchema = {
  id: "sla-monitor",
  title: "SLA monitor",
  domain: "anomaly",
  version: "0.0.0.dev+derived",
  capabilities: ["Flags a breached service level"],
  streams: ["elapsed_time", "threshold"],
  rules: [{ id: "elapsed-beyond-threshold", kind: "threshold", severity: "critical", message: "Elapsed time is beyond the agreed service level", field: "elapsed_time", operator: ">", value: 1000, windowMs: 60000 }],
};

const CONFIG: PortalConfig = {
  tenant: "dev",
  title: "demo diagnostics",
  version: "0.0.0.dev+derived",
  widgets: [{ id: "w", kind: "metric", title: "Elapsed time", agentId: "dev/sla-monitor", span: "recent" }],
  forms: [{ id: "new", title: "Add an agent", fields: [{ name: "id", label: "Agent id", type: "text", required: true }] }],
  dashboards: [{ agentId: "dev/sla-monitor", title: "SLA", layout: "grid", columns: 2 }],
};

const VERDICT = { ...simulateVerdict(3, 240), synthetic: false };

const source: PortalSource = {
  fetchActiveSchemas: async () => ({ at: "2026-10-04T09:00:00.000Z", total: 1, agents: [AGENT], ready: 1, stubCount: 0 }),
  fetchPortalConfig: async () => ({ derived: true, config: CONFIG }),
  fetchSchema: async () => SCHEMA,
  // The front door needs BOTH write methods, and hasDemoTransport checks for
  // them at runtime. A read-only double correctly gets no button.
  uploadSchema: async () => ({ installed: true }),
  ingest: async (_provider: string, events: readonly unknown[]) => ({ accepted: events.length, refused: 0, provider: "pega" }),
} as unknown as PortalSource;

const live = {
  fetchLive: async () => ({
    at: "2026-10-04T09:00:00.000Z",
    provider: "pega",
    enabled: true,
    verdict: VERDICT,
    throughput: { records: 240, delta: 240, windowMs: 1000, eventsPerSecond: 240 },
  }),
};

/** The whole application, assembled, with a store driven to a real state. */
async function page(diagnostics?: boolean): Promise<string> {
  const store = new SchemaStore();
  await store.load(source);
  await store.loadSchema(source, "sla-monitor");
  return renderToStaticMarkup(<App store={store} source={source} liveSource={live} {...(diagnostics === undefined ? {} : { diagnostics })} />);
}

const spoken = (html: string): string =>
  html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

describe("the assembled page, default", () => {
  it("contains none of the internal vocabulary the operator enumerated", async () => {
    const text = spoken(await page()).toLowerCase();
    for (const marker of DIAGNOSTIC_MARKERS_FOR_TESTS) {
      expect(text, `the assembled page still contains "${marker}"`).not.toContain(marker.toLowerCase());
    }
  });

  it("carries none of the specific strings read off the screen by name", async () => {
    const html = (await page()).toLowerCase();
    // Checked against RAW markup, because these are things that are displayed or
    // announced rather than merely present in a value attribute.
    for (const marker of ["0.0.0.dev+derived", "layout version", "dispatched alert", "recs", "— stub", "— ready"]) {
      expect(html, `the assembled page still contains "${marker}"`).not.toContain(marker);
    }
  });

  it("shows the composite id as a VALUE but never as text", async () => {
    // The distinction is deliberate and the guard would be wrong to demand more.
    // An `<option value="dev/sla-monitor">` MUST carry the real id or selecting
    // the agent breaks — that is a bug, not jargon. What must not happen is the
    // id being VISIBLE, because a reader cannot act on "dev/sla-monitor".
    const html = await page();
    expect(html).toContain('value="dev/sla-monitor"');
    expect(spoken(html)).not.toContain("dev/sla-monitor");
    expect(spoken(html)).toContain("SLA monitor");
  });

  it("still names the product and the work it is doing", async () => {
    // The failure mode of a jargon sweep is a blank page. Asserted explicitly.
    const text = spoken(await page());
    expect(text).toContain("Neurofebric");
    expect(text).toContain("SLA monitor");
    expect(text).toContain("Elapsed time");
    expect(text.length).toBeGreaterThan(200);
  });

  it("shows the front door, because an empty state with no exit is not a product", async () => {
    // This one renders with NO traffic, which is the state a stranger arrives in.
    const store = new SchemaStore();
    await store.load(source);
    const html = renderToStaticMarkup(
      <App
        store={store}
        source={source}
        liveSource={{ fetchLive: async () => ({ at: "2026-10-04T09:00:00.000Z", provider: "pega", enabled: true, verdict: null, throughput: null }) }}
      />,
    );
    expect(spoken(html)).toContain("Show me a demo");
  });
});

describe("the assembled page, diagnostics on — the direction that proves the flag is a flag", () => {
  it("brings the internals BACK", async () => {
    const html = (await page(true)).toLowerCase();
    // Without this the guard is satisfied forever by DELETING the internals.
    expect(html).toContain("0.0.0.dev+derived");
    expect(html).toContain("dev/sla-monitor");
  });

  it("decides the flag from the query string, in both directions", () => {
    expect(diagnosticsEnabled({ search: "?diagnostics=1" })).toBe(true);
    expect(diagnosticsEnabled({ search: "" })).toBe(false);
    expect(diagnosticsEnabled({ search: "?diagnostics=0" })).toBe(false);
    expect(diagnosticsEnabled({ search: "?diagnostics=1", flag: "0" })).toBe(true);
    expect(diagnosticsEnabled({ flag: "1" })).toBe(true);
    expect(diagnosticsEnabled({ flag: "true" })).toBe(true);
    expect(diagnosticsEnabled({ flag: "0" })).toBe(false);
    // A malformed query is not a reason to show internals.
    expect(diagnosticsEnabled({ search: "%%%broken", flag: "0" })).toBe(false);
  });
});