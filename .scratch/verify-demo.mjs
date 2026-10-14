/**
 * LIVE RECEIPT FOR THE DEMO AGENT. One-shot, quarantined in `.scratch`.
 *
 * Imports the real `DEMO_AGENT` and the real generator -- not a copy -- and runs
 * the whole front-door sequence against a REAL wedge over HTTP. A hand-written
 * curl body would be a different document from the one that ships, and the point
 * of this check is that they are the SAME document.
 *
 * Run it with the wedge already listening and the credential in argv.
 *
 *   node --experimental-strip-types .scratch/verify-demo.mjs <token> [baseUrl]
 */
import { DEMO_AGENT, DEMO_PROVIDER, demoEvents } from "../frontend/src/api/demo-agent.ts";

const TOKEN = process.argv[2];
const BASE = process.argv[3] ?? "http://127.0.0.1:8095";
if (TOKEN === undefined || TOKEN === "") throw new Error("usage: node .scratch/verify-demo.mjs <token> [baseUrl]");

const H = { "x-gateway-token": TOKEN, "content-type": "application/json" };
const line = (k, v) => console.log(`  ${String(k).padEnd(22)} ${v}`);

console.log("\n=== the front door, against a real wedge ===\n");

const t0 = Date.now();

// STEP 1 — register the agent, exactly as the button does.
const posted = await fetch(`${BASE}/api/portal/schema`, { method: "POST", headers: H, body: JSON.stringify(DEMO_AGENT) });
const postedBody = await posted.text();
console.log(`POST /api/portal/schema   ${posted.status}`);
console.log(`  ${postedBody.slice(0, 200)}`);

if (!posted.ok) {
  console.log("\nFAIL: the demo schema was refused. The front door would be broken.");
  process.exit(1);
}

const roster = await (await fetch(`${BASE}/api/portal/agents`, { headers: H })).json();
console.log(`\nGET  /api/portal/agents   ${roster.total} agent(s)`);
line("ids", roster.agents.map((a) => a.id).join(", "));

// STEP 2 — push the generated batch, exactly as the button does.
const batch = demoEvents();
const push = await fetch(`${BASE}/api/portal/ingest`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ provider: DEMO_PROVIDER, events: batch.events }),
});
const pushed = await push.json();
console.log(`\nPOST /api/portal/ingest   ${push.status}`);
line("accepted", pushed.accepted);
line("refused", pushed.refused);
line("provider", pushed.provider);

// STEP 3 — the panel must have something to show.
await new Promise((r) => setTimeout(r, 150));
const snap = await (await fetch(`${BASE}/api/portal/live`, { headers: H })).json();
console.log(`\nGET  /api/portal/live     ${snap.verdict ? "verdict present" : "NO VERDICT"}`);
line("records", snap.verdict?.records ?? "null");
line("breachedColumns", snap.verdict?.breachedColumns ?? "null");
line("columns", snap.verdict?.columns.map((c) => c.column).join(", ") ?? "-");
for (const c of snap.verdict?.columns ?? []) {
  line(`  ${c.column}`, `max=${c.max} outerFence=${c.extremeUpper} breached=${c.breached}`);
}

console.log(`\nWALL CLOCK for register + push + read: ${Date.now() - t0}ms`);
console.log(`Acceptance is 5000ms from the click; this excludes render, which needs a browser.\n`);