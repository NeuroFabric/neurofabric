/**
 * BOOT PROOF, RUN BY HAND. Not a test, and never run in CI.
 *
 * It starts the real `start-ui.mjs`, with the real record, and asks the real
 * route for the real diff with a real credential -- because the claims this MR
 * makes are claims about a RUNNING PROCESS, and the only honest receipt for
 * those is one.
 *
 * Usage:
 *   NEUROFEBRIC_GATEWAY_TOKENS='[{"id":"acme","credential":"smoke","providers":["portal","memory"]}]' \
 *     node --experimental-strip-types .scratch/boot-proof.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const workspace = mkdtempSync(path.join(tmpdir(), "nf-boot-"));
const FIRST_TOKENS = JSON.stringify([
  { id: "acme", credential: "smoke-credential", providers: ["portal", "memory"] },
]);

const child = spawn(
  process.execPath,
  ["--experimental-strip-types", "start-ui.mjs", "--workspace", workspace, "--port", "8123"],
  {
    env: {
      ...process.env,
      NEUROFEBRIC_GATEWAY_TOKENS: FIRST_TOKENS,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

const output: string[] = [];
child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));

const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));

/** Wait for the URL the boot script prints, rather than sleeping a guessed time. */
async function waitForUrl(): Promise<string> {
  for (let i = 0; i < 100; i += 1) {
    const match = output.join("").match(/http:\/\/localhost:\d+/);
    if (match?.[0] !== undefined) return match[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the wedge never printed a URL:\n${output.join("")}`);
}

const base = await waitForUrl();

async function show(label: string, path: string, init?: RequestInit, credential: string | null = "smoke-credential"): Promise<void> {
  // EXPLICITLY BUILT PER CALL. The first version of this script shared one
  // `headers` object across every request, which meant its "no credential" case
  // silently sent the credential and reported a 200 for a request that had
  // proved nothing. An auth receipt that cannot fail is not a receipt.
  const sent: Record<string, string> = credential === null ? {} : { "x-gateway-token": credential };
  const response = await fetch(`${base}${path}`, { ...init, headers: sent });
  const text = await response.text();
  console.log(`\n--- ${label}: ${init?.method ?? "GET"} ${path} -> ${response.status}`);
  console.log(text.length > 700 ? `${text.slice(0, 700)}...` : text);
}

const AGENT = {
  id: "log-anomaly",
  title: "Log anomalies",
  domain: "anomaly",
  version: "1.0.0",
  capabilities: ["find bursts"],
  // STREAMS ARE COLUMN NAMES, not stream objects. The first fixture here passed
  // `[{ name, columns }]` and the registry refused it with
  // `$.streams[0]: a stream name must be a non-empty string` -- the same
  // invented-grammar failure the demo agent's own comment records, committed a
  // second time in a different file. Caught by the route, which is the point of
  // validating on write.
  streams: ["elapsed_time", "threshold"],
  rules: [
    {
      id: "slow",
      kind: "threshold",
      severity: "warning",
      message: "elapsed_time is above its usual ceiling",
      field: "elapsed_time",
      operator: ">",
      value: 1000,
    },
  ],
};

await show("no credential", "/api/memory/diff", undefined, null);
await show("a credential that was never issued", "/api/memory/diff", undefined, "not-a-real-credential");
await show("the diff, first run -- before anything is installed", "/api/memory/diff");

// INSTALL AN AGENT. This is the only path by which the record gains content.
const installed = await fetch(`${base}/api/portal/schema`, {
  method: "POST",
  headers: { "x-gateway-token": "smoke-credential", "content-type": "application/json" },
  body: JSON.stringify(AGENT),
});
console.log(`\n--- install the agent -> ${installed.status}`);
console.log((await installed.text()).slice(0, 300));

const afterInstall = (await (
  await fetch(`${base}/api/memory/diff`, { headers: { "x-gateway-token": "smoke-credential" } })
).json()) as { differences: { key: string; kind: string; subject: string }[]; recorded: { verdicts: unknown[] } };
console.log("\n--- the diff after installing one agent");
for (const d of afterInstall.differences) console.log(`    ${d.kind} :: ${d.subject}`);

const target = afterInstall.differences.find((d) => d.kind === "no-live-window-yet");
console.log(`\n    expecting "no-live-window-yet": ${target === undefined ? "ABSENT" : "present"}`);

await show(
  "acknowledge a difference that is not on the list",
  "/api/memory/ack",
  { method: "POST", body: JSON.stringify({ key: "no-live-window-yet|agent imaginary" }) },
);

if (target !== undefined) {
  await show("acknowledge the REAL difference", "/api/memory/ack", { method: "POST", body: JSON.stringify({ key: target.key }) });
  const afterAck = (await (
    await fetch(`${base}/api/memory/diff`, { headers: { "x-gateway-token": "smoke-credential" } })
  ).json()) as { differences: { key: string; acknowledged: boolean; seenCount: number }[] };
  const same = afterAck.differences.find((d) => d.key === target.key);
  console.log(`\n--- after acknowledging: still listed = ${same !== undefined}, acknowledged = ${same?.acknowledged}`);
  console.log("    If `still listed` were false, the system would have chosen.");
}

console.log("\n--- stopping");
child.kill("SIGINT");
await done;
// DELIBERATELY NOT REMOVED HERE. The first version of this script called
// `rmSync(workspace)` on this line, before the restart below -- so the "restart"
// opened an empty directory and printed "FIRST RUN", and the durability claim it
// appeared to be proving was measured on a record that had just been deleted.
// The environment was flattering the code by removing the only thing under test.

/* ------------------------------------------------------------------ *
 * THE RESTART. The same workspace, a second process.
 *
 * This is the claim that matters most and the one a single boot cannot make:
 * an acknowledgement and an installed agent both SURVIVE. A record that is
 * opened, written and thrown away is a cache wearing a database's name.
 * ------------------------------------------------------------------ */

console.log("\n\n=========== RESTART, same workspace ===========\n");

const second = spawn(
  process.execPath,
  ["--experimental-strip-types", "start-ui.mjs", "--workspace", workspace, "--port", "8124"],
  {
    env: {
      ...process.env,
      NEUROFEBRIC_GATEWAY_TOKENS: FIRST_TOKENS,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const restartOutput: string[] = [];
second.stdout.on("data", (chunk: Buffer) => restartOutput.push(chunk.toString()));
second.stderr.on("data", (chunk: Buffer) => restartOutput.push(chunk.toString()));
const secondDone = new Promise<void>((resolve) => second.once("exit", () => resolve()));

let secondBase = "";
for (let i = 0; i < 100; i += 1) {
  const match = restartOutput.join("").match(/http:\/\/localhost:\d+/);
  if (match?.[0] !== undefined) {
    secondBase = match[0];
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const afterRestart = (await (
  await fetch(`${secondBase}/api/memory/diff`, { headers: { "x-gateway-token": "smoke-credential" } })
).json()) as {
  differences: { key: string; kind: string; acknowledged: boolean }[];
  summary: string;
};

console.log(`summary: ${afterRestart.summary}`);
for (const d of afterRestart.differences) {
  console.log(`    ${d.kind} :: acknowledged=${d.acknowledged}`);
}
console.log(`\n    the boot lines said:`);
for (const line of restartOutput.join("").split("\n")) {
  if (line.includes("Durable record") || line.includes("schema version") || line.includes("neurofebric.sqlite")) {
    console.log(`    ${line.trim()}`);
  }
}

second.kill("SIGINT");
await secondDone;
// Now, and only now, is the workspace disposable.
rmSync(workspace, { recursive: true, force: true });
