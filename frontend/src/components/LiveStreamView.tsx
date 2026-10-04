import type { ReactElement } from "react";

import type { LiveVerdict, ThroughputReading } from "../api/live-contracts";

/**
 * THE LIVE STREAM VIEW.
 *
 * === IT NOW SHOWS A REAL RATE, MEASURED SERVER-SIDE ===
 *
 * This view used to state that no endpoint reported throughput and therefore
 * displayed none. That was true, and it is no longer: `GET /api/portal/live`
 * returns a rate computed by `ThroughputMeter` from two consecutive observations,
 * because the server is the only place both instants exist.
 *
 * The number rendered here is therefore MEASURED, and two consequences follow
 * that this component takes seriously:
 *
 *   - It renders the WINDOW beside the rate. 56,690 events/sec over 1.4s and 56,690
 *     over 10s are different claims, and showing the rate alone would let a
 *     one-sample spike read as a sustained throughput. The window is not detail;
 *     it is what makes the number mean anything.
 *   - It renders "no reading yet" until a window exists, rather than a zero. One
 *     observation cannot produce a rate, and zero would read as a dead stream.
 *
 * === SYNTHETIC IS STILL LABELLED, AND STILL MATTERS ===
 *
 * The banner is now conditional. It appears when `verdict.synthetic` is true and
 * disappears when it is false -- which is the whole point: a simulated figure
 * that could be mistaken for a measurement is a fixture, and one that CANNOT is
 * no longer a fixture at all. The check remains because the frontend can still be
 * handed a simulated sample, and the condition is what makes the label honest
 * rather than decorative.
 *
 * === IT STILL DOES NOT PUT RAW EVENTS IN THE DOM ===
 *
 * There is no scrolling log and no array of events. At any real rate a line per
 * event is a heap problem, not a rendering problem; 56,000 events a second is not
 * something a browser can render one node at a time. The aggregated columns ARE
 * the log, read as statistics, and they are why a flood of half a million events
 * moves this panel without moving the DOM count.
 */
export interface LiveStreamViewProps {
  /** Null until a snapshot has arrived. Rendered as an explicit absence. */
  readonly verdict: LiveVerdict | null;
  /** The measured rate, or null until two observations exist. */
  readonly throughput?: ThroughputReading | null;
  readonly error?: string | undefined;
  readonly loading?: boolean;
  /** True while the gateway is attached but nothing has arrived. */
  readonly idle?: boolean;
  /** Which provider this is reporting on, for the idle message. */
  /**
   * The front door, offered when there is nothing to show.
   *
   * Rendered HERE rather than as a global empty-state overlay because this panel
   * is the one that explains the emptiness: it already knows the gateway is
   * attached and holding zero records, which is exactly the state a stranger
   * arrives in, and it is the panel that starts filling in.
   *
   * Null when there is nothing to offer -- no transport, or data already flowing.
   */
  readonly demo?: ReactElement | null;
}

function numberOrDash(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-GB");
}

export function LiveStreamView({
  verdict,
  throughput = null,
  error,
  loading = false,
  idle = false,

  demo = null,
}: LiveStreamViewProps): ReactElement {
  if (error !== undefined && error !== "") {
    return (
      <div className="banner banner--error" role="alert">
        <strong>Live stream unavailable.</strong> {error}
      </div>
    );
  }

  if (verdict === null) {
    // An explicit absence, not a spinner. A spinner that never resolves is
    // indistinguishable from a working pipeline.
    return (
      <section className="live" aria-label="Live telemetry">
        <h3>Live telemetry</h3>
        <p className="muted">
          {loading ? "Connecting…" : "Nothing has arrived yet."}
        </p>
        {/* THE WAY OUT IS HERE TOO.
            *
            * The front door used to live only in the `records === 0` branch below,
            * which means it was ABSENT in the state a stranger actually arrives in:
            * a fresh install has no verdict yet, so this early return rendered
            * "Connecting to the live gateway…" and no button. The assembled-page
            * test caught it by mounting App with no traffic and looking for the
            * button, which is precisely what that test is for.
            *
            * "Connecting" with nothing to show is not progress a viewer can watch,
            * so the way out belongs in both empty states. */}
        {demo}
      </section>
    );
  }

  return (
    <section className="live" aria-label="Live telemetry">
      <h3>Live telemetry</h3>

      {verdict.synthetic ? (
        <div className="banner banner--warn" role="status">
          <strong>SIMULATED SAMPLE.</strong> These figures are generated, not measured. They exist to exercise this
          view.
        </div>
      ) : null}

      {/* IDLE IS ITS OWN STATE. Connected, healthy, and holding zero records is a
          real condition -- it is what the gateway looks like before the flood
          starts -- and folding it into "no data" would make a healthy idle system
          look broken. */}
      {idle || verdict.records === 0 ? (
        <>
          <p className="muted">
            No activity yet. The platform is connected and holding nothing.
          </p>
          {/* THE WAY OUT. An empty state that explains itself and then leaves the
              operator there is a dead end, and the previous copy here --
              "Start the flood and this fills in" -- described a terminal command
              to someone who does not know there is a terminal. */}
          {demo}
        </>
      ) : null}

      <dl className="kv kv--wide">
        <dt>measured throughput</dt>
        <dd>
          {throughput === null ? (
            <span className="muted">no reading yet — one observation cannot produce a rate</span>
          ) : (
            <>
              <strong>{throughput.eventsPerSecond.toLocaleString("en-GB")}</strong> events/sec
              <span className="muted">
                {" "}
                over {throughput.windowMs.toLocaleString("en-GB")}ms ({throughput.delta.toLocaleString("en-GB")} events)
              </span>
            </>
          )}
        </dd>
        <dt>snapshot at</dt>
        <dd>{verdict.at}</dd>
        <dt>
          records in snapshot
          <span className="muted"> (a count, not a rate)</span>
        </dt>
        <dd>{verdict.records.toLocaleString("en-GB")}</dd>
        {/*
            F6a -- THE COUNT AND THE RATE, EXPLAINED RATHER THAN DISPLAYED.

            The runbook's strongest beat is throughput reading `0 events/sec` while
            the record count holds at 20,000. Displayed side by side, those two
            numbers look like a contradiction, and an operator who believes one of
            them is broken stops reading the panel.

            They are not in conflict. One is how much the window HOLDS -- everything
            that has arrived since it was opened. The other is how much ARRIVED in
            the last moment measured. Zero arriving per second with twenty thousand
            held is the ordinary shape of a stream that has stopped being busy.

            So this says it in a sentence, in the product's own register, and it
            says what the difference would look like if something WERE wrong --
            because "0/sec" is only reassuring when the reader knows what a fault
            would say instead. A quiet feed is a condition; a stopped feed is a
            fault, and the two must never render the same way (ADR-005 §6).
        */}
        {throughput !== null && throughput.eventsPerSecond === 0 && verdict.records > 0 ? (
          <div className="quiet" data-condition="quiet">
            <dt>why the rate is zero</dt>
            <dd>
              <p>
                Nothing new has arrived in the last {throughput.windowMs.toLocaleString("en-GB")}ms. The{" "}
                {verdict.records.toLocaleString("en-GB")} above are the records this window is still holding, and a window
                does not empty itself -- so the two figures measure different things and are expected to disagree.
              </p>
              <p className="muted">
                This is a quiet feed, which is a condition. If the feed were <em>stopped</em> rather than quiet, the{" "}
                <strong>last answer</strong> at the top of this screen would be growing old instead.
              </p>
            </dd>
          </div>
        ) : null}
        <dt>columns past the outer fence</dt>
        <dd className={verdict.breachedColumns > 0 ? "bad" : "good"}>{verdict.breachedColumns}</dd>
        <dt>busiest hour</dt>
        <dd>
          {verdict.busiestHour === null ? (
            <span className="muted">none recorded</span>
          ) : (
            <>
              {verdict.busiestHour.hour} — {verdict.busiestHour.count.toLocaleString("en-GB")}
            </>
          )}
        </dd>
      </dl>

      <h4>Columns ({verdict.columns.length})</h4>
      {verdict.columns.length === 0 ? (
        <p className="muted">No column carried enough measurements to judge.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">column</th>
              <th scope="col">partition</th>
              <th scope="col">measured</th>
              <th scope="col">min</th>
              <th scope="col">max</th>
              <th scope="col">outer fence</th>
              <th scope="col">verdict</th>
            </tr>
          </thead>
          <tbody>
            {verdict.columns.map((column) => (
              <tr key={`${column.partition}:${column.column}`}>
                <td>
                  <code>{column.column}</code>
                  {/* A sampled quantile is not an exact one, and a fence drawn
                      from a sample must never be read as a hard boundary. */}
                  {column.quantilesSampled ? <span className="muted"> (sampled)</span> : null}
                </td>
                <td>{column.partition}</td>
                <td>{numberOrDash(column.measured)}</td>
                <td>{numberOrDash(column.min)}</td>
                <td>{numberOrDash(column.max)}</td>
                <td>
                  {numberOrDash(column.extremeLower)} … {numberOrDash(column.extremeUpper)}
                </td>
                <td className={column.breached ? "bad" : "good"}>
                  {column.breached ? "BREACHED" : "within fence"}
                  {column.breached && column.breachedEverywhere ? " in every partition" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {verdict.topKeys.length === 0 ? null : (
        <>
          <h4>Top keys</h4>
          <ol className="topkeys">
            {verdict.topKeys.map((entry) => (
              <li key={entry.key}>
                <code>{entry.key}</code> — {entry.count.toLocaleString("en-GB")}
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}