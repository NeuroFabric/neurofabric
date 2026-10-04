import { useCallback, useState } from "react";
import type { ReactElement } from "react";

import type { PortalField, PortalForm } from "../api/contracts";

/**
 * INSTALL AN AGENT. The whole loop, in the browser.
 *
 * === WHAT WAS HERE BEFORE ===
 *
 * A TABLE. The "Forms" section rendered a read-only description of the form the
 * portal declared — a list of field names, labels, types and whether each was
 * required — and called it a form. There was no input, no submit, and no code
 * path from the UI to `POST /api/portal/schema` at all.
 *
 * So the honest description of the previous state is that installing an agent was
 * something a person did with curl, and the screen described the paperwork.
 *
 * === THE SCHEMA IS BUILT, NOT COLLECTED ===
 *
 * The portal declares two fields — an id and a title. A valid `AgentSchema` needs
 * considerably more: a domain, a version, capabilities, streams, and **at least
 * one rule** (the registry refuses a schema with none, which is why the very first
 * demo POST answered 400).
 *
 * Asking an operator for all of that would be a form nobody fills in. So the two
 * things a person can meaningfully name are asked for, and the rest is supplied —
 * visibly. **A starter rule is created and the panel says so**, because an agent
 * that silently arrived with a rule nobody chose is worse than one that visibly
 * did.
 *
 * === WHY THIS IS NOT THE FRONT DOOR ===
 *
 * The front door is one click that demonstrates. This is the real authoring path,
 * and it is deliberately more work: the difference between watching a product work
 * and operating one.
 */

/** What the form needs from the platform. Structural, so a test supplies three functions. */
export interface InstallSource {
  uploadSchema(document: unknown): Promise<unknown>;
}

export interface InstallAgentFormProps {
  readonly form: PortalForm;
  readonly source: InstallSource;
  /** Called after a successful install, with the id that was installed. */
  readonly onInstalled?: ((agentId: string) => void) | undefined;
}

/**
 * Turn what a person typed into something the REGISTRY will accept.
 *
 * Exported because the grammar is the registry's, not ours, and the first version
 * of the demo agent invented field names that validator refused. Anything this
 * builds is asserted against the same allowed-key set the demo agent test uses.
 */
export function buildSchemaDocument(fields: Readonly<Record<string, string>>): Record<string, unknown> {
  const id = (fields["id"] ?? "").trim();
  const title = (fields["title"] ?? "").trim();

  return {
    id,
    title: title === "" ? id : title,
    domain: "anomaly",
    version: "1.0.0",
    capabilities: ["Flags a breached service level"],
    streams: ["elapsed_time", "threshold"],
    rules: [
      {
        // Only keys the registry's grammar accepts. See demo-agent.test.ts for the
        // allowed set and the failure this list produced when it was guessed.
        id: "starter-rule",
        kind: "missing-field",
        severity: "warning",
        message: "A starter rule, added so the agent can be registered. Edit it to describe your own.",
        field: "elapsed_time",
      },
    ],
    // Carried for the operator's benefit, and stripped before it is sent.

  };
}

/** Say what went wrong in the customer's language, keeping the detail in `title`. */
function describeFailure(cause: unknown): { what: string; detail: string } {
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (/credential|401|not recognised|unauthenticated/i.test(detail)) {
    return { what: "This screen is not authorised to install agents. Check the gateway credential.", detail };
  }
  if (/fetch failed|network|ECONNREFUSED/i.test(detail)) {
    return { what: "Cannot reach the platform. Check that it is running.", detail };
  }
  // The registry's refusals are the ones a person can act on: they name the field.
  if (/schema refused|unrecognised field|needs at least one rule|\$\./i.test(detail)) {
    return { what: "The platform refused that agent. The details are below.", detail };
  }
  return { what: "The agent could not be installed. This is probably our fault.", detail };
}

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "working" }
  | { readonly kind: "done"; readonly agentId: string }
  | { readonly kind: "failed"; readonly what: string; readonly detail: string };

export function InstallAgentForm({ form, source, onInstalled }: InstallAgentFormProps): ReactElement {
  const [values, setValues] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const set = useCallback((name: string, value: string) => {
    setValues((previous) => ({ ...previous, [name]: value }));
  }, []);

  const submit = useCallback(
    (event: { preventDefault(): void }) => {
      event.preventDefault();
      if (phase.kind === "working") return;

      // Required fields are checked HERE rather than by the browser, because a
      // native bubble is not an error the operator can read in this product's
      // language and it disappears the moment they click again.
      const missing = form.fields.filter((f: PortalField) => f.required === true && (values[f.name] ?? "").trim() === "");
      if (missing.length > 0) {
        setPhase({
          kind: "failed",
          what: `Give it a ${missing.map((f) => f.label.toLowerCase()).join(" and a ")} first.`,
          detail: missing.map((f) => `${f.name} is required`).join("; "),
        });
        return;
      }

      setPhase({ kind: "working" });
      void (async () => {
        try {
          const document = buildSchemaDocument(values);
          await source.uploadSchema(document);
          const agentId = String(document["id"] ?? "");
          setPhase({ kind: "done", agentId });
          onInstalled?.(agentId);
        } catch (cause) {
          const { what, detail } = describeFailure(cause);
          setPhase({ kind: "failed", what, detail });
        }
      })();
    },
    [phase.kind, form, values, source, onInstalled],
  );

  if (phase.kind === "done") {
    return (
      <div className="install install--done" data-install-phase="done" data-install-id={phase.agentId} role="status">
        <strong>{phase.agentId}</strong> is installed and in the list above.
        <button type="button" className="install__again" onClick={() => setPhase({ kind: "idle" })}>
          Add another
        </button>
      </div>
    );
  }

  return (
    <form className="install" data-install-phase={phase.kind} onSubmit={submit}>
      {form.fields.map((field: PortalField) => (
        <label className="install__field" key={field.name} htmlFor={`install-${field.name}`}>
          <span>{field.label}</span>
          <input
            id={`install-${field.name}`}
            name={field.name}
            type="text"
            value={values[field.name] ?? ""}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => set(field.name, event.target.value)}
          />
        </label>
      ))}

      {phase.kind === "failed" ? (
        <p className="install__error" role="alert" title={phase.detail}>
          {phase.what}
        </p>
      ) : null}

      <button type="submit" className="install__button" disabled={phase.kind === "working"}>
        {phase.kind === "working" ? "Installing…" : form.title}
      </button>

      {/* Stated, not hidden. An agent that arrives with a rule nobody chose is
          worse than one that visibly does, and the operator will want to edit it. */}
      <p className="install__note">
        We add a starter rule so the agent can be registered, and you can change it afterwards.
      </p>
    </form>
  );
}