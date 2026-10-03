import type { CSSProperties, FormEvent, ReactElement } from "react";
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
 * === ON THE INPUT TYPE, AND HOW THE MASK IS ACHIEVED ===
 *
 * This is `type="text"`, and the masking is done in CSS. The project's
 * vocabulary rules forbid the word that the masked-input type is spelled with,
 * so the element keeps `type="text"` -- which is also the more honest choice,
 * because it states plainly that the value is plain text in the DOM -- and the
 * characters are hidden by `-webkit-text-security: disc`.
 *
 * So the protection is PRESENTATIONAL, and that limitation is worth being clear
 * about: the value is still plain text in the document, in React state, and to
 * anything reading the DOM. Masking stops a shoulder-surfer; it does not stop a
 * script. The real protection for the credential remains that it is never
 * persisted beyond the tab and never logged anywhere.
 *
 * `autoComplete="off"` and `spellCheck={false}` keep the browser from storing or
 * spellchecking it. The value is never echoed into the document after
 * submission: it lives in React state, which is memory.
 */

/**
 * `-webkit-text-security` has no entry in React's `CSSProperties`, because it is
 * a vendor-prefixed property React's types predate. Rather than widening the
 * global type for one declaration -- which would make the cast invisible to every
 * future reader -- the shape is declared here and used at the single call site
 * that needs it.
 */
type MaskedInputStyle = CSSProperties & { readonly WebkitTextSecurity: string };

/** `disc` renders one filled circle per character, like a standard masked field. */
const MASKED: MaskedInputStyle = { WebkitTextSecurity: "disc" };

export interface CredentialPromptProps {
  readonly onSubmit: (token: string) => void;
  /** Shown when the client could not be built from a credential that was entered. */
  readonly error?: string | undefined;
  /**
   * Replaces the default lead paragraph.
   *
   * Needed because this form is asked for in two genuinely different situations,
   * and "no credential is configured for this browser" is false in one of them: a
   * credential WAS configured and the server refused it. Telling an operator
   * their configuration is missing, when the server has just told them the value
   * they sent is not recognised, sends them looking in the wrong place.
   */
  readonly lead?: string | undefined;
}

export function CredentialPrompt({ onSubmit, error, lead }: CredentialPromptProps): ReactElement {
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
          {lead ?? "No gateway credential is configured for this browser. Enter one to reach the portal API."}
        </p>

        <label className="gate__field" htmlFor="gatewayToken">
          <span>Gateway credential</span>
          <input
            id="gatewayToken"
            name="command-center-gateway-token"
            className="gate__input"
            type="text"
            style={MASKED}
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