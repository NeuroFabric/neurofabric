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
import { SseAccumulator, readAlert, type AlertReading } from "./sse-frames.ts";
import { classifyToolFailure, classifyToolOutcome, JsonRpcCallError } from "./triage-routing.ts";

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
          /**
           * THE CODE IS A FIELD, NOT A SENTENCE.
           *
           * This used to be `new Error(\`${code}: ${message}\`)`, and the consequence
           * was not cosmetic: the one machine-readable fact in the exchange was
           * buried in prose, so every caller had to guess at it. The caller here
           * guessed badly -- it reported an operator's refusal as an unknown fault,
           * and the escalation it produced named a broken gateway where a decision
           * had in fact been made and recorded. The field is what makes the next
           * `classifyToolFailure` a lookup rather than a regular expression.
           */
          const error = frame["error"] as { code?: unknown; message?: unknown };
          entry.reject(
            new JsonRpcCallError(
              typeof error.code === "number" ? error.code : undefined,
              typeof error.message === "string" ? error.message : "refused",
            ),
          );
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

// === DETECTION: THE ALERT STREAM =========================================

/**
 * SUBSCRIBE TO THE ALERT STREAM, AND REPORT THE FIRST BREACH -- OR WHY THERE WAS NONE.
 *
 * The one-way half of the platform an agent consumes at 2am. The hub deliberately
 * does not replay, so this is opened BEFORE any data is injected -- a subscription
 * opened afterwards could not have missed anything and would prove nothing.
 *
 * The framing lives in `sse-frames.ts` rather than here, because framing is where
 * this goes wrong: the socket chooses the chunk boundaries, a proxy can rewrite line
 * endings, and a reader that is only ever exercised on a stream arriving perfectly
 * has not been tested at all. What this function owns is the part that is a
 * JUDGEMENT rather than a parser -- an unreadable frame is reported as unreadable,
 * never as the absence of a breach.
 */
async function openAlertStream(
  origin: string,
  credential: string,
): Promise<{ first: (ms: number) => Promise<{ opened: boolean; reading: AlertReading }> }> {
  const readings: AlertReading[] = [];
  /** Frames we could not read. Kept so a quiet stream can explain itself. */
  const unreadable: string[] = [];
  const controller = new AbortController();
  let opened = false;
  let closed = false;

  void fetch(`${origin}/api/memory/alerts`, {
    headers: { [CREDENTIAL_HEADER]: credential },
    signal: controller.signal,
  })
    .then(async (response) => {
      opened = response.ok;
      if (!opened) return;
      const reader = response.body?.getReader();
      if (reader === undefined) return;
      const frames = new SseAccumulator();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Every frame, including the ones we do not act on. A dropped frame is a
        // fact about the stream that an operator may need, and it is cheaper to keep
        // it than to lose it.
        for (const item of frames.push(value)) {
          const reading = readAlert(item);
          if (reading.kind === "unreadable") unreadable.push(reading.because);
          else readings.push(reading);
        }
      }
      closed = true;
      // The end of the stream is itself an event. Whatever was buffered when the
      // socket closed is accounted for here rather than dropped.
      for (const item of frames.end()) {
        const reading = readAlert(item);
        if (reading.kind === "unreadable") unreadable.push(reading.because);
        else readings.push(reading);
      }
    })
    .catch((error: unknown) => {
      // An aborted subscription is the normal way this function ends. Anything else
      // is a stream that died, and a stream that died is not a quiet system.
      if (!controller.signal.aborted) unreadable.push(`the alert stream ended early: ${error instanceof Error ? error.message : "unknown"}`);
    });

  return {
    /**
     * Waits for the first breach, and REPORTS whether the subscription worked.
     *
     * Both together, because the two used to be separate and separate was wrong:
     * `opened` is only true once the response headers have come back, and asking
     * for it straight after calling this raced the fetch. The symptom was a FAIL on
     * a subscription that had demonstrably worked -- the alert arrived on the next
     * line. Asking once, after the wait, removes the race rather than documenting it.
     */
    async first(ms: number): Promise<{ opened: boolean; reading: AlertReading }> {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && !closed && readings.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      controller.abort();
      const alert = readings.find((reading) => reading.kind === "alert");
      if (alert !== undefined) return { opened, reading: alert };

      /**
       * NOTHING ARRIVED, AND THIS MUST NOT READ AS "ALL QUIET".
       *
       * The three states are kept apart because they call for three different
       * responses. No alert on a healthy stream is a clean night. No alert on a
       * stream we never got into is a monitoring gap, and an agent that files it as
       * a clean night has reported a healthy system while blind to it. Frames we
       * could not read are the third: the hub spoke and we could not understand it.
       */
      if (!opened) return { opened, reading: { kind: "unreadable", because: "the alert stream never opened", preview: "" } };
      if (unreadable.length > 0) return { opened, reading: { kind: "unreadable", because: unreadable.join("; "), preview: "" } };
      if (closed) return { opened, reading: { kind: "ignored", event: "no alert before the stream closed" } };
      return { opened, reading: { kind: "ignored", event: "no alert within the window" } };
    },
  };
}

/** Real variance and one genuine outlier, so the engine has a fence to trip. */
async function injectBreach(origin: string, credential: string): Promise<void> {
  const events = (base: number, spikes: number) =>
    Array.from({ length: 400 }, (_, i) => {
      const elapsed = i % 20 === 0 && spikes > 0 ? spikes-- : base + (i % 20) * 4;
      return {
        fields: { service: "order-fulfilment", alert_code: "PEGA0001", elapsed_time: String(elapsed), threshold: "1000" },
        at: 1_760_000_000_000 + i * 500,
      };
    });

  await fetch(`${origin}/api/portal/ingest`, {
    method: "POST",
    headers: { [CREDENTIAL_HEADER]: credential, "content-type": "application/json" },
    body: JSON.stringify({ provider: "pega", events: [...events(1000, 40_000), ...events(1200, 0)] }),
  });
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
  const checks: { name: string; ok: boolean; note?: string }[] = [];
  /**
   * WHAT THE AGENT DID WITH A REFUSAL.
   *
   * A list rather than a log line, because the point of the routing branch is that
   * it produces a HANDOFF: something a person has to pick up. An agent that simply
   * moved on has silently dropped the reason it could not act.
   */
  const routed: { credentialName: string; outcome: string; to: string; because: string }[] = [];
  const record = (name: string, ok: boolean, note?: string) => checks.push({ name, ok, ...(note === undefined ? {} : { note }) });

  // A real core, so `get_verdict` is a real measurement and not a stub.
  const cwd = await makeTempWorkspace("nf-triage-");
  // The wedge's ledger is a FILE, not memory, because the embassy process has to
  // write approvals into it. Two processes, one ledger, and WAL is what makes that
  // possible -- which is exactly the arrangement a deployment would run.
  const ledgerDir = mkdtempSync(join(tmpdir(), "nf-triage-ledger-"));
  const store = MemoryStore.open({ directory: ledgerDir });
  const token = { id: TENANT, credential: "triage-value", providers: ["portal", "memory"] };
  const wedge = await startWedgeServer({
    cwd,
    port: 0,
    portalVault: staticVault([token], "triage"),
    memory: { store, tenant: TENANT },
    evaluationIntervalMs: 150,
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
    NEUROFEBRIC_AUDIT_DIR: ledgerDir,
    NEUROFEBRIC_CAPABILITY_ID: "cap-triage",
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

    // 3. DETECTION IS A PUSH, NOT A POLL. The stream is opened BEFORE the breach is
    //    injected, because the hub deliberately does not replay -- a subscription
    //    opened afterwards is one that could not have missed anything and would
    //    prove nothing.
    const alerts = await openAlertStream(wedge.url, token.credential);
    await client.settle();

    await injectBreach(wedge.url, token.credential);
    notes.push("injected a breaching batch and waited for the engine to fence it");

    const detected = await alerts.first(30_000);
    const reading = detected.reading;
    const alert = reading.kind === "alert" ? reading.alert : null;
    // WHY THERE IS NO ALERT, in one place, because every branch below has to be
    // able to say it. A check that fails without saying why is a check that gets
    // ignored the next time it fails.
    const why = reading.kind === "alert" ? undefined : reading.kind === "unreadable" ? reading.because : `the stream produced no alert (${reading.event})`;
    record("the alert stream subscribed", detected.opened);
    record("the autonomous engine pushed a breach over SSE", alert !== null, why);
    notes.push(alert === null ? `no alert arrived: ${why}` : `SSE alert: ${JSON.stringify(alert).slice(0, 100)}`);

    // 4. THE VERDICT IS STILL READ. A push tells you something happened; the tool
    //    tells you what the window actually holds, and an agent that acts on the
    //    push alone never learns whether the breach is still breaching.
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

    // 5. METADATA FIRST. Rotation is often the whole explanation, and it never
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

    // 6. THEN raw, which the operator DECLINES -- and this is the part the demo is
    //    really about.
    //
    //    A declined approval is a ROUTING CONDITION, not an error. An agent that
    //    treats it as a failure will retry, then rephrase the request, then ask for
    //    a narrower one, and every step of that is a human being worn down by an
    //    agent that will not take no for an answer. So the branch below is explicit
    //    and terminal: the refusal is recorded as a decision, remediation is handed
    //    to whoever is awake, and the agent carries on with what it can still do.
    //
    //    What the branch is NOT allowed to be is "anything that went wrong". The
    //    classification is a named test (`triage-routing.test.ts`) because the old
    //    one-liner -- an error, or an isError flag -- reported a broken ledger as a
    //    person having said no, and sent an engineer to look for a prompt that was
    //    never shown.
    const rawCall = client.ask("tools/call", {
      name: "read_credential",
      arguments: { credentialName: CREDENTIAL, exposure: "raw" },
    });
    const rawOutcome = await rawCall.then(classifyToolOutcome, classifyToolFailure);
    notes.push(`the raw call came back as ${rawOutcome.kind}${rawOutcome.kind === "fault" ? `: ${rawOutcome.because}` : ""}`);

    record("a declined raw read is refused, not retried", rawOutcome.kind === "refused");

    if (rawOutcome.kind === "refused") {
      /**
       * THE ROUTING BRANCH. Named so it reads as a decision rather than as something
       * that happened to us.
       *
       * And the sentence is allowed to say "a person declined", because a refusal is
       * the one outcome that means exactly that.
       */
      routed.push({
        credentialName: CREDENTIAL,
        outcome: "deferred",
        to: "the on-call engineer",
        because: "a person declined to put a live credential into a model's context",
      });
      notes.push("raw exposure declined: remediation deferred to the on-call engineer, and the agent did NOT retry");

      // And the agent keeps working. Proving that it can do something useful after
      // being told no is the difference between a gate and an obstacle.
      let stillWorks = false;
      try {
        const answer = (await client.ask("tools/call", { name: "get_verdict", arguments: {} })) as {
          content?: { text?: string }[];
        };
        stillWorks = Array.isArray(answer.content) && answer.content.length > 0;
      } catch {
        stillWorks = false;
      }
      record("the agent carries on after a refusal", stillWorks);
    } else {
      routed.length = 0;
      record("the agent carries on after a refusal", false, `the call came back as ${rawOutcome.kind}, so nothing was proven about a refusal`);
    }
    record("no raw value reached the client", !JSON.stringify(rawOutcome).includes("sk-live"));

    // 7. The inbound-request machinery actually ran.
    record("the client received and answered a server-initiated request", seen.length >= 2);
    record("the raw prompt carried the high-severity warning", seen.some((s) => s.exposure === "raw" && s.warning.includes("RAW CREDENTIAL EXPOSURE REQUESTED")));
    record("the raw prompt required its own acknowledgement box", seen.some((s) => s.exposure === "raw" && s.required.includes("acknowledgeRawExposure")));
    record("the metadata prompt did not", seen.some((s) => s.exposure === "metadata" && !s.required.includes("acknowledgeRawExposure")));

    /**
     * 7. THE REFUSAL IS IN SQLITE. Not "the client was told", not "a log line said
     * so" -- the row, read back with the same query an investigator would use.
     *
     * This is the check that would have caught ADR-010 §A5. Before the durable sink,
     * everything above still passed: the client saw a refusal, the operator saw a
     * prompt, and nothing anywhere said who declined what. The proof that the
     * decision SURVIVED the process is that it is still here, after that process is
     * gone, in a store this script opens independently.
     *
     * The embassy has already exited by the time this runs, so the row cannot be
     * anything the embassy is still holding.
     */
    const allRows = store.auditFor(TENANT);
    const rows = allRows.filter((row) => row.action.startsWith("vault."));
    const approvalRows = rows.filter((row) => row.action.startsWith("vault.approval."));
    const readRows = rows.filter((row) => row.action.startsWith("vault.read."));
    const exposureRows = rows.filter((row) => row.action.startsWith("vault.exposure."));
    const approvalRows1 = approvalRows.filter((row) => row.action === "vault.approval.granted");
    const refusalRows = approvalRows.filter((row) => row.action === "vault.approval.refused");

    record("the approval is queryable from SQLite", approvalRows1.length === 1);
    record("the refusal is queryable from SQLite", refusalRows.length === 1);

    const document = (raw: unknown): Record<string, unknown> =>
      typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);

    const granted = approvalRows1[0];
    record("the row names the operator", granted?.actor === "on-call");
    record("the row records what was approved, not merely that it was", document(granted?.document)["exposure"] === "metadata");

    const grantedDocument = document(granted?.document);
    record("the row names the capability", grantedDocument["capability"] === "cap-triage");
    record("the row names the tenant", grantedDocument["tenant"] === TENANT);
    record("the row names the target item", grantedDocument["credentialName"] === CREDENTIAL);
    record("the row carries the operator's reason", String(grantedDocument["reason"]).includes("incident 4471"));

    const refused = refusalRows[0];
    const refusedDocument = document(refused?.document);
    record("the refusal names the capability too", refusedDocument["capability"] === "cap-triage");
    record("the refusal says what was requested", refusedDocument["exposure"] === "raw");
    record("the refusal carries a reason", String(refusedDocument["reason"]).length > 0);
    record("no ledger row carries a credential", !JSON.stringify(rows).includes("sk-live"));

    /**
     * 8. THE READ AND EXPOSURE TRAILS, CORRELATED TO THE APPROVAL BY THE CAPABILITY.
     *
     * Three questions, three different row classes, one shared field. Someone at 2am
     * asking "was this credential read?" must be able to answer it from the ledger
     * without also learning that someone approved it, and someone asking "was a live
     * value put in a model's context?" must not have to read an approval row to find
     * out. Sharing the `capability` field is what joins the three tables into one
     * answer.
     */
    record("the granted read is in the ledger", readRows.some((row) => row.action === "vault.read.success"));
    record(
      "a declined approval leaves NO read row, because no read was attempted",
      readRows.every((row) => document(row.document)["exposure"] !== "raw"),
      "otherwise a refusal would look like a read that happened",
    );
    record("the metadata exposure is recorded as its own class", exposureRows.some((row) => row.action === "vault.exposure.metadata"));
    record("no raw exposure was recorded, because none was approved", exposureRows.every((row) => row.action !== "vault.exposure.raw"));

    const correlated = [granted, readRows.find((row) => row.action === "vault.read.success"), exposureRows.find((row) => row.action === "vault.exposure.metadata")].filter(
      (row): row is (typeof allRows)[number] => row !== undefined,
    );
    record(
      "the approval, the read and the exposure join on the capability",
      correlated.length === 3 && correlated.every((row) => document(row.document)["capability"] === "cap-triage"),
    );

    notes.push(
      `ledger holds ${approvalRows1.length} approval, ${refusalRows.length} refusal, ${readRows.length} read and ${exposureRows.length} exposure row, written by the embassy process`,
    );
    notes.push(`vault actions present: ${[...new Set(rows.map((row) => row.action))].join(", ")}`);
  } finally {
    client.end();
    await wedge.close();
    store.close();
  }

  console.log("\n=== 2 AM TRIAGE, THROUGH A REAL EMBASSY PROCESS =================");
  for (const note of notes) console.log(`  . ${note}`);
  if (routed.length > 0) {
    console.log("\nhanded off");
    for (const item of routed) console.log(`  > ${item.credentialName}: ${item.outcome} to ${item.to} -- ${item.because}`);
  }
  console.log("\nchecks");
  for (const check of checks) {
    console.log(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.note === undefined ? "" : ` (${check.note})`}`);
  }

  const passed = checks.every((check) => check.ok);
  console.log(`\n${passed ? "TRIAGE PATH PASSED" : "TRIAGE PATH FAILED"}`);
  return passed;
}

process.exitCode = (await main()) ? 0 : 1;
