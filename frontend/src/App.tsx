import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ReactElement } from "react";

import { AgentList } from "./components/AgentList";
import { AlertCenter } from "./components/AlertCenter";
import { DynamicDashboard, type RuleReading } from "./components/DynamicDashboard";
import { LiveStreamView } from "./components/LiveStreamView";
import { AGE_TICK_MS, LivenessStrip, livenessOf } from "./components/LivenessStrip";
import { StartDemo, hasDemoTransport } from "./components/StartDemo";
import { RefusalScreen } from "./components/RefusalScreen";
import { ReconciliationPanel } from "./components/ReconciliationPanel";
import { useLiveTelemetry, type LiveSource } from "./hooks/useLiveTelemetry";
import { SchemaStore, type PortalSource, type StoreStatus } from "./store/SchemaStore";
import type { AlertPayload } from "./api/live-contracts";
import type { ReconciliationDiff } from "./api/memory-contracts";

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
  /** Whether the internal view is shown. Undefined reads the browser sources. */
  readonly diagnostics?: boolean | undefined;
  /**
   * WHERE THE RECORD AND THE RUNNING SYSTEM DISAGREE.
   *
   * Three states, and the distinction between the last two is the whole point:
   *
   *  - **absent** -- no transport was ever asked. The panel renders NOTHING.
   *  - **`null`** -- a transport exists and answered, and there is nothing to
   *    compare: a process with no record open, or a record that agrees with
   *    everything.
   *  - **a diff** -- here is what disagrees.
   *
   * Absent and `null` render the same empty thing, which sounds like a collapsed
   * distinction until you ask what happens when it collapses: a panel showing "no
   * differences" because nobody asked is claiming agreement it never checked.
   * The backend already refuses to mount the route without a record, so `null`
   * here means "asked and told there is nothing", and the two cases arrive from
   * different places rather than being told apart at the call site.
   */
  readonly reconciliation?: ReconciliationDiff | null;
  /**
   * Called with a difference's key when an operator says they have seen it.
   *
   * A callback and not a client, so `App` stays a tree of components with no
   * transport of its own and a test can drive it. **There is no `resolve` prop,
   * and adding one is the mistake this signature exists to prevent**: the system
   * presents the disagreement and the operator decides what it means. What is
   * recorded is that they looked, which is a smaller and defensible claim.
   */
  readonly onAcknowledge?: ((key: string) => void) | undefined;
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
  diagnostics,
  reconciliation,
  onAcknowledge,
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

  // THE INSTALL TRANSPORT, offered only when the source can actually install.
  // Same runtime check as the front door: a cast would offer a form that 404s.
  const installSource = hasDemoTransport(source) ? source : undefined;

  /**
   * After a successful install: reload the roster, then SELECT the new agent and
   * load its rules.
   *
   * Without the select step the agent appears in the list and nothing else
   * happens, which is the half-loop this replaces. The id from the server is
   * composite (tenant/name) and is exactly what the roster will carry, so it is
   * used verbatim rather than reconstructed.
   */
  const afterInstall = useCallback(
    (agentId: string) => {
      void (async () => {
        await store.load(source);
        const composite = store.getState().agents.find((a) => a.id === agentId || a.id.endsWith(`/${agentId}`))?.id ?? agentId;
        store.select(composite);
        await store.loadSchema(source, composite);
      })();
    },
    [store, source],
  );

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
          // ADR-003: the rate decides whether the feed is LIVE. Without this the
          // strip said "Live, just now" beside "0 events/sec" after a burst.
          rate: live.snapshot?.throughput?.eventsPerSecond ?? null,
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

      {/*
        THE AGENT LIST, IN ITS OWN LANDING STRIP.

        Slice 4 (F6c): a `<select>` rendered here, which is a form control for
        the primary navigation of the product. The list is the same information in
        a shape a person can scan, and it is a real `<nav>` so the product's main
        navigation is navigable as one.

        The `<nav>` here is NOT a label for the component -- `AgentList` renders
        its own `<nav aria-label="Agents">`, and nesting a labelled navigation
        inside another navigation landmark produces two landmarks with the same
        purpose, which is exactly the sort of thing a screen-reader user has to
        disambiguate by guesswork. So this wrapper is gone with the old wrapper's
        reason, and `AgentList` owns the landmark.
      */}
      <AgentList
        agents={state.agents}
        selectedAgentId={state.selectedAgentId}
        loading={state.schemaLoading}
        onSelect={select}
      />

      <main className="app__main">
        {/*
          THE RECORD PANEL IS A SIBLING OF THE LIVE PANEL, NOT A CHILD OF IT.
          THIS IS THE STRUCTURAL HALF OF ADR-005 §9 RULE 1.

          Rule 1 says the two truths never appear in the same block, and it says
          the distinction must be STRUCTURAL RATHER THAN A CAPTION -- because a
          caption is a thing a reader can stop noticing, while a boundary is a
          thing the layout enforces. So the record sits in its own `<section>`
          above the dashboard, and the live telemetry stays in `<aside
          className="app__side">`. Nothing here reads the live verdict and nothing
          there reads the record; neither can drift into the other by accident,
          because neither has a reference to it.

          Rendered unconditionally when the prop is present, and the panel itself
          decides what to draw. Passing `null` renders nothing -- see the prop
          comment for why that is not the same as "no differences".
        */}
        <ReconciliationPanel
          diff={reconciliation ?? null}
          {...(onAcknowledge === undefined ? {} : { onAcknowledge })}
          now={now}
        />
        <DynamicDashboard config={state} readings={readings} install={installSource} onInstalled={afterInstall} {...(diagnostics === undefined ? {} : { diagnostics })} />
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

  /*
   * THE DUPLICATE BLOCK THIS REPLACES, AND WHY IT WAS HERE.
   *
   * This file ended with a SECOND verbatim copy of everything from the
   * refusal screen to the closing `return` -- sitting after the first
   * `return`, where nothing can reach it.
   *
   * Nothing caught it. `tsc` does not report unreachable code as an error by
   * default (`allowUnreachableCode` is `undefined`, which is a suggestion),
   * the tests render the LIVE copy, and both copies pass every assertion
   * anybody wrote. So the next person to change this component had a fair
   * chance of editing the copy that does not run -- and the record panel
   * added in this MR would have been the third thing wired into one of the
   * two, silently.
   *
   * It is deleted rather than left, because this is the third instance of the
   * same shape in this repository (after the CSS class collision in !97 and
   * the `StoreStatus` union drift) and the fix that keeps working is the one
   * that removes the second copy.
   */
}
