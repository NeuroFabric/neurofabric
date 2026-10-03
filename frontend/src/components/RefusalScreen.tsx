import type { ReactElement } from "react";

import { CredentialPrompt } from "./CredentialPrompt";
import { describeCredentialLead, describeCredentialState, type CredentialState } from "../api/credential-state";

/**
 * WHAT A REFUSAL LOOKS LIKE.
 *
 * Split out of `App` for one reason: `App` reaches its refusal branch through the
 * telemetry hook, the hook runs its poll inside an effect, and an effect does not
 * run in a static render. So a screen that only `App` can reach is a screen that
 * can only be verified by eye, in a browser, by someone who happens to have a
 * refused credential on hand. These two branches are reachable directly, so they
 * are tested directly -- which is what makes "the states are visibly distinct" an
 * assertion rather than a claim about a screenshot.
 *
 * === WHY TWO VARIANTS, RATHER THAN ONE WITH A DIFFERENT LABEL ===
 *
 * When the caller owns a credential, a prompt is the screen: the operator can fix
 * this by typing. When it does not -- an integration test, or a host that supplies
 * the value another way -- there is nothing to type, and offering an input that
 * goes nowhere is worse than saying what is wrong. The second variant says it
 * plainly and offers the one action that is real.
 */
export interface RefusalScreenProps {
  readonly state: CredentialState;
  /** Present when the surrounding app can accept a newly entered credential. */
  readonly onCredentialRequired?: ((token: string) => void) | undefined;
  /** Retries the read with the credential already held. */
  readonly onRetry?: (() => void) | undefined;
}

export function RefusalScreen({ state, onCredentialRequired, onRetry }: RefusalScreenProps): ReactElement {
  // A lead of "enter the one the server was started with" on a WITHDRAWN
  // credential sends the operator round the same loop: the value cannot work and
  // the screen asked them to retype it. So the prompt's wording is per state, not
  // a constant wrapped around a varying error line.
  const lead = describeCredentialLead(state);

  if (onCredentialRequired !== undefined) {
    return <CredentialPrompt onSubmit={onCredentialRequired} error={describeCredentialState(state)} lead={lead} />;
  }

  return (
    <main className="gate">
      <div className="gate__card">
        <h1>Command Center</h1>
        {/* role="alert" because this appears where a dashboard was, with no
            transition: a screen that changes silently is a screen nobody notices
            has changed. */}
        <p className="gate__error" role="alert">
          {describeCredentialState(state)}
        </p>
        <p className="muted">{lead}</p>
        {onRetry === undefined ? null : (
          <button type="button" className="gate__submit" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    </main>
  );
}