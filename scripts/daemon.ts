import { createIngressGateway } from "../platform/gateway/ingress-server.ts";
import { startWedgeServer } from "../platform/web/server.ts";

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT || 8080);
const WEDGE_PORT = Number(process.env.WEDGE_PORT || 3000);
const HOST = "127.0.0.1";

async function bootDaemon() {
  console.log("===================================================================");
  console.log("   NEUROFABRIC PRODUCTION SUPERVISOR DAEMON                       ");
  console.log("===================================================================");

  // 1. Boot Edge Telemetry Gateway on Port 8080
  const gatewayServer = createIngressGateway({ port: GATEWAY_PORT, host: HOST });
  await new Promise<void>((resolve, reject) => {
    gatewayServer.once("error", reject);
    gatewayServer.listen(GATEWAY_PORT, HOST, () => resolve());
  });
  console.log(`  [+] Edge Ingress Gateway listening on http://${HOST}:${GATEWAY_PORT}`);

  // 2. Boot The Wedge UI on Port 3000 (Pure ADR-005 dashboard)
  const runningWedge = await startWedgeServer({
    cwd: process.cwd(),
    port: WEDGE_PORT,
    host: HOST,
  });
  console.log(`  [+] The Wedge Dashboard listening on http://${HOST}:${WEDGE_PORT}`);

  console.log("\nNeuroFabric topology active. Press Ctrl+C to terminate cleanly.");

  // Graceful multi-process shutdown handler
  let shuttingDown = false;
  async function teardown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[Daemon] Received ${signal}. Shutting down all listeners...`);

    try {
      await Promise.all([
        new Promise<void>((res) => gatewayServer.close(() => res())),
        runningWedge.close(),
      ]);
      console.log("[Daemon] All ports (8080, 3000) released cleanly.");
      process.exit(0);
    } catch (err) {
      console.error("[Daemon] Error during teardown:", err);
      process.exit(1);
    }
  }

  process.on("SIGINT", () => teardown("SIGINT"));
  process.on("SIGTERM", () => teardown("SIGTERM"));
}

bootDaemon().catch((err) => {
  console.error("[Daemon] Fatal boot error:", err);
  process.exit(1);
});
