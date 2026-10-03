import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { GatewayClient } from "./api/gateway-client";
import { SchemaStore } from "./store/SchemaStore";
import { simulateVerdict } from "./api/live-contracts";
import "./styles.css";

/**
 * THE BOOT SEQUENCE.
 *
 * Three objects, constructed here and nowhere else: the transport, the store,
 * and the app. That is the whole composition root, and it is worth being small:
 * every dependency is visible in one screen, so nothing can be imported from
 * somewhere that decides to make its own client.
 *
 * === WHERE THE GATEWAY CREDENTIAL COMES FROM ===
 *
 * Read from the environment at boot and handed to the client, and never written
 * into a bundle, a source file, or this repository. In a real deployment the
 * sign-in step issues it to the browser; here the variable is the stand-in for
 * that step.
 *
 * The empty-string fallback is deliberate and it is NOT a default credential.
 * `GatewayClient` refuses to be constructed with a blank token, so an
 * unconfigured deployment fails loudly at boot, on this line, naming the reason.
 * What it must never do is start up in a working-looking state that fails every
 * request -- a page that renders and then shows a wall of 401s is much harder to
 * diagnose than a page that refuses to start.
 */
const gatewayToken = import.meta.env.VITE_GATEWAY_TOKEN ?? "";

const client = new GatewayClient({ gatewayToken });
const store = new SchemaStore();

const container = document.getElementById("root");
if (container === null) {
  throw new Error("index.html must provide #root for the command center to mount into");
}

createRoot(container).render(
  <StrictMode>
    <App
      store={store}
      source={client}
      // Synthetic, and labelled as such wherever it renders. No backend endpoint
      // reports a live verdict or a throughput rate yet; `simulateVerdict` exists
      // so the telemetry views have something to exercise, and it can never be
      // mistaken for a measurement because every view is required to banner it.
      verdict={simulateVerdict(1, 250_000)}
      tenantHint={gatewayToken === "" ? "" : "gateway configured"}
    />
  </StrictMode>,
);