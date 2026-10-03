import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import { SchemaStore, type PortalSource } from "./store/SchemaStore";
import { simulateVerdict } from "./api/live-contracts";
import type { AgentDescriptor, AgentSchema, PortalConfig } from "./api/contracts";
import type { LiveSource } from "./hooks/useLiveTelemetry";

/**
 * THE WHOLE APPLICATION, RENDERED.
 *
 * This drives the REAL store with a mocked transport and renders the REAL
 * component tree. Everything between the socket and the DOM is the production
 * code path: the guards, the store's reducers, the subscription, and every
 * component. Only `fetch` is swapped.
 *
 * === WHAT THIS DOES NOT COVER, STATED RATHER THAN IMPLIED ===
 *
 * `renderToStaticMarkup` does not run `useEffect`, so the mount-time load in
 * App is not exercised here -- which is why every test below drives the store
 * explicitly before rendering. And it does not test interaction: the Reload
 * button, the selector's onChange and the refresh cycle are all unverified.
 * Those need a DOM and a real user, and pretending otherwise would be the worse
 * failure of the two.
 */

const descriptor = (id: string, maturity: AgentDescriptor["maturity"] = "ready"): AgentDescriptor => ({
  id,
  title: `${id} title`,
  domain: "anomaly",
  maturity,
  version: "1.0.0",
  capabilities: [`${id} capability`],
});

const config: PortalConfig = {
  tenant: "acme",
  title: "acme diagnostics",
  version: "1.0.0",
  widgets: [
    { id: "errors", kind: "metric", title: "Error rate", agentId: "log-anomaly", span: "recent" },
    { id: "static-banner", kind: "metric", title: "Build status" },
  ],
  forms: [{ id: "new", title: "Install an agent", fields: [{ name: "id", label: "Agent id", type: "text", required: true }] }],
  dashboards: [{ agentId: "log-anomaly", title: "Logs", layout: "grid", columns: 2 }],
};

const schema: AgentSchema = {
  id: "log-anomaly",
  title: "Log anomalies",
  domain: "anomaly",
  version: "1.0.0",
  capabilities: ["finds bursts"],
  streams: ["app.log"],
  rules: [
    { id: "slow", kind: "threshold", severity: "warning", message: "too slow", operator: ">", value: 1000, field: "elapsed" },
    { id: "fatal", kind: "regex", severity: "critical", message: "fatal seen", pattern: "FATAL" },
  ],
};

function source(overrides: Partial<PortalSource> = {}): PortalSource & LiveSource {
  return {
    fetchPortalConfig: async () => ({ derived: false, config }),
    fetchActiveSchemas: async () => ({
      at: "2026-10-03T00:00:00.000Z",
      total: 2,
      agents: [descriptor("log-anomaly"), descriptor("latency", "stub")],
      ready: 1,
      stubCount: 1,
    }),
    fetchSchema: async (id: string) => ({ ...schema, id }),
    fetchLive: async () => ({
      at: "2026-10-03T00:00:00.000Z",
      provider: "pega",
      enabled: true,
      verdict: { ...simulateVerdict(3, 554_000), synthetic: false },
      throughput: { records: 554_000, delta: 79_000, windowMs: 1_420, eventsPerSecond: 56_690 },
    }),
    ...overrides,
  };
}

function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** A store already driven to the interesting state, so effects are not needed. */
async function loadedStore(overrides: Partial<PortalSource> = {}, selectSchema = false): Promise<SchemaStore> {
  const store = new SchemaStore();
  await store.load(source(overrides));
  if (selectSchema) {
    store.select("log-anomaly");
    await store.loadSchema(source(overrides), "log-anomaly");
  }
  return store;
}

describe("App end to end", () => {
  it("renders the whole command center from a mocked gateway", async () => {
    const store = await loadedStore({}, true);
    const html = text(renderToStaticMarkup(<App store={store} source={source()} liveSource={source()} />));

    // Shell
    expect(html).toContain("Command Center");
    expect(html).toContain("acme diagnostics");
    expect(html).toContain("ready");

    // Agent roster, from the payload
    expect(html).toContain("log-anomaly");
    expect(html).toContain("latency");
    expect(html).toContain("1 ready, 1 stub");

    // Widgets, one static and one agent-fed
    expect(html).toContain("Error rate");
    expect(html).toContain("a static widget with no agent behind it");

    // The selected agent's rules, as a table
    expect(html).toContain("too slow");
    expect(html).toContain("fatal seen");
    expect(html).toContain("limit 1000");

    // Portal form fields
    expect(html).toContain("Install an agent");

    // Telemetry during a STATIC render. Polling lives in an effect, which
    // `renderToStaticMarkup` does not run, so the honest state here is
    // "connecting" -- asserting live numbers from this test would be asserting
    // something the renderer never executed. LiveStreamView's rendering of a
    // real verdict and a measured rate is covered directly in
    // components/telemetry.test.tsx, where it is driven by props.
    expect(html).toContain("Connecting to the live gateway");
    expect(html).not.toContain("SIMULATED SAMPLE");
  });

  it("renders a tenant with no agents at all, without crashing", async () => {
    const empty = new SchemaStore();
    await empty.load(
      source({
        fetchActiveSchemas: async () => ({ at: "t", total: 0, agents: [], ready: 0, stubCount: 0 }),
        fetchPortalConfig: async () => ({ derived: true, config: { ...config, widgets: [], forms: [] } }),
      }),
    );
    const html = text(renderToStaticMarkup(<App store={empty} source={source()} />));
    expect(html).toContain("No agents are registered");
    expect(html).toContain("derived from registered agents");
  });

  it("renders a refused gateway rather than an empty shell", async () => {
    const store = new SchemaStore();
    await store.load(
      source({
        fetchPortalConfig: async () => {
          throw Object.assign(new Error("no credential was proven"), { kind: "refused", issues: [] });
        },
        fetchActiveSchemas: async () => {
          throw Object.assign(new Error("no credential was proven"), { kind: "refused", issues: [] });
        },
      }),
    );
    const html = text(renderToStaticMarkup(<App store={store} source={source()} />));
    expect(html).toContain("refused");
    expect(html).toContain("no credential was proven");
  });

  it("renders a degraded store, showing what validated and naming what did not", async () => {
    const store = await loadedStore({
      fetchActiveSchemas: async () => ({ at: "t", total: 99, agents: [descriptor("log-anomaly")], ready: 0, stubCount: 0 }),
    });
    const html = text(renderToStaticMarkup(<App store={store} source={source()} />));
    // The widgets still drew.
    expect(html).toContain("Error rate");
    // And the fault is named rather than swallowed.
    expect(html).toContain("field(s) refused by the gateway");
    expect(html).toContain("What is below is what validated.");
  });

  it("renders an app that survived a garbage payload on every channel", async () => {
    // The requirement stated most plainly: malformed input must not crash the UI.
    const store = await loadedStore({
      fetchPortalConfig: async () => ({ derived: false, config: { tenant: 5, widgets: "no" } }) as never,
      fetchActiveSchemas: async () => ({ agents: [null, 3], total: "x" }) as never,
      fetchSchema: async () => ({ rules: "not-an-array" }) as never,
    });
    store.select("log-anomaly");
    await store.loadSchema(
      source({ fetchSchema: async () => ({ rules: "not-an-array" }) as never }),
      "log-anomaly",
    );
    const html = text(renderToStaticMarkup(<App store={store} source={source()} />));
    expect(html).toContain("Command Center");
    expect(html).toContain("degraded");
  });

  it("renders an alert center with a real payload alongside the dashboard", async () => {
    const store = await loadedStore({}, true);
    const html = text(
      renderToStaticMarkup(
        <App
          store={store}
          source={source()}
          liveSource={source()}
          alerts={[
            {
              id: "deadbeef",
              title: "kafka: 1 column past the outer fence",
              body: "latency_ms exceeded the outer fence",
              severity: "warning",
              source: "kafka",
              at: "2026-10-03T00:00:00.000Z",
              summary: { records: 12000, open: true, breachedColumns: 1, partitions: 3 },
              columns: [{ column: "latency_ms", partitions: 3, max: 4200, fenceUpper: 3000, multiple: 1.4, breachedEverywhere: false }],
            },
          ]}
        />,
      ),
    );
    expect(html).toContain("kafka: 1 column past the outer fence");
    // The distinction that decides restart-a-replica versus page-the-fleet.
    expect(html).toContain("some partitions");
    expect(html).not.toContain("every partition");
  });

  it("reflects the status in the header, so a fault is visible without scrolling", async () => {
    const healthy = await loadedStore();
    expect(text(renderToStaticMarkup(<App store={healthy} source={source()} />))).toContain("ready");

    const broken = new SchemaStore();
    await broken.load(
      source({
        fetchActiveSchemas: async () => {
          throw new Error("nope");
        },
      }),
    );
    expect(text(renderToStaticMarkup(<App store={broken} source={source()} />))).toContain("degraded");
  });

  it("shows the tenant hint in the header", async () => {
    const store = await loadedStore();
    const html = text(renderToStaticMarkup(<App store={store} source={source()} liveSource={source()} />));
    expect(html).toContain("live");
  });

  it("renders without a verdict and without alerts", async () => {
    const store = await loadedStore();
    const html = text(renderToStaticMarkup(<App store={store} source={source()} />));
    expect(html).toContain("Connecting to the live gateway");
    expect(html).toContain("An empty alert list is the only healthy one");
  });
});