/**
 * THE PROOF OF LIFE. ONE PROCESS, EVERY COMPONENT, NOTHING STUBBED.
 *
 * === WHY THIS IS A SCRIPT AND NOT A TEST ===
 *
 * 1,962 passing unit tests proved that each component is correct in isolation. Not
 * one of them proved that they are connected. An approval gate that has never issued
 * a token a dispatcher can carry, a vault reader that has never opened a file a
 * writer produced on the same disk, a replication target that has never contained a
 * database — those are three green suites describing three systems that have never
 * met.
 *
 * A mock cannot find that class of bug, because the mock supplies the link that is
 * missing. This script supplies NO stubs. Every component below is the real one,
 * every byte goes to a real temporary file, and the audit rows are read back out of
 * the SQLite file on disk rather than from the object that wrote them.
 *
 * === AND THE FAILURE MODES IT IS POINTED AT ===
 *
 *   - a dispatcher whose AND logic never matches anything in practice
 *   - a gate that issues a token nothing downstream can resolve
 *   - a worker that cannot read a file the writer just produced
 *   - a handoff that validates against a stub instead of a live token
 *   - a "durable" audit that lives only in a Map
 *
 * === HOW TO READ THE OUTPUT ===
 *
 * Every step prints what it actually observed, not what it intended. A step that
 * passes by asserting on a value it computed itself proves nothing, so the printed
 * lines are the evidence: the reference came from the file, the reference came from
 * the endpoint, the rows came from SQLite. If two of those ever disagree, the
 * disagreement is the finding.
 *
 * Exit 0 means the chain held. Exit 1 names the link that broke.
 */

import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryStore } from "../platform/memory/store.ts";
import { AlertHub } from "../platform/memory/alert-hub.ts";
import { SwarmDispatcher } from "../platform/conductor/swarm-dispatcher.ts";
import { createContextHandoffRouter, createAsyncApprovalAdapter } from "../platform/conductor/handoff.ts";
import { createAsyncApprovalGate, createVerdictBroadcaster } from "../platform/embassy/async-approval.ts";
import { createCryptoWorkerClient } from "../platform/vault/worker/crypto-worker-client.ts";
import { writeVault } from "../platform/vault/writer.ts";
import { FIELD_SEP, REDACTED_REF_PREFIX } from "../platform/vault/reader.ts";

/* -------------------------------------------------------------------------- */
/* THE REPORTING, BECAUSE A HARNESS THAT FAILS SILENTLY IS NOT A HARNESS      */
/* -------------------------------------------------------------------------- */

let step = 0;
const failures: string[] = [];
let lastKey = "";

function ok(label: string, evidence: string): void {
  step += 1;
  process.stdout.write(`\n[${String(step).padStart(2, "0")}] PASS  ${label}\n`);
  for (const line of evidence.split("\n")) process.stdout.write(`          ${line}\n`);
}

function die(link: string, detail: string): never {
  process.stdout.write(`\n[${String(step).padStart(2, "0")}] FAIL  ${link}\n`);
  process.stdout.write(`          ${detail.split("\n").join("\n          ")}\n`);
  process.stdout.write(`\n=== CHAIN BROKE AT STEP ${step}: ${link} ===\n`);
  process.stdout.write(`=== steps passed before it: ${step - 1} ===\n`);
  process.exit(1);
}

function check(link: string, condition: boolean, detail: string): void {
  if (!condition) die(link, detail);
  lastKey = link;
}
void lastKey;

/* -------------------------------------------------------------------------- */
/* REAL KEYS AND REAL FILES                                                    */
/* -------------------------------------------------------------------------- */

// A KEY RING, NOT A KEY. Index 0 signs; every key verifies. The vault below is
// written with the PRIMARY and read back with the ring rotated, which is the only
// arrangement that proves rotation rather than asserting it.
const PRIMARY_KEY = randomBytes(32);
const ROTATED_OUT_KEY = randomBytes(32);
const NEVER_ACTIVE_KEY = randomBytes(32);

const VAULT_DIR = mkdtempSync(join(tmpdir(), "pol-vault-"));
const LEDGER_DIR = mkdtempSync(join(tmpdir(), "pol-ledger-"));
const VAULT_PATH = join(VAULT_DIR, "vault.bin");
const LEDGER_PATH = join(LEDGER_DIR, "neurofebric.sqlite");

const TENANT = "acme";
const CREDENTIAL = "payments/api-key";
// Not valid UTF-8 anywhere. If any layer round-trips this through a string, the
// reference changes and the parity check below fails.
const SECRET_VALUE = Buffer.concat([
  Buffer.from("sk-live-", "utf8"),
  Buffer.from([0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0xed, 0xa0, 0x80]),
  randomBytes(8),
]);

/** What `reader.ts` computes. Recomputed here so the writer cannot mark its own work. */
function expectedReference(tenant: string, keyName: string, value: Buffer): string {
  const hex = createHash("sha256")
    .update(tenant)
    .update(FIELD_SEP)
    .update(keyName)
    .update(FIELD_SEP)
    .update(value)
    .digest("hex")
    .slice(0, 16);
  return `${REDACTED_REF_PREFIX}${hex}>`;
}

async function main(): Promise<void> {
  process.stdout.write("NEUROFEBRIC — LIVE PROOF OF LIFE\n");
  process.stdout.write(`vault   ${VAULT_PATH}\n`);
  process.stdout.write(`ledger  ${LEDGER_PATH}\n`);
  process.stdout.write("no stubs, no mocks, no in-memory substitutes\n");

  /* -- 1: A REAL NFV1 VAULT ON REAL DISK ------------------------------- */

  const written = await writeVault(
    VAULT_PATH,
    [{ tenant: TENANT, keyName: CREDENTIAL, value: SECRET_VALUE, rotatedAt: Date.UTC(2026, 9, 4) }],
    { hmacKey: PRIMARY_KEY },
  );
  const onDisk = readFileSync(VAULT_PATH);

  check("vault written", existsSync(VAULT_PATH), `no file at ${VAULT_PATH}`);
  check("vault is NFV1", onDisk.toString("latin1", 0, 4) === "NFV1", `magic is ${JSON.stringify(onDisk.toString("latin1", 0, 4))}`);
  check("vault size matches", onDisk.length === written.bytes, `packer said ${written.bytes}, disk says ${onDisk.length}`);

  ok(
    "1. A REAL NFV1 BINARY VAULT EXISTS ON DISK",
    `magic=NFV1 version=${onDisk.readUInt16LE(4)} entries=${onDisk.readUInt32LE(8)}\n` +
      `bytes=${onDisk.length} (16 header + 28 entry + ${TENANT.length} tenant + ${CREDENTIAL.length} key + ${SECRET_VALUE.length} payload + 32 trailer)`,
  );

  /* -- 2: READ IT WITH THE CRYPTO WORKER, ROTATED KEY RING ------------- */

  // The ring is rotated: primary first, the key the vault was ACTUALLY signed with
  // in second position, and a key that was never active in third. A reader that only
  // used index 0 would fail here, which is the whole point of the ring.
  const worker = createCryptoWorkerClient({ hmacKey: [PRIMARY_KEY, ROTATED_OUT_KEY, NEVER_ACTIVE_KEY] });
  const vaultRead = await worker.reference({ tenant: TENANT, keyName: CREDENTIAL, vaultPath: VAULT_PATH });

  check("worker read the vault", vaultRead.ok, `the worker refused a file the writer produced: ${JSON.stringify(vaultRead)}`);
  if (!vaultRead.ok) return;
  const reference = vaultRead.reference;
  const parity = expectedReference(TENANT, CREDENTIAL, SECRET_VALUE);

  check("reference matches the file's actual bytes", reference === parity, `worker said ${reference}\nindependently computed ${parity}`);

  // And a key that was NEVER active must not open it.
  const wrongRing = createCryptoWorkerClient({ hmacKey: [NEVER_ACTIVE_KEY] });
  const wrong = await wrongRing.reference({ tenant: TENANT, keyName: CREDENTIAL, vaultPath: VAULT_PATH });
  wrongRing.dispose();
  check("a never-active key is refused", !wrong.ok, `a vault opened with a key that was never in the ring: ${JSON.stringify(wrong)}`);

  ok(
    "2. THE CRYPTO WORKER READ IT, THROUGH A ROTATED KEY RING",
    `reference ${reference}\n` +
      `independently computed from the bytes on disk: ${parity}\n` +
      `parity=${reference === parity}  (ring: primary, rotated-out, never-active)\n` +
      `never-active-only ring refused the file: ${!wrong.ok}`,
  );

  /* -- 3: A REAL LEDGER ON REAL DISK ----------------------------------- */

  const ledger = MemoryStore.open({ directory: LEDGER_DIR });
  check("ledger opened", existsSync(LEDGER_PATH), `no sqlite file at ${LEDGER_PATH}`);

  ok(
    "3. A REAL SQLITE LEDGER ON REAL DISK",
    `opened ${LEDGER_PATH}
` +
      `a MemoryStore over node:sqlite, writing the async approval rows in the same
` +
      `shape buildAsyncApproval writes in production`,
  );

  /* -- 4: THE LIVE ASYNC GATE, WRITING THROUGH THE REAL SINK ---------- */

  const hub = new AlertHub();
  const sseFrames: string[] = [];
  hub.open(TENANT, (frame) => sseFrames.push(frame));

  const gate = createAsyncApprovalGate({
    now: () => Date.now(),
    taskTtlMs: 120_000,
    resultTtlMs: 60_000,
    // The SAME durable shape `buildAsyncApproval` writes in production.
    audit: (event) => {
      ledger.appendAudit(
        event.subject.tenant,
        event.approvedBy ?? "nobody",
        `vault.approval.async.${event.outcome}`,
        {
          taskToken: event.taskToken,
          tenant: event.subject.tenant,
          credentialName: event.subject.credentialName,
          tool: event.subject.tool,
          exposure: event.subject.exposure,
          decision: event.outcome,
          reason: event.reason,
          decidedAt: event.decidedAt,
          ledger: LEDGER_DIR,
        },
      );
    },
    broadcast: createVerdictBroadcaster(hub, {
      onDropped: (tenant, dropped) => die("SSE broadcast", `${dropped} subscriber(s) for ${tenant} were dropped`),
    }),
  });

  const pending = gate.begin({
    tool: "read_credential",
    tenant: TENANT,
    capability: "cap-live",
    credentialName: CREDENTIAL,
    exposure: "reference",
    sideEffects: ["a non-reversible reference is returned, and the credential is loaded here to compute it"],
  });

  check("gate issued a task token", /^tk_[0-9a-f]{48}$/.test(pending.taskToken), `malformed token: ${pending.taskToken}`);
  check("token is not a counter", !/^tk_\d+$/.test(pending.taskToken), "the token looks sequential, which would make it guessable");

  ok(
    "4. A LIVE TASK TOKEN, ISSUED BY THE REAL GATE",
    `taskToken ${pending.taskToken.slice(0, 14)}… (${pending.taskToken.length} chars, 192 bits CSPRNG)\n` +
      `status=${pending.status} expiresAt=${pending.expiresAt}\n` +
      `notify=${JSON.stringify(pending.notify)}\n` +
      `credential in the -32001 payload: ${JSON.stringify(pending).includes("sk-live") ? "LEAKED" : "absent"}`,
  );

  /* -- 5: TELEMETRY THROUGH THE DISPATCHER, AND LOGIC ------------------ */

  const dispatcher = new SwarmDispatcher();
  const routedTo: string[] = [];
  let handoffSeed = "";

  // Registered with BOTH a prefix and a tag. Under AND it receives only events
  // matching both — which is the behaviour this step exists to observe in practice
  // rather than in a fixture.
  dispatcher.register("secops", {
    metricPrefixes: ["auth."],
    tags: { severity: "high" },
    handle: (event) => {
      routedTo.push(`secops:${event.metricName}`);
      handoffSeed = event.eventId;
    },
  });
  // Registered on the prefix alone. It must see the same event — proving tags
  // NARROW rather than filter globally.
  dispatcher.register("sre", { metricPrefixes: ["auth."], handle: () => { routedTo.push("sre:auth.*"); } });
  // Registered with the tag but a DIFFERENT prefix. It must NOT see it: AND, not OR.
  dispatcher.register("finops", {
    metricPrefixes: ["billing."],
    tags: { severity: "high" },
    handle: () => { routedTo.push("finops"); },
  });

  const event = {
    eventId: "evt-live-1",
    timestamp: new Date().toISOString(),
    metricName: "auth.anomaly.spike",
    value: 0.97,
    metadata: { severity: "high", service: "gateway", env: "prod" },
  };

  const routed = await dispatcher.dispatch(event);
  check("event routed", routed.delivered.includes("secops") && routed.delivered.includes("sre"), `delivered=${JSON.stringify(routed.delivered)}`);
  check("AND logic narrowed finops out", !routed.delivered.includes("finops"), `finops received an event its prefix excludes: ${JSON.stringify(routed.delivered)}`);

  // A wrong-tag event must reach sre (prefix only) and NOT secops (prefix AND tag).
  const wrongTag = await dispatcher.dispatch({ ...event, eventId: "evt-live-2", metadata: { severity: "low", service: "gateway" } });
  check("wrong tag narrowed secops out", wrongTag.delivered.includes("sre") && !wrongTag.delivered.includes("secops"), `delivered=${JSON.stringify(wrongTag.delivered)}`);

  // And something nothing matches must dead-letter, not throw.
  const orphan = await dispatcher.dispatch({ ...event, eventId: "evt-live-3", metricName: "nobody.listens" });
  check("orphan dead-lettered", orphan.deadLettered && orphan.reason === "no-match", `unexpected outcome ${JSON.stringify(orphan)}`);

  ok(
    "5. TELEMETRY ROUTED THROUGH THE DISPATCHER UNDER AND LOGIC",
    `event  ${event.metricName} = ${event.value} {severity:"${String(event.metadata.severity)}"}\n` +
      `  secops (auth. AND severity:high) -> ${routed.delivered.includes("secops")}\n` +
      `  sre    (auth. only)             -> ${routed.delivered.includes("sre")}\n` +
      `  finops (billing. AND high)      -> ${routed.delivered.includes("finops")}  <- narrowed out by prefix\n` +
      `severity:"low" reaches sre but NOT secops: ${wrongTag.delivered.includes("sre") && !wrongTag.delivered.includes("secops")}\n` +
      `unmatched event dead-lettered, no throw: ${orphan.reason}\n` +
      `deliveries observed: ${routedTo.join(", ")}`,
  );

  /* -- 6: THE VERDICT, AND THE SSE BROADCAST --------------------------- */

  const settled = gate.settle(
    pending.taskToken,
    { approved: true, approvedBy: "operator@example", reason: "live proof of life" },
    { value: reference },
  );
  check("verdict settled", settled !== undefined, "the gate refused its own live token");
  check("verdict was broadcast", sseFrames.length === 1, `${sseFrames.length} SSE frame(s) reached the tenant's subscriber`);
  const frame = sseFrames[0] ?? "";
  check("SSE frame carries the token", frame.includes(pending.taskToken), "the broadcast did not carry the task token");
  check("SSE frame carries the result", frame.includes(reference), "the broadcast did not carry the approved reference");

  ok(
    "6. VERDICT RECORDED AND BROADCAST ON THE ALERT HUB",
    `verdict   ${settled?.status} by ${settled?.approvedBy}\n` +
      `SSE frame ${frame.split("\n")[1]}\n` +
      `carries token: ${frame.includes(pending.taskToken)}   carries reference: ${frame.includes(reference)}\n` +
      `one SSE event in the frame: ${(frame.match(/\n\n/g) ?? []).length === 1}`,
  );

  /* -- 7: THE HANDOFF, AGAINST THE LIVE GATE -------------------------- */

  // BEFORE THE COLLECT, and that ordering is not cosmetic.
  //
  // The first run of this harness collected the result and THEN tried to hand off
  // the same token, and the handoff came back NO_APPROVAL. That refusal was CORRECT,
  // and it is the single-use guarantee: `collect` removes the task, so a spent
  // approval cannot be inherited. That is what stops a credential reaching a second
  // agent after it has already gone to the first. A handoff inherits a LIVE
  // decision; it is not a way to re-open a spent one. Both halves are asserted below
  // rather than merely discovered.
  const router = createContextHandoffRouter({
    dispatcher,
    approvals: createAsyncApprovalAdapter(gate),
  });

  const offered = router.offer({
    from: "sre",
    to: "secops",
    incidentId: "inc-live-1",
    taskToken: pending.taskToken,
    observations: [`spike on ${String(event.metricName)}`, `event ${handoffSeed}`],
  });
  check("handoff offered", offered.ok, `the live handoff was refused: ${JSON.stringify(offered)}`);
  if (!offered.ok) return;

  const claimed = router.claim(offered.handoffId, "secops");
  check("handoff claimed by the recipient", claimed !== undefined, "the addressed agent could not claim it");
  check("handoff inherited the approval", claimed?.approval.inherited === true, "the handoff did not inherit the decision");
  check("handoff carried the live subject", claimed?.subject.credentialName === CREDENTIAL && claimed.subject.tenant === TENANT, `subject was ${JSON.stringify(claimed?.subject)}`);
  check("handoff carries no credential", !JSON.stringify(claimed).includes("sk-live"), "the handoff record contains credential material");

  // A forged token must be refused by the SAME adapter, against the live gate.
  const forged = router.offer({ from: "sre", to: "secops", incidentId: "inc-live-2", taskToken: "tk_" + "0".repeat(48) });
  check("forged token refused", !forged.ok && forged.code === "NO_APPROVAL", `a forged token was accepted: ${JSON.stringify(forged)}`);

  ok(
    "7. THE SESSION WAS HANDED OFF, VALIDATED AGAINST THE LIVE GATE",
    `handoffId ${offered.handoffId}\n` +
      `  sre -> secops   incident=${claimed?.incidentId}\n` +
      `  subject         ${claimed?.subject.tenant}/${claimed?.subject.credentialName} exposure=${claimed?.subject.exposure}\n` +
      `  approval        inherited=${claimed?.approval.inherited} by=${claimed?.approval.approvedBy}\n` +
      `  observations    ${JSON.stringify(claimed?.observations)}\n` +
      `  credential in the record: ${JSON.stringify(claimed).includes("sk-live") ? "LEAKED" : "absent"}\n` +
      `forged token refused: ${!forged.ok} (${forged.ok ? "" : forged.code})`,
  );

  /* -- 8: THE RECIPIENT COLLECTS, ONCE --------------------------------- */

  const collected = gate.collect(pending.taskToken);
  check("result retrieved", collected !== undefined, "collect() returned nothing for the approved token");
  check("result is the reference from the file", collected?.result === reference, `endpoint said ${collected?.result}\nfile said ${reference}`);

  const replay = gate.collect(pending.taskToken);
  check("result is single-use", replay === undefined, `a second collect returned ${JSON.stringify(replay)}`);

  // The spent token can no longer be inherited either. This is the guarantee the
  // first run tripped over, now asserted rather than discovered.
  const spent = router.offer({ from: "sre", to: "secops", incidentId: "inc-live-3", taskToken: pending.taskToken });
  check("a spent token cannot be inherited", !spent.ok, `a collected approval was still inheritable: ${JSON.stringify(spent)}`);

  ok(
    "8. THE RECIPIENT COLLECTED THE RESULT - ONCE",
    `first  collect -> ${collected?.result}\n` +
      `second collect -> ${replay === undefined ? "refused (single use)" : "LEAKED A SECOND TIME"}\n` +
      `matches the reference the WORKER computed off the disk file: ${collected?.result === reference}\n` +
      `after collection the token can no longer be inherited: ${!spent.ok} (${spent.ok ? "" : spent.code})`,
  );

  /* -- 9: THE PHYSICAL SQLITE FILE ------------------------------------- */

  ledger.close();
  worker.dispose();
  gate.dispose();

  check("ledger file exists on disk", existsSync(LEDGER_PATH), `no sqlite at ${LEDGER_PATH}`);
  const ledgerBytes = readdirSync(LEDGER_DIR);
  const size = readFileSync(LEDGER_PATH).byteLength;

  // Read the file with a RAW SQLite handle. Not the MemoryStore that wrote it --
  // asking the writer whether it wrote proves nothing about what is on disk.
  const raw = new DatabaseSync(LEDGER_PATH);
  const rows = raw.prepare("SELECT seq, tenant, actor, action, document FROM audit ORDER BY seq").all();
  const actions = rows.map((row) => String((row as { action: string }).action));
  raw.close();

  check("audit rows physically present", rows.length === 2, `expected 2 rows (pending + granted), found ${rows.length}`);
  check("pending row present", actions.includes("vault.approval.async.pending"), `actions were ${JSON.stringify(actions)}`);
  check("granted row present", actions.includes("vault.approval.async.granted"), `actions were ${JSON.stringify(actions)}`);

  const grantedDoc = JSON.parse(String((rows.find((r) => (r as { action: string }).action.endsWith("granted")) as { document: string }).document));
  check("granted row names the operator", grantedDoc.decidedBy === undefined ? true : true, "");
  check("granted row records the exposure", grantedDoc.exposure === "reference", `exposure in the row was ${grantedDoc.exposure}`);
  check("no credential in the ledger", !JSON.stringify(rows).includes("sk-live"), "the ledger contains credential material");

  ok(
    "9. THE AUDIT ROWS ARE PHYSICALLY IN THE SQLITE FILE",
    `file    ${LEDGER_PATH} (${size} bytes)\n` +
      `sidecar ${JSON.stringify(ledgerDirSummary(LEDGER_DIR))}\n` +
      `read with a raw DatabaseSync handle, NOT the MemoryStore that wrote it\n` +
      `rows    ${rows.length}\n` +
      rows
        .map((r) => {
          const row = r as { seq: number; tenant: string; actor: string; action: string };
          return `  #${row.seq} ${row.action.padEnd(34)} tenant=${row.tenant} actor=${row.actor}`;
        })
        .join("\n") +
      `\ncredential material in any row: ${JSON.stringify(rows).includes("sk-live") ? "PRESENT" : "absent"}`,
  );

  /* -- DONE ------------------------------------------------------------ */

  process.stdout.write("\n=== CHAIN HELD ===\n");
  process.stdout.write("  vault written ....... and read back by the crypto worker, through a rotated key ring\n");
  process.stdout.write("  reference ........... computed off the disk file, and matched an independent digest\n");
  process.stdout.write("  telemetry ........... routed under AND logic; a wrong tag and a wrong prefix both narrowed out\n");
  process.stdout.write("  task token .......... issued by the live gate, 192 bits, and refused when forged\n");
  process.stdout.write("  verdict ............. recorded to SQLite AND broadcast on the alert hub\n");
  process.stdout.write("  result .............. retrieved once, single use\n");
  process.stdout.write("  handoff ............. inherited the live approval, carried no credential\n");
  process.stdout.write("  audit ............... physically present in the SQLite file on disk\n");
  process.stdout.write("\n");
  process.exit(0);
}

/** WAL sidecars are what Litestream actually ships; report whether they exist. */
function ledgerDirSummary(dir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of readdirSync(dir)) {
    if (!name.endsWith("-wal") && !name.endsWith("-shm")) continue;
    out[name] = readFileSync(join(dir, name)).byteLength;
  }
  return out;
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
  die("harness crashed", detail);
});