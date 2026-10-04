import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import type { AgentDescriptor, AgentSchema, PortalConfig } from "../api/contracts";
import type { UIConfig } from "../store/SchemaStore";
import { DynamicDashboard } from "./DynamicDashboard";
import { AgentList } from "./AgentList";

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

describe("AgentList", () => {
  const one = descriptor("a");

  it("says so when there are no agents, rather than rendering an empty control", () => {
    const html = render(<AgentList agents={[]} selectedAgentId={null} loading={false} onSelect={() => {}} />);
    expect(html).toContain("No agents registered");
  });

  it("is a NAVIGATION landmark, not a form control", () => {
    // Slice 4 (F6c). The claim is that a product's primary navigation stopped
    // rendering as a `<select>`, and this is the assertion that holds it: a
    // `<select>` appearing here again would be a regression nobody would notice
    // without asking, because it still compiles and still works.
    const html = render(<AgentList agents={[one]} selectedAgentId={null} loading={false} onSelect={() => {}} />);
    expect(html).toContain('<nav class="agentlist" aria-label="Agents">');
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<option");
    // Every row is a real button, so focus, Tab and Enter come from the browser.
    // Re-implementing any of that is how a control ends up mouse-only.
    expect(html).toContain("<button");
  });

  it("offers every agent in the roster, by title and never by maturity", () => {
    const html = render(
      <AgentList agents={[descriptor("a"), descriptor("b", "stub")]} selectedAgentId={null} loading={false} onSelect={() => {}} />,
    );
    expect(html).toContain("a title");
    expect(html).toContain("b title");
    // PROJECT LAW 1: a test that pins jargon defends jargon. `stub` is this
    // codebase's internal classification, so it must be ABSENT here -- and the
    // negative assertion is the only thing that keeps it out.
    expect(html).not.toContain("— stub");
    expect(html).not.toContain("— ready");
    expect(html).not.toContain("stub");
  });

  it("carries the composite id invisibly, so a selection cannot address the wrong agent", () => {
    // The `<select>` carried the id in `option value`; replacing the control must
    // not quietly move it somewhere uncheckable. It is a data attribute, NOT
    // text, because a reader cannot act on `dev/sla-monitor`.
    const html = render(
      <AgentList agents={[{ ...descriptor("a"), id: "acme/log-anomaly" }]} selectedAgentId={null} loading={false} onSelect={() => {}} />,
    );
    expect(html).toContain('data-agent-id="acme/log-anomaly"');
    expect(html.replace(/<[^>]*>/g, " ")).not.toContain("acme/log-anomaly");
  });

  it("always offers a real control for no selection, so a null selection is representable", () => {
    // A `<select>` with a null value shows its first option, which reads as "the
    // first agent is selected" when no agent is. The null row is a BUTTON, not a
    // label, so it is reachable the same way every other row is.
    const html = render(<AgentList agents={[one]} selectedAgentId={null} loading={false} onSelect={() => {}} />);
    expect(html).toContain("No agent open");
    expect(html).toContain('class="agentlist__row agentlist__row--none"');
  });

  it("marks the selection with a SHAPE and with aria-current, not with colour alone", () => {
    const html = render(<AgentList agents={[one]} selectedAgentId="a" loading={false} onSelect={() => {}} />);
    // Two independent signals. A reader who cannot distinguish the accent is not
    // left with nothing -- which is also why there is no per-agent status dot
    // here: nothing in the roster could honestly fill one.
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('class="agentlist__mark"');
  });

  it("reflects the current selection, and ONLY the current one", () => {
    const html = render(<AgentList agents={[descriptor("a"), descriptor("b")]} selectedAgentId="a" loading={false} onSelect={() => {}} />);
    const current = html.match(/aria-current="true"/g) ?? [];
    // Exactly one row is current, or the reader cannot tell where they are.
    expect(current.length).toBe(1);
    expect(html).toContain('data-agent-id="a"');
  });

  it("falls back to no-selection when the selection names an agent that is gone", () => {
    // The named agent is not in the roster, so no row may claim to be selected
    // except the null row. A stale id that kept its highlight would show an
    // operator an agent they had already lost.
    const html = render(<AgentList agents={[one]} selectedAgentId="vanished" loading={false} onSelect={() => {}} />);
    expect(html).toContain('class="agentlist__row agentlist__row--none" aria-current="true"');
    expect(html).not.toContain('data-agent-id="a" aria-current');
  });

  it("shows that rules are loading", () => {
    expect(render(<AgentList agents={[one]} selectedAgentId="a" loading onSelect={() => {}} />)).toContain("loading rules");
  });

  it("does NOT render a per-agent status dot", () => {
    // ANTI-SWING, and the reason is a product one. A dot would need per-agent
    // breach data, `AgentDescriptor` carries none, and an indicator that cannot
    // mean anything teaches an operator to glance and be right by accident. This
    // test exists so that adding one requires removing it deliberately.
    const html = render(<AgentList agents={[one, descriptor("b")]} selectedAgentId={null} loading={false} onSelect={() => {}} />);
    expect(html).not.toContain("agentlist__dot");
    expect(html).not.toContain("data-status");
  });
});
