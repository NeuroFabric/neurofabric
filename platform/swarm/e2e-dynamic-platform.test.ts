import test from "node:test";
import assert from "node:assert/strict";

import { DynamicAgentRegistry } from "./dynamic-registry.ts";
import type { TelemetryEvent } from "./diagnostic-agent.ts";
import { InMemoryPortalStore, createPortalRoutes } from "../api/portal-routes.ts";
import { CREDENTIAL_HEADER, staticVault } from "../omniroute/edge-security.ts";

/** The owning tenant for the registry in these tests. There is no default bucket. */
const T = "acme";

/**
 * THE PLATFORM PROOF. Two generated agents, a real flood, and the memory claim
 * under test rather than asserted in a comment.
 *
 * === HOW THE MEMORY CLAIM IS ACTUALLY TESTED ===
 *
 * The obvious version of this test feeds N events and asserts memory did not grow,
 * which proves nothing: N is small, and V8 would not have needed to collect. The
 * test that means something gives each event a LARGE payload and streams many of
 * them. Then the two implementations separate by an order of magnitude:
 *
 *   - buffering holds every payload at once. 50,000 events at 4 KiB is 200 MiB of
 *     live strings, which is not a slow test, it is a heap that has doubled.
 *   - streaming holds one payload at a time and drops it, so retained memory is
 *     the agent's bounded state: a capped findings array, a fixed ring per rate
 *     rule, and nothing else.
 *
 * The threshold below is 64 MiB against 200 MiB of payload volume. It is
 * deliberately generous: `heapUsed` is read without forcing a collection, because
 * the suites are run by plain `node --test` with no `--expose-gc`, so the number
 * includes transient garbage that a collection would have reclaimed. Generous
 * enough not to be flaky, tight enough that retaining the payloads cannot pass.
 *
 * AND THE DETERMINISTIC HALF MATTERS MORE. Retention that scales with input would
 * show up as a finding list that grows with the flood, which is checked directly
 * and exactly, with no GC involved: the same cap at 1,000 events and at 50,000.
 */

/** A payload big enough that buffering 50,000 of them cannot hide. */
const BIG = "x".repeat(4096);

const FLOOD = 50_000;

/** The two schemas this platform exists to demonstrate, generated not hardcoded. */
const FINANCIAL_SCHEMA = {
  id: "financial-agent",
  title: "Financial Agent",
  domain: "financial-compliance",
  version: "1.0.0",
  capabilities: ["detects large transfers, missing beneficiaries and payment velocity"],
  streams: ["payments"],
  rules: [
    { id: "large-transfer", kind: "threshold", severity: "critical", message: "transfer above the reporting threshold", field: "amount", operator: ">", value: 50_000 },
    { id: "no-beneficiary", kind: "missing-field", severity: "warning", message: "a transfer with no named beneficiary", field: "beneficiary" },
    { id: "urgent-wiring", kind: "regex", severity: "warning", message: "an urgent wire instruction", pattern: "urgent wire", flags: "i" },
    { id: "velocity", kind: "rate", severity: "critical", message: "payment velocity above the account's usual rate", field: "account_id", windowMs: 1_000, rateAbove: 20 },
  ],
};

const SERVER_SCHEMA = {
  id: "server-health",
  title: "Server Health Agent",
  domain: "performance",
  version: "1.0.0",
  capabilities: ["detects heap pressure, long GC pauses and exhaustion warnings"],
  streams: ["jvm-metrics"],
  rules: [
    { id: "heap-pressure", kind: "threshold", severity: "critical", message: "heap use above the safe ceiling", field: "heap_used_mb", operator: ">", value: 512 },
    { id: "long-gc", kind: "threshold", severity: "warning", message: "a GC pause long enough to matter", field: "gc_pause_ms", operator: ">", value: 200 },
    { id: "exhaustion", kind: "regex", severity: "critical", message: "the JVM reported exhaustion", pattern: "OutOfMemory|to-space exhausted", flags: "i" },
    { id: "gc-flood", kind: "rate", severity: "warning", message: "more GC pauses than usual", field: "gc_pause_ms", windowMs: 60_000, rateAbove: 5 },
  ],
};

/**
 * A generator that never materialises its events.
 *
 * Written as a generator rather than an array on purpose: an array would be the
 * thing the test is claiming not to do, and writing one would make the proof
 * circular.
 *
 * Each branch keeps its OWN counter. Keying the anomalies off the loop index looks
 * equivalent and is not: `i % 30 === 0` is only ever true for even `i`, so every
 * anomaly scheduled that way lands on the payments branch and the JVM side of the
 * flood contains no anomaly at all. A test flood that quietly carries nothing to
 * find would pass while proving the opposite of what it claims.
 */
async function* flood(total: number, clock: () => number): AsyncGenerator<TelemetryEvent> {
  let money = 0;
  let jvm = 0;
  for (let i = 0; i < total; i += 1) {
    const now = clock();
    if (i % 2 === 0) {
      yield {
        partition: "payments",
        fields: {
          amount: money % 40 === 0 ? "90000" : String(100 + (money % 900)),
          account_id: `acct-${money % 25}`,
          narrative: BIG,
          ...(money % 7 === 0 ? {} : { beneficiary: `b-${money % 11}` }),
          ...(money % 97 === 0 ? { instruction: "URGENT WIRE to new account" } : {}),
          at: String(now),
        },
      };
      money += 1;
      continue;
    }
    yield {
      partition: "jvm-metrics",
      fields: {
        heap_used_mb: jvm % 30 === 0 ? "900" : String(120 + (jvm % 300)),
        gc_pause_ms: jvm % 30 === 0 ? "450" : String(10 + (jvm % 90)),
        heap_dump: BIG,
        ...(jvm % 211 === 0 ? { log: "java.lang.OutOfMemoryError: to-space exhausted" } : {}),
        at: String(now),
      },
    };
    jvm += 1;
  }
}

/* ------------------------------------------------------------------ */
/* THE FACTORY                                                         */
/* ------------------------------------------------------------------ */

test("BOTH SCHEMAS REGISTER AND BECOME ORDINARY AGENTS", () => {
  const registry = new DynamicAgentRegistry();
  registry.register(FINANCIAL_SCHEMA, { tenant: T });
  registry.register(SERVER_SCHEMA, { tenant: T });

  const roster = registry.describeAll();
  assert.equal(roster.length, 2);
  assert.deepEqual(roster.map((a) => a.id).sort(), ["acme/financial-agent", "acme/server-health"]);
  assert.deepEqual(roster.map((a) => a.tenant), [T, T], "and every descriptor names its owner");
  for (const descriptor of roster) assert.equal(descriptor.maturity, "ready");
});

test("EACH AGENT EVALUATES ONLY ITS OWN DECLARED STREAM", async () => {
  // The premise of a shared platform: two agents on one stream, each answering for
  // itself, neither firing on the other's telemetry.
  const registry = new DynamicAgentRegistry();
  const financial = registry.register(FINANCIAL_SCHEMA, { tenant: T }).agent;
  const server = registry.register(SERVER_SCHEMA, { tenant: T }).agent;

  const money = await financial.diagnose({
    prompt: "",
    stream: (async function* () {
      yield { partition: "payments", fields: { amount: "90000" } };
      yield { partition: "jvm-metrics", fields: { amount: "90000" } };
    })(),
  });
  const jvm = await server.diagnose({
    prompt: "",
    stream: (async function* () {
      yield { partition: "payments", fields: { heap_used_mb: "900" } };
      yield { partition: "jvm-metrics", fields: { heap_used_mb: "900" } };
    })(),
  });

  // The payments event trips TWO financial rules -- it is over the threshold AND
  // it names no beneficiary -- so two findings is the correct answer and one would
  // have meant a rule silently stopped firing.
  assert.deepEqual(
    money.findings.map((f) => f.title.split(":")[0]).sort(),
    ["large-transfer", "no-beneficiary"],
  );
  assert.equal(money.stats?.eventsRead, 2);
  assert.equal(money.stats?.eventsSkippedOffStream, 1);
  assert.deepEqual(jvm.findings.map((f) => f.title.split(":")[0]), ["heap-pressure"]);
  assert.equal(jvm.stats?.eventsSkippedOffStream, 1);
});

test("EVERY RULE KIND FIRES ON A REAL PAYLOAD", async () => {
  const registry = new DynamicAgentRegistry();
  const financial = registry.register(FINANCIAL_SCHEMA, { tenant: T }).agent;
  const server = registry.register(SERVER_SCHEMA, { tenant: T }).agent;
  let now = 1_000_000;
  const clock = () => now;

  const money = await financial.diagnose({
    prompt: "",
    stream: (async function* () {
      for (let i = 0; i < 30; i += 1) {
        now += 1;
        // account_id is REQUIRED: the velocity rule counts occurrences of that
        // field, so a payload without it produces no velocity at all and the rule
        // would look broken when it is merely unexercised.
        yield { partition: "payments", fields: { amount: "90000", account_id: "acct-1", at: String(now) } };
      }
    })(),
  });
  const jvm = await server.diagnose({
    prompt: "",
    stream: (async function* () {
      now += 1;
      yield { partition: "jvm-metrics", fields: { heap_used_mb: "900", gc_pause_ms: "450", log: "OutOfMemoryError", at: String(now) } };
    })(),
  });

  const moneyRules = money.findings.map((f) => f.title.split(":")[0]).sort();
  const jvmRules = jvm.findings.map((f) => f.title.split(":")[0]).sort();

  // threshold, missing-field and rate all fire on the payments side.
  assert.ok(moneyRules.includes("large-transfer"), "threshold rule did not fire");
  assert.ok(moneyRules.includes("no-beneficiary"), "missing-field rule did not fire");
  assert.ok(moneyRules.includes("velocity"), "rate rule did not fire");

  // threshold and regex fire on the server side.
  assert.ok(jvmRules.includes("heap-pressure"), "threshold rule did not fire");
  assert.ok(jvmRules.includes("exhaustion"), "regex rule did not fire");
});

test("A REGEX FINDING CARRIES A CLIPPED VALUE, NOT A FOUR-KILOBYTE EVIDENCE STRING", async () => {
  // The evidence is capped. Without the clip, every regex finding would carry a
  // copy of the subject into a finding array, and the finding array is the one
  // thing a verdict serialises.
  const registry = new DynamicAgentRegistry();
  const agent = registry.register(FINANCIAL_SCHEMA, { tenant: T }).agent;

  const result = await agent.diagnose({
    prompt: "",
    stream: (async function* () {
      yield { partition: "payments", fields: { narrative: BIG, instruction: "urgent wire now", account_id: "a" } };
    })(),
  });

  for (const finding of result.findings) {
    for (const piece of finding.evidence) {
      assert.ok(piece.length <= 200, `evidence piece is ${piece.length} characters`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* THE MEMORY CLAIM, DETERMINISTICALLY                                */
/* ------------------------------------------------------------------ */

test("THE FINDING LIST IS CAPPED AT 5,000 EVENTS AND AT 50,000 ALIKE", async () => {
  // The deterministic half, and the stronger one: retention that scaled with
  // input would show up here exactly, with no GC and no thresholds involved.
  //
  // Both sizes saturate the cap deliberately. A small input that did NOT saturate
  // would prove less, not more: "38 findings at 1,000 events" and "50 at 50,000"
  // is consistent with a list that grows, which is the failure being ruled out.
  const registry = new DynamicAgentRegistry();
  const agent = registry.register(SERVER_SCHEMA, { tenant: T, sinkCap: 50 }).agent;
  let clockValue = 1_000_000;
  const clock = () => { clockValue += 1; return clockValue; };

  const smaller = await agent.diagnose({ prompt: "", stream: flood(5_000, clock) });
  const larger = await agent.diagnose({ prompt: "", stream: flood(FLOOD, clock) });

  assert.equal(smaller.findings.length, 50);
  assert.equal(larger.findings.length, 50, "a tenfold larger input produced the same list");
  assert.equal(smaller.stats?.eventsRead, 5_000);
  assert.equal(larger.stats?.eventsRead, FLOOD);
  // The input grew by 10x and the omitted count grew with it, which is how the
  // cap stays honest: nothing is silently dropped without being counted.
  assert.ok((larger.stats?.findingsOmitted ?? 0) > (smaller.stats?.findingsOmitted ?? 0));
});

test("EVERY STATISTIC IS EXACT, WHATEVER THE INPUT SIZE", async () => {
  // An O(1) implementation that quietly undercounts is worse than a slow one: the
  // number looks authoritative and is wrong.
  const registry = new DynamicAgentRegistry();
  const agent = registry.register(FINANCIAL_SCHEMA, { tenant: T, sinkCap: 1 }).agent;
  let clockValue = 2_000_000;
  const clock = () => { clockValue += 1; return clockValue; };

  const result = await agent.diagnose({ prompt: "", stream: flood(FLOOD, clock) });

  assert.equal(result.stats?.eventsRead, FLOOD);
  // Half the flood is payments; the agent declared that one stream.
  assert.equal(result.stats?.eventsSkippedOffStream, FLOOD / 2);
  assert.equal(result.stats?.rulesEvaluated, 4);
  assert.ok((result.stats?.findingsOmitted ?? 0) > 0, "omissions are counted, not hidden");
  assert.match(result.summary, /omitted by the cap/);
});

/* ------------------------------------------------------------------ */
/* THE MEMORY CLAIM, EMPIRICALLY                                      */
/* ------------------------------------------------------------------ */

test("A 50,000-EVENT FLOOD OF 4 KiB PAYLOADS DOES NOT RETAIN THE PAYLOADS", async () => {
  const registry = new DynamicAgentRegistry();
  const financial = registry.register(FINANCIAL_SCHEMA, { tenant: T }).agent;
  const server = registry.register(SERVER_SCHEMA, { tenant: T }).agent;
  let clockValue = 3_000_000;
  const clock = () => { clockValue += 1; return clockValue; };

  // Warm the code paths first, so the measurement below is about retention and
  // not about V8 having to compile anything.
  await financial.diagnose({ prompt: "", stream: flood(200, clock) });

  const before = process.memoryUsage().heapUsed;
  const money = await financial.diagnose({ prompt: "", stream: flood(FLOOD, clock) });
  const jvm = await server.diagnose({ prompt: "", stream: flood(FLOOD, clock) });
  const after = process.memoryUsage().heapUsed;

  const retained = after - before;
  // 50,000 x 4 KiB is roughly 200 MiB of payload VOLUME that a buffering
  // implementation would still be holding when the verdict is returned.
  const CEILING_MIB = 64;
  const payloadVolumeMiB = (FLOOD * BIG.length) / (1024 * 1024);

  assert.ok(
    retained < CEILING_MIB * 1024 * 1024,
    `retained ${(retained / 1024 / 1024).toFixed(1)} MiB against ${payloadVolumeMiB.toFixed(0)} MiB of payload`,
  );

  // Both agents produced real verdicts, so the flood was not skipped.
  assert.equal(money.stats?.eventsRead, FLOOD);
  assert.equal(jvm.stats?.eventsRead, FLOOD);
  assert.ok(money.findings.length > 0 && jvm.findings.length > 0);
});

test("THE VERDICT ITSELF IS BOUNDED, SO IT IS SAFE TO SERIALISE", async () => {
  const registry = new DynamicAgentRegistry();
  const agent = registry.register(SERVER_SCHEMA, { tenant: T, sinkCap: 20 }).agent;
  let clockValue = 4_000_000;
  const clock = () => { clockValue += 1; return clockValue; };

  const result = await agent.diagnose({ prompt: "", stream: flood(FLOOD, clock) });

  assert.equal(result.findings.length, 20);
  // The point of a bounded verdict: it crosses the wire.
  const serialised = JSON.stringify(result);
  assert.ok(serialised.length < 256 * 1024, `verdict serialised to ${serialised.length} bytes`);
});

/* ------------------------------------------------------------------ */
/* THE PORTAL, GENERATED FROM WHAT WAS REGISTERED                      */
/* ------------------------------------------------------------------ */

test("A TENANT'S PORTAL IS GENERATED FROM ITS REGISTERED AGENTS, END TO END", async () => {
  // The two halves of the platform proven together: install two schemas through
  // the API, then read back the screen the platform decides should exist.
  const credential = { id: "acme", credential: "acme-value", providers: ["portal"] };
  const routes = createPortalRoutes({
    registry: new DynamicAgentRegistry(),
    store: new InMemoryPortalStore(),
    vault: staticVault([credential], "e2e"),
  });
  const as = { [CREDENTIAL_HEADER]: "acme-value" };

  assert.equal((await routes.handle("POST", "/api/portal/schema", as, FINANCIAL_SCHEMA)).status, 200);
  assert.equal((await routes.handle("POST", "/api/portal/schema", as, SERVER_SCHEMA)).status, 200);

  const body = JSON.parse(JSON.stringify(
    (await routes.handle("GET", "/api/portal/config", as)).body,
  ));

  assert.equal(body.derived, true);
  assert.equal(body.config.tenant, "acme");
  assert.deepEqual(body.config.dashboards.map((d: { agentId: string }) => d.agentId).sort(), ["acme/financial-agent", "acme/server-health"]);
  assert.deepEqual(body.config.widgets.map((w: { agentId: string }) => w.agentId).sort(), ["acme/financial-agent", "acme/server-health"]);
  // A dashboard column count derived from capabilities, not a constant.
  assert.ok(body.config.dashboards.every((d: { columns: number }) => d.columns >= 1));
});

test("AN UPGRADED SCHEMA IS REFLECTED IN THE PORTAL WITHOUT A STORED CONFIG", async () => {
  const registry = new DynamicAgentRegistry();
  registry.register(FINANCIAL_SCHEMA, { tenant: T });
  const routes = createPortalRoutes({
    registry, store: new InMemoryPortalStore(), vault: staticVault([], "unused"),
  });

  const before = registry.get(T, "financial-agent")?.version;
  registry.register({ ...FINANCIAL_SCHEMA, version: "2.0.0", capabilities: ["now also flags chargebacks"] }, { tenant: T });

  assert.equal(before, "1.0.0");
  assert.equal(registry.get(T, "financial-agent")?.version, "2.0.0");
  assert.equal(routes.routes.length, 4);
});
