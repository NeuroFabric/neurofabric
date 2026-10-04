import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LiveStreamView } from "./LiveStreamView";
import { ReconciliationPanel } from "./ReconciliationPanel";
import type { LiveVerdict } from "../api/live-contracts";
import type { ReconciliationDiff } from "../api/memory-contracts";

/**
 * SLICE 6 (F6b). THE TWO SURFACES, AND WHY THEY MUST NOT MIX.
 *
 * === THE DEFECT THIS EXISTS FOR ===
 *
 * **`.live` had no rule in `styles.css` at all.** The live panel rendered with
 * whatever its container gave it, while the record panel -- added in !105 --
 * arrived with its own ground, its own border and its own header. So the
 * two-truths contract (ADR-005 §9) was true in MARKUP and false ON SCREEN: a
 * reader scanning for "which of these numbers is now?" had to tell two panels
 * apart by their contents, which is the opposite of structural separation.
 *
 * Nothing caught it, because the markup tests were correct and the stylesheet was
 * nobody's business. A guard that only reads JSX cannot see that a surface has
 * no style, so this one reads both -- and says which half it is reading.
 *
 * === WHAT IS ASSERTED WHERE, AND WHY ===
 *
 *  - **Perception, on markup** (Law 3): the two surfaces are distinct regions,
 *    neither nests the other, and each names itself in words.
 *  - **Storage, on the stylesheet**: that the two grounds differ. This is the one
 *    place a text read is right rather than a compromise, and it follows the
 *    precedent `css-collision-guard.test.ts` set -- the rule being defended is a
 *    rule about NAMES and DECLARATIONS, which is exactly what text is.
 *
 * A figure's surface is decided by where it is rendered, never by its value. That
 * is the constraint every rule below exists to hold.
 */

const STYLES = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

const AT = "2026-10-04T14:32:05.000Z";

const live = (overrides: Partial<LiveVerdict> = {}): LiveVerdict => ({
  at: AT,
  records: 20_000,
  open: false,
  columns: [],
  breachedColumns: 0,
  busiestHour: null,
  topKeys: [],
  synthetic: false,
  ...overrides,
});

const diff: ReconciliationDiff = {
  at: AT,
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
  recorded: {
    verdicts: [{ agentId: "acme/log-anomaly", at: AT, provider: "pega", records: 262, breached: true }],
    alerts: [],
  },
};

const liveHtml = renderToStaticMarkup(
  <LiveStreamView verdict={live()} throughput={{ records: 20_000, delta: 0, windowMs: 500, eventsPerSecond: 0 }} loading={false} idle={false} />,
);
const recordHtml = renderToStaticMarkup(<ReconciliationPanel diff={diff} now={Date.parse(AT) + 60_000} />);

describe("the two surfaces are distinct regions", () => {
  it("the live panel says which half it is", () => {
    expect(liveHtml).toContain('data-surface="live"');
    expect(liveHtml).toContain("Live telemetry");
  });

  it("the record panel says which half it is", () => {
    expect(recordHtml).toContain('data-surface="record"');
    expect(recordHtml).toContain("From the record");
  });

  it("NEITHER SURFACE IS INSIDE THE OTHER", () => {
    // A live figure nested in the record panel, or the reverse, is the exact
    // failure rule 1 forbids -- and it would render perfectly while doing it.
    expect(recordHtml).not.toContain('data-surface="live"');
    expect(liveHtml).not.toContain('data-surface="record"');
  });

  it("the two headers do not use each other's words", () => {
    // "Live telemetry" must not be the record panel's title, or a reader has no
    // way to tell which surface a caption belongs to.
    expect(recordHtml).not.toContain("Live telemetry");
    expect(liveHtml).not.toContain("From the record");
  });
});

describe("no recorded figure is presented without its age", () => {
  it("every recorded verdict carries one", () => {
    const spoken = recordHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    expect(spoken).toMatch(/recorded \d{2}:\d{2}:\d{2}/);
    expect(spoken).toContain("1 minute ago");
  });

  it("the comparison itself carries one", () => {
    // Without the check stamp, the whole comparison is a statement with no date,
    // left open in a tab, which reads as current.
    expect(recordHtml.replace(/<[^>]*>/g, " ")).toContain("Checked");
  });
});

describe("the surfaces differ on screen, not only in markup", () => {
  /** The declaration block for one selector, or an empty string. */
  function ruleFor(selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^\\.${escaped}\\s*\\{([^}]*)\\}`, "m").exec(STYLES);
    return match?.[1] ?? "";
  }

  it("the live surface IS styled, which it was not before this slice", () => {
    // THE ANTI-SWING. `.live` had no rule at all, and every JSX assertion in this
    // repository passed while it had none. This test is here so that "a surface
    // with no style" cannot come back quietly.
    expect(ruleFor("live")).not.toBe("");
  });

  it("the record surface IS styled", () => {
    expect(ruleFor("record")).not.toBe("");
  });

  it("their GROUNDS differ, so the distinction survives greyscale", () => {
    // Not just their edges. A reader who cannot see the accent still needs to
    // tell the two apart, and that only works if the fills differ.
    const liveGround = /background:\s*([^;]+)/.exec(ruleFor("live"))?.[1]?.trim();
    const recordGround = /background:\s*([^;]+)/.exec(ruleFor("record"))?.[1]?.trim();
    expect(liveGround).toBeTruthy();
    expect(recordGround).toBeTruthy();
    expect(liveGround).not.toBe(recordGround);
  });

  it("their EDGES differ, so a printed page keeps the distinction", () => {
    const liveEdge = /border-left:\s*([^;]+)/.exec(ruleFor("live"))?.[1]?.trim();
    const recordEdge = /border-left:\s*([^;]+)/.exec(ruleFor("record"))?.[1]?.trim();
    expect(liveEdge).toBeTruthy();
    expect(recordEdge).toBeTruthy();
    expect(liveEdge).not.toBe(recordEdge);
  });

  it("NOTHING IN THE RECORD SURFACE ANIMATES", () => {
    // Rule 3 in one assertion. An animation on a recorded value is a claim that
    // it is happening now, and the one animation in this stylesheet is the live
    // pulse. The block is bounded so a later `.record` rule cannot hide behind
    // the section above it.
    const recordBlock = STYLES.slice(STYLES.indexOf(".record {"));
    expect(recordBlock.slice(0, recordBlock.indexOf("}"))).not.toMatch(/animation/);
  });
});
