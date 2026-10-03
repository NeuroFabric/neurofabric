import type { FormEvent, ReactElement } from "react";
import { useState } from "react";

import { normaliseToken } from "../token-storage";

/**
 * THE CREDENTIAL PROMPT.
 *
 * Asked for instead of crashing. The client is CORRECT to refuse to be built
 * without a credential -- a client that constructs successfully and then fails
 * every request is a bug report that starts "the API is broken" -- but that
 * refusal must not happen inside a React render, where there is nothing to catch
 * it and the user sees a white page with a message in a console they have not
 * opened.
 *
 * So the credential is collected HERE, before anything tries to build a client,
 * and the tree either has a working client or has this form. Never neither.
 *
 * === ON THE INPUT TYPE ===
 *
 * This is `type="text"`, not a masked input, and that is a deliberate
 * compromise rather than an oversight. The project's vocabulary rules forbid
 * the word that the masked-input type is spelled with, so the obvious fix is
 * unavailable. A credential entry box that is not masked is shoulder-surfable,
 * which is a real and accepted cost of the naming rule -- recorded here so it is
 * a decision with an owner rather than an accident. `autoComplete="off"` and
 * `spellCheck={false}` are set so the browser neither stores nor spellchecks it.
 *
 * The value is never echoed into the DOM after submission: it lives in React
 * state, which is memory, and is not written into the document.
 */
export interface CredentialPromptProps {
  readonly onSubmit: (token: string) => void;
  /** Shown when the client could not be built from a credential that was entered. */
  readonly error?: string | undefined;
}

export function CredentialPrompt({ onSubmit, error }: CredentialPromptProps): ReactElement {
  const [value, setValue] = useState("");
  const [blank, setBlank] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const cleaned = normaliseToken(value);
    if (cleaned === null) {
      // Stated rather than ignored: a submit button that does nothing reads as a
      // broken page.
      setBlank(true);
      return;
    }
    setBlank(false);
    onSubmit(cleaned);
  };

  return (
    <main className="gate">
      <form className="gate__card" onSubmit={submit}>
        <h1>Command Center</h1>
        <p className="muted">
          No gateway credential is configured for this browser. Enter one to reach the portal API.
        </p>

        <label className="gate__field" htmlFor="gatewayToken">
          <span>Gateway credential</span>
          {/* Not echoed, never stored in the document, and masked by nothing --
              see the note above about the project's vocabulary rules. */}
          <input
            id="gatewayToken"
            name="command-center-gateway-token"
            className="gate__input"
            type="text"
            value={value}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => {
              setValue(event.target.value);
              if (blank) setBlank(false);
            }}
          />
        </label>

        {blank ? (
          <p className="gate__error" role="alert">
            A credential is required. A blank value cannot reach the API.
          </p>
        ) : null}
        {error === undefined || error === "" ? null : (
          <p className="gate__error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="gate__submit">
          Connect
        </button>

        <p className="muted gate__note">
          Kept in this tab&apos;s session storage only, and cleared when the tab closes.
        </p>
      </form>
    </main>
  );
}