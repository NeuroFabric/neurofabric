/**
 * !106 PROOF, RUN BY HAND. Boots the real wedge and drives the real socket.
 *
 * The claim under test is the one no unit test can make: that an alert reaches a
 * live subscriber AND is in the durable record, in that order, through the
 * running process.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TOKENS = JSON.stringify([
  { id: "acme", credential: "smoke-credential", providers: ["portal", "memory"] },
]);

const workspace = mkdtempSync(path.join(tmpdir(), "nf-sse-"));
const child = spawn(process.execPath, ["--experimental-strip-types", "start-ui.mjs", "--workspace", workspace, "--port", "8131"], {
  env: { ...process.env, NEUROFEBRIC_GATEWAY_TOKENS: TOKENS },
  stdio: ["ignore", "pipe", "pipe"],
});
const out: string[] = [];
child.stdout.on("data", (c: Buffer) => out.push(c.toString()));
child.stderr.on("data", (c: Buffer) => out.push(c.toString()));
const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));

let base = "";
for (let i = 0; i < 100; i += 1) {
  const m = out.join("").match(/http:\/\/localhost:\d+/);
  if (m?.[0] !== undefined) { base = m[0]; break; }
  await new Promise((r) => setTimeout(r, 100));
}
const H = { "x-gateway-token": "smoke-credential", "content-type": "application/json" };

// ---- 1. THE GUARD ACTIVELY DEFENDS THE STREAM ----
const anon = await fetch(`${base}/api/memory/alerts`);
console.log(`\n[guard] no credential            -> ${anon.status} ${anon.headers.get("content-type")}`);
const bogus = await fetch(`${base}/api/memory/alerts`, { headers: { "x-gateway-token": "wrong" } });
console.log(`[guard] credential not issued    -> ${bogus.status}`);

// ---- 2. A PROVEN SUBSCRIBER ----
const controller = new AbortController();
const stream = await fetch(`${base}/api/memory/alerts`, { headers: H, signal: controller.signal });
console.log(`[stream] proven credential       -> ${stream.status} ${stream.headers.get("content-type")}`);
console.log(`[stream] cache-control           -> ${stream.headers.get("cache-control")}`);

const received: string[] = [];
const reader = stream.body!.getReader();
const decoder = new TextDecoder();
(async () => {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received.push(decoder.decode(value, { stream: true }));
    }
  } catch { /* aborted */ }
})();

// ---- 3. TRAFFIC, THEN A BREACH, ON THE READ PATH ----
const normal = (i: number) => ({
  fields: {
    service: i % 2 === 0 ? "checkout" : "search",
    pega_time: `2026-09-30T${String(i % 24).padStart(2, "0")}:00:00Z`,
    elapsed_time: String(100 + (i % 300)),
  },
  at: 1_757_000_000_000 + i,
});

/**
 * The ingest route validates the envelope: every event is `{ fields, at }`, and
 * a call carries at most 1000. My first pass sent flat field objects and got a
 * 400 on both batches -- which is the route working, and a good reminder that a
 * proof script has to obey the same contract a client does.
 */
async function ingest(events: unknown[]) {
  let last = 0;
  for (let i = 0; i < events.length; i += 900) {
    const r = await fetch(`${base}/api/portal/ingest`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ provider: "pega", events: events.slice(i, i + 900) }),
    });
    last = r.status;
    if (r.status !== 200) console.log("   ingest refusal:", JSON.stringify(await r.json()));
  }
  return last;
}

/** Traffic plus one poll: the poll is what runs the evaluation loop. */
async function feedAndPoll(events: unknown[], label: string) {
  const pushed = await ingest(events);
  await new Promise((r) => setTimeout(r, 250));
  const live = await fetch(`${base}/api/portal/live`, { headers: H });
  const body = (await live.json()) as { verdict: { records: number; breachedColumns: number } | null };
  console.log(`[ingest] ${label.padEnd(22)} push=${pushed} records=${body.verdict?.records ?? 0} breached=${body.verdict?.breachedColumns ?? 0}`);
}

await feedAndPoll(Array.from({ length: 400 }, (_, i) => normal(i)), "400 clean events");
await feedAndPoll(
  Array.from({ length: 900 }, (_, i) => ({ ...normal(i), fields: { ...normal(i).fields, elapsed_time: i === 500 ? "9000000" : String(100 + (i % 300)) } })),
  "900 events, 1 outlier",
);
await new Promise((r) => setTimeout(r, 600));

// ---- 4. WHAT THE SUBSCRIBER RECEIVED ----
const text = received.join("");
const gotAlert = /event: alert/.test(text);
console.log(`\n[subscriber] received a frame    -> ${gotAlert}`);
console.log(`[subscriber] "connected" comment  -> ${/^: connected/m.test(text)}`);
const severity = text.match(/"severity":"([a-z]+)"/)?.[1];
const alertId = text.match(/"id":"([0-9a-f]{8,})"/)?.[1];
console.log(`[subscriber] severity             -> ${severity ?? "(none)"}`);
console.log(`[subscriber] alert id             -> ${alertId ?? "(none)"}`);

// ---- 5. AND THE RECORD, WHICH IS WHERE THE GUARANTEE LIVES ----
const diff = (await (await fetch(`${base}/api/memory/diff`, { headers: H })).json()) as {
  recorded: { alerts: { id: string; severity: string }[]; verdicts: unknown[] };
};
const stored = diff.recorded.alerts[0];
console.log(`\n[record]    alerts in the record  -> ${diff.recorded.alerts.length}`);
console.log(`[record]    first alert id        -> ${stored?.id ?? "(none)"}`);
console.log(`[record]    severity              -> ${stored?.severity ?? "(none)"}`);
console.log(`[record]    verdicts recorded     -> ${diff.recorded.verdicts.length}`);
console.log(`\n[same id?]  frame == record       -> ${alertId !== undefined && alertId === stored?.id ? "YES" : "NO"}`);

controller.abort();
await new Promise((r) => setTimeout(r, 200));
child.kill("SIGINT");
await stopped;

console.log("\n--- boot lines ---");
for (const line of out.join("").split("\n")) {
  if (/Durable record|schema version|Decisions are recorded|tenant/.test(line)) console.log(line.trim());
}
