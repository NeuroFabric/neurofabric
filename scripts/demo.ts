/**
 * THE DEMO. One script, the whole pipeline, no network and no dependencies.
 *
 * === WHY IT IS `node --experimental-strip-types` AND NOT tsx ===
 *
 * The directive offered `tsx` or `ts-node`. Both are runtime dependencies, and the
 * standing rule for this repository is D-018: ZERO runtime dependencies, because a
 * serving image with no installed packages has no third-party code to compromise
 * and no lockfile to drift. The platform already runs its TypeScript directly on
 * node's strip-only type erasure -- that is how every suite in this repository
 * executes -- so the demo runs the same way. A demo that needs a transpiler
 * installed is a demo that will not run on the machine it was written on.
 *
 * === WHAT IT PROVES, IN ORDER ===
 *
 *   1. A CUSTOMER CAN AUTHOR AN AGENT over HTTP, and it is live immediately.
 *   2. TEN THOUSAND LINES flow through the authenticated gateway.
 *   3. MEMORY stays flat while they do, with the payload volume printed beside it
 *      so the number can be read rather than admired.
 *   4. AN ANOMALY INJECTED MID-STREAM produces a LiveVerdict naming it.
 *   5. THE VERDICT BECOMES AN EGRESS PAYLOAD, delivered to a stub receiver.
 *
 * Step 5 uses a stub `fetch` rather than a real webhook, and says so in its
 * output. A demo that posted to the internet to prove it works would be a demo
 * that fails on a locked-down network and teaches nobody anything the stub does
 * not.
 */

import { DynamicAgentRegistry } from "../platform/swarm/dynamic-registry.ts";
import {
  TenantRouter,
  createGateway,
  type GatewayOptions,
} from "../platform/omniroute/omniroute-gateway.ts";
import { CREDENTIAL_HEADER, staticVault, type GatewayToken } from "../platform/omniroute/edge-security.ts";
import { createSchemaRoutes } from "../platform/api/schema-routes.ts";
import { AUTHORING_PROVIDER } from "../platform/api/schema-routes.ts";
import { evaluateLive, liveFindings } from "../platform/conductor/live-anomaly.ts";
import { WebhookDispatcher, buildAlertPayload } from "../platform/egress/webhook-dispatcher.ts";
import { attachDispatcher } from "../platform/egress/webhook-dispatcher.ts";
import type { SwarmAlert } from "../platform/omniroute/omniroute-gateway.ts";

const TENANT = "acme";
const TOTAL = 10_000;
/** Where the breach goes. Late enough that the fences have already been measured. */
const BREACH_AT = 5_000;

const heading = (text: string) => {
  console.log("");
  console.log(`── ${text} ${"─".repeat(Math.max(0, 68 - text.length))}`);
};

const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

/**
 * THE SCHEMA A CUSTOMER WOULD WRITE.
 *
 * One rule reads a numeric field and one reads the log text. Between them they
 * exercise every part of the evaluator that matters: a threshold, a customer
 * regex, the finding cap, and evidence that traces a claim back to the field that
 * produced it.
 */
const CUSTOMER_SCHEMA = {
  id: "service-health",
  title: "Service health",
  domain: "performance",
  version: "1.0.0",
  capabilities: ["reads the error rate and the fatal lines out of a log stream"],
  streams: ["logs"],
  rules: [
    {
      id: "error-rate",
      kind: "threshold",
      severity: "critical",
      message: "error rate above the service objective",
      field: "error_rate",
      operator: ">",
      value: 0.05,
    },
    {
      id: "fatal-line",
      kind: "regex",
      severity: "critical",
      message: "a fatal or corrupting line in the log",
      field: "line",
      // A nested quantifier on purpose. D-040.2 refused this shape; the NFA engine
      // evaluates it in one pass, and the demo is the place to show that.
      pattern: "(FATAL|panic|checksum mismatch)+",
      flags: "i",
    },
  ],
};

const token: GatewayToken = {
  id: TENANT,
  credential: "demo-credential",
  providers: [AUTHORING_PROVIDER, "logs"],
};

/** A synthetic log line. Deterministic, so the demo prints the same numbers twice. */
function lineFor(index: number): string {
  const level = index % 500 === 0 ? "WARN" : "INFO";
  return `[${String(index).padStart(5, "0")}] ${level} request completed in ${8 + (index % 90)}ms route=/checkout`;
}

/** The event pushed for one log line. */
function eventFor(index: number, breached: boolean): { fields: Record<string, string>; at?: number } {
  const fields: Record<string, string> = {
    stream: "logs",
    line: lineFor(index),
    // Ordinary traffic sits well under the objective. The breach is 0.87.
    error_rate: breached ? "0.87" : (0.001 + (index % 7) / 1000).toFixed(4),
    latency_ms: breached ? "99999" : String(8 + (index % 90)),
    at: String(1_700_000_000_000 + index),
  };
  if (breached) {
    // The line the regex rule exists to catch.
    fields.line = `[${String(index).padStart(5, "0")}] FATAL panic: checksum mismatch in shard 7`;
  }
  return { fields, at: 1_700_000_000_000 + index };
}

/** Wait for the broker's async consumer to reach the expected record count. */
async function settle(gateway: ReturnType<typeof createGateway>, target: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  const broker = gateway.brokerFor("logs");
  while (broker !== undefined && broker.snapshot().records < target && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function main(): Promise<void> {
  console.log("Neurofebric — end-to-end demonstration");
  console.log("10,000 authenticated log lines, one injected breach, no network calls.");

  // ---------------------------------------------------------------- 1
  heading("1. AUTHOR AN AGENT OVER HTTP");
  const registry = new DynamicAgentRegistry();
  const authoring = createSchemaRoutes({ registry, vault: staticVault([token], "demo-vault") });
  const authHeaders = { [CREDENTIAL_HEADER]: "demo-credential" };

  const unauthenticated = await authoring.handle("POST", "/api/tenant/schema", {}, CUSTOMER_SCHEMA);
  console.log(`   POST without a credential      -> ${unauthenticated.status} (this is the point)`);

  const created = await authoring.handle("POST", "/api/tenant/schema", authHeaders, CUSTOMER_SCHEMA);
  const described = JSON.parse(JSON.stringify(created.body));
  console.log(`   POST with a credential         -> ${created.status} ${created.status === 201 ? "created" : ""}`);
  console.log(`   agent id                       -> ${described.agent.id}`);
  console.log(`   rules                          -> ${Object.keys(CUSTOMER_SCHEMA.rules).length} rules, ${CUSTOMER_SCHEMA.rules.map((rule) => rule.id).join(", ")}`);
  console.log(`   hot-loaded, no restart          -> ${registry.get(TENANT, "service-health")?.id === "acme/service-health"}`);

  // ---------------------------------------------------------------- 2
  heading("2. THE INGRESS AND THE RECEIVER");
  const gatewayOptions: GatewayOptions = { tokens: [token] };
  const gateway = createGateway(gatewayOptions);
  gateway.connect({ name: "logs", keyColumn: "latency_ms", timeColumn: "at" });

  // A stub receiver. Real enough to exercise the whole dispatcher -- payload,
  // signature, retry accounting -- and it cannot fail the demo by reaching out.
  let delivered = 0;
  let lastBody = "";
  const dispatcher = new WebhookDispatcher({
    endpoints: [{ url: "http://receiver.invalid/demo", hmacKey: "demo-key" }],
    fetchImpl: (async (_url: string, init: { body: string }) => {
      delivered += 1;
      lastBody = init.body;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
    sleep: async () => { /* no backoff to wait through in a demo */ },
  });
  attachDispatcher(gateway, dispatcher);

  console.log(`   gateway token provider         -> logs`);
  console.log(`   egress receiver                -> stub (one delivery expected)`);

  // ---------------------------------------------------------------- 3
  heading(`3. STREAMING ${TOTAL.toLocaleString("en-US")} LINES`);
  const initial = process.memoryUsage();
  let peakHeap = initial.heapUsed;
  let peakRss = initial.rss;

  const began = Date.now();
  for (let index = 0; index < TOTAL; index += 1) {
    const breached = index === BREACH_AT;
    const request = {
      headers: { [CREDENTIAL_HEADER]: "demo-credential" },
      provider: "logs",
      events: 1,
    };
    const decision = gateway.pushAdmitted(request, eventFor(index, breached));
    if (!decision.ok) throw new Error(`push refused at ${index}: ${decision.reason}`);

    if (index % 250 === 0) {
      const sample = process.memoryUsage();
      if (sample.heapUsed > peakHeap) peakHeap = sample.heapUsed;
      if (sample.rss > peakRss) peakRss = sample.rss;
    }
  }
  const elapsed = Date.now() - began;
  await settle(gateway, TOTAL);

  const final = process.memoryUsage();
  if (final.heapUsed > peakHeap) peakHeap = final.heapUsed;
  if (final.rss > peakRss) peakRss = final.rss;

  const payloadVolume = TOTAL * lineFor(0).length;
  console.log(`   records accepted               -> ${gateway.snapshot("logs")[0]?.records.toLocaleString("en-US")}`);
  console.log(`   throughput                     -> ${(TOTAL / (elapsed / 1000)).toFixed(0)} lines/sec over ${elapsed} ms`);
  console.log(`   payload volume streamed        -> ${mib(payloadVolume)}`);
  console.log(`   initial heap                   -> ${mib(initial.heapUsed)}`);
  console.log(`   peak heap                      -> ${mib(peakHeap)}`);
  console.log(`   final heap                     -> ${mib(final.heapUsed)}`);
  console.log(`   peak rss                       -> ${mib(peakRss)}`);
  console.log(`   retained across the flood      -> ${mib(final.heapUsed - initial.heapUsed)}`);

  // ---------------------------------------------------------------- 4
  heading("4. THE LIVE VERDICT");
  const snapshot = gateway.snapshot("logs")[0];
  if (snapshot === undefined) throw new Error("no snapshot: the stream never reached the broker");
  const verdict = evaluateLive(snapshot);
  const alert: SwarmAlert = {
    provider: "logs",
    verdict,
    text: liveFindings(verdict),
    at: verdict.at,
    firstObservation: true,
  };

  console.log(`   records                        -> ${verdict.records.toLocaleString("en-US")}`);
  console.log(`   stream open                    -> ${verdict.open}`);
  console.log(`   columns measured               -> ${verdict.columns.length}`);
  console.log(`   columns past the outer fence   -> ${verdict.breachedColumns}`);
  console.log(`   verdict text                   -> ${alert.text}`);

  const breachedColumn = verdict.columns.find((column) => column.breached);
  if (breachedColumn === undefined) {
    throw new Error("the injected breach did not produce a verdict: the demo would be proving nothing");
  }
  console.log(`   breached column                -> ${breachedColumn.column}`);
  console.log(`   observed max / outer fence     -> ${breachedColumn.max} / ${breachedColumn.extremeUpper}`);
  console.log(`   times past the fence           -> ${breachedColumn.extremeMultiple}`);
  console.log(`   contributed partitions         -> ${breachedColumn.partitions}`);
  console.log(`   breached in every partition    -> ${breachedColumn.breachedEverywhere}`);

  // ---------------------------------------------------------------- 5
  heading("5. THE SCHEMA-DRIVEN AGENT, ON THE SAME DATA");
  const agent = registry.get(TENANT, "service-health");
  if (agent === undefined) throw new Error("the authored agent vanished");
  const agentResult = await agent.diagnose({
    prompt: "check the service",
    stream: (async function* () {
      for (let index = 0; index < TOTAL; index += 1) {
        yield { fields: eventFor(index, index === BREACH_AT).fields, partition: "logs", at: 1_700_000_000_000 + index };
      }
    })(),
  });
  console.log(`   verdict                        -> ${agentResult.status}`);
  console.log(`   events read                    -> ${agentResult.stats?.eventsRead?.toLocaleString("en-US")}`);
  console.log(`   findings retained              -> ${agentResult.findings.length} (omitted: ${agentResult.stats?.findingsOmitted ?? 0})`);
  console.log(`   rules that fired               -> ${agentResult.findings
    .map((finding) => finding.title.split(":")[0])
    .filter((id, at, all) => all.indexOf(id) === at)
    .join(", ") || "none"}`);
  console.log(`   summary                        -> ${agentResult.summary}`);

  // ---------------------------------------------------------------- 6
  heading("6. THE EGRESS PAYLOAD");
  // `evaluate` is what fires alerts. `attachDispatcher` subscribed the receiver
  // to the alert stream, but a subscriber is not a trigger -- the gateway only
  // speaks when someone asks it to judge, which is the same rule as every other
  // pull-based surface in this platform.
  const emitted = gateway.evaluate("logs");
  // Give the dispatcher a turn: it was invoked from the alert subscriber.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const payload = buildAlertPayload(alert);

  console.log(`   alerts emitted                 -> ${emitted.length} (${emitted.filter((a) => a.firstObservation).length} first observation)`);
  console.log(`   payload title                  -> ${payload.title}`);
  console.log(`   payload severity               -> ${payload.severity}`);
  console.log(`   payload id                     -> ${payload.id}`);
  console.log(`   payload summary                -> ${JSON.stringify(payload.summary)}`);
  console.log(`   payload columns                -> ${payload.columns.map((column) => `${column.column}(max ${column.max})`).join(", ")}`);
  console.log(`   payload bytes delivered        -> ${lastBody.length.toLocaleString("en-US")}`);
  console.log(`   deliveries to the receiver     -> ${delivered}`);

  if (delivered === 0 || lastBody.length === 0) {
    // The demo throws rather than exiting zero having proved nothing. A demo that
    // prints "payload formed -> false" and exits 0 is worse than one that fails,
    // because the output is what a reader believes.
    throw new Error("the egress dispatcher delivered nothing: the verdict never reached a receiver");
  }
  console.log(`   payload formed and delivered   -> true`);

  heading("DONE");
  console.log("Authored an agent over HTTP, streamed 10,000 authenticated lines,");
  console.log("injected one breach mid-stream, and turned the verdict into a payload.");
  console.log("");
}

await main();
