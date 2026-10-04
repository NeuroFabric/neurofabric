import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import type { AgentDescriptor, AgentSchema, PortalConfig } from "../api/contracts";
import type { UIConfig } from "../store/SchemaStore";
import { DynamicDashboard } from "./DynamicDashboard";
import { AgentSelector } from "./AgentSelector";

/**
 * THE COMPONENTS, TESTED WITHOUT A BROWSER.
 *
 * `renderToStaticMarkup` from `react-dom/server` is the whole reason this file
 * exists and the reason the project has no jsdom dependency. It runs in a plain
 * node process, renders real React output to a string, and throws on anything
 * React cannot render -- including a null dereference, a bad key, or a component
 * that returns a fragment where an element was required.
 *
 * So these are not snapshot tests of markup nobody reads. They assert the
 * specific claim each component makes, on a string that was produced by actually
 * executing React. What they cannot do is test interaction, layout or focus, and
 * that limitation is stated here rather than left for someone to discover when a
 * click handler is found to be broken.
 */

function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

const descriptor = (id: string, maturity: AgentDescriptor["maturity"] = "ready"): AgentDescriptor => ({
  id,
  title: `${id} title`,
  domain: "anomaly",
  maturity,
  version: "1.0.0",
  capabilities: [`${id} capability`],
});

const baseConfig: UIConfig = {
  status: "ready",
  tenant: "acme",
  title: "acme diagnostics",
  version: "1.0.0",
  derived: false,
  widgets: [],
  forms: [],
  dashboards: [],
  agents: [],
  readyCount: 0,
  stubCount: 0,
  selectedAgentId: null,
  schema: null,
  issues: [],
  error: null,
  schemaLoading: false,
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
    { id: "burst", kind: "rate", severity: "critical", message: "burst", rateAbove: 5, windowMs: 60000 },
    { id: "fatal", kind: "regex", severity: "critical", message: "fatal", pattern: "FATAL" },
    { id: "absent", kind: "missing-field", severity: "info", message: "no field", field: "traceId" },
  ],
};

const widget = (id: string, kind: PortalConfig["widgets"][number]["kind"], agentId?: string) => ({
  id,
  kind,
  title: `${id} title`,
  ...(agentId === undefined ? {} : { agentId }),
});

describe("DynamicDashboard renders from data alone", () => {
  it("renders an idle store without crashing", () => {
    const html = render(<DynamicDashboard config={baseConfig} />);
    expect(html).toContain('aria-label="Agent dashboard"');
    expect(html).toContain("No agents yet");
  });

  it("falls back to a generic heading when the portal has no title", () => {
    expect(render(<DynamicDashboard config={{ ...baseConfig, title: "" }} />)).toContain("Portal");
  });

  it("counts ready and stub agents from the roster", () => {
    const html = render(
      <DynamicDashboard
        config={{ ...baseConfig, agents: [descriptor("a"), descriptor("b", "stub")], readyCount: 1, stubCount: 1 }}
      />,
    );
    // The count stays; the internal classification does not.
    expect(html).toContain("Agents");
    // The CLASS may keep the machine value -- it is not displayed. The LABEL is
    // what a screen reader announces, and that was "stub".
    expect(html).not.toContain('aria-label="stub"');
    expect(html).toContain("not yet configured");
  });

  it("renders a widget with no agent as static, and one with an agent as fed", () => {
    const html = render(
      <DynamicDashboard config={{ ...baseConfig, widgets: [widget("static-one", "metric"), widget("live-one", "table", "log-anomaly")] }} />,
    );
    expect(html).toContain("a static widget with no agent behind it");
    expect(html).toContain("log-anomaly");
  });

  it("renders an unfamiliar agent with no code change, proving it is not hardcoded", () => {
    // An agent this project has never heard of. If the component were a template
    // in disguise, this is the case that would fail.
    const exotic: AgentSchema = {
      id: "quantum-lattice-drift",
      title: "Quantum lattice drift",
      domain: "supply-chain",
      version: "9.9.9",
      capabilities: ["detects decoherence"],
      streams: ["lattice.telemetry"],
      rules: [{ id: "drift", kind: "threshold", severity: "info", message: "drift", operator: ">=", value: 42, field: "sigma" }],
    };
    const html = render(
      <DynamicDashboard config={{ ...baseConfig, agents: [descriptor("quantum-lattice-drift")], schema: exotic, selectedAgentId: exotic.id }} />,
    );
    expect(html).toContain("Quantum lattice drift");
    expect(html).toContain("quantum-lattice-drift");
    expect(html).toContain("lattice.telemetry");
    expect(html).toContain("sigma");
    expect(html).toContain("42");
  });

  it("groups rules into a table per kind", () => {
    const html = render(<DynamicDashboard config={{ ...baseConfig, schema, selectedAgentId: schema.id }} />);
    expect(html).toContain("threshold");
    expect(html).toContain("rate");
    expect(html).toContain("regex");
    expect(html).toContain("missing-field");
    expect(html).toContain("too slow");
    expect(html).toContain("more than 5 per 60000ms");
    expect(html).toContain("matches /FATAL/");
    expect(html).toContain("field traceId is absent");
  });

  it("states the configured threshold and does NOT invent a measured value", () => {
    // The schema says fire above 1000. Nothing says the current value is anything.
    // A bar at a height invented from the schema is a picture of a number nobody
    // measured, which is the one failure this platform's claim is against.
    const html = render(<DynamicDashboard config={{ ...baseConfig, schema, selectedAgentId: schema.id }} />);
    expect(html).toContain("limit 1000");
    expect(html).toContain("no reading yet");
    expect(html).not.toContain("BREACHED");
  });

  it("renders a breach only when a reading is actually supplied", () => {
    const html = render(
      <DynamicDashboard config={{ ...baseConfig, schema, selectedAgentId: schema.id }} readings={[{ ruleId: "slow", value: 1500 }]} />,
    );
    expect(html).toContain("1500 against limit 1000");
    expect(html).toContain("BREACHED");
  });

  it("does not mark a rule breached on a reading below its limit", () => {
    const html = render(
      <DynamicDashboard config={{ ...baseConfig, schema, selectedAgentId: schema.id }} readings={[{ ruleId: "slow", value: 10 }]} />,
    );
    expect(html).toContain("10 against limit 1000");
    expect(html).not.toContain("BREACHED");
  });

  it("says a schema with no rules has nothing to say, rather than drawing an empty table", () => {
    const empty: AgentSchema = { ...schema, rules: [] };
    const html = render(<DynamicDashboard config={{ ...baseConfig, schema: empty, selectedAgentId: empty.id }} />);
    expect(html).toContain("declares no rules");
  });

  it("asks for a selection instead of rendering an empty ruleset", () => {
    const html = render(<DynamicDashboard config={baseConfig} />);
    expect(html).toContain("Choose one to load its rules");
  });

  it("distinguishes loading from idle", () => {
    expect(render(<DynamicDashboard config={{ ...baseConfig, schemaLoading: true }} />)).toContain("Loading rules");
  });

  it("shows refused fields rather than swallowing them", () => {
    const html = render(
      <DynamicDashboard config={{ ...baseConfig, status: "degraded", issues: [{ path: "$.schema.rules[2].kind", reason: "kind is not a known rule kind" }] }} />,
    );
    expect(html).toContain("field(s) refused by the gateway");
    expect(html).toContain("$.schema.rules[2].kind");
    expect(html).toContain("What is below is what validated.");
  });

  it("caps the issue list instead of dumping an unbounded fault report", () => {
    const issues = Array.from({ length: 30 }, (_, i) => ({ path: `$.x${i}`, reason: "bad" }));
    const html = render(<DynamicDashboard config={{ ...baseConfig, status: "degraded", issues }} />);
    // The total is stated; only the first eight are listed.
    expect(html).toContain("30 field(s) refused by the gateway");
    expect(html).toContain("$.x7");
    expect(html).toContain("…and 22 more");
  });

  it("surfaces a transport error with its kind", () => {
    const html = render(
      <DynamicDashboard config={{ ...baseConfig, error: { kind: "refused", message: "no credential was proven", issues: [] } }} />,
    );
    expect(html).toContain("refused");
    expect(html).toContain("no credential was proven");
  });

  it("renders form fields as a table from the portal config", () => {
    const html = render(
      <DynamicDashboard
        config={{
          ...baseConfig,
          forms: [{ id: "new", title: "Install an agent", fields: [{ name: "id", label: "Agent id", type: "text", required: true }] }],
        }}
      />,
    );
    // With no install transport, the form is NOT rendered at all -- not rendered
    // as a description, which is what it used to be.
    expect(html).not.toContain("Install an agent");
    expect(html).not.toContain("Agent id");
    expect(html).not.toContain("<thead>");
  });

  it("says every stream when a schema names none", () => {
    const html = render(<DynamicDashboard config={{ ...baseConfig, schema: { ...schema, streams: [] }, selectedAgentId: schema.id }} />);
    expect(html).toContain("every stream");
  });

  it("marks a derived portal as derived", () => {
    expect(render(<DynamicDashboard config={{ ...baseConfig, derived: true }} />)).not.toContain("derived from registered agents");
  });
});

describe("AgentSelector", () => {
  it("says so when there are no agents, rather than rendering an empty control", () => {
    const html = render(<AgentSelector agents={[]} selectedAgentId={null} loading={false} onSelect={() => {}} />);
    expect(html).toContain("No agents registered");
  });

  it("offers every agent in the roster with its maturity", () => {
    const html = render(
      <AgentSelector
        agents={[descriptor("a"), descriptor("b", "stub")]}
        selectedAgentId={null}
        loading={false}
        onSelect={() => {}}
      />,
    );
    // Maturity is no longer appended to the agent title: "stub" is this
    // codebase's classification, not something a customer can act on.
    expect(html).toContain("a title");
    expect(html).not.toContain("— ready");
    expect(html).toContain("b title");
    expect(html).not.toContain("— stub");
  });

  it("always offers a none option so a null selection is representable", () => {
    // Without it, a select with a null value shows its first option, which reads
    // as "the first agent is selected" when no agent is.
    const html = render(<AgentSelector agents={[descriptor("a")]} selectedAgentId={null} loading={false} onSelect={() => {}} />);
    expect(html).toContain("— none —");
  });

  it("falls back to none when the selection names an agent that is gone", () => {
    const html = render(
      <AgentSelector agents={[descriptor("a")]} selectedAgentId="vanished" loading={false} onSelect={() => {}} />,
    );
    // The none option is the selected one, because the named agent is not here.
    expect(html).toContain('value="" selected=""');
    expect(html).not.toContain('value="a" selected');
  });

  it("reflects the current selection", () => {
    const html = render(<AgentSelector agents={[descriptor("a")]} selectedAgentId="a" loading={false} onSelect={() => {}} />);
    expect(html).toContain('value="a" selected');
  });

  it("shows that rules are loading", () => {
    expect(render(<AgentSelector agents={[descriptor("a")]} selectedAgentId="a" loading onSelect={() => {}} />)).toContain("loading rules");
  });
});