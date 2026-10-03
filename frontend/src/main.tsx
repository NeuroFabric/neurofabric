import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

/**
 * THE MOUNT POINT, AND DELIBERATELY ALMOST EMPTY.
 *
 * This micro-step delivered the data layer -- a gateway client and a schema
 * store -- and no visual components. So this file mounts a placeholder rather
 * than inventing a shell for screens that do not exist yet. A shell built now
 * would be a second place to change in the next micro-step, and it would be
 * wrong by then.
 *
 * `StrictMode` is on from the first commit rather than added later. It only
 * finds bugs while the tree is still small, which is the only time finding them
 * is cheap.
 */
const container = document.getElementById("root");

// Loudly, at boot, rather than as a blank page. `index.html` owns the id, so a
// rename there and a stale selector here would otherwise fail as "the app does
// not work" with no reason attached.
if (container === null) {
  throw new Error("index.html must provide #root for the command center to mount into");
}

createRoot(container).render(
  <StrictMode>
    <main>
      <h1>Command Center</h1>
      <p>Data layer ready. Visual components arrive in the next micro-step.</p>
    </main>
  </StrictMode>,
);