import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";

import { AgentSelector } from "./components/AgentSelector";
import { AlertCenter } from "./components/AlertCenter";
import { DynamicDashboard, type RuleReading } from "./components/DynamicDashboard";
import { LiveStreamView } from "./components/LiveStreamView";
import { AGE_TICK_MS, LivenessStrip, livenessOf } from "./components/LivenessStrip";
import { StartDemo, hasDemoTransport } from "./components/StartDemo";
import { RefusalScreen } from "./components/RefusalScreen";
import { useLiveTelemetry, type LiveSource } from "./hooks/useLiveTelemetry";
import { SchemaStore, type PortalSource, type StoreStatus } from "./store/SchemaStore";
import type { AlertPayload } from "./api/live-contracts";

/**
 * THE COMMAND CENTER.
 *
 * === WHY THE STORE IS A PROP ===
 *
 * `App` takes its `store` and its `source` rather than building them. That is
 * what makes the integration test possible at all: a test builds a real store
 * over a mocked client, drives it to a known state, and renders the real tree.
 * If App constructed its own store internally, the only way to test it would be
 * to fire effects and wait, in a DOM, which this environment does not have.
 *
 * So the wiring is exercised for real -- same store, same components, same
 * reducer -- and the only thing swapped is the transport. The effects that fetch
 * on mount are the one part `renderToStaticMarkup` will not run, which is
 * stated in the test file rather than left to be discovered.
 */
/**
 * What a person reads instead of the store's internal status word.
 *
 * === WHY THIS EXISTS ===
 *
 * The header rendered `state.status` verbatim: `idle`, `loading`, `ready`,
 * `degraded`. "degraded" in particular is a word that means whatever the reader
 * is already worried about -- it is the store's honest name for "some payloads
 * were fine and some were refused", which is a fact a person needs stated
 * precisely, not shouted. This was the clearest "this is a debug console"
 * symptom in the tree, and it was one span wide.
 *
 * The keys are `StoreStatus`, not strings, so a state added to the union fails
 * the type gate here instead of shipping untranslated. That is the fourth
 * instance of one lesson in this repository: a literal drifts, a type does not.
 */
const STATUS_WORDS: Record<StoreStatus, string> = {
  idle: "Not loaded",
  loading: "Loading",
  ready: "Ready",
  degraded: "Partial data",
};

export function statusWord(status: string): string {
  return STATUS_WORDS[status as StoreStatus] ?? status;
}

/**
 * A wall clock that ticks, for showing how old something is.
 *
 * === WHY THIS IS A HOOK AND NOT A VALUE PASSED AROUND ===
 *
 * "Last answer: 43s ago" is only true if something re-reads the clock. Without
 * it the age is frozen at whatever it was when the panel rendered, and a frozen
 * age is worse than none -- it looks live and is not.
 *
 * The tick is deliberately coarser than the 500ms poll. The age is the ONLY thing
 * that changes without new data, so re-rendering it at the poll rate would double
 * the render count for a number that only moves once a second. One second reads
 * as live; a fifth of a second reads as a machine with nothing better to do.
 *
 * Cleared on unmount for the reason every timer here is cleared: a timer that
 * outlives its component keeps the event loop alive, and this repository has been
 * hung by exactly that shape once.
 */
function useNow(intervalMs: number = AGE_TICK_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export interface AppProps {
  readonly store: SchemaStore;
  readonly source: PortalSource;
  /**
   * The transport for telemetry. Separate from `source` because the store only
   * needs the three calls it makes, while polling needs `fetchLive`, and a test
   * double for one should not be forced to implement the other.
   */
  readonly liveSource?: LiveSource;
  /** Dispatched webhook payloads, newest first. */
  readonly alerts?: readonly AlertPayload[];
  /** Poll cadence. Defaults to 500ms; tests shorten it rather than disabling it. */
  readonly pollMs?: number;
  /**
   * Called with a newly entered credential when polling has been halted by a
   * refusal.
   *
   * Optional because the caller that owns the credential is `Root`, and a test
   * that renders `App` with a fake transport does not own one. Absent, the tree
   * says what is wrong and stops -- which is a complete screen, not a broken one.
   */
  readonly onCredentialRequired?: ((token: string) => void) | undefined;
}

/**
 * What the hook polls when no live transport was supplied.
 *
 * A rejected promise rather than a fake snapshot, so an unwired app says
 * "connecting" and never shows a number nobody measured.
 */
const IDLE_SOURCE: LiveSource = {
  fetchLive: () => Promise.reject(new Error("no live transport is wired")),
};

export function App({
  store,
  source,
  liveSource,
  alerts = [],
  pollMs,
  onCredentialRequired,
}: AppProps): ReactElement {
  // `getServerSnapshot` is the third argument and it is required: without it
  // React refuses to render this component on a server at all, and throws
  // rather than degrading. Passing the same getter for both is correct here --
  // the store's state is the same object on either side.
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  // Polling only runs when a live transport was supplied, so a static render --
  // and every integration test -- creates no interval and leaves no timer.
  const live = useLiveTelemetry(liveSource ?? IDLE_SOURCE, pollMs);
  const now = useNow();

  /**
   * THE READINGS THE RULE PANEL NEEDS, DERIVED FROM THE LIVE VERDICT.
   *
   * `DynamicDashboard` takes `readings` and defaulted it to an empty array, and
   * `App` never passed one — so `measured` was ALWAYS undefined and every rule
   * rendered "limit 1000, no reading yet" directly beneath a panel showing a
   * critical breach. Two surfaces, two answers, both true-looking.
   *
   * The join is by COLUMN NAME, not by rule id: the verdict reports
   * `elapsed_time`, the rule declares `field: "elapsed_time"`, and nothing in
   * the pipeline gives a rule an id the verdict knows about.
   *
   * `useMemo` because this runs on every poll and would otherwise allocate a
   * fresh array each time, re-rendering every rule row for a list that is almost
   * always identical to the last one.
   */
  const readings = useMemo<RuleReading[]>(() => {
    const columns = live.snapshot?.verdict?.columns ?? [];
    if (columns.length === 0) return [];
    const out: RuleReading[] = [];
    for (const rule of state.schema?.rules ?? []) {
      const field = "field" in rule && typeof rule.field === "string" ? rule.field : null;
      if (field === null) continue;
      const column = columns.find((candidate) => candidate.column === field);
      if (column === undefined) continue;
      out.push({ ruleId: rule.id, value: column.measured });
    }
    return out;
  }, [live.snapshot, state.schema]);

  useEffect(() => {
    void store.load(source);
  }, [store, source]);

  const reload = useCallback(() => {
    void store.load(source);
  }, [store, source]);

  // THE FRONT DOOR, and only when the transport can keep the promise.
  //
  // Declared AFTER `reload`, because it closes over it. The first version had it
  // above, which the type gate caught immediately -- and it was a real defect, not
  // a type nit: `reload` would have been read before it was assigned.
  //
  // A runtime CHECK rather than a cast: `PortalSource` is the store's narrower
  // interface and does not declare `ingest`, so without it a component could be
  // handed a source with no way to push and would offer a button that cannot work.
  const demo =
    hasDemoTransport(source) && liveSource !== undefined ? (
      <StartDemo source={source} onAgentRegistered={reload} />
    ) : null;

  const select = useCallback(
    (agentId: string | null) => {
      store.select(agentId);
      if (agentId !== null) void store.loadSchema(source, agentId);
    },
    [store, source],
  );

  /**
   * THE REFUSAL SCREEN, TAKEN BEFORE THE DASHBOARD.
   *
   * A refused credential is not a degraded dashboard. It is a question only a
   * person can answer, and it is asked ONCE, in place of the screen whose data
   * could never arrive. Returning early here is what makes the two states visibly
   * distinct rather than merely differently bad: without it the operator gets a
   * shell with refused-field panels and a live panel that can only ever say
   * "unreachable", which is precisely the screenshot this replaces.
   *
   * Both variants live in `RefusalScreen`, reachable without an effect, so what
   * is asserted about them is what an operator would actually see.
   */
  if (live.credentialRequired) {
    return (
      <RefusalScreen
        state={live.state}
        {...(onCredentialRequired === undefined ? {} : { onCredentialRequired })}
        onRetry={reload}
      />
    );
  }

  return (
    <div className="app">
      {/* THE STATUS LINE, FIRST, ABOVE EVERYTHING.
          *
          "Visible without scrolling" is the requirement, and putting it here
          * rather than in the side panel is what satisfies it. A fault you have
          * to scroll to find is a fault an operator misses, and the state that
          * must never be ambiguous is the one that costs the most to reach. */}
      <LivenessStrip
        liveness={livenessOf({
          credentialRequired: live.credentialRequired,
          lastUpdated: live.snapshot?.at ?? null,
          now,
          loading: live.loading,
          records: live.snapshot?.verdict?.records ?? null,
        })}
        lastUpdated={live.snapshot?.at ?? null}
        now={now}
        credentialState={live.state}
        fault={live.error}
        records={live.snapshot?.verdict?.records ?? null}
      />

      <header className="app__bar">
        {/* THE PRODUCT'S NAME, CENTRED. It was "Command Center" in the left
            gutter, which is a description of a component rather than a product
            -- and the word "Neurofebric" appeared nowhere on screen at all. The
            class carries the centring so the change is one line of CSS rather
            than a layout rewrite. */}
        <div className="app__identity">
          <h1 className="app__wordmark">Neurofebric</h1>
        </div>
        <div className="app__meta">
          <p className="muted">
            {liveSource === undefined ? "schema-driven · " : "schema-driven · live · "}
            {state.agents.length} agent{state.agents.length === 1 ? "" : "s"}
          </p>
          <div className="app__actions">
            {/* The CLASS still carries the machine state, for styling and for the
                test that asserts on it. Only the word a person reads changes. */}
            <span className={`pill pill--${state.status}`} data-status={state.status}>
              {statusWord(state.status)}
            </span>
            <button type="button" onClick={reload}>
              Reload
            </button>
          </div>
        </div>
      </header>

      <nav className="app__select" aria-label="Agent selection">
        <AgentSelector
          agents={state.agents}
          selectedAgentId={state.selectedAgentId}
          loading={state.schemaLoading}
          onSelect={select}
        />
      </nav>

      <main className="app__main">
        <DynamicDashboard config={state} readings={readings} />
        <aside className="app__side">
          <LiveStreamView
            verdict={live.snapshot?.verdict ?? null}
            throughput={live.snapshot?.throughput ?? null}
            error={live.error ?? undefined}
            loading={live.loading}
            idle={live.snapshot !== null && live.snapshot.verdict !== null && live.snapshot.verdict.records === 0}
            demo={demo}
          />
          <AlertCenter alerts={alerts} verdict={live.snapshot?.verdict ?? null} />
        </aside>
      </main>
    </div>
  );

  /**
   * THE REFUSAL SCREEN, TAKEN BEFORE THE DASHBOARD.
   *
   * A refused credential is not a degraded dashboard. It is a question only a
   * person can answer, and it is asked ONCE, in place of the screen whose data
   * could never arrive. Returning early here is what makes the two states visibly
   * distinct rather than merely differently bad: without it the operator gets a
   * shell with refused-field panels and a live panel that can only ever say
   * "unreachable", which is precisely the screenshot this replaces.
   *
   * Both variants live in `RefusalScreen`, reachable without an effect, so what
   * is asserted about them is what an operator would actually see.
   */
  if (live.credentialRequired) {
    return (
      <RefusalScreen
        state={live.state}
        {...(onCredentialRequired === undefined ? {} : { onCredentialRequired })}
        onRetry={reload}
      />
    );
  }

  return (
    <div className="app">
      {/* THE STATUS LINE, FIRST, ABOVE EVERYTHING.
          *
          "Visible without scrolling" is the requirement, and putting it here
          * rather than in the side panel is what satisfies it. A fault you have
          * to scroll to find is a fault an operator misses, and the state that
          * must never be ambiguous is the one that costs the most to reach. */}
      <LivenessStrip
        liveness={livenessOf({
          credentialRequired: live.credentialRequired,
          lastUpdated: live.snapshot?.at ?? null,
          now,
          loading: live.loading,
          records: live.snapshot?.verdict?.records ?? null,
        })}
        lastUpdated={live.snapshot?.at ?? null}
        now={now}
        credentialState={live.state}
        fault={live.error}
        records={live.snapshot?.verdict?.records ?? null}
      />

      <header className="app__bar">
        {/* THE PRODUCT'S NAME, CENTRED. It was "Command Center" in the left
            gutter, which is a description of a component rather than a product
            -- and the word "Neurofebric" appeared nowhere on screen at all. The
            class carries the centring so the change is one line of CSS rather
            than a layout rewrite. */}
        <div className="app__identity">
          <h1 className="app__wordmark">Neurofebric</h1>
        </div>
        <div className="app__meta">
          <p className="muted">
            {liveSource === undefined ? "schema-driven · " : "schema-driven · live · "}
            {state.agents.length} agent{state.agents.length === 1 ? "" : "s"}
          </p>
          <div className="app__actions">
            {/* The CLASS still carries the machine state, for styling and for the
                test that asserts on it. Only the word a person reads changes. */}
            <span className={`pill pill--${state.status}`} data-status={state.status}>
              {statusWord(state.status)}
            </span>
            <button type="button" onClick={reload}>
              Reload
            </button>
          </div>
        </div>
      </header>

      <nav className="app__select" aria-label="Agent selection">
        <AgentSelector
          agents={state.agents}
          selectedAgentId={state.selectedAgentId}
          loading={state.schemaLoading}
          onSelect={select}
        />
      </nav>

      <main className="app__main">
        <DynamicDashboard config={state} readings={readings} />
        <aside className="app__side">
          <LiveStreamView
            verdict={live.snapshot?.verdict ?? null}
            throughput={live.snapshot?.throughput ?? null}
            error={live.error ?? undefined}
            demo={demo}
          />
          <AlertCenter alerts={alerts} verdict={live.snapshot?.verdict ?? null} />
        </aside>
      </main>
    </div>
  );
}