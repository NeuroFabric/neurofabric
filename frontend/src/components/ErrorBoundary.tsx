import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * THE ERROR BOUNDARY. A CLASS, because that is still the only way to write one.
 *
 * === WHY THIS EXISTS RATHER THAN A TRY/CATCH ===
 *
 * A `try`/`catch` around a render does nothing: React throws asynchronously
 * during its own work, and the exception unwinds out of the reconciler rather
 * than through the call site that drew the component. The only supported way to
 * catch it and keep the page alive is a boundary -- so this is a class, and
 * `getDerivedStateFromError` is static, and that is not a style choice.
 *
 * === WHAT IT BUYS ===
 *
 * A styled explanation with a way forward, instead of a white page. The specific
 * failure it exists to cover already happened: `GatewayClient` threw from a
 * module-level `new` in `main.tsx`, outside any tree, and React had nothing to
 * catch, so the operator got a blank page and a message in a console tab they
 * had not opened. Boot is now guarded, but a boundary is what stops the NEXT
 * unguarded constructor from repeating it.
 *
 * === WHAT IT DOES NOT COVER, AND THAT IS THE HONEST LIMIT ===
 *
 * Errors thrown by event handlers, by async code, and by the initial render of
 * `main.tsx` itself. Those do not pass through a boundary; they need their own
 * handling at their own call site. This is a floor, not a net.
 */
export interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /** Optional heading. Defaults to something that names no internals. */
  readonly title?: string;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  /**
   * Static, by requirement. React calls it to derive the next state; it must not
   * touch `this`.
   */
  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    // Normalised, because the thrown value is not guaranteed to be an Error and
    // `error.message` on a string is `undefined`, which would render a fallback
    // with a blank explanation -- the worst possible version of this component.
    const normalised = error instanceof Error ? error : new Error(String(error));
    return { error: normalised };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Deliberately a console line and nothing more. There is no telemetry sink
    // in this project, and inventing one that POSTs errors to a third party
    // would be a worse default than a console line. The component stack is
    // included because it is what makes the line actionable.
    console.error("command center: a render failed and was contained", error, info.componentStack);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <main className="gate">
        <div className="gate__card gate__card--error" role="alert">
          <h1>{this.props.title ?? "Something broke in this view"}</h1>
          <p className="muted">
            The error was caught rather than left to blank the page. Nothing was written and no request was lost.
          </p>
          <p className="gate__error">
            <strong>{error.name}</strong>: {error.message}
          </p>
          <button type="button" className="gate__submit" onClick={this.reset}>
            Try again
          </button>
        </div>
      </main>
    );
  }
}