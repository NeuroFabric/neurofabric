/**
 * QUARANTINED VERIFICATION PROBE. NOT A DELIVERABLE, NOT A TEST, NEVER COMMITTED.
 *
 * `.scratch/` is gitignored, and this file stays there for the same reason the
 * deletion guard refuses to remove probe files: a file that was needed is kept and
 * named, not quietly disposed of. Run it by hand; the suite does not glob it.
 *
 * WHAT IT PROVES. The browser is the one thing this environment cannot open, so
 * the claim "the command center authenticates" is checked the next best way: the
 * REAL `GatewayClient`, carrying the REAL header name, against the REAL running
 * wedge through the REAL dev proxy at the same base URL the browser uses. What it
 * cannot prove -- pixels, CSS, a click on Connect -- is stated as such rather than
 * implied by the pass.
 *
 * USAGE. `node --experimental-strip-types .scratch/verify-live.mjs <token>`
 * The value is passed on the command line rather than written here, so this file
 * holds no credential and can be committed-as-is if this class of check is ever
 * promoted.
 */
import { GatewayClient } from "../frontend/src/api/gateway-client.ts";
import { credentialStateOf, describeCredentialState } from "../frontend/src/api/credential-state.ts";
import { TelemetryPoller } from "../frontend/src/api/telemetry-poller.ts";

const BASE = "http://127.0.0.1:5173";
const token = process.argv[2];

if (token === undefined || token === "") {
  console.error("usage: node --experimental-strip-types .scratch/verify-live.mjs <token>");
  process.exit(2);
}

const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`);

async function check(label, fn) {
  try {
    const out = await fn();
    console.log(`PASS  ${label}`);
    if (out !== undefined) console.log(`      ${out}`);
    return true;
  } catch (error) {
    console.log(`FAIL  ${label}`);
    console.log(`      ${error.constructor.name}: ${error.message}`);
    return false;
  }
}

console.log("\n=== Command Center: live read path, real client, real proxy ===\n");

const client = new GatewayClient({ gatewayToken: token, baseUrl: BASE });

await check("GET /config", async () => {
  const { derived, config } = await client.fetchPortalConfig();
  line("derived", String(derived));
  line("tenant", config.tenant);
  line("widgets", String(config.widgets.length));
  return `${config.widgets.length} widgets, ${config.dashboards.length} dashboards`;
});

await check("GET /agents", async () => {
  const roster = await client.fetchActiveSchemas();
  line("total", String(roster.total));
  line("ids", roster.agents.map((a) => a.id).join(", "));
  return `${roster.total} agent(s)`;
});

await check("GET /live", async () => {
  const snap = await client.fetchLive();
  line("provider", snap.provider);
  line("enabled", String(snap.enabled));
  line("records", String(snap.verdict?.records ?? "null"));
  line("breachedColumns", String(snap.verdict?.breachedColumns ?? "null"));
  line("throughput", snap.throughput === null ? "null (by design)" : `${snap.throughput.eventsPerSecond}/sec over ${snap.throughput.windowMs}ms`);
  line("synthetic", String(snap.verdict?.synthetic));
  if (snap.verdict !== null) {
    for (const c of snap.verdict.columns) {
      line(`  column ${c.column}`, `max=${c.max} outerFence=${c.extremeUpper} breached=${c.breached}`);
    }
  }
  return `verdict records=${snap.verdict?.records} breached=${snap.verdict?.breachedColumns}`;
});

await check("GET /schema/:id", async () => {
  const roster = await client.fetchActiveSchemas();
  const first = roster.agents[0];
  if (first === undefined) throw new Error("no agent registered, so there is no id to read");
  const schema = await client.fetchSchema(first.id);
  line("id", schema.id);
  line("version", schema.version);
  return `schema ${schema.id} v${schema.version}`;
});

console.log("\n=== the refusal path, through the same client and proxy ===\n");

const wrong = new GatewayClient({ gatewayToken: `${token}-deliberately-wrong`, baseUrl: BASE });

await check("a wrong credential halts the poller and names itself", async () => {
  const requested = [];
  let armed = null;
  const poller = new TelemetryPoller({
    source: { fetchLive: () => wrong.fetchLive() },
    intervalMs: 500,
    setTimer: (fn, ms) => {
      requested.push(ms);
      armed = fn;
      return ms;
    },
    clearTimer: () => {
      armed = null;
    },
  });
  const seen = [];
  poller.subscribe((s) => seen.push(s));
  poller.start();
  await new Promise((r) => setImmediate(r));

  const last = seen[seen.length - 1];
  line("state", last.state);
  line("credentialRequired", String(last.credentialRequired));
  line("server says", last.error ?? "-");
  line("ui says", describeCredentialState(last.state));
  line("delays requested", requested.length === 0 ? "NONE (halted)" : requested.join(", "));

  if (requested.length !== 0) throw new Error(`expected no further requests, saw ${requested.length}`);
  if (armed !== null) throw new Error("expected no timer to remain armed");
  if (last.state !== "rejected") throw new Error(`expected 'rejected', got '${last.state}'`);
  return "one request, then silence";
});

await check("recovery: a valid credential resumes and renders a verdict", async () => {
  const requested = [];
  const poller = new TelemetryPoller({
    source: { fetchLive: () => wrong.fetchLive() },
    setTimer: (fn, ms) => {
      requested.push(ms);
      return ms;
    },
    clearTimer: () => {},
  });
  poller.start();
  await new Promise((r) => setImmediate(r));
  if (!poller.halted) throw new Error("expected the poller to be halted on a refusal");

  // The operator enters the right value. This is the same call Root makes.
  poller.configure({ source: { fetchLive: () => client.fetchLive() } });
  await new Promise((r) => setImmediate(r));

  line("halted after recovery", String(poller.halted));
  line("next delay requested", `${requested[requested.length - 1]}ms`);
  const snap = await client.fetchLive();
  line("records after recovery", String(snap.verdict?.records));
  if (poller.halted) throw new Error("expected the poller to be running again");
  if (snap.verdict === null) throw new Error("expected a verdict after recovery");
  return `recovered, ${snap.verdict.records} records, ${snap.verdict.breachedColumns} breached column(s)`;
});

console.log("\n--- what this probe does NOT cover ---");
console.log("  pixels, CSS, and a person clicking Connect. The refusal screens are");
console.log("  covered as rendered markup in the vitest suite, and the polling");
console.log("  behaviour is covered there with hand-driven timers.");
console.log("");