import type { ReactElement } from "react";

import {
  DIFFERENCE_WORDS,
  type MemoryDifference,
  type ReconciliationDiff,
} from "../api/memory-contracts";

/**
 * THE DIFF. Five legal disagreements, and an alarm for everything else.
 *
 * === WHAT THIS PANEL IS NOT ALLOWED TO DO ===
 *
 * It does not decide. There is no "resolve", no "migrate", no "dismiss", and no
 * button that would make a difference go away by being pressed. The only verb is
 * "I've seen this", and it records an observation -- durably, in the audit trail
 * -- while leaving the difference exactly where it was.
 *
 * The reason is not caution, it is authority. A reconciliation that silently
 * migrates a customer's records is making a claim about their data that nobody
 * asked it to make, and in the one case where that claim would be wrong it would
 * be unfalsifiable (ADR-005 §7.3, §10.3). The operator is the resolver. This
 * panel is the briefing.
 *
 * === THE TWO-TRUTHS CONTRACT, AND WHERE EACH RULE LIVES ===
 *
 * ADR-005 §9, all three rules, asserted on what a READER IS SHOWN rather than on
 * a machine attribute -- because a timestamp in a prop is not evidence that
 * anything was rendered:
 *
 *  - **RULE 1, they never appear in the same block.** This is its own `<section>`
 *    with its own header reading "From the record", and the live panel beside it
 *    is a different `<section>` with a different header. Inside a difference row
 *    there IS a recorded value and a live value, because the disagreement *is*
 *    those two values -- so each is labelled in its own column and neither is ever
 *    bare. That is the structural separation at row level; a caption under the
 *    panel would not be it.
 *  - **RULE 2, every figure carries its age.** Each side of a row is prefixed with
 *    "recorded" or "live", and the panel header carries the moment the comparison
 *    was made. A bare timestamp is never rendered.
 *  - **RULE 3, a recorded breach and a live breach look different, deliberately.**
 *    The recorded verdict below is drawn with a flat, dated chip; the live panel
 *    draws its breaches with the pulse. Same word, two ink treatments, because a
 *    four-hour-old alert rendered identically to a breach happening now is the
 *    specific dishonesty the contract exists to prevent.
 *
 * === AND WHAT IT DOES NOT PROVE ===
 *
 * `renderToStaticMarkup` does not run effects, so the acknowledgement CLICK is not
 * driven by the tests here. What is asserted is what an operator would read, and
 * that the panel renders NOTHING rather than a description of a diff when no
 * transport supplied one -- the same rule the install form follows.
 */

export interface ReconciliationPanelProps {
  /** Absent means there is no record to compare against, and NOTHING renders. */
  readonly diff: ReconciliationDiff | null;
  /** Absent means no one is here to acknowledge. The panel is still readable. */
  readonly onAcknowledge?: ((key: string) => void) | undefined;
  /** Durations, injected so a test does not depend on the wall clock. */
  readonly now?: number;
}

const AGE_TICK_LABEL = "just now";

/**
 * HOW OLD SOMETHING IS, IN WORDS.
 *
 * Coarse on purpose. "4 hours ago" is a fact an operator can act on; "4 hours,
 * 3 minutes and 41 seconds ago" is a number that pushes the number that matters
 * out of view. The seconds are still there underneath for anyone who hovers.
 *
 * A FUTURE time is reported as "just now" rather than as a negative age. A clock
 * skew between the browser and the server would otherwise render "-2s ago", and a
 * panel that can print a negative duration is a panel whose arithmetic is not
 * trustworthy.
 */
export function ageOf(at: number, now: number): string {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return AGE_TICK_LABEL;
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 5) return AGE_TICK_LABEL;
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** `14:32:05`, the clock time a reader can compare against another clock time. */
function clockOf(iso: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleTimeString("en-GB", { hour12: false });
}

/**
 * ONE ROW.
 *
 * Two labelled columns and never a bare figure, which is the row-level half of
 * rule 1. `acknowledged` changes ONE thing and one thing only: the chip beside
 * the button. The title, the two values, the explanation and the action all stay,
 * because a difference the operator has seen is still a difference, and rendering
 * it as handled is the claim this product refuses to make.
 */
function DifferenceRow({
  difference,
  onAcknowledge,
  now,
}: {
  readonly difference: MemoryDifference;
  readonly onAcknowledge: ((key: string) => void) | undefined;
  readonly now: number;
}): ReactElement {
  const words = DIFFERENCE_WORDS[difference.kind];
  return (
    <li className="card card--difference" data-kind={difference.kind} data-acknowledged={difference.acknowledged}>
      <div className="card__head">
        <span className="chip chip--legal">Legal difference</span>
        <strong>{words.title}</strong>
      </div>

      <p className="muted">
        {difference.subject} · {words.because}
      </p>

      {/*
        THE TWO SIDES, LABELLED IN THEIR OWN COLUMNS.

        Not a caption and not a colour: two labelled cells. "Recorded" and "live"
        are the two words ADR-005 §9 asks for, and they are on every row rather
        than once on the panel, because a rule stated once is a rule that stops
        being read four rows down.
      */}
      <dl className="kv kv--twotruths">
        <dt>Recorded</dt>
        <dd>{difference.recorded}</dd>
        <dt>Live</dt>
        <dd>{difference.live}</dd>
      </dl>

      <p className="diff__action">{difference.whatToDo}</p>

      {/*
        THE ACKNOWLEDGEMENT IS SHOWN WHETHER OR NOT ANYONE IS HERE TO ADD ONE.

        The first version wrapped this whole line in `onAcknowledge !== undefined`
        -- and that silently hid an acknowledgement that had already been
        recorded whenever no callback was supplied. A durable fact about what a
        person did, invisible because this particular render had nobody to offer
        a button to. That is the same failure the record exists to prevent, one
        layer up: the state was stored, and the screen did not show it.

        So the button is conditional and the RECORD is not.
      */}
      <p className="diff__ack">
        {difference.acknowledged ? (
          <span className="chip chip--seen">
            Seen by the operator{difference.acknowledgedAt === null ? "" : ` · ${ageOf(difference.acknowledgedAt, now)}`}.
            {difference.seenCount > 1 ? ` It has come back ${difference.seenCount} times.` : ""} Still open -- this
            system does not resolve differences for you.
          </span>
        ) : onAcknowledge === undefined ? (
          // Nobody to acknowledge it here. Not a dead button, and not silence
          // about it: the row still says what the disagreement is.
          <span className="muted">Not looked at yet.</span>
        ) : (
          <button type="button" onClick={() => onAcknowledge(difference.key)}>
            I have seen this
          </button>
        )}
      </p>
    </li>
  );
}

/**
 * CORRUPTION, WHICH IS NOT A DIFFERENCE.
 *
 * Rendered above the differences and never inside them, and labelled with a
 * different word, because it is the only category that means something is WRONG
 * rather than something CHANGED. A list that mixes the two is a list people learn
 * to skim, and the day real corruption appears they skim past it (ADR-005 §7.3).
 */
function CorruptionRow({ subject, what }: { readonly subject: string; readonly what: string }): ReactElement {
  return (
    <li className="card card--corruption" data-corruption="true">
      <div className="card__head">
        <span className="chip chip--corruption">Problem</span>
        <strong>{subject}</strong>
      </div>
      <p>{what}</p>
      <p className="muted">
        This is not a difference between the record and the running system. Something is wrong with the record itself,
        and nothing here will resolve it for you.
      </p>
    </li>
  );
}

export function ReconciliationPanel({ diff, onAcknowledge, now = Date.now() }: ReconciliationPanelProps): ReactElement | null {
  // NO TRANSPORT, NO PANEL. Not a placeholder, not "no differences found" -- an
  // absent record and an agreeing record look identical on screen, and claiming
  // they agree is the one thing this panel must never do.
  if (diff === null) return null;

  const checkedAt = Date.parse(diff.at);

  const quiet = diff.differences.length === 0 && diff.corruptions.length === 0;

  return (
    <section className="record" aria-label="From the record" data-source={diff.source} data-surface="record">
      {/*
        THE HEADER, IN THE WORDS ADR-005 §9 ASKS FOR.

        "From the record" is not decoration. It is the label that makes the two
        truths distinguishable at a glance, and it is the same string the live
        panel does not use -- a panel that could say either one is a panel that
        has not decided what it is showing.
      */}
      <h3>From the record</h3>
      <p className="muted">
        Checked {clockOf(diff.at)}
        {Number.isNaN(checkedAt) ? "" : ` · ${ageOf(checkedAt, now)}`} · record version {diff.recordVersion}
        {diff.recordVersion === diff.expectedVersion ? "" : ` (this build expects ${diff.expectedVersion})`}
      </p>

      {/*
        THE SUMMARY IS THE BACKEND'S WORDS, NOT A COUNT RENDERED HERE.

        `summarise()` already leads with corruption and already says "Nothing has
        been changed for you". A panel that recomputed that sentence would be a
        second policy, free to disagree with the first, and the one that
        disagrees is the one an operator reads.
      */}
      <p className="record__summary">{diff.summary}</p>

      {quiet ? (
        <p className="muted">
          The record and the running system agree on everything this check looks at. That is a fact about{" "}
          {clockOf(diff.at)}, not a promise about later.
        </p>
      ) : null}

      {diff.corruptions.length > 0 ? (
        <>
          <h4 className="record__subhead">Needs attention</h4>
          <ul className="stack">
            {diff.corruptions.map((corruption) => (
              <CorruptionRow key={`${corruption.subject}|${corruption.what}`} subject={corruption.subject} what={corruption.what} />
            ))}
          </ul>
        </>
      ) : null}

      {diff.differences.length > 0 ? (
        <>
          <h4 className="record__subhead">Differences to look at</h4>
          <ul className="stack">
            {diff.differences.map((difference) => (
              <DifferenceRow
                key={difference.key}
                difference={difference}
                onAcknowledge={onAcknowledge}
                now={now}
              />
            ))}
          </ul>
        </>
      ) : null}

      {/*
        RULE 3, IN INK.

        The recorded verdicts are drawn here, in this block, under this header,
        with their own age on every line -- and they are deliberately FLAT. The
        live panel draws a current breach with a pulse; a breach recorded four
        hours ago, in the same ink, would read as something happening now, which
        is the exact dishonesty §9 rule 3 exists to prevent.
      */}
      {diff.recorded.verdicts.length > 0 ? (
        <div className="record__verdicts">
          <h4 className="record__subhead">Last recorded verdict per agent</h4>
          <ul className="stack">
            {diff.recorded.verdicts.map((verdict) => (
              <li key={verdict.agentId} className="record__verdict" data-breached={verdict.breached}>
                <span className="record__agent">{verdict.agentId}</span>
                <span className={verdict.breached ? "chip chip--recorded-breach" : "chip chip--recorded-clear"}>
                  {verdict.breached ? "Recorded breach" : "Recorded clear"}
                </span>
                <span className="muted">
                  recorded {clockOf(verdict.at)} · {ageOf(Date.parse(verdict.at), now)} · {verdict.provider} ·{" "}
                  {verdict.records.toLocaleString("en-GB")} records
                </span>
              </li>
            ))}
          </ul>
          <p className="muted">Every line above is a record of a past reading. None of them is the current reading.</p>
        </div>
      ) : null}

      {diff.recorded.alerts.length > 0 ? (
        <div className="record__verdicts">
          <h4 className="record__subhead">Alerts in the record</h4>
          <ul className="stack">
            {diff.recorded.alerts.map((alert) => (
              <li key={alert.id} className="record__verdict">
                <span className="record__agent">{alert.agentId}</span>
                <span className="chip chip--recorded-clear">{alert.severity}</span>
                <span className="muted">
                  raised {clockOf(alert.raisedAt)} · {ageOf(Date.parse(alert.raisedAt), now)}
                  {alert.acknowledged ? " · acknowledged" : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
