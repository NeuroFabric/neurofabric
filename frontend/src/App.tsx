import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { ReactElement } from "react";

import { AgentSelector } from "./components/AgentSelector";
import { AlertCenter } from "./components/AlertCenter";
import { DynamicDashboard } from "./components/DynamicDashboard";
import { LiveStreamView } from "./components/LiveStreamView";
import { SchemaStore, type PortalSource } from "./store/SchemaStore";
import type { AlertPayload, LiveVerdict } from "./api/live-contracts";

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
export interface AppProps {
  readonly store: SchemaStore;
  readonly source: PortalSource;
  /** The current live verdict, or null before one arrives. */
  readonly verdict?: LiveVerdict | null;
  /** Dispatched webhook payloads, newest first. */
  readonly alerts?: readonly AlertPayload[];
  /** Shown in the header so a screenshot is attributable to a credential. */
  readonly tenantHint?: string;
}

export function App({
  store,
  source,
  verdict = null,
  alerts = [],
  tenantHint = "",
}: AppProps): ReactElement {
  // `getServerSnapshot` is the third argument and it is required: without it
  // React refuses to render this component on a server at all, and throws
  // rather than degrading. Passing the same getter for both is correct here --
  // the store's state is the same object on either side.
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  useEffect(() => {
    void store.load(source);
  }, [store, source]);

  const reload = useCallback(() => {
    void store.load(source);
  }, [store, source]);

  const select = useCallback(
    (agentId: string | null) => {
      store.select(agentId);
      if (agentId !== null) void store.loadSchema(source, agentId);
    },
    [store, source],
  );

  return (
    <div className="app">
      <header className="app__bar">
        <div>
          <h1>Command Center</h1>
          <p className="muted">
            {tenantHint === "" ? "" : `${tenantHint} · `}
            schema-driven · {state.agents.length} agent{state.agents.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="app__actions">
          <span className={`pill pill--${state.status}`}>{state.status}</span>
          <button type="button" onClick={reload}>
            Reload
          </button>
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
        <DynamicDashboard config={state} />
        <aside className="app__side">
          <LiveStreamView verdict={verdict} />
          <AlertCenter alerts={alerts} verdict={verdict} />
        </aside>
      </main>
    </div>
  );
}