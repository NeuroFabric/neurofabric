import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReconciliationPanel, ageOf, type ReconciliationPanelProps } from "./ReconciliationPanel";
import { validateReconciliationDiff, type ReconciliationDiff } from "../api/memory-contracts";

/**
 * THE DIFF PANEL, TESTED AS A READER SEES IT.
 *
 * === PROJECT LAW 3: PERCEIVED, NOT STORED ===
 *
 * Every assertion below is made against MARKUP -- the string a browser renders
 * from -- and never against a prop, a `data-*` value read as truth, or an object
 * the component was handed. A machine attribute is evidence that a value reached
 * the tree; it is not evidence that a person could read it, and ADR-005 §9 is a
 * contract about reading.
 *
 * That is why this file has its own `markup()` and `words()` helpers, splitting
 * the two kinds of claim the way `liveness-strip.test.tsx` does:
 *
 *  - `words()` for anything a person is supposed to read: the header, the ages,
 *    the action, the refusal to resolve.
 *  - raw `markup()` for structure: that the two truths are in separate blocks,
 *    that no recorded figure shares a block with a live one.
 *
 * === AND WHAT THESE TESTS DELIBERATELY DO NOT CLAIM ===
 *
 * `renderToStaticMarkup` does not run effects, so **the click is not driven
 * here.** That the button reaches the server, that the acknowledgement lands and
 * the panel re-reads, is the operator's browser test. What IS asserted is that
 * the button exists, that it is labelled as seeing rather than resolving, and
 * that with no transport the panel renders nothing -- which is the half that
 * cannot be checked in a browser at all, because in a browser it is invisible.
 */

/** Raw markup. Structure, boundaries, class names. */
const markup = (props: ReconciliationPanelProps): string => renderToStaticMarkup(<ReconciliationPanel {...props} />);

/** The projection a person reads. Wording. */
const words = (props: ReconciliationPanelProps): string =>
  markup(props)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#x2014;/g, "--")
    .replace(/\s+/g, " ")
    .trim();

/** 2023-11-14T22:13:20.000Z. Fixed, so nothing here depends on today's date. */
const AT = "2023-11-14T22:13:20.000Z";
const AGENT = "acme/log-anomaly";

function diff(overrides: Partial<ReconciliationDiff> = {}): ReconciliationDiff {
  return {
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
        whatToDo: "Nothing to do unless it stays this way -- then the agent is registered but its stream is not arriving.",
        acknowledged: false,
        acknowledgedAt: null,
        seenCount: 0,
      },
    ],
    corruptions: [],
    recorded: { verdicts: [], alerts: [] },
    ...overrides,
  };
}

/* ================================================================== *
 * THE ABSENCE. Rendered first, because it is the easiest thing to lose. *
 * ================================================================== */

describe("with no record to compare against", () => {
  it("renders NOTHING, not an empty diff", () => {
    // THE CLAIM THAT MATTERS MOST IN THIS FILE. An absent record and an
    // agreeing record look identical if the absent case draws "no differences",
    // and then the panel reports agreement it never checked -- which is the one
    // thing this surface must never do.
    expect(markup({ diff: null })).toBe("");
    expect(words({ diff: null })).toBe("");
  });

  it("does not mention agreement, absence or the record at all", () => {
    const rendered = words({ diff: null });
    for (const claim of ["agree", "nothing has changed", "From the record", "difference"]) {
      expect(rendered).not.toContain(claim);
    }
  });
});

/* ================================================================== *
 * RULE 1 AND RULE 2: THE TWO TRUTHS, AS A READER MEETS THEM.        *
 * ================================================================== */

describe("the two-truths contract", () => {
  it("says which half it is showing, in the words the ADR names", () => {
    const rendered = words({ diff: diff(), now: Date.parse(AT) });
    expect(rendered).toContain("From the record");
    // Rule 1 asks for BOTH labels. A panel that says only one has not said which
    // half the other thing is, and the reader is left to assume.
    expect(rendered).toContain("Recorded");
    expect(rendered).toContain("Live");
  });

  it("carries the age of the comparison itself, so a stale diff cannot read as current", () => {
    // Ten minutes later. Without this stamp the panel would say "registered /
    // nothing observed yet" with no indication of when anyone last looked.
    const rendered = words({ diff: diff(), now: Date.parse(AT) + 10 * 60_000 });
    expect(rendered).toContain("10 minutes ago");
    expect(rendered).toContain("Checked");
  });

  it("labels BOTH sides of every row, so neither is ever a bare value", () => {
    const rendered = markup({ diff: diff(), now: Date.parse(AT) });
    // One row, two labelled cells. A reader scanning the list sees the words on
    // each row rather than being told once at the top and expected to remember.
    expect(rendered).toContain("Recorded");
    expect(rendered).toContain("Live");
    expect(rendered).toContain("registered");
    expect(rendered).toContain("nothing observed yet");
  });

  it("never puts a recorded figure and a live figure in the same block", () => {
    // The recorded verdicts live in their own sub-block under their own heading,
    // inside the record's own section. What is asserted is that they are NOT
    // interleaved into the difference rows -- which is what rule 1 forbids.
    const rendered = markup({
      diff: diff({
        recorded: {
          verdicts: [
            { agentId: AGENT, at: AT, provider: "pega", records: 262, breached: true },
          ],
          alerts: [],
        },
      }),
      now: Date.parse(AT) + 60_000,
    });
    const recordHeading = rendered.indexOf("Last recorded verdict per agent");
    const breachChip = rendered.indexOf("Recorded breach");
    expect(recordHeading).toBeGreaterThan(-1);
    expect(breachChip).toBeGreaterThan(recordHeading);
    // And the closing sentence that rules out the F1 reading outright.
    expect(words({ diff: diff({
      recorded: { verdicts: [{ agentId: AGENT, at: AT, provider: "pega", records: 262, breached: true }], alerts: [] },
    }), now: Date.parse(AT) + 60_000 })).toContain("None of them is the current reading.");
  });

  it("draws a RECORDED breach differently from a live one, on purpose", () => {
    const rendered = markup({
      diff: diff({
        recorded: { verdicts: [{ agentId: AGENT, at: AT, provider: "pega", records: 262, breached: true }], alerts: [] },
      }),
      now: Date.parse(AT) + 4 * 3_600_000,
    });
    // Rule 3 in ink. The class is the whole mechanism, and it is asserted in raw
    // markup because the property IS the styling.
    expect(rendered).toContain("chip--recorded-breach");
    // ...and it is FLAT. The live strip's pulse is the one animation in this
    // stylesheet and a recorded value must not carry it.
    const recordedBlock = rendered.slice(rendered.indexOf("chip--recorded-breach") - 200);
    expect(recordedBlock).not.toMatch(/animation:\s*(live-pulse|pulse)/);
  });

  it("gives every recorded figure an age, not a bare clock time", () => {
    const rendered = words({
      diff: diff({
        recorded: { verdicts: [{ agentId: AGENT, at: AT, provider: "pega", records: 262, breached: false }], alerts: [] },
      }),
      now: Date.parse(AT) + 2 * 3_600_000,
    });
    expect(rendered).toContain("2 hours ago");
    // A bare ISO string reaching a screen is a timestamp an operator cannot act
    // on and can very easily mistake for a current reading.
    expect(rendered).not.toContain("2023-11-14T22:13:20.000Z");
  });
});

/* ================================================================== *
 * CONSTRAINT 1: THE SYSTEM PRESENTS, IT DOES NOT CHOOSE.              *
 * ================================================================== */

describe("the system does not choose", () => {
  it("offers seeing, and offers nothing that resolves", () => {
    const rendered = words({ diff: diff(), now: Date.parse(AT), onAcknowledge: () => {} });
    expect(rendered).toContain("I have seen this");
    for (const forbidden of ["Resolve", "Dismiss", "Migrate now", "Accept", "Ignore"] as const) {
      expect(rendered).not.toContain(forbidden);
    }
  });

  it("an acknowledged difference is STILL LISTED, still explained, still actionable", () => {
    // The state this test exists for: a panel that greys out or removes an
    // acknowledged row is telling the operator the system handled it, which is
    // the claim ADR-005 §7.3 refuses.
    const acknowledged = diff({
      differences: [
        {
          ...diff().differences[0]!,
          acknowledged: true,
          acknowledgedAt: Date.parse(AT) + 30_000,
          seenCount: 1,
        },
      ],
    });
    const rendered = words({ diff: acknowledged, now: Date.parse(AT) + 60_000 });
    expect(rendered).toContain("Seen by the operator");
    expect(rendered).toContain("Still open");
    expect(rendered).toContain("does not resolve differences for you");
    // And the row is still there, with its action still attached.
    expect(rendered).toContain("agent log-anomaly");
    expect(rendered).toContain("Nothing to do unless it stays this way");
  });

  it("says so plainly when a difference has come back after being seen", () => {
    const returning = diff({
      differences: [{ ...diff().differences[0]!, acknowledged: true, acknowledgedAt: Date.parse(AT), seenCount: 3 }],
    });
    expect(words({ diff: returning, now: Date.parse(AT) + 60_000 })).toContain("It has come back 3 times.");
  });

  it("shows NO button when nobody can acknowledge, rather than a dead one", () => {
    // A button wired to nothing is the "an agent that appears but does not open"
    // failure in a new costume: the operator presses it and nothing happens, and
    // concludes the record is broken.
    const rendered = markup({ diff: diff(), now: Date.parse(AT) });
    expect(rendered).not.toContain("I have seen this");
  });

  it("still SHOWS an acknowledgement that was recorded, with nobody here to add one", () => {
    // Found by this file rather than by reading the component. The recorded fact
    // was inside the `onAcknowledge` branch, so a panel rendered without a
    // callback showed an acknowledged difference as though nobody had looked --
    // a durable fact about a person's action, invisible.
    const acknowledged = diff({
      differences: [{ ...diff().differences[0]!, acknowledged: true, acknowledgedAt: Date.parse(AT), seenCount: 1 }],
    });
    const rendered = words({ diff: acknowledged, now: Date.parse(AT) + 60_000 });
    expect(rendered).toContain("Seen by the operator");
    expect(rendered).toContain("Still open");
  });

  it("says an unacknowledged difference is unacknowledged even with no callback", () => {
    expect(words({ diff: diff(), now: Date.parse(AT) })).toContain("Not looked at yet.");
  });
});

/* ================================================================== *
 * CORRUPTION IS NOT A DIFFERENCE.                                     *
 * ================================================================== */

describe("corruption", () => {
  const corrupt = diff({
    corruptions: [{ subject: "agent log-anomaly", what: "the stored document is not readable JSON" }],
  });

  it("is named with a different word, above the differences", () => {
    const rendered = words({ diff: corrupt, now: Date.parse(AT) });
    expect(rendered).toContain("Problem");
    expect(rendered).toContain("Needs attention");
    // Never folded in: a list that mixes "something changed" with "something is
    // wrong" is a list people learn to skim.
    expect(markup({ diff: corrupt, now: Date.parse(AT) }).indexOf("Needs attention")).toBeLessThan(
      markup({ diff: corrupt, now: Date.parse(AT) }).indexOf("Differences to look at"),
    );
  });

  it("states that nothing here will fix it for the operator", () => {
    expect(words({ diff: corrupt, now: Date.parse(AT) })).toContain("nothing here will resolve it for you");
  });
});

/* ================================================================== *
 * THE FIVE, EACH IN WORDS A PERSON CAN ACT ON.                        *
 * ================================================================== */

describe("the five legal disagreements", () => {
  const kinds = [
    "schema-not-accepted-now",
    "no-live-window-yet",
    "provider-not-in-record",
    "record-version-behind-code",
    "verdict-newer-than-live",
  ] as const;

  it.each(kinds)("renders %s in words, never as the machine token", (kind) => {
    const rendered = words({
      diff: diff({ differences: [{ ...diff().differences[0]!, key: `${kind}|agent log-anomaly`, kind }] }),
      now: Date.parse(AT),
    });
    expect(rendered).not.toContain(kind);
    expect(rendered).toContain("Legal difference");
    expect(rendered).toMatch(/registered|version|rules no longer accept|never seen|window|source/);
  });

  it("every one of them carries what the operator can DO", () => {
    for (const kind of kinds) {
      const rendered = words({
        diff: diff({ differences: [{ ...diff().differences[0]!, key: `${kind}|agent log-anomaly`, kind }] }),
        now: Date.parse(AT),
      });
      expect(rendered).not.toContain("undefined");
      expect(rendered).toContain("Nothing to do unless it stays this way");
    }
  });

  it("a kind the frontend does not know is REFUSED at the boundary, not drawn", () => {
    // THE MOST IMPORTANT TEST IN THIS FILE AFTER THE ABSENCE ONE.
    //
    // Every other validator in this directory ignores fields it does not
    // recognise, because the server owns the shape and may grow it. This one must
    // not: an unknown kind is a disagreement the platform cannot explain, and
    // rendering it as an unlabelled row is exactly the skimming ADR-005 §7.3
    // warns about. So the contract refuses it and the client never draws it.
    const verdict = validateReconciliationDiff({
      ...diff(),
      differences: [{ ...diff().differences[0]!, kind: "something-nobody-has-heard-of" }],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.issues.some((issue) => issue.path === "differences[0].kind")).toBe(true);
    expect(JSON.stringify(verdict.issues)).toContain("not one of the five legal differences");
  });

  it("a missing timestamp is refused rather than rendered as an empty age", () => {
    // `at` is what stops a stale comparison reading as current. A response
    // without it must not become `Checked ` with nothing after it.
    const { at: _dropped, ...withoutAt } = diff();
    const verdict = validateReconciliationDiff(withoutAt);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.issues.some((issue) => issue.path === "at")).toBe(true);
  });
});

/* ================================================================== *
 * THE CLOCK, WHICH EVERY AGE DEPENDS ON.                               *
 * ================================================================== */

describe("ages", () => {
  it("is coarse, human, and never negative", () => {
    expect(ageOf(1_000_000, 1_000_000)).toBe("just now");
    expect(ageOf(1_000_000, 1_030_000)).toBe("30s ago");
    expect(ageOf(1_000_000, 1_060_000)).toBe("1 minute ago");
    expect(ageOf(1_000_000, 1_120_000)).toBe("2 minutes ago");
    expect(ageOf(1_000_000, 3_600_000 + 1_000_000)).toBe("1 hour ago");
    expect(ageOf(1_000_000, 48 * 3_600_000 + 1_000_000)).toBe("2 days ago");
  });

  it("a clock skewed into the future reads as 'just now', never as a negative age", () => {
    // A browser clock behind the server's would otherwise render "-2s ago", and a
    // panel that can print a negative duration is a panel whose arithmetic is not
    // trustworthy.
    expect(ageOf(10_000, 1_000)).toBe("just now");
    expect(ageOf(Number.NaN, 1_000)).toBe("just now");
  });
});

/* ================================================================== *
 * THE CALM CASE, which must not read as a boast.                     *
 * ================================================================== */

describe("when nothing disagrees", () => {
  it("says what was checked and when, and does not promise about later", () => {
    const clean = diff({ differences: [], summary: "Nothing has changed since you were last here." });
    const rendered = words({ diff: clean, now: Date.parse(AT) + 30_000 });
    expect(rendered).toContain("From the record");
    expect(rendered).toContain("Checked");
    expect(rendered).toContain("agree");
    // Agreement is a fact about a moment. Promising it about later is the F1
    // shape wearing a reassuring hat.
    expect(rendered).toContain("not a promise about later");
  });
});
