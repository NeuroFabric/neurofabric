import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { LiveStreamView } from "./LiveStreamView";
import { AlertCenter } from "./AlertCenter";
import { simulateVerdict, validateLiveVerdict, type AlertPayload, type LiveVerdict } from "../api/live-contracts";

function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

/**
 * The TEXT of a render, with markup removed.
 *
 * Needed because assertions on raw markup match things nobody meant to write:
 * a search for "/sec" finds `</section>`. Every claim about what a user READS is
 * made against text, and only claims about structure (rows, elements, selected
 * attributes) are made against markup.
 */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * THE LIVE VIEWS, AND THE CLAIMS THEY REFUSE TO MAKE.
 *
 * The most important tests in this file are negative: they assert that a
 * throughput figure is NOT rendered, and that a simulated sample IS labelled.
 * A dashboard's credibility is its arithmetic, and the cheapest way to destroy
 * it is to display a confident number that nothing measured.
 */

describe("LiveStreamView", () => {
  it("states an explicit absence rather than spinning forever", () => {
    const html = render(<LiveStreamView verdict={null} />);
    expect(html).toContain("No snapshot yet");
    // A spinner that never resolves is indistinguishable from a working pipeline.
    expect(html).not.toContain("Loading");
  });

  it("renders a transport error rather than an empty panel", () => {
    expect(render(<LiveStreamView verdict={null} error="the gateway refused" />)).toContain("the gateway refused");
  });

  it("labels the record count as a count, not a rate", () => {
    const html = render(<LiveStreamView verdict={simulateVerdict(7, 257_000)} />);
    expect(html).toContain("records in snapshot");
    expect(html).toContain("a count, not a rate");
  });

  it("never renders a per-second throughput figure", () => {
    // The single most important assertion in this file. There is no endpoint
    // that reports a rate, so any "/sec" or "events per second" text here would
    // be a number this component invented.
    //
    // Asserted against TEXT, not markup: searching raw HTML for "/sec" finds
    // the closing `</section>` tag and fails for a reason that has nothing to
    // do with the claim.
    const html = render(<LiveStreamView verdict={simulateVerdict(7, 257_000)} />);
    const body = text(html);
    expect(body).not.toContain("/sec");
    expect(body).not.toContain("per second");
    expect(body).not.toContain("events/s");
    expect(body).not.toContain("throughput");
    // The count it was fed is displayed, and is a count.
    expect(body).toContain("257,000");
    expect(body).toContain("a count, not a rate");
  });

  it("banners a simulated sample so it cannot be read as measured", () => {
    const html = render(<LiveStreamView verdict={simulateVerdict(7, 1000)} />);
    expect(html).toContain("SIMULATED SAMPLE");
    expect(html).toContain("generated, not measured");
  });

  it("does not banner a real verdict", () => {
    const real: LiveVerdict = { ...simulateVerdict(1, 10), synthetic: false };
    expect(render(<LiveStreamView verdict={real} />)).not.toContain("SIMULATED SAMPLE");
  });

  it("renders measured, min, max and the fence it judged against", () => {
    const verdict = simulateVerdict(3, 5000);
    const column = verdict.columns[0];
    expect(column).toBeDefined();
    const html = render(<LiveStreamView verdict={verdict} />);
    expect(html).toContain(column?.column ?? "missing");
    expect(html).toContain("measured");
    expect(html).toContain("outer fence");
    expect(html).toMatch(/within fence|BREACHED/);
  });

  it("marks a sampled quantile as sampled", () => {
    // A fence drawn from a sample must never be read as a hard boundary.
    const verdict = simulateVerdict(3, 100);
    expect(verdict.columns[0]?.quantilesSampled).toBe(true);
    expect(render(<LiveStreamView verdict={verdict} />)).toContain("(sampled)");
  });

  it("says when no column could be judged", () => {
    const empty: LiveVerdict = { ...simulateVerdict(1, 0), columns: [], topKeys: [], breachedColumns: 0 };
    const html = render(<LiveStreamView verdict={empty} />);
    expect(html).toContain("No column carried enough measurements");
  });

  it("keeps a breached column visible as breached", () => {
    const verdict = simulateVerdict(11, 9000);
    const breached = verdict.columns.filter((c) => c.breached);
    expect(breached.length).toBeGreaterThan(0);
    const html = render(<LiveStreamView verdict={verdict} />);
    expect(html).toContain("BREACHED");
  });

  it("renders no per-event log, so there is nothing for the DOM to choke on", () => {
    // At any real rate a log line per event is a heap problem, not a rendering
    // problem. The aggregate columns ARE the log, read as statistics.
    const verdict = simulateVerdict(5, 257_000);
    const html = render(<LiveStreamView verdict={verdict} />);
    const bodyRows = html.split("<tbody>")[1]?.match(/<tr>/g)?.length ?? 0;
    // One row per COLUMN, never one per record.
    expect(bodyRows).toBe(verdict.columns.length);
  });
});

describe("validateLiveVerdict", () => {
  it("accepts a verdict that states its provenance", () => {
    expect(validateLiveVerdict({ ...simulateVerdict(1, 1), synthetic: false }).ok).toBe(true);
  });

  it("refuses a verdict with no provenance rather than assuming it is real", () => {
    const verdict = { ...simulateVerdict(1, 1) } as Record<string, unknown>;
    delete verdict.synthetic;
    const result = validateLiveVerdict(verdict);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Defaulting would let a source that forgot the field render as measured.
    expect(result.issues[0]?.reason).toContain("may not be assumed real");
  });

  it("refuses a non-object", () => {
    expect(validateLiveVerdict("nope").ok).toBe(false);
  });

  it("refuses a verdict missing its record count", () => {
    expect(validateLiveVerdict({ ...simulateVerdict(1, 1), records: "many" }).ok).toBe(false);
  });
});

describe("simulateVerdict", () => {
  it("is deterministic, so a test or a screenshot reproduces", () => {
    // A generator that differs on every call makes every visual test flaky and
    // every bug report unreproducible.
    expect(JSON.stringify(simulateVerdict(42, 1000))).toBe(JSON.stringify(simulateVerdict(42, 1000)));
  });

  it("always marks itself synthetic", () => {
    expect(simulateVerdict(9, 5).synthetic).toBe(true);
  });
});

describe("AlertCenter", () => {
  const verdictWithBreach = (): LiveVerdict => ({
    ...simulateVerdict(2, 4000),
    breachedColumns: 1,
    columns: simulateVerdict(2, 4000).columns.map((c, i) => (i === 0 ? { ...c, breached: true, breachedEverywhere: false } : c)),
  });

  const alert = (overrides: Partial<AlertPayload> = {}): AlertPayload => ({
    id: "abc123",
    title: "kafka: 2 columns past the outer fence",
    body: "Latency exceeded the outer fence across 3 partitions.",
    severity: "warning",
    source: "kafka",
    at: "2026-10-03T00:00:00.000Z",
    summary: { records: 4000, open: true, breachedColumns: 2, partitions: 3 },
    columns: [{ column: "latency_ms", partitions: 3, max: 4200, fenceUpper: 3000, multiple: 1.4, breachedEverywhere: false }],
    ...overrides,
  });

  it("says an empty alert list is the healthy one", () => {
    const html = render(<AlertCenter alerts={[]} verdict={null} />);
    expect(html).toContain("An empty alert list is the only healthy one");
  });

  it("renders a dispatched payload with its backend severity", () => {
    const html = render(<AlertCenter alerts={[alert()]} verdict={null} />);
    expect(html).toContain("warning");
    expect(html).toContain("kafka");
    expect(html).toContain("latency_ms");
    expect(html).toContain("some partitions");
  });

  it("keeps the one-partition-versus-every-partition distinction visible", () => {
    // The whole point of the view. Restart a replica, or page the fleet.
    const html = render(<AlertCenter alerts={[alert()]} verdict={null} />);
    expect(html).toContain("some partitions");
    expect(html).not.toContain("every partition");
  });

  it("does not recompute severity; it shows what the backend decided", () => {
    // The backend says `info` with nothing breached. A component that re-derived
    // severity from the column list would have to agree, and the day somebody
    // edits either policy is the day they would not.
    const html = render(
      <AlertCenter
        alerts={[
          alert({
            severity: "info",
            summary: { records: 1, open: true, breachedColumns: 0, partitions: 3 },
            columns: [],
          }),
        ]}
        verdict={null}
      />,
    );
    expect(text(html)).toContain("info");
    expect(text(html)).toContain("No column breached in this snapshot.");
  });

  it("falls back to the verdict, and labels that it is not a dispatched alert", () => {
    const html = render(<AlertCenter alerts={[]} verdict={verdictWithBreach()} />);
    expect(html).toContain("From the live verdict, not a dispatched alert");
    expect(html).toContain("SIMULATED");
  });

  it("shows a clean verdict without pretending an alert exists", () => {
    const clean: LiveVerdict = { ...simulateVerdict(1, 10), breachedColumns: 0, columns: [] };
    const html = render(<AlertCenter alerts={[]} verdict={clean} />);
    expect(html).toContain("An empty alert list is the only healthy one");
  });

  it("prefers a dispatched payload over the verdict fallback", () => {
    const html = render(<AlertCenter alerts={[alert()]} verdict={verdictWithBreach()} />);
    expect(html).not.toContain("From the live verdict");
  });

  it("renders many alerts without nesting or crashing", () => {
    const alerts = Array.from({ length: 50 }, (_, i) => alert({ id: `id-${i}`, title: `alert ${i}` }));
    const html = render(<AlertCenter alerts={alerts} verdict={null} />);
    expect(html).toContain("alert 49");
  });
});