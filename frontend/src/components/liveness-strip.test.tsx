import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AGE_TICK_MS,
  LivenessStrip,
  STALL_AFTER_MS,
  formatAge,
  livenessOf,
  livenessWord,
  severityFor,
  type Liveness,
} from "./LivenessStrip";

/**
 * THE LIVENESS STRIP. The !86 contract, applied.
 *
 * === THE CONTRACT, AND WHY IT EXISTS ===
 *
 * The `slice-1` commit was titled "machine attribute asserted on raw markup
 * (text() strips tags)" and the reason is worth keeping: `text()` strips tags and
 * collapses punctuation, so an assertion made against it is asserting on a
 * DIFFERENT THING than the one a machine reads. Two failures follow from using
 * it for both -- a test that passes on wording that was never wired, and a
 * reword that breaks a test nobody meant as a wording check.
 *
 * So this file splits them deliberately:
 *
 *   - **machine claims** assert on `renderToStaticMarkup(...)` RAW, via
 *     `data-*` attributes. Every state, age and severity is read from there.
 *   - **human claims** assert on `text()`, which is where wording belongs.
 *
 * A test that cannot tell which kind it is should not be written.
 */

/** Raw markup. For anything a machine reads. */
const markup = (props: Parameters<typeof LivenessStrip>[0]): string =>
  renderToStaticMarkup(<LivenessStrip {...props} />);

/** The human-readable projection. For anything a person reads. */
const words = (props: Parameters<typeof LivenessStrip>[0]): string =>
  markup(props)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const AT = Date.parse("2026-10-04T09:00:00.000Z");

const base = { lastUpdated: new Date(AT - 900).toISOString(), now: AT };

describe("livenessOf -- the decision, as a pure function", () => {
  // Tested WITHOUT rendering. The decision is arithmetic over four inputs, and
  // a decision that can only be tested through a component is a decision nobody
  // will test at its edges.

  it("says HALTED when the credential was refused, before anything else", () => {
    // FIRST, deliberately. A poller that stopped asking is not "connecting", and
    // calling it that is a lie that looks like patience.
    const verdict = livenessOf({ credentialRequired: true, lastUpdated: null, now: AT, loading: true, records: null });
    expect(verdict).toBe("halted");
  });

  it("says HALTED even when a perfectly good reading exists", () => {
    // A stale-but-valid snapshot must not paper over a stopped poller.
    expect(
      livenessOf({ credentialRequired: true, lastUpdated: new Date(AT - 100).toISOString(), now: AT, loading: false, records: 500 }),
    ).toBe("halted");
  });

  it("says CONNECTING before the first answer arrives", () => {
    expect(livenessOf({ credentialRequired: false, lastUpdated: null, now: AT, loading: true, records: null })).toBe("connecting");
  });

  it("says LIVE when an answer is fresh", () => {
    expect(livenessOf({ credentialRequired: false, lastUpdated: new Date(AT - 200).toISOString(), now: AT, loading: false, records: 42 })).toBe("live");
  });

  it("says EMPTY when connected, answering, and there is genuinely nothing", () => {
    // Distinct from stalled, and the distinction is the whole point: "idle" and
    // "broken" look identical from outside.
    expect(livenessOf({ credentialRequired: false, lastUpdated: new Date(AT - 200).toISOString(), now: AT, loading: false, records: 0 })).toBe("empty");
  });

  it("says STALLED when the last answer is too old, WHATEVER the counter says", () => {
    // THE CASE THIS STRIP EXISTS FOR: a count holding steady while the feed dies.
    const old = new Date(AT - STALL_AFTER_MS - 1).toISOString();
    expect(livenessOf({ credentialRequired: false, lastUpdated: old, now: AT, loading: false, records: 262 })).toBe("stalled");
    // And with no records at all, it is still stalled rather than empty.
    expect(livenessOf({ credentialRequired: false, lastUpdated: old, now: AT, loading: false, records: 0 })).toBe("stalled");
  });

  it("treats a future-dated instant as fresh rather than as stalled", () => {
    // "Negative age" is not a thing a viewer can act on, and calling it stalled
    // would raise an alarm about nothing.
    const future = new Date(AT + 5_000).toISOString();
    expect(livenessOf({ credentialRequired: false, lastUpdated: future, now: AT, loading: false, records: 10 })).toBe("live");
  });

  it("puts the stall boundary exactly where it is stated", () => {
    const at = new Date(AT - STALL_AFTER_MS).toISOString();
    expect(livenessOf({ credentialRequired: false, lastUpdated: at, now: AT, loading: false, records: 1 })).toBe("live");
    const past = new Date(AT - STALL_AFTER_MS - 1).toISOString();
    expect(livenessOf({ credentialRequired: false, lastUpdated: past, now: AT, loading: false, records: 1 })).toBe("stalled");
  });
});

describe("severityFor -- partial data with a visible fault", () => {
  it("shows a fault as HARD, and it wins over everything else", () => {
    expect(severityFor({ fault: "the roster was refused", liveness: "live" })).toBe("hard");
    expect(severityFor({ fault: "anything at all", liveness: "live" })).toBe("hard");
  });

  it("treats a stalled or halted feed as a fault even with no message", () => {
    expect(severityFor({ fault: null, liveness: "stalled" })).toBe("fault");
    expect(severityFor({ fault: null, liveness: "halted" })).toBe("fault");
  });

  it("is OK only when there is genuinely nothing wrong", () => {
    expect(severityFor({ fault: null, liveness: "live" })).toBe("ok");
    expect(severityFor({ fault: undefined, liveness: "live" })).toBe("ok");
    // An empty string is not a fault. `fault ?? null` would treat it as one, and
    // a permanent red banner over healthy data is the failure this avoids.
    expect(severityFor({ fault: "", liveness: "live" })).toBe("ok");
  });
});

describe("the rendered strip -- MACHINE claims, asserted on RAW markup", () => {
  const cases: readonly { readonly liveness: Liveness; readonly severity: string }[] = [
    { liveness: "connecting", severity: "ok" },
    { liveness: "live", severity: "ok" },
    { liveness: "empty", severity: "ok" },
    { liveness: "stalled", severity: "fault" },
    { liveness: "halted", severity: "fault" },
  ];

  it("publishes the state as a machine attribute in every state", () => {
    for (const { liveness, severity } of cases) {
      const html = markup({ ...base, liveness, records: 1 });
      expect(html, `liveness=${liveness}`).toContain(`data-liveness="${liveness}"`);
      expect(html, `liveness=${liveness}`).toContain(`data-severity="${severity}"`);
    }
  });

  it("carries the age as a number, so no test has to parse a sentence", () => {
    const html = markup({ ...base, liveness: "live" });
    expect(html).toContain('data-age-ms="900"');
  });

  it("uses an EMPTY age attribute rather than zero when there has never been an answer", () => {
    // Zero would mean "0ms ago" -- a reading that is precisely wrong. Null is not
    // zero, and the attribute has to be able to say so.
    const html = markup({ liveness: "connecting", lastUpdated: null, now: AT });
    expect(html).toContain('data-age-ms=""');
    expect(html).not.toContain('data-age-ms="0"');
  });

  it("gives every state a distinct class AND a distinct attribute", () => {
    // Two channels for the same fact. The class is for the stylesheet and the
    // attribute is for a machine; conflating them is how a reword breaks a test.
    const rendered = cases.map(({ liveness }) => markup({ ...base, liveness, records: 1 }));
    expect(new Set(rendered).size).toBe(cases.length);
    for (const { liveness } of cases) {
      expect(markup({ ...base, liveness, records: 1 })).toContain(`liveness--${liveness}`);
    }
  });

  it("puts the fault in the DOM when one exists, and out of it when none does", () => {
    const withFault = markup({ ...base, liveness: "live", fault: "the roster was refused" });
    expect(withFault).toContain("liveness__fault");
    expect(withFault).toContain("the roster was refused");
    expect(markup({ ...base, liveness: "live" })).not.toContain("liveness__fault");
  });

  it("omits the record count when there is none rather than printing zero", () => {
    expect(markup({ ...base, liveness: "connecting", records: null })).not.toContain("liveness__records");
    expect(markup({ ...base, liveness: "live", records: 262 })).toContain("262");
  });
});

describe("the rendered strip -- HUMAN claims, asserted through text()", () => {
  // Wording belongs here and nowhere else. If one of these fails, the WORD
  // changed; the behaviour did not.

  it("gives every state a word a person can act on", () => {
    // `.map(words)` would be WRONG here: it passes the array INDEX as the second
    // argument, so `words` would receive a number where it expects props and
    // every call would render the same thing. That bug is in this file's history
    // and produced "expected 1 to be 5" -- five identical strings from five
    // different states.
    const states: Liveness[] = ["connecting", "live", "stalled", "halted", "empty"];
    const seen = states.map((liveness) => words({ ...base, liveness, records: 1 }));
    expect(new Set(seen).size).toBe(5);
    for (const text of seen) expect(text.length).toBeGreaterThan(0);
  });

  it("says what is HAPPENING, not what the machine calls it", () => {
    // "Polling stopped" tells an operator what to do. "halted" tells them nothing
    // they have not already read in the source.
    expect(words({ ...base, liveness: "halted" })).toContain("Polling stopped");
    expect(words({ ...base, liveness: "stalled" })).toContain("Feed stalled");
    expect(words({ ...base, liveness: "empty" })).toContain("nothing arriving");
  });

  it("names the credential fault rather than echoing a code", () => {
    const text = words({ ...base, liveness: "halted", credentialState: "rejected" });
    expect(text).toContain("does not recognise");
    expect(text).not.toContain("UNAUTHENTICATED");
  });

  it("renders an age a person reads, not an epoch difference", () => {
    expect(words({ ...base, liveness: "live" })).toContain("just now");
    expect(words({ ...base, lastUpdated: new Date(AT - 43_000).toISOString(), now: AT, liveness: "live" })).toContain("43s ago");
    expect(words({ ...base, lastUpdated: new Date(AT - 300_000).toISOString(), now: AT, liveness: "live" })).toContain("5m ago");
    expect(words({ liveness: "connecting", lastUpdated: null, now: AT })).toContain("never");
  });
});

describe("formatAge and livenessWord", () => {
  it("formats ages as a person reads them", () => {
    const at = (ms: number): string => formatAge(new Date(AT - ms).toISOString(), AT);
    expect(at(0)).toBe("just now");
    expect(at(1_000)).toBe("just now");
    expect(at(3_000)).toBe("3s ago");
    expect(at(59_000)).toBe("59s ago");
    expect(at(60_000)).toBe("1m ago");
    expect(at(3_600_000)).toBe("1h ago");
    expect(formatAge(null, AT)).toBe("never");
  });

  it("never renders a negative age", () => {
    // A clock problem elsewhere must not produce "-5s ago".
    expect(formatAge(new Date(AT + 5_000).toISOString(), AT)).toBe("just now");
  });

  it("has a word for every state, and no state without one", () => {
    for (const state of ["connecting", "live", "stalled", "halted", "empty"] as Liveness[]) {
      expect(livenessWord(state).length).toBeGreaterThan(0);
    }
  });
});

describe("the numbers the product shows are all changing", () => {
  it("uses a coarse enough tick that re-rendering is free", () => {
    // The age is the only thing that changes without the data changing. Once a
    // second is fine enough to read as live and coarse enough that a 500ms poll
    // does not double the render count.
    expect(AGE_TICK_MS).toBeGreaterThanOrEqual(1_000);
    expect(AGE_TICK_MS).toBeLessThanOrEqual(2_000);
  });
});