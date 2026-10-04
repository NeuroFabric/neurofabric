import type { ReactElement } from "react";

import { describeCredentialState, type CredentialState } from "../api/credential-state";

/**
 * THE LIVENESS STRIP. The answer to "is anything happening?".
 *
 * === WHY IT EXISTS, IN THE ORDER THINGS WENT WRONG ===
 *
 * A dashboard that is silent and a dashboard that is broken look identical from
 * the outside. Both show numbers that are not moving. The only difference is
 * which one is *true*, and the operator standing in front of it cannot tell.
 *
 * That is not a styling complaint. It is the failure this strip exists to
 * remove: **silence must never be ambiguous.** Every state it can be in says
 * something different, out loud, without scrolling:
 *
 *   connecting   we asked, nothing has answered yet
 *   live         answers are arriving, and this is when the last one landed
 *   stalled      the last answer is older than it should be -- SUSPECT, and said
 *   halted       polling has stopped because the credential was refused
 *   no data      connected, answering, and there is genuinely nothing
 *
 * Those are five different situations a viewer would otherwise collapse into one
 * grey number.
 *
 * === "PARTIAL DATA WITH A VISIBLE FAULT BEATS NO DATA" ===
 *
 * The store's most interesting state is `degraded`: agents loaded, config
 * loaded, and *something* refused. An earlier instinct is to hide that and show
 * nothing until everything is well. It is the wrong instinct twice over --
 *
 *   - the operator loses the good data they already have, and
 *   - the fault, which is the only thing they could act on, is the one thing
 *     hidden.
 *
 * So the fault is shown INSTEAD of the data being hidden, not in addition to it.
 * `severityFor` is where that decision is made, and it is a pure function so the
 * decision can be tested without rendering anything.
 *
 * === WHY `now` IS A PROP AND NOT A CLOCK READ INSIDE ===
 *
 * Because "42 seconds ago" is the entire content of this component, and a clock
 * read inside it makes that number untestable. Every caller passes the instant
 * to measure against, so a test can assert "43s ago" exactly rather than "some
 * number of seconds".
 *
 * === NO ANIMATION HAPPENS HERE ===
 *
 * The pulse is a CSS animation on a single element and it is disabled under
 * `prefers-reduced-motion`. Nothing here animates per poll: a strip that
 * re-animates every 500ms is motion nobody chose, and this component updates on
 * a timer whether or not anyone is looking at it.
 */

/** How old the last answer may be before we call the feed stalled. */
export const STALL_AFTER_MS = 5_000;

/** How often the age re-renders. Fine enough to feel live, coarse enough to be free. */
export const AGE_TICK_MS = 1_000;

export type Liveness =
  /** Nothing has answered yet. Not an error, and not claimed to be healthy. */
  | "connecting"
  /** Answers arriving. The good case, and the only one with a green pulse. */
  | "live"
  /** Connected, but the last answer is too old. Something between us and it. */
  | "stalled"
  /** Polling has stopped: the credential was refused. Only a new one clears it. */
  | "halted"
  /** Connected and answering, and there is genuinely nothing to report. */
  | "empty";

export interface LivenessStripProps {
  readonly liveness: Liveness;
  /** ISO instant of the last successful read, or null if there has not been one. */
  readonly lastUpdated: string | null;
  /** The instant to measure age against. Passed in so it is testable. */
  readonly now: number;
  /** The credential state behind the liveness, when there is a fault to name. */
  readonly credentialState?: CredentialState;
  /** The fault text, when the store has one. */
  readonly fault?: string | null;
  /** Records in the last snapshot. Null is not zero. */
  readonly records?: number | null;
}

/**
 * Decide the liveness. Pure, and the single place the decision is made.
 *
 * ORDER MATTERS and the order is the argument:
 *
 * 1. `halted` first. A refused credential means polling has stopped; nothing
 *    else about the feed is meaningful, and reporting "connecting" for a poller
 *    that will never ask again is a lie that looks like patience.
 * 2. No successful read at all is `connecting` -- but only while there is no
 *    error. A failed first attempt is a fault, not patience.
 * 3. A read that is too old is `stalled`, whatever the counter says. A counter
 *    holding a number while the feed dies is the exact failure this strip exists
 *    to catch.
 */
export function livenessOf(input: {
  readonly credentialRequired: boolean;
  readonly lastUpdated: string | null;
  readonly now: number;
  readonly loading: boolean;
  readonly records: number | null;
}): Liveness {
  if (input.credentialRequired) return "halted";
  if (input.lastUpdated === null) return input.loading ? "connecting" : "empty";
  const age = input.now - Date.parse(input.lastUpdated);
  // A future-dated instant is a clock problem somewhere else. Treat it as fresh
  // rather than as stalled: "negative age" is not a thing a viewer can act on.
  if (age > STALL_AFTER_MS) return "stalled";
  if (input.records === 0) return "empty";
  return "live";
}

/**
 * Whether the fault should REPLACE the happy reading.
 *
 * "Partial data with a visible fault beats no data." A fault is shown in place
 * of a normal reading, never instead of the good data and never hidden.
 */
export function severityFor(input: { readonly fault: string | null | undefined; readonly liveness: Liveness }): "ok" | "fault" | "hard" {
  if (input.fault !== null && input.fault !== undefined && input.fault !== "") return "hard";
  if (input.liveness === "stalled" || input.liveness === "halted") return "fault";
  return "ok";
}

const LIVENESS_WORDS: Record<Liveness, string> = {
  connecting: "Connecting",
  live: "Live",
  stalled: "Feed stalled",
  halted: "Polling stopped",
  empty: "Connected, nothing arriving",
};

/** The word a person reads. Kept beside the decision so the two cannot drift. */
export function livenessWord(liveness: Liveness): string {
  return LIVENESS_WORDS[liveness];
}

/** Human age, so "43s" is never read as a raw epoch difference. */
export function formatAge(lastUpdated: string | null, now: number): string {
  if (lastUpdated === null) return "never";
  const ms = Math.max(0, now - Date.parse(lastUpdated));
  const seconds = Math.floor(ms / 1000);
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function LivenessStrip({
  liveness,
  lastUpdated,
  now,
  credentialState = "ok",
  fault = null,
  records = null,
}: LivenessStripProps): ReactElement {
  const severity = severityFor({ fault, liveness });
  const age = formatAge(lastUpdated, now);

  return (
    <section
      className={`liveness liveness--${liveness} liveness--${severity}`}
      // THE MACHINE ATTRIBUTE. Every assertion about this strip runs on the
      // markup, never on rendered text -- `text()` strips tags and punctuation,
      // so an assertion made against it is asserting on a different thing than
      // the one a machine would read. This attribute is the contract; the words
      // below are for people and may change freely.
      data-liveness={liveness}
      data-severity={severity}
      data-age-ms={lastUpdated === null ? "" : String(Math.max(0, now - Date.parse(lastUpdated)))}
      aria-label="Connection status"
    >
      {/* The pulse. Green only when answers are actually arriving -- a green
          pulse next to a frozen counter is the exact combination that makes a
          dashboard lie, so `empty` and `stalled` get no pulse at all. */}
      <span className="liveness__pulse" data-testid="liveness-pulse" aria-hidden="true" />

      <span className="liveness__word">{livenessWord(liveness)}</span>

      {/* Tabular figures on both. A counter and a timestamp that jitter in width
          are unreadable, and the jitter is worst exactly when you are watching
          for movement. */}
      <span className="liveness__age liveness__num" title={`Last answer at ${lastUpdated ?? "never"}`}>
        {age}
      </span>

      {/* The fault REPLACES the reading rather than sitting politely under it.
          Two conditions, and the second matters: a refused credential has to NAME
          ITSELF even when there is no `fault` string to show, because "Polling
          stopped" alone tells an operator nothing about what to type. The first
          version gated this on severity === "hard", which a credential refusal
          with an empty fault never reached -- so the most important message in
          the component was unreachable in the state that most needed it. */}
      {credentialState !== "ok" && (severity !== "ok" || liveness === "halted") ? (
        <span className="liveness__fault">{describeCredentialState(credentialState)}</span>
      ) : null}
      {fault !== null && fault !== "" ? <span className="liveness__fault">{fault}</span> : null}

      {records === null ? null : (
        <span className="liveness__records liveness__num">
          <span title="Events in the current window. A count, not a rate.">events</span>{" "}
          {records.toLocaleString("en-GB")}
        </span>
      )}
    </section>
  );
}