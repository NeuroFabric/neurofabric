import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Root } from "./Root";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

/**
 * THE MOUNT POINT.
 *
 * Three lines of real work, and that is deliberate. The previous version of this
 * file constructed the gateway client at module scope, so with no credential
 * configured the constructor threw BEFORE React existed -- no tree, no boundary,
 * no handler in a position to catch it, and the operator got a blank page.
 *
 * Now nothing is constructed here that can fail on missing configuration. The
 * credential is read, checked, and handed to `Root`, which renders either the
 * prompt or a working app. `ErrorBoundary` sits OUTSIDE `Root` so it also covers
 * Root's own render -- the point of a boundary is the part nobody anticipated.
 *
 * `StrictMode` stays: it only finds bugs while the tree is small, which is the
 * only time finding them is cheap.
 */
const container = document.getElementById("root");

// Loudly, at boot, rather than as a blank page. `index.html` owns this id, so a
// rename there and a stale selector here would otherwise fail as "the app does
// not work" with no reason attached.
if (container === null) {
  throw new Error("index.html must provide #root for the command center to mount into");
}

const environmentToken = import.meta.env.VITE_GATEWAY_TOKEN;

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary title="The command center could not start">
      {/* An empty or absent variable falls through to session storage and then to
          the prompt. It is never passed on blank. */}
      <Root environmentToken={environmentToken} />
    </ErrorBoundary>
  </StrictMode>,
);