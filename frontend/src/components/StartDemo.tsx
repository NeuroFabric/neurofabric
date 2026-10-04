import { useCallback, useState } from "react";
import type { ReactElement } from "react";

import { DEMO_AGENT, DEMO_PROVIDER, demoEvents } from "../api/demo-agent";

/**
 * THE FRONT DOOR. One click, from empty to events arriving.
 *
 * === WHY THIS IS THE MOST IMPORTANT COMPONENT IN THE PRODUCT ===
 *
 * The Command Center could read every route and push nothing at all -- the
 * client had no ingest method, so a stranger who opened it had exactly two ways
 * out of an empty screen: a terminal, or a hand-built curl. An empty state with
 * no exit is not a rough edge. It is a product with no front door.
 *
 * **One click does the whole loop:** register the demo agent, push a burst of
 * traffic, and let the existing poller notice on its next read. Nothing else.
 *
 * === IT DOES NOT OPTIMISE, AND IT SAYS WHAT IT IS ===
 *
 * The button reads "Show me a demo". Not "load sample data", not "seed", and
 * never anything that implies a real pipeline is involved. A stranger must not
 * be able to finish this flow believing they are looking at a live customer.
 * Everything it pushes is synthetic and the button says so before it is pressed.
 *
 * === WHY THE AGENT IS REGISTERED FIRST ===
 *
 * Because an agent with no traffic is still an agent, and traffic with no agent
 * has nothing to belong to. Registering first means the operator can see the
 * agent appear in the list **before** the numbers start moving, so the two halves
 * of what happened are separately visible rather than one blur.
 *
 * === FAILURE IS TOLD, NOT SWALLOWED ===
 *
 * If the schema POST is refused or the ingest is refused, the button becomes a
 * sentence saying which, in the customer's language, with the technical detail
 * kept in `title` for whoever needs it. A demo that fails silently in front of a
 * stranger is worse than no demo, because it looks like a broken product.
 */

/** What the transport needs. Structural, so a test supplies three functions. */
export interface DemoSource {
  /** Registers the agent. Resolves once the server has accepted it. */
  uploadSchema(document: unknown): Promise<unknown>;
  /** Pushes a batch. Resolves with the server's own counts. */
  ingest(provider: string, events: readonly unknown[]): Promise<{ readonly accepted: number; readonly refused: number }>;
}

export interface StartDemoProps {
  readonly source: DemoSource;
  /** Called once the agent is registered, so the roster reloads. */
  readonly onAgentRegistered?: (() => void) | undefined;
  /** Events per click. The test lowers it; production uses the default. */
  readonly eventCount?: number | undefined;
}

/**
 * Can this source actually keep the demo's promise?
 *
 * A RUNTIME check, and deliberately not a cast. `PortalSource` is the store's
 * narrower interface: it declares `uploadSchema` because the store installs
 * agents, and it does not declare `ingest` because the store has never pushed
 * anything. Asserting the shape would compile and would offer a button to a
 * transport that cannot push -- which is how a front door becomes a broken one.
 */
export function hasDemoTransport(source: unknown): source is DemoSource {
  if (typeof source !== "object" || source === null) return false;
  const candidate = source as Record<string, unknown>;
  return typeof candidate.uploadSchema === "function" && typeof candidate.ingest === "function";
}

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "working"; readonly step: string }
  | { readonly kind: "done"; readonly accepted: number }
  | { readonly kind: "failed"; readonly what: string; readonly detail: string };

/**
 * Say what went wrong in the customer's language, keeping the detail for a title.
 *
 * Written as a lookup rather than an inline ternary because the alternative is a
 * sentence that grows a branch every time a new failure appears, and the branches
 * are the part nobody reads.
 */
function describeFailure(cause: unknown): { what: string; detail: string } {
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (/credential|401|not recognised|unauthenticated/i.test(detail)) {
    return { what: "This screen is not authorised to send data. Check the gateway credential.", detail };
  }
  if (/fetch failed|network|ECONNREFUSED/i.test(detail)) {
    return { what: "Cannot reach the platform. Check that it is running.", detail };
  }
  if (/schema refused|unrecognised field|unprocessable|400/i.test(detail)) {
    return { what: "The demo agent could not be registered. This is our fault, not yours.", detail };
  }
  return { what: "The demo could not start.", detail };
}

export function StartDemo({ source, onAgentRegistered, eventCount }: StartDemoProps): ReactElement {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const start = useCallback(() => {
    if (phase.kind === "working") return;
    setPhase({ kind: "working", step: "Registering the demo agent…" });
    void (async () => {
      try {
        // FIRST the agent, so the roster shows it before anything moves.
        await source.uploadSchema(DEMO_AGENT);
        onAgentRegistered?.();
        setPhase({ kind: "working", step: "Sending sample traffic…" });

        const batch = demoEvents(eventCount);
        const result = await source.ingest(DEMO_PROVIDER, batch.events);
        setPhase({ kind: "done", accepted: result.accepted });
      } catch (cause) {
        const { what, detail } = describeFailure(cause);
        setPhase({ kind: "failed", what, detail });
      }
    })();
  }, [phase.kind, source, onAgentRegistered, eventCount]);

  if (phase.kind === "done") {
    return (
      <div className="demo demo--done" data-demo-phase="done" data-demo-accepted={phase.accepted} role="status">
        <strong>Running.</strong> {phase.accepted.toLocaleString("en-GB")} sample events accepted. Live numbers are
        arriving now.
      </div>
    );
  }

  return (
    <div className="demo" data-demo-phase={phase.kind}>
      {phase.kind === "working" ? (
        <p className="demo__step" role="status">
          {phase.step}
        </p>
      ) : null}

      {phase.kind === "failed" ? (
        <p className="demo__error" role="alert" title={phase.detail}>
          {phase.what}
        </p>
      ) : null}

      <button type="button" className="demo__button" onClick={start} disabled={phase.kind === "working"}>
        {phase.kind === "working" ? "Starting…" : phase.kind === "failed" ? "Try again" : "Show me a demo"}
      </button>

      {/* The sample is named BEFORE it is pushed, and named again after. A
          stranger must never be able to finish this flow believing they are
          looking at a live customer pipeline. The `done` case returned above, so
          this line only ever renders pre- or mid-flight. */}
      <p className="demo__note">
        This creates a sample agent and sends generated traffic so you can see the screen work. Nothing leaves this
        machine.
      </p>
    </div>
  );
}