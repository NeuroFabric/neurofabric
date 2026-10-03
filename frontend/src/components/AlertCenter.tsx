import type { ReactElement } from "react";

import type { AlertPayload, LiveVerdict } from "../api/live-contracts";

/**
 * THE ALERT CENTER.
 *
 * Renders the webhook egress payloads from `platform/egress/webhook-dispatcher.ts`
 * -- the `AlertPayload` -- and, when no payload has been dispatched yet, falls
 * back to the raw `LiveVerdict` so an operator can still see a breach before a
 * dispatcher has fired one.
 *
 * === THE ONE DISTINCTION THIS VIEW EXISTS TO KEEP ===
 *
 * A column breached in ONE partition out of forty is not the same event as a
 * column breached in ALL forty, and the difference decides what a person does:
 * restart one replica, or page the fleet. The backend deliberately carries
 * `breachedEverywhere` for this reason -- "critical" attached to the first case
 * is how an on-call rotation learns to ignore the word.
 *
 * So the severity a viewer reads is the BACKEND'S, and this component never
 * recomputes it. An alert is shown as `info` when nothing breached and as
 * `critical` only when the backend said so. Re-deriving it here would be a
 * second severity policy that agrees with the first right up until the day
 * somebody edits one of them.
 */
export interface AlertCenterProps {
  /** Dispatched webhook payloads, newest first by the caller's ordering. */
  readonly alerts: readonly AlertPayload[];
  /** The current verdict, shown when no payload has been dispatched yet. */
  readonly verdict: LiveVerdict | null;
}

function SeverityPill({ severity }: { severity: AlertPayload["severity"] }): ReactElement {
  return <span className={`pill pill--${severity}`}>{severity}</span>;
}

function AlertCard({ alert }: { alert: AlertPayload }): ReactElement {
  return (
    <li className="card card--alert">
      <div className="card__head">
        <SeverityPill severity={alert.severity} />
        <strong>{alert.title}</strong>
      </div>
      <p className="muted">
        {alert.source} · {alert.at} · id <code>{alert.id}</code>
      </p>
      <p>{alert.body}</p>
      <dl className="kv">
        <dt>records</dt>
        <dd>{alert.summary.records.toLocaleString("en-GB")}</dd>
        <dt>columns breached</dt>
        <dd className={alert.summary.breachedColumns > 0 ? "bad" : "good"}>{alert.summary.breachedColumns}</dd>
        <dt>partitions</dt>
        <dd>{alert.summary.partitions}</dd>
      </dl>
      {alert.columns.length === 0 ? (
        <p className="muted">No column breached in this snapshot.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">column</th>
              <th scope="col">partitions</th>
              <th scope="col">max</th>
              <th scope="col">fence</th>
              <th scope="col">multiple past</th>
              <th scope="col">scope</th>
            </tr>
          </thead>
          <tbody>
            {alert.columns.map((column) => (
              <tr key={column.column}>
                <td>
                  <code>{column.column}</code>
                </td>
                <td>{column.partitions}</td>
                <td>{column.max === null ? "—" : column.max.toLocaleString("en-GB")}</td>
                <td>{column.fenceUpper === null ? "—" : column.fenceUpper.toLocaleString("en-GB")}</td>
                <td>{column.multiple === null ? "—" : column.multiple}</td>
                {/* The line that matters. One replica, or the fleet. */}
                <td className={column.breachedEverywhere ? "bad" : "warn"}>
                  {column.breachedEverywhere ? "every partition" : "some partitions"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </li>
  );
}

/**
 * The fallback, drawn from a verdict rather than a payload.
 *
 * Shown ONLY when nothing has been dispatched, and labelled, so a viewer never
 * mistakes it for an alert somebody actually sent.
 */
function VerdictFallback({ verdict }: { verdict: LiveVerdict }): ReactElement {
  const breached = verdict.columns.filter((column) => column.breached);
  if (breached.length === 0) {
    return (
      <li className="card card--alert">
        <div className="card__head">
          <SeverityPill severity="info" />
          <strong>No column past the outer fence</strong>
        </div>
        <p className="muted">
          {verdict.records.toLocaleString("en-GB")} records in the snapshot at {verdict.at}.
          {verdict.synthetic ? " This sample is SIMULATED." : ""}
        </p>
      </li>
    );
  }
  return (
    <li className="card card--alert">
      <div className="card__head">
        {/* Derived from the backend's own `breachedEverywhere`, never guessed. */}
        <SeverityPill severity={breached.every((column) => column.breachedEverywhere) ? "critical" : "warning"} />
        <strong>
          {breached.length} column{breached.length === 1 ? "" : "s"} past the outer fence
        </strong>
      </div>
      <p className="muted">
        From the live verdict, not a dispatched alert.{verdict.synthetic ? " This sample is SIMULATED." : ""}
      </p>
      <ul className="topkeys">
        {breached.map((column) => (
          <li key={`${column.partition}:${column.column}`}>
            <code>{column.column}</code> in {column.partition} —{" "}
            {column.breachedEverywhere ? "every partition" : "some partitions"}
          </li>
        ))}
      </ul>
    </li>
  );
}

export function AlertCenter({ alerts, verdict }: AlertCenterProps): ReactElement {
  const showFallback = alerts.length === 0 && verdict !== null && verdict.breachedColumns > 0;

  return (
    <section className="alerts" aria-label="Alert center">
      <h3>Alerts</h3>
      {alerts.length === 0 && !showFallback ? (
        <p className="muted">
          No alert has been dispatched, and no column is past its outer fence. An empty alert list is the only
          healthy one.
        </p>
      ) : (
        <ul className="stack">
          {alerts.map((alert) => (
            <AlertCard key={alert.id} alert={alert} />
          ))}
          {showFallback ? <VerdictFallback verdict={verdict} /> : null}
        </ul>
      )}
    </section>
  );
}