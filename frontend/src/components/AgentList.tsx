import type { ReactElement } from "react";

import type { AgentDescriptor } from "../api/contracts";

/**
 * THE AGENT LIST. Slice 4, F6c.
 *
 * === WHY THIS IS NOT A `<select>` ===
 *
 * The design log's reason, which is the right one: this is the primary navigation
 * of the product and it rendered as a native dropdown -- indistinguishable from a
 * form field, and structurally incapable of carrying a per-agent status marker,
 * which is exactly what would let an operator see "one agent is breaching"
 * without opening anything.
 *
 * === AND WHAT WAS GIVEN UP TO GET HERE, WHICH IS THE HONEST COST ===
 *
 * A `<select>` is keyboard-operable, screen-reader-labelled and mobile-native
 * without a line of code, and that is not nothing. The replacement keeps it
 * WITHOUT re-implementing any of it: every entry is a real `<button>`, so focus,
 * Tab, Enter and Space come from the browser rather than from this file, and
 * `aria-current` names the selection for a screen reader instead of a styled
 * border doing it by colour alone.
 *
 * The thing a `<select>` did that buttons do not is arrow-key roving focus. That
 * is a real, if minor, regression on a list of more than about five agents, and
 * it is stated here rather than discovered by an operator who expected it.
 *
 * === NO STATUS DOT, AND THAT IS A DECISION ===
 *
 * F6c's stated prize is a per-agent status dot, and this file deliberately does
 * not render one. **The roster carries no per-agent status**: `AgentDescriptor` is
 * a title, a domain, a version and a maturity, and the live verdict is one
 * provider-wide answer rather than one per agent. A dot drawn now would have no
 * meaning, and a meaningless indicator is worse than none -- it teaches an
 * operator to glance at something and be right by accident.
 *
 * What this file does instead is make the LIST rather than the dropdown, so a dot
 * has somewhere to live the moment something can honestly fill it. The slot is
 * the row, not the absence of a row.
 *
 * === NULL SELECTION IS STILL REPRESENTABLE ===
 *
 * The store can hold no selection, and a control that cannot say so renders the
 * first entry as if it were chosen. The "No agent open" row is a real control, not
 * a placeholder, and it is what a selection of `null` renders as.
 */
export interface AgentListProps {
  readonly agents: readonly AgentDescriptor[];
  readonly selectedAgentId: string | null;
  readonly loading: boolean;
  readonly onSelect: (agentId: string | null) => void;
}

/**
 * What a person reads in a row.
 *
 * Maturity is still not shown. `stub` is this codebase's classification and means
 * nothing outside it, and the operator listed it among the words that made this
 * read as a debug console. It remains behind the diagnostics flag.
 */
function rowLabel(agent: AgentDescriptor): string {
  return agent.title;
}

export function AgentList({ agents, selectedAgentId, loading, onSelect }: AgentListProps): ReactElement {
  if (agents.length === 0) {
    return <p className="muted">No agents registered for this tenant.</p>;
  }

  // A selection naming an agent that is not in the roster must render as no
  // selection rather than as a row that is not there.
  const selected = agents.some((agent) => agent.id === selectedAgentId) ? selectedAgentId : null;

  return (
    <nav className="agentlist" aria-label="Agents">
      <p className="agentlist__label">
        Agents
        {loading ? <span className="muted"> · loading rules…</span> : null}
      </p>

      <ul className="agentlist__items">
        <li>
          {/*
            THE NULL ROW. A real button, so it is reachable by keyboard like every
            other row, rather than a heading or a hint that only looks clickable.
          */}
          <button
            type="button"
            className="agentlist__row agentlist__row--none"
            aria-current={selected === null ? "true" : undefined}
            onClick={() => onSelect(null)}
          >
            No agent open
          </button>
        </li>
        {agents.map((agent) => (
          <li key={agent.id}>
            <button
              type="button"
              className="agentlist__row"
              // THE COMPOSITE ID TRAVELS WITH THE ROW.
              //
              // It is invisible, and it has to be here. The id is composite
              // (`tenant/name`), the selection handler needs the real one or
              // selecting the wrong agent is a bug, and with a `<select>` that id
              // was inspectable in an `option value`. Replacing the control must
              // not quietly remove the ability to check that -- so it moves to a
              // data attribute rather than to a closure where nobody can see it.
              //
              // Deliberately NOT text: a reader cannot act on `dev/sla-monitor`,
              // which is why the visible row carries the title only.
              data-agent-id={agent.id}
              aria-current={selected === agent.id ? "true" : undefined}
              onClick={() => onSelect(agent.id)}
            >
              {/*
                THE SELECTION MARKER. A shape, not a colour: the selected row also
                carries `aria-current` and a weight change, so a reader who cannot
                distinguish the accent is not left with nothing.
              */}
              <span className="agentlist__mark" aria-hidden="true" />
              <span className="agentlist__name">{rowLabel(agent)}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
