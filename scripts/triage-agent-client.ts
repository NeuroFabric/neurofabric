/**
 * THE 2 AM TRIAGE AGENT. An MCP client, and the first one this project has.
 *
 * === WHAT IT IS ACTUALLY EXERCISING ===
 *
 * Every other test in the embassy drives `dispatch()` or a pipe it owns. This one
 * does the thing a real client does: it starts the embassy as a SEPARATE PROCESS,
 * speaks JSON-RPC to it over pipes, and -- the part nothing else has tested -- it
 * RECEIVES A REQUEST FROM THE SERVER and answers it.
 *
 * That direction matters. Until the precheck, this protocol was one-way: the
 * client asked, the server answered. Now the server asks, and a client that cannot
 * answer would leave every credential call parked until it timed out. This script
 * is the proof that a client CAN.
 *
 * === THE WORKFLOW, AND WHY IT IS ORDERED THIS WAY ===
 *
 *   1. Connect, and declare the elicitation capability.
 *   2. Discover the tools. An agent cannot bind to what it has not seen, so
 *      discovery is a step rather than an assumption.
 *   3. Read the verdict, and decide from it whether anything is actually wrong.
 *   4. ONLY THEN reach for a credential -- and only to "remediate" a breach that
 *      step 3 found. An agent that grabs a credential before checking whether
 *      there is a problem is the behaviour this whole design exists to prevent,
 *      and a demo that did it would be teaching the wrong shape.
 *   5. Ask for METADATA first. Knowing WHEN a credential was rotated is often
 *      enough to explain a failure, and it never loads the credential.
 *   6. The raw request is DECLINED, by a scripted operator, and the client reports
 *      the refusal as a refusal rather than retrying.
 *
 * Step 6 is the interesting one. A client that treats a declined approval as an
 * error to route around is exactly what the precheck is for, so this script models
 * the correct behaviour explicitly rather than only modelling the happy path.
 *
 * === IT IS A SCRIPTED DEMONSTRATION, NOT AN AGENT ===
 *
 * The "judgement" here is a fixed sequence, chosen to hit every branch. It is not a
 * model and it does not pretend to be one. What it proves is the PROTOCOL: a
 * client can discover, call, receive an inbound request, answer it, and handle all
 * three outcomes without corrupting the stream.
 *
 * Run it:
 *   node --experimental-strip-types scripts/triage-agent-client.ts
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startWedgeServer } from "../platform/web/server.ts";
import { MemoryStore } from "../platform/memory/store.ts";
import { staticVault, CREDENTIAL_HEADER } from "../platform/omniroute/edge-security.ts";
import { makeTempWorkspace } from "../platform/test-support/temp-workspace.ts";
import { mintCapability, READ_SCOPE } from "../platform/vault/capability.ts";
import { createFileSecretSource } from "../platform/vault/file-source.ts";

const TENANT = "acme";
const CREDENTIAL = "payments/api-key";
const ROTATED_AT = "2026-01-04T09:12:00.000Z";

// === THE CLIENT ==========================================================

/**
 * A MINIMAL MCP CLIENT, AND MINIMAL FOR A REASON.
 *
 * It has a request/response table and a handler for inbound requests, because those
 * two together are what "bidirectional" means. It has nothing else: no retry, no
 * reconnect, no batching, no protocol-version negotiation beyond declaring the
 * capability. A client that grew a transport abstraction would make the thing this
 * script exists to demonstrate -- that a server-initiated request can be answered --
 * harder to see, not easier.
 */
class McpClient {
  readonly #child;
  #nextId = 0;
  #buffer = "";
  readonly #pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  /** Called when the SERVER asks us something. The whole point of the class. */
  onServerRequest: ((method: string, params: Record<string, unknown>) => Promise<unknown>) | undefined;

  constructor(command: string, args: string[], env: Record<string, string>) {
    this.#child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    this.#child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`  [embassy] ${chunk.toString("utf8")}`));
    this.#child.stdout.on("data", (chunk: Buffer) => this.#onBytes(chunk));
    this.#child.on("error", (error) => this.#failAll(error));
  }

  #failAll(error: Error): void {
    for (const entry of this.#pending.values()) entry.reject(error);
    this.#pending.clear();
  }

  #onBytes(chunk: Buffer): void {
    this.#buffer += chunk.toString("utf8");
    let split = this.#buffer.indexOf("\n");
    while (split !== -1) {
      const line = this.#buffer.slice(0, split).trim();
      this.#buffer = this.#buffer.slice(split + 1);
      if (line !== "") this.#onLine(line);
      split = this.#buffer.indexOf("\n");
    }
  }

  #onLine(line: string): void {
    const frame = JSON.parse(line) as Record<string, unknown>;

    if (typeof frame["id"] === "number" || typeof frame["id"] === "string") {
      const id = frame["id"];
      const entry = this.#pending.get(id);
      // A response to something we asked. Unknown ids are dropped rather than
      // erroring, because a server that answered twice is not a reason to stop.
      if (entry !== undefined) {
        this.#pending.delete(id);
        if (frame["error"] !== undefined) {
          const error = frame["error"] as { code?: number; message?: string };
          entry.reject(new Error(`${String(error.code ?? "?")}: ${error.message ?? "refused"}`));
        } else {
          entry.resolve(frame["result"]);
        }
        return;
      }
    }

    /**
     * THE INBOUND REQUEST. A frame with a `method` and an `id` is the SERVER asking
     * us something, and it is answered the same way we answer our own calls.
     *
     * This branch is what the precheck needed and what nothing else tested. A client
     * that only ever parsed responses would leave every elicitation parked until it
     * expired.
     */
    if (typeof frame["method"] === "string" && frame["id"] !== undefined && this.onServerRequest !== undefined) {
      const params = (frame["params"] ?? {}) as Record<string, unknown>;
      void this.onServerRequest(frame["method"], params).then((result) => {
        this.#send({ jsonrpc: "2.0", id: frame["id"], result });
      });
    }
  }

  #send(message: unknown): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  ask(method: string, params?: unknown, timeoutMs = 20_000): Promise<unknown> {
    const id = (this.#nextId += 1);
    return new Promise((resolve, reject) => {
      /**
       * A REQUEST THAT CAN TIME OUT.
       *
       * Without this, a client whose server failed to start waits forever -- because
       * a promise nobody settles is indistinguishable from a server that is thinking.
       * The first run of this script hung with no output at all for that reason, and
       * the fix is not the diagnosis: it is that a client must be able to say it
       * heard nothing, or every upstream failure presents as a hang.
       */
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} was not answered within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
      });
      this.#send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  /** A notification carries no id and gets no answer. */
  notify(method: string, params?: unknown): void {
    this.#send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  /** The flush, for the same reason the server's own tests need it. */
  settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 60));
  }

  end(): void {
    this.#child.stdin.end();
  }
}

// === THE WORKFLOW =======================================================

interface Ctx {
  readonly client: McpClient;
  /** What the scripted operator decided about the request they were shown. */
  readonly operator: (subject: { credentialName: string; exposure: string }) => { approve: boolean; acknowledge: boolean; by: string; reason: string };
  readonly notes: readonly string[];
}

async function main(): Promise<boolean> {
  const notes: string[] = [];
  const checks: { name: string; ok: boolean }[] = [];
  const record = (name: string, ok: boolean) => checks.push({ name, ok });

  // A real core, so `get_verdict` is a real measurement and not a stub.
  const cwd = await makeTempWorkspace("nf-triage-");
  const store = MemoryStore.open({ directory: mkdtempSync(join(tmpdir(), "nf-triage-store-")), inMemory: true });
  const token = { id: TENANT, credential: "triage-value", providers: ["portal", "memory"] };
  const wedge = await startWedgeServer({
    cwd,
    port: 0,
    portalVault: staticVault([token], "triage"),
    memory: { store, tenant: TENANT },
    evaluationIntervalMs: 150,
  });

  // Inject a breaching batch, so triage has something real to find.
  const breach = (base: number, spikes: number) =>
    Array.from({ length: 400 }, (_, i) => {
      const elapsed = i % 20 === 0 && spikes > 0 ? spikes-- : base + (i % 20) * 4;
      return { fields: { service: "order-fulfilment", alert_code: "PEGA0001", elapsed_time: String(elapsed), threshold: "1000" }, at: 1_760_000_000_000 + i * 500 };
    });
  await fetch(`${wedge.url}/api/portal/ingest`, {
    method: "POST",
    headers: { [CREDENTIAL_HEADER]: token.credential, "content-type": "application/json" },
    body: JSON.stringify({ provider: "pega", events: [...breach(1000, 40_000), ...breach(1200, 0)] }),
  });

  // A real vault file and a real, signed capability.
  const key = randomBytes(32);
  const vaultPath = join(mkdtempSync(join(tmpdir(), "nf-vault-")), "credentials.json");
  writeFileSync(
    vaultPath,
    JSON.stringify({
      credentials: [{ name: CREDENTIAL, value: "sk-live-TRIAGE-DO-NOT-LOG", rotatedAt: ROTATED_AT }],
    }),
    "utf8",
  );
  const capability = mintCapability(
    { capabilityId: "cap-triage", tenant: TENANT, scopes: [READ_SCOPE], expiresAt: Date.now() + 3_600_000 },
    key,
  );

  // The operator's two decisions, scripted. The METADATA read is allowed; the RAW
  // read is not, which is the realistic outcome at 2am and the behaviour worth
  // demonstrating.
  const operator = (subject: { credentialName: string; exposure: string }) => {
    if (subject.exposure === "raw") {
      notes.push("operator DECLINED the raw request: it would put a live credential in the model's context");
      return { approve: false, acknowledge: false, by: "on-call", reason: "not at 2am" };
    }
    notes.push(`operator ALLOWED a ${subject.exposure} read of ${subject.credentialName}`);
    return { approve: true, acknowledge: true, by: "on-call", reason: "triage incident 4471" };
  };

  const client = new McpClient(process.execPath, ["--experimental-strip-types", "platform/embassy/bin.mjs"], {
    NEUROFEBRIC_EMBASSY_TOKEN: token.credential,
    NEUROFEBRIC_CORE_ORIGIN: wedge.url,
    NEUROFEBRIC_EMBASSY_TENANT: TENANT,
    NEUROFEBRIC_CAPABILITY: capability,
    NEUROFEBRIC_VAULT_KEY: key.toString("hex"),
    NEUROFEBRIC_VAULT_FILE: vaultPath,
  });

  const seen: { method: string; warning: string; exposure: string; required: readonly string[] }[] = [];
  client.onServerRequest = async (method, params) => {
    if (method !== "elicitation/create") return { action: "decline" };
    const message = String(params["message"] ?? "");
    const schema = (params["requestedSchema"] ?? {}) as { required?: readonly string[] };
    const subject = {
      credentialName: /Requested credential: (.+)/.exec(message)?.[1] ?? "?",
      exposure: message.includes("RAW PLAINTEXT") ? "raw" : message.includes("METADATA ONLY") ? "metadata" : "reference",
    };
    seen.push({ method, warning: message, exposure: subject.exposure, required: schema.required ?? [] });
    const decision = operator(subject);
    return {
      action: decision.approve ? "accept" : "decline",
      content: {
        approve: decision.approve,
        ...(decision.acknowledge ? { acknowledgeRawExposure: true } : {}),
        approvedBy: decision.by,
        reason: decision.reason,
      },
    };
  };

  try {
    // 1. Connect. The elicitation capability is DECLARED, because a server must not
    //    send a mode the client did not say it can handle.
    const init = (await client.ask("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { elicitation: {} },
      clientInfo: { name: "triage-agent", version: "0.1.0" },
    })) as { protocolVersion?: string };
    client.notify("notifications/initialized");
    await client.settle();
    record("the handshake completes and names a protocol version", typeof init.protocolVersion === "string");

    // 2. Discover. An agent binds to what it can see.
    const listed = (await client.ask("tools/list")) as { tools?: { name: string }[] };
    const names = (listed.tools ?? []).map((tool) => tool.name);
    record("the tool surface is discovered, not assumed", names.includes("read_credential") && names.includes("get_verdict"));
    notes.push(`discovered ${names.length} tools: ${names.join(", ")}`);

    // 3. TRIAGE FIRST. Nothing is reached for until the verdict says there is a problem.
    let verdict: { records?: number } | null = null;
    for (let attempt = 0; attempt < 30 && verdict === null; attempt += 1) {
      const body = (await client.ask("tools/call", { name: "get_verdict", arguments: {} })) as {
        content?: { text?: string }[];
      };
      const parsed = JSON.parse(body.content?.[0]?.text ?? "{}") as { verdict?: { records?: number } | null };
      verdict = parsed.verdict ?? null;
      if (verdict === null) await client.settle();
    }
    record("triage read a real measured verdict", (verdict?.records ?? 0) > 0);
    notes.push(`verdict reports ${String(verdict?.records ?? 0)} records in the window`);

    // 4. METADATA FIRST. Rotation is often the whole explanation, and this never
    //    loads the credential.
    const metaCall = client.ask("tools/call", {
      name: "read_credential",
      arguments: { credentialName: CREDENTIAL, exposure: "metadata" },
    });
    const metaResult = (await metaCall) as { content?: { text?: string }[]; isError?: boolean };
    const metaBody = JSON.parse(metaResult.content?.[0]?.text ?? "{}") as { exists?: boolean; rotatedAt?: string; exposure?: string };
    record("metadata answers existence and rotation", metaBody.exposure === "metadata" && metaBody.exists === true);
    record("metadata reports the rotation instant", metaBody.rotatedAt === ROTATED_AT);
    record("metadata carries no value anywhere in its answer", !JSON.stringify(metaResult).includes("sk-live"));

    // 5. THEN raw, which the operator declines. The client treats that as an answer.
    const rawCall = client.ask("tools/call", {
      name: "read_credential",
      arguments: { credentialName: CREDENTIAL, exposure: "raw" },
    });
    const rawResult = (await rawCall.catch((error: Error) => ({ error }))) as
      | { content?: { text?: string }[]; isError?: boolean; error?: Error };
    const declined = rawResult.error !== undefined || rawResult.isError === true;
    record("a declined raw read is refused, not retried", declined);
    record("no raw value reached the client", !JSON.stringify(rawResult).includes("sk-live"));

    // 6. The inbound-request machinery actually ran.
    record("the client received and answered a server-initiated request", seen.length >= 2);
    record("the raw prompt carried the high-severity warning", seen.some((s) => s.exposure === "raw" && s.warning.includes("RAW CREDENTIAL EXPOSURE REQUESTED")));
    record("the raw prompt required its own acknowledgement box", seen.some((s) => s.exposure === "raw" && s.required.includes("acknowledgeRawExposure")));
    record("the metadata prompt did not", seen.some((s) => s.exposure === "metadata" && !s.required.includes("acknowledgeRawExposure")));
  } finally {
    client.end();
    await wedge.close();
    store.close();
  }

  console.log("\n=== 2 AM TRIAGE, THROUGH A REAL EMBASSY PROCESS =================");
  for (const note of notes) console.log(`  . ${note}`);
  console.log("\nchecks");
  for (const check of checks) console.log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}`);

  const passed = checks.every((check) => check.ok);
  console.log(`\n${passed ? "TRIAGE PATH PASSED" : "TRIAGE PATH FAILED"}`);
  return passed;
}

process.exitCode = (await main()) ? 0 : 1;
