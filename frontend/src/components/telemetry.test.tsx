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
    expect(html).toContain("Nothing has arrived yet");
    // A spinner that never resolves is indistinguishable from a working pipeline.
    expect(html).not.toContain("Loading");
  });

  it("says it is connecting while the first poll is outstanding", () => {
    expect(render(<LiveStreamView verdict={null} loading />)).toContain("Connecting");
  });

  it("renders a transport error rather than an empty panel", () => {
    expect(render(<LiveStreamView verdict={null} error="the gateway refused" />)).toContain("the gateway refused");
  });

  it("labels the record count as a count, not a rate", () => {
    const html = render(<LiveStreamView verdict={simulateVerdict(7, 257_000)} />);
    expect(html).toContain("records in snapshot");
    expect(html).toContain("a count, not a rate");
  });

  it("renders a MEASURED rate, and always with the window it was measured over", () => {
  // This test INVERTS an earlier one. The previous version asserted that no
  // per-second figure could appear, and it was right at the time: no endpoint
  // reported a rate, so any number would have been invented. One now does, and
  // the number is measured server-side by `ThroughputMeter`.
  //
  // What did NOT change is the discipline. A rate without its window is not a
  // measurement, so the window is asserted here rather than assumed -- and a
  // verdict with no reading still says so instead of showing a zero.
  const html = text(render(<LiveStreamView verdict={simulateVerdict(7, 257_000)} />));
  // The sample IS synthetic, so the banner must be present. The label is
  // conditional, not deleted: it is what makes the number trustworthy when it is
  // the other way round.
  expect(html).toContain("SIMULATED SAMPLE");

  const real = { ...simulateVerdict(7, 554_000), synthetic: false };
  const live = text(
    render(
      <LiveStreamView
        verdict={real}
        throughput={{ records: 554_000, delta: 79_000, windowMs: 1_420, eventsPerSecond: 56_690 }}
      />,
    ),
  );
  expect(live).toContain("56,690");
  expect(live).toContain("events/sec");
  // The window, and the delta it was computed from. Without both, the rate is a
  // vibe rather than a measurement.
  expect(live).toContain("1,420ms");
  expect(live).toContain("79,000");
  expect(live).not.toContain("SIMULATED SAMPLE");
});

it("says 'no reading yet' rather than a zero rate when no window exists", () => {
  // One observation cannot produce a rate, and zero would read as a dead stream.
  const html = text(render(<LiveStreamView verdict={{ ...simulateVerdict(1, 10), synthetic: false }} />));
  expect(html).toContain("no reading yet");
  expect(html).not.toContain("events/sec");
});

it("reports connected but idle, which is healthy rather than broken", () => {
  const idle = { ...simulateVerdict(1, 0), synthetic: false, records: 0, columns: [] };
  const html = text(render(<LiveStreamView verdict={idle} />));
  expect(html).toContain("No activity yet");

  // INVERTED, AND THIS IS THE POINT. This assertion used to be
  // `expect(html).toContain("pega")` -- the empty state named the provider, which
  // is internal vocabulary on a screen a stranger is looking at. It is the same
  // text the operator reported as "provider greg": a provider identifier rendered
  // as customer copy.
  //
  // So the empty state now says what is TRUE in a sentence a non-engineer can
  // act on, and the provider name is asserted ABSENT rather than present. A test
  // that pins jargon is a test that defends jargon.
  expect(html).not.toContain("pega");
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

  it("falls back to the verdict, and says where the number came from", () => {
    const html = render(<AlertCenter alerts={[]} verdict={verdictWithBreach()} />);
    expect(html).toContain("Measured directly from the data in view.");
    // The old sentence named a mechanism that does not exist on this screen.
    expect(html).not.toContain("dispatched alert");
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