import type { ReactElement } from "react";

import type { LiveVerdict } from "../api/live-contracts";

/**
 * THE LIVE STREAM VIEW.
 *
 * === IT DOES NOT DISPLAY A THROUGHPUT RATE, AND THAT IS THE DESIGN ===
 *
 * The brief asked this view to "prove the 257k event/sec throughput is
 * happening". It cannot. No backend endpoint reports a rate: `LiveVerdict`
 * carries `records`, a count from one snapshot, and a rate needs two instants and
 * a numerator. So there is no figure here to render, and inventing one --
 * hardcoded, interpolated, or derived from a count -- would put an unfalsifiable
 * number on screen with a live-looking spinner beside it.
 *
 * What it renders instead, all of it real:
 *   - the record count a snapshot actually saw, labelled as a COUNT,
 *   - every column's measured / min / max, which is measured data,
 *   - the fence each column is judged against, and whether it breached,
 *   - the busiest hour and the top keys, which are computed from the snapshot.
 *
 * AND IT NEVER PUTS RAW EVENTS IN THE DOM. A log line per event at any real
 * rate is the fastest way to lock a browser tab: 257k events a second is not a
 * rendering problem, it is a heap problem. There is no scrolling log here and no
 * array of events, so there is nothing for the main thread to choke on. The
 * aggregated columns ARE the log, read as statistics.
 *
 * === SYNTHETIC DATA IS ALWAYS LABELLED ===
 *
 * `verdict.synthetic` is rendered as a banner whenever it is true. A simulated
 * number that cannot be mistaken for a measurement is a fixture; one that can is
 * a lie, and the person who believes it is the person who does not page anyone
 * at three in the morning.
 */
export interface LiveStreamViewProps {
  /** Null until a snapshot has arrived. Rendered as an explicit absence. */
  readonly verdict: LiveVerdict | null;
  readonly error?: string | undefined;
}

function numberOrDash(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-GB");
}

export function LiveStreamView({ verdict, error }: LiveStreamViewProps): ReactElement {
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
          No snapshot yet. This view renders verdict samples when one arrives; it shows no throughput rate, because
          no endpoint reports one.
        </p>
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

      <dl className="kv kv--wide">
        <dt>snapshot at</dt>
        <dd>{verdict.at}</dd>
        <dt>
          records in snapshot
          <span className="muted"> (a count, not a rate)</span>
        </dt>
        <dd>{verdict.records.toLocaleString("en-GB")}</dd>
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