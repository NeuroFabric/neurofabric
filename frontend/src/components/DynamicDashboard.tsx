import type { ReactElement } from "react";

import { diagnosticsEnabled } from "../diagnostics-flag";

import type { AgentDescriptor, PortalWidget, RuleSpec } from "../api/contracts";
import type { UIConfig } from "../store/SchemaStore";

/**
 * THE DASHBOARD ENGINE. NOTHING ABOUT IT IS ABOUT A PARTICULAR AGENT.
 *
 * There is no `log-anomaly` in this file, no `pega-alert-export`, no domain.
 * Every element below is derived from the JSON that arrived -- the portal
 * config's widgets and forms, and the selected schema's rules -- and a new agent
 * renders with no edit here at all. That is the test: if adding an agent
 * required touching this component, it would be a template wearing a dynamic
 * component's name, which is the thing `portal-routes.ts` refused to be when it
 * returned a config value instead of HTML.
 *
 * === WHAT THE SCHEMA DOES NOT CONTAIN, AND WHAT IS THEREFORE NOT DRAWN ===
 *
 * A schema describes RULES. It does not carry observations: a threshold rule
 * says "fire above 1000", and nothing anywhere says the current value is 1043.
 * So the threshold visualizer draws the CONFIGURED THRESHOLD and labels it as
 * configured. It does not render a bar at a height invented from the schema,
 * because a bar at an invented height is a picture of a number nobody measured,
 * and a dashboard whose numbers are decorative is the one failure mode the
 * platform's whole claim is against.
 *
 * Where a reading arrives later -- from the live stream -- it is passed in as
 * `readings` and rendered alongside. Absent readings are stated, never faked.
 */

/** How each rule kind is presented. The table itself comes from the schema. */
type RuleKind = RuleSpec["kind"];

const RULE_ORDER: readonly RuleKind[] = ["threshold", "rate", "regex", "missing-field"];

export interface RuleReading {
  readonly ruleId: string;
  /** A measured value. Never inferred from the schema. */
  readonly value: number;
}

export interface DynamicDashboardProps {
  readonly config: UIConfig;
  /** Observed values, keyed by rule id. Absent values are stated, never invented. */
  readonly readings?: readonly RuleReading[];
}

function readingFor(readings: readonly RuleReading[], ruleId: string): number | undefined {
  return readings.find((reading) => reading.ruleId === ruleId)?.value;
}

/**
 * The label a rule gets, derived from its kind.
 *
 * `threshold` and `rate` describe a comparison, so the comparison is rendered.
 * `regex` describes a pattern and `missing-field` a field name; neither has an
 * order to place on a scale, so forcing them onto one would be a graphic that
 * means nothing.
 */
function describeRule(rule: RuleSpec): string {
  switch (rule.kind) {
    case "threshold":
      return `${rule.operator ?? "="} ${rule.value ?? 0}${rule.field === undefined ? "" : ` on ${rule.field}`}`;
    case "rate":
      return `more than ${rule.rateAbove ?? 0} per ${rule.windowMs ?? 0}ms`;
    case "regex":
      return `matches /${rule.pattern ?? ""}/${rule.flags ?? ""}`;
    case "missing-field":
      return `field ${rule.field ?? "(unnamed)"} is absent`;
  }
}

/**
 * THE THRESHOLD BAR.
 *
 * A filled track with the threshold marked on it, and the measured value marked
 * separately when one exists. The scale is not `value * 2`: a bar whose full
 * width means "twice the threshold" would make a rule at 1 and a rule at 100000
 * draw the same picture. The scale is the threshold itself, so a bar at full
 * width means exactly one thing everywhere in this UI -- "at or over the limit".
 */
function ThresholdBar({ rule, measured }: { rule: RuleSpec; measured: number | undefined }): ReactElement {
  const limit = rule.kind === "rate" ? rule.rateAbove ?? 0 : rule.value ?? 0;
  const breached = measured !== undefined && limit > 0 && measured >= limit;
  return (
    <span className="threshold">
      <span className="threshold__track" role="presentation">
        <span
          className={breached ? "threshold__fill threshold__fill--breached" : "threshold__fill"}
          style={{ inlineSize: breached ? "100%" : "0%" }}
        />
      </span>
      <span className="threshold__label">
        {measured === undefined
          ? `limit ${limit}${measured === undefined && breached === false ? ", no reading yet" : ""}`
          : `${measured} against limit ${limit}${breached ? " — BREACHED" : ""}`}
      </span>
    </span>
  );
}

function RuleRow({ rule, measured }: { rule: RuleSpec; measured: number | undefined }): ReactElement {
  const scalable = rule.kind === "threshold" || rule.kind === "rate";
  return (
    <tr>
      <td>
        <code>{rule.id}</code>
      </td>
      <td>
        <span className={`pill pill--${rule.severity}`}>{rule.severity}</span>
      </td>
      <td>{rule.kind}</td>
      <td>{rule.message}</td>
      <td>{describeRule(rule)}</td>
      <td>{scalable ? <ThresholdBar rule={rule} measured={measured} /> : <span className="muted">not a scalar rule</span>}</td>
    </tr>
  );
}

function AgentStatusCard({ agent }: { agent: AgentDescriptor }): ReactElement {
  return (
    <li className="card">
      <div className="card__head">
        {/* The CLASS keeps the machine value -- it is what the stylesheet keys
            off and what a developer needs. The LABEL is for anyone using a screen
            reader, and it was the raw maturity, so a non-sighted operator heard
            "stub" as if it meant something. Both are now stated: the shape keeps
            the machine, the word keeps the human. */}
        <span
          className={`dot dot--${agent.maturity}`}
          role="img"
          aria-label={maturityLabel(agent.maturity)}
        />
        <strong>{agent.title}</strong>
      </div>
      <dl className="kv">
        {/* The composite id is an address in our namespace (tenant/name), not a
            thing a customer recognises. The title is right above it. */}
        {diagnosticsEnabled() ? (
          <>
            <dt>id</dt>
            <dd><code>{agent.id}</code></dd>
          </>
        ) : null}
        <dt>domain</dt>
        <dd>{agent.domain}</dd>
        {/* Version is a build artefact. "0.0.0.dev+derived" on a customer screen
            tells a reader nothing they can act on, and it is one of the lines the
            operator read off the screen by name. Available under ?diagnostics=1. */}
        {diagnosticsEnabled() ? (
          <>
            <dt>version</dt>
            <dd><code>{agent.version}</code></dd>
          </>
        ) : null}
        <dt>capabilities</dt>
        <dd>{agent.capabilities.length === 0 ? <span className="muted">none declared</span> : agent.capabilities.join(", ")}</dd>
      </dl>
    </li>
  );
}

/**
 * A portal widget.
 *
 * The portal config says what kind of widget this is and which agent feeds it.
 * It does not carry the data, so the card states what it is waiting for rather
 * than drawing a plausible-looking empty chart.
 */
function WidgetCard({ widget }: { widget: PortalWidget }): ReactElement {
  return (
    <li className="card">
      <div className="card__head">
        <span className={`pill pill--${widget.kind}`}>{widget.kind}</span>
        <strong>{widget.title}</strong>
      </div>
      <p className="muted">
        {"agentId" in widget ? (
          <>
            {/* "fed by dev/sla-monitor" -- a tenant-qualified composite id, which is
                an address in our namespace rather than a thing a customer knows.
                The agent's NAME is what a reader can act on; the id stays behind
                the flag. */}
            {widget.agentId.split("/").pop()}
            {widget.span === undefined ? "" : ` over ${widget.span}`}
          </>
        ) : (
          "a static widget with no agent behind it"
        )}
      </p>
    </li>
  );
}

/**
 * What the maturity dot is CALLED when it is read aloud.
 *
 * `stub` and `ready` are this codebase's classification. Read through a screen
 * reader they are jargon with no action attached -- a non-sighted operator hears
 * "stub" and cannot tell whether it means "placeholder" or "failed to build",
 * which is the same complaint as the visible jargon, in a channel fewer people
 * check.
 */
function maturityLabel(maturity: string): string {
  switch (maturity) {
    case "ready":
      return "active";
    case "stub":
      return "not yet configured";
    default:
      return maturity;
  }
}

export function DynamicDashboard({ config, readings = [] }: DynamicDashboardProps): ReactElement {
  const schema = config.schema;
  const issues = config.issues;

  return (
    <section className="dashboard" aria-label="Agent dashboard">
      <header className="dashboard__head">
        <h2>{config.title === "" ? "Portal" : config.title}</h2>
        {/* INTERNAL, AND OFF BY DEFAULT. Tenant, layout version and the derived/
            stored distinction are what an operator needs while setting a portal up
            and are noise to anyone using one. The operator enumerated all three as
            things that made this read as a debug tool, and they were right.
            Behind ?diagnostics=1 -- see diagnostics-flag.ts for why this is not
            import.meta.env.DEV, which would be true on the very dev server the
            complaint came from. */}
        {diagnosticsEnabled() ? (
          <p className="muted muted--diagnostic">
            tenant <code>{config.tenant === "" ? "—" : config.tenant}</code> · layout version{" "}
            <code>{config.version === "" ? "—" : config.version}</code>
            {config.derived ? " · derived from registered agents, not stored" : ""}
          </p>
        ) : null}
      </header>

      {/* A fault is shown, not swallowed. The store never throws, so without this
          banner a refused payload would be indistinguishable from an empty one. */}
      {issues.length > 0 ? (
        <div className="banner banner--warn" role="status">
          <strong>{issues.length} field(s) refused by the gateway.</strong> What is below is what validated.
          <ul>
            {issues.slice(0, 8).map((issue) => (
              <li key={`${issue.path}:${issue.reason}`}>
                <code>{issue.path}</code> — {issue.reason}
              </li>
            ))}
            {issues.length > 8 ? <li>…and {issues.length - 8} more</li> : null}
          </ul>
        </div>
      ) : null}

      {config.error === null ? null : (
        <div className="banner banner--error" role="alert">
          <strong>{config.error.kind}</strong> — {config.error.message}
        </div>
      )}

      <h3>
        Agents{" "}
        {/* "1 ready, 0 stub" counts a classification nobody outside this codebase
            has a use for. The count is what matters and the classification is
            internal, so the count stays and the classification goes. */}
        {config.agents.length}
      </h3>
      {config.agents.length === 0 ? (
        <p className="muted">
          No agents yet. Add one with the form above and it will appear here.
        </p>
      ) : (
        <ul className="grid">
          {config.agents.map((agent) => (
            <AgentStatusCard key={agent.id} agent={agent} />
          ))}
        </ul>
      )}

      {config.widgets.length === 0 ? null : (
        <>
          <h3>Widgets</h3>
          <ul className="grid">
            {config.widgets.map((widget) => (
              <WidgetCard key={widget.id} widget={widget} />
            ))}
          </ul>
        </>
      )}

      <h3>{schema === null ? "Rules" : `Rules for ${schema.title}`}</h3>
      {schema === null ? (
        <p className="muted">
          {config.schemaLoading ? "Loading rules…" : "No agent selected. Choose one to load its rules."}
        </p>
      ) : schema.rules.length === 0 ? (
        <p className="muted">
          <code>{schema.id}</code> declares no rules. A schema with no rules is a screen with nothing to say.
        </p>
      ) : (
        <>
          <p className="muted">
            {/* The schema line was "dev/sla-monitor v0.0.0.dev+derived · streams ..." --
                a qualified id and a build version, neither of which a customer can
                use. What remains is what it watches, which is the point of it. */}
            watching{" "}
            {schema.streams.length === 0 ? "every stream" : schema.streams.join(", ")} ·{" "}
            {schema.rules.length} rule{schema.rules.length === 1 ? "" : "s"}
          </p>
          {/* One table, grouped by rule kind. The columns are the schema's, so a
              new rule kind needs no column and a new field needs no markup. */}
          {RULE_ORDER.filter((kind) => schema.rules.some((rule) => rule.kind === kind)).map((kind) => (
            <div key={kind} className="ruleset">
              <h4>{kind}</h4>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">rule</th>
                    <th scope="col">severity</th>
                    <th scope="col">kind</th>
                    <th scope="col">message</th>
                    <th scope="col">fires when</th>
                    <th scope="col">threshold</th>
                  </tr>
                </thead>
                <tbody>
                  {schema.rules
                    .filter((rule) => rule.kind === kind)
                    .map((rule) => (
                      <RuleRow key={rule.id} rule={rule} measured={readingFor(readings, rule.id)} />
                    ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}

      {config.forms.length === 0 ? null : (
        <>
          <h3>Forms</h3>
          {config.forms.map((form) => (
            <div key={form.id} className="ruleset">
              <h4>{form.title}</h4>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">field</th>
                    <th scope="col">label</th>
                    <th scope="col">type</th>
                    <th scope="col">required</th>
                  </tr>
                </thead>
                <tbody>
                  {form.fields.map((field) => (
                    <tr key={field.name}>
                      <td><code>{field.name}</code></td>
                      <td>{field.label}</td>
                      <td>{field.type}</td>
                      <td>{field.required === true ? "yes" : "no"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}
    </section>
  );
}