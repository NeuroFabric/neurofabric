export const ENV = {
  API_URL:
    (import.meta as any).env?.VITE_API_URL ||
    (import.meta as any).env?.VITE_BACKEND_URL ||
    (typeof window !== "undefined" && window.location.hostname.includes("onrender.com")
      ? "https://neurofabric-backend.onrender.com"
      : "http://127.0.0.1:10000"),
  INGESTION_KEY:
    (import.meta as any).env?.VITE_INGESTION_KEY || "nf-edge-telemetry-token-2026",
  COMMAND_TOKEN:
    (import.meta as any).env?.VITE_CMD_TOKEN || "nf-cap-cmd-production",
};
