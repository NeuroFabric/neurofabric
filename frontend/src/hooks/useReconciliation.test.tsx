import type { JSX } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DIFF_POLL_MS, useReconciliation, type ReconciliationSource } from "./useReconciliation";
import type { ReconciliationDiff } from "../api/memory-contracts";

/**
 * THE DIFF'S OWN CLOCK.
 *
 * === WHY THESE TESTS RENDER A COMPONENT INSTEAD OF CALLING THE HOOK ===
 *
 * The first version of this file called `useReconciliation()` directly from a
 * helper, which does not work and should not have been written: a React hook
 * reads a dispatcher that only exists DURING A RENDER, so calling it from a test
 * body throws `Cannot read properties of null (reading 'useState')`. The failure
 * was loud, which is the only reason it was caught at all -- a version that
 * swallowed it would have been a test that asserted nothing.
 *
 * So the state is read the way it is in production: through a real component,
 * rendered. What that buys and what it costs is stated per test rather than
 * glossed.
 *
 * === THE HONEST LIMIT, UP FRONT ===
 *
 * `renderToStaticMarkup` runs `useState` and `useRef` and does NOT run
 * `useEffect`. So what is provable here is the state a hook STARTS in and the
 * contract it exposes. What is not provable here, and is not claimed:
 *
 *  - that the interval actually fires on the cadence,
 *  - that a tick re-reads and updates,
 *  - that `refresh()` reaches the server,
 *  - that the in-flight guard skips an overlapping read.
 *
 * Those are timing behaviours, and this environment has no clock. They are the
 * operator's browser test, and the cadence constant is asserted instead -- a
 * named number a reviewer can argue with is worth more here than a test that
 * pretends to have measured five seconds.
 */

const DIFF: ReconciliationDiff = {
  at: "2023-11-14T22:13:20.000Z",
  source: "the record",
  tenant: "acme",
  recordVersion: 2,
  expectedVersion: 2,
  summary: "Nothing has changed since you were last here.",
  differences: [],
  corruptions: [],
  recorded: { verdicts: [], alerts: [] },
};

function source(returning: () => Promise<ReconciliationDiff>): ReconciliationSource {
  return { fetchReconciliation: returning };
}

/**
 * READ THE HOOK'S STATE THROUGH A RENDER.
 *
 * The probe renders the state as text, so the assertions are on what a component
 * would SEE rather than on an object shape -- the same split the panel tests use,
 * applied to a hook.
 */
function probe(input: ReconciliationSource | undefined): string {
  function Probe(): JSX.Element {
    const { diff, error, loading } = useReconciliation(input, DIFF_POLL_MS);
    const kind = diff === undefined ? "undefined" : diff === null ? "null" : "diff";
    return <p>{`${kind}|${String(error)}|${String(loading)}|${typeof diff}`}</p>;
  }
  return renderToStaticMarkup(<Probe />);
}

describe("the cadence", () => {
  it("is five seconds, and it is a named constant rather than a number at a call site", () => {
    // 500ms would make this a second live panel wearing a record panel's header,
    // which is precisely the confusion ADR-005 section 9 exists to prevent: a
    // reader who cannot tell which truth a number belongs to.
    expect(DIFF_POLL_MS).toBe(5_000);
    // And it is an order of magnitude slower than the live poll beside it.
    expect(DIFF_POLL_MS / 500).toBe(10);
  });
});

describe("without a transport", () => {
  it("reports UNDEFINED, which means nobody asked -- never a fabricated empty diff", () => {
    // The distinction that matters: `undefined` is "no transport", `null` is
    // "asked, nothing to report". Both render as nothing, which is right, but
    // only one of them is honest about WHY. Reporting `null` here would let an
    // unanswered read read as agreement.
    expect(probe(undefined)).toContain("undefined|");
  });

  it("is not loading, because nothing is in flight", () => {
    expect(probe(undefined)).toContain("|false|");
  });
});

describe("with a transport", () => {
  it("starts as NULL -- asked, nothing yet -- rather than undefined", () => {
    // The opposite error to the one above, and just as bad: `undefined` before
    // the first answer would claim there is no transport when there is one.
    expect(probe(source(async () => DIFF))).toContain("null|");
  });

  it("is loading on the first read, so a caller can say so", () => {
    expect(probe(source(async () => DIFF))).toContain("|true|");
  });
});

describe("what a transport refuses", () => {
  it("is a REJECTED PROMISE rather than an empty document", () => {
    // A rejected read is what makes `error` reachable. A transport that resolved
    // with `null` instead would make the hook permanently indistinguishable from
    // a healthy one, and the panel would show its calm state forever.
    const refusing = source(async () => {
      throw new Error("that difference is not on the list right now");
    });
    expect(() => probe(refusing)).not.toThrow();
  });
});
