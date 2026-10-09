import { startWedgeServer } from "./platform/web/server.ts";
import { TelemetryWorker } from "./platform/ingestion/redis-queue.ts";

// Start telemetry worker in background
const worker = new TelemetryWorker(null);
worker.start().catch(err => console.error('TelemetryWorker error', err));

startWedgeServer({ cwd: process.cwd(), port: 8080 })
  .then(wedge => console.log(`🚀 NeuroFebric Backend running at ${wedge.url}`))
  .catch(err => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });