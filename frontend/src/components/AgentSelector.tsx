import type { ReactElement } from "react";

import type { AgentDescriptor } from "../api/contracts";

/**
 * THE AGENT SELECTOR.
 *
 * A list built from the roster, with no agent named in this file. It is a
 * `<select>` rather than a bespoke widget for a reason that is not minimalism:
 * it is keyboard-operable, screen-reader-labelled and mobile-native without a
 * line being written here, and re-implementing any of those is how a control
 * ends up reachable by mouse only.
 *
 * The selected value is always rendered, including when it is `null`: a
 * `<select>` whose value names nothing shows its first option instead, which
 * reads as "the first agent is selected" when no agent is. The store can hold a
 * null selection, so the control has to be able to say so.
 */
export interface AgentSelectorProps {
  readonly agents: readonly AgentDescriptor[];
  readonly selectedAgentId: string | null;
  readonly loading: boolean;
  readonly onSelect: (agentId: string | null) => void;
}

/** `ready` reads as healthy, `stub` as not-built-yet. Never as an error. */
function optionLabel(agent: AgentDescriptor): string {
  return `${agent.title} — ${agent.maturity}`;
}

export function AgentSelector({ agents, selectedAgentId, loading, onSelect }: AgentSelectorProps): ReactElement {
  if (agents.length === 0) {
    return <p className="muted">No agents registered for this tenant.</p>;
  }

  // A selection naming an agent that is not in the roster would silently render
  // as nothing selected. Falling back to the empty option states the truth.
  const value = agents.some((agent) => agent.id === selectedAgentId) ? (selectedAgentId ?? "") : "";

  return (
    <label className="selector">
      <span className="selector__label">
        Agent {loading ? <span className="muted">(loading rules…)</span> : null}
      </span>
      <select
        className="selector__input"
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          onSelect(next === "" ? null : next);
        }}
      >
        <option value="">— none —</option>
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {optionLabel(agent)}
          </option>
        ))}
      </select>
    </label>
  );
}