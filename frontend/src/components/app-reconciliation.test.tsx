import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "../App";
import { SchemaStore, type PortalSource } from "../store/SchemaStore";
import type { LiveSource } from "../hooks/useLiveTelemetry";
import type { AgentSchema } from "../api/contracts";
import type { ReconciliationDiff } from "../api/memory-contracts";

/**
 * THE RECORD PANEL'S PLACE IN THE TREE.
 *
 * === WHAT IS BEING ASSERTED, AND WHY IT IS NOT ABOUT WORDING ===
 *
 * Structure. ADR-005 §9 rule 1 says the two truths never appear in the same
 * BLOCK, and that the distinction must be structural rather than a caption --
 * because a caption is something a reader stops noticing and a boundary is
 * something the layout enforces. **A component that renders correctly in
 * isolation proves nothing about where it sits**, so these tests assert on the
 * assembled tree and on nesting.
 *
 * The three claims:
 *
 *  1. With no `reconciliation` prop, nothing is drawn. Not an empty panel, not a
 *     caption. This is the F1-adjacent failure: an absent record and an agreeing
 *     record must not look the same.
 *  2. With one, it is a SIBLING of the live column -- a `<section>` that closes
 *     before the `<aside>` opens -- so no element can be a descendant of both.
 *  3. It is offered a way to acknowledge, and offered NOTHING that resolves.
 *
 * === WHAT THIS DOES NOT PROVE ===
 *
 * `renderToStaticMarkup` runs no effects, so the click is not driven. That the
 * acknowledgement reaches the server, and that the panel re-reads afterwards, is
 * the operator's browser test. What is asserted here is that the wiring EXISTS
 * and that the absent case is honest.
 */

const source: PortalSource = {
  fetchPortalConfig: async () => ({
    derived: true,
    config: { tenant: "acme", title: "acme", version: "1.0.0", widgets: [], forms: [], dashboards: [] },
  }),
  // Annotated, not inferred. The roster shape is load-bearing for the store's
  // reducer, and a fixture whose fields widen to `never[]` would be testing a
  // tree the store never sees.
  fetchActiveSchemas: async () => ({ at: "2023-11-14T22:13:20.000Z", total: 0, agents: [], ready: 0, stubCount: 0 }),
  // Never called in these tests -- no effect runs -- but the transport is a
  // complete interface, and a half-implemented one would make this file's
  // fixtures drift from what a real client provides.
  fetchSchema: async () => schema,
};

/** Never reached without effects; present so the interface is whole. */
const schema: AgentSchema = {
  id: "log-anomaly",
  title: "Log anomalies",
  domain: "anomaly",
  version: "1.0.0",
  capabilities: ["find bursts"],
  streams: [],
  rules: [],
};

const live: LiveSource = { fetchLive: async () => Promise.reject(new Error("no live transport")) };

const DIFF: ReconciliationDiff = {
  at: "2023-11-14T22:13:20.000Z",
  source: "the record",
  tenant: "acme",
  recordVersion: 2,
  expectedVersion: 2,
  summary: "1 difference(s) to look at. Nothing has been changed for you.",
  differences: [
    {
      key: "no-live-window-yet|agent log-anomaly",
      kind: "no-live-window-yet",
      subject: "agent log-anomaly",
      recorded: "registered",
      live: "nothing observed yet",
      whatToDo: "Nothing to do unless it stays this way.",
      acknowledged: false,
      acknowledgedAt: null,
      seenCount: 0,
    },
  ],
  corruptions: [],
  recorded: { verdicts: [], alerts: [] },
};

function tree(overrides: Partial<Parameters<typeof App>[0]> = {}): string {
  return renderToStaticMarkup(
    <App store={new SchemaStore()} source={source} liveSource={live} pollMs={60_000} {...overrides} />,
  );
}

describe("with no record to compare against", () => {
  it("draws NOTHING, so an absent record cannot read as an agreeing one", () => {
    const rendered = tree();
    expect(rendered).not.toContain("From the record");
    expect(rendered).not.toContain("Differences to look at");
    expect(rendered).not.toContain("difference(s) to look at");
  });

  it("draws nothing for an explicit null either", () => {
    // `null` means "asked, and there is no record". The panel handles both, and
    // both are silent -- an empty diff would be a claim, not a rendering.
    const rendered = tree({ reconciliation: null });
    expect(rendered).not.toContain("From the record");
  });
});

describe("the panel's place in the tree", () => {
  const rendered = tree({ reconciliation: DIFF, onAcknowledge: () => {} });

  it("is present, headed as the record", () => {
    expect(rendered).toContain("From the record");
  });

  it("is a SIBLING of the live column, not a descendant of it", () => {
    // The structural half of rule 1. Asserted on nesting because nesting IS the
    // rule: if the record panel closed before the live column opened, no element
    // can belong to both, and no future edit can quietly merge them.
    const recordOpen = rendered.indexOf('<section class="record"');
    const recordClose = rendered.indexOf("</section>", recordOpen);
    const liveOpen = rendered.indexOf('<aside class="app__side">');
    expect(recordOpen).toBeGreaterThan(-1);
    expect(liveOpen).toBeGreaterThan(recordClose);
  });

  it("carries the difference and what to do about it", () => {
    expect(rendered).toContain("agent log-anomaly");
    expect(rendered).toContain("Nothing to do unless it stays this way");
  });

  it("offers seeing and nothing that resolves", () => {
    expect(rendered).toContain("I have seen this");
    expect(rendered).not.toMatch(/Resolve|Dismiss|Migrate now/);
  });

  it("offers NO acknowledge button when the caller wired none", () => {
    // A button wired to nothing is the "an agent that appears but does not open"
    // failure: the operator presses it, nothing happens, and the record looks
    // broken.
    const without = tree({ reconciliation: DIFF });
    expect(without).not.toContain("I have seen this");
    // ...and the row still says it has not been looked at, which is the fact.
    expect(without).toContain("Not looked at yet.");
  });
});
