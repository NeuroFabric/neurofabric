import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LiveStreamView } from "./LiveStreamView";
import type { LiveVerdict, ThroughputReading } from "../api/live-contracts";

/**
 * THE COUNT AND THE RATE, EXPLAINED. Slice 5, F6a. The anti-swing test.
 *
 * === THE AMBIGUITY BEING KILLED ===
 *
 * The runbook's strongest beat is throughput reading `0 events/sec` while the
 * record count holds at 20,000. Displayed side by side, those look like two
 * numbers that cannot both be true, and the operator's conclusion -- correctly, as
 * a general matter -- is that one of them is broken. So one of the two numbers
 * stops being read, and the panel has lost the ability to say anything.
 *
 * They are not in conflict. One is how much the window HOLDS; the other is how
 * much ARRIVED in the last moment measured. The fix is not better arithmetic --
 * the arithmetic was always right -- it is a SENTENCE.
 *
 * === WHY THIS FILE ASSERTS ON TEXT, NOT ON A BOOLEAN ===
 *
 * Project Law 3. A `data-condition="quiet"` attribute proves a branch was taken;
 * it proves nothing about whether an operator would understand the difference.
 * So every assertion here is against the words, because the words are the feature.
 * The one structural assertion is the negative one -- that the explanation is NOT
 * present in the states where it would be wrong -- because that is a case where
 * the presence of markup is itself the defect.
 */

function spoken(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function verdict(overrides: Partial<LiveVerdict> = {}): LiveVerdict {
  return {
    at: "2026-10-04T14:32:05.000Z",
    records: 20_000,
    open: false,
    columns: [],
    breachedColumns: 0,
    busiestHour: null,
    topKeys: [],
    synthetic: false,
    ...overrides,
  };
}

function throughput(overrides: Partial<ThroughputReading> = {}): ThroughputReading {
  return { eventsPerSecond: 0, windowMs: 500, delta: 0, records: 20_000, ...overrides };
}

function render(props: {
  readonly records?: number;
  readonly throughput: ThroughputReading | null;
  readonly idle?: boolean;
}): string {
  return renderToStaticMarkup(
    <LiveStreamView
      verdict={verdict({ records: props.records ?? 20_000 })}
      throughput={props.throughput}
      loading={false}
      error={undefined}
      idle={props.idle ?? false}
    />,
  );
}

describe("a quiet feed: zero rate, records held", () => {
  const html = render({ throughput: throughput() });
  const words = spoken(html);

  it("EXPLAINS the two figures rather than only showing them", () => {
    // The whole point. Both numbers were already on screen; the ambiguity is what
    // is removed.
    expect(words).toContain("why the rate is zero");
    expect(words).toContain("Nothing new has arrived");
    expect(words).toContain("20,000");
    expect(words).toContain("still held from earlier");
  });

  it("says the two figures MEASURE DIFFERENT THINGS, in those words", () => {
    // Not "the window is cumulative" -- that is this codebase's word. The reader
    // needs the distinction, not the terminology.
    expect(words).toContain("measure different things");
    expect(words).toContain("expected to disagree");
  });

  it("distinguishes a QUIET feed from a STOPPED one, and says where a fault would show", () => {
    // ADR-005 §6: "A feed that is quiet is a condition. A feed that is stopped is
    // a fault." An operator who cannot tell those apart cannot act, and the
    // sentence is only reassuring if they know what a fault would look like.
    expect(words).toContain("quiet feed");
    expect(words).toContain("stopped");
    expect(words).toContain("last answer");
  });

  it("uses the WINDOW the rate was measured over, not a round number", () => {
    // Because the explanation is about that specific measurement. A hard-coded
    // "500ms" here would be a caption that lies the moment the poll changes.
    expect(words).toContain("500ms");
  });
});

describe("the explanation appears ONLY where it is true", () => {
  it("not when the rate is non-zero", () => {
    // Traffic is flowing. An explanation of why a rate is zero, shown beside a
    // healthy rate, is noise that trains a reader to skip the panel.
    const words = spoken(render({ throughput: throughput({ eventsPerSecond: 412, delta: 206 }) }));
    expect(words).not.toContain("why the rate is zero");
  });

  it("not when the window is empty, where there is nothing to disagree with", () => {
    // Zero records and zero rate agree with each other. Explaining a
    // non-contradiction is how a panel loses the habit of being read.
    const words = spoken(render({ records: 0, throughput: throughput(), idle: true }));
    expect(words).not.toContain("why the rate is zero");
  });

  it("not when there is no measurement yet", () => {
    // One observation cannot produce a rate. Saying "nothing has arrived in the
    // last 500ms" when no window was measured would be a fabricated claim.
    const words = spoken(render({ throughput: null }));
    expect(words).not.toContain("why the rate is zero");
  });

  it("not when a sub-second non-zero rate rounds down to zero on screen", () => {
    // The honest edge: `eventsPerSecond` is a real number and may be 0.4, which
    // `toLocaleString` renders as "0". Explaining a rate of zero when the truth
    // is "some arrived" would be worse than showing nothing.
    const words = spoken(render({ throughput: throughput({ eventsPerSecond: 0.4, delta: 1 }) }));
    expect(words).toContain("0");
    expect(words).not.toContain("why the rate is zero");
  });
});

describe("the words themselves", () => {
  /**
   * ONLY THE EXPLANATION IS SWEPT, and scoping it matters.
   *
   * The panel as a whole says "records in snapshot" and "measured throughput",
   * which are settled vocabulary from earlier slices and are defended by
   * `app-default-view.test.tsx`'s marker list. Sweeping the entire panel here
   * would make this test a second opinion on a decision somebody already made --
   * and a test that fights settled vocabulary gets deleted, taking the real
   * assertion with it.
   *
   * So the sweep is scoped to the block this slice added. That is the copy with
   * no settled precedent, which is exactly the copy at risk.
   */
  const explanation = (): string => {
    const html = render({ throughput: throughput() });
    const from = html.indexOf('<div class="quiet"');
    expect(from).toBeGreaterThan(-1);
    return spoken(html.slice(from));
  };

  it("contain none of this codebase's internal vocabulary", () => {
    // PROJECT LAW 1, applied to a test that pins wording. A jargon sweep that
    // lists forbidden strings is the only thing that keeps them out.
    //
    // The FIRST draft of this copy said "this window is still holding, and a
    // window does not empty itself". This test went red on its own wording --
    // "window" is the engine's word, not an operator's -- and the copy was
    // reworded rather than the assertion relaxed. That is the whole point of
    // pinning wording: it defends the writing, not the writer's confidence.
    for (const term of ["cumulative", "window", "snapshot", "delta", "meter", "throughput", "null", "undefined"]) {
      expect(explanation().toLowerCase(), `the explanation says "${term}"`).not.toContain(term);
    }
  });

  it("name the reading interval in a unit a reader already uses", () => {
    expect(explanation()).toMatch(/\d+ms/);
  });

  it("still say everything the reader needs, after the rewording", () => {
    // The reword must not have cost the explanation its content. This is the
    // anti-swing half: a jargon fix that deletes the point is not a fix.
    const words = explanation();
    expect(words).toContain("Nothing new has arrived");
    expect(words).toContain("measure different things");
    expect(words).toContain("quiet feed");
    expect(words).toContain("stopped");
    expect(words).toContain("still held from earlier");
  });
});
