import test from "node:test";
import assert from "node:assert/strict";

import {
  DynamicAgent,
  DynamicAgentRegistry,
  SCHEMA_LIMITS,
  SchemaRejected,
  validateSchema,
} from "./dynamic-registry.ts";
import type { AgentSchema } from "./dynamic-registry.ts";
import type { TelemetryEvent } from "./diagnostic-agent.ts";
import {
  FindingSink,
  RateWindow,
  BoundedCounter,
  BoundedMap,
  streamLines,
  readLines,
} from "./agents/stream-harness.ts";
import { parseSarifLine, severityFromRiskCode, ZapXmlScanner } from "./agents/sast-dast-parsers.ts";

/** The owning tenant for the registry in these tests. There is no default bucket. */
const T = "acme";

/**
 * THE FACTORY, AND THE SUBSTRATE UNDER IT.
 *
 * The properties worth pinning are the ones a customer can feel: a schema that
 * cannot fire is worse than no schema, a regex that can wedge the process is worse
 * than no platform, and a finding list that silently truncates is worse than
 * either.
 */

/** A schema generator, so each test states only what it is actually about. */
function schema(over: Partial<AgentSchema> = {}): unknown {
  return {
    id: "orders",
    title: "Order anomaly detector",
    domain: "anomaly",
    version: "1.0.0",
    capabilities: ["flags unusual order values"],
    streams: [],
    rules: [
      { id: "big-amount", kind: "threshold", severity: "warning", message: "order amount is high", field: "amount", operator: ">", value: 1000 },
    ],
    ...over,
  };
}

async function* stream(events: readonly TelemetryEvent[]): AsyncGenerator<TelemetryEvent> {
  for (const event of events) yield event;
}

const at = (fields: Record<string, string>): TelemetryEvent => ({ fields, partition: "orders" });

/* ------------------------------------------------------------------ */
/* VALIDATION                                                          */
/* ------------------------------------------------------------------ */

test("A VALID SCHEMA VALIDATES, AND A ROUND TRIP LOSES NOTHING", () => {
  const result = validateSchema(schema());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.schema.id, "orders");
  assert.equal(result.schema.rules.length, 1);
  assert.equal(result.schema.rules[0]?.operator, ">");
});

test("A DOCUMENT THAT IS NOT AN OBJECT IS REFUSED", () => {
  for (const bad of [null, 42, "orders", [], undefined]) {
    const result = validateSchema(bad);
    assert.equal(result.ok, false);
  }
});

test("AN UNRECOGNISED FIELD IS A MISSPELLING, AND IS REFUSED RATHER THAN IGNORED", () => {
  // A schema author who writes "treshold" must be told. Left alone, the rule never
  // fires and the agent reports a clean pipeline for ever.
  const result = validateSchema(schema({
    rules: [{ id: "r", kind: "threshold", severity: "warning", message: "m", field: "a", operator: ">", value: 1, treshold: 5 } as never],
  }));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((issue) => issue.path.includes("treshold")));
});

test("EVERY REFUSAL NAMES A PATH, SO AN AUTHOR CAN FIND IT", () => {
  const result = validateSchema({ id: "", title: 1, domain: "made-up", version: "", capabilities: "no", rules: [] });

  assert.equal(result.ok, false);
  if (result.ok) return;
  for (const issue of result.issues) assert.ok(issue.path.startsWith("$"), `unpathed issue: ${issue.reason}`);
});

test("A SCHEMA WITH NO RULES IS REFUSED, RATHER THAN ACCEPTED AS A DETECTOR THAT IS ALWAYS CLEAN", () => {
  const result = validateSchema(schema({ rules: [] }));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((issue) => issue.reason.includes("at least one rule")));
});

test("DUPLICATE RULE IDS WITHIN A SCHEMA ARE REFUSED", () => {
  // Two rules with one id cannot both be reported, cannot both be silenced, and
  // cannot be linked to from a portal.
  const result = validateSchema(schema({
    rules: [
      { id: "dup", kind: "missing-field", severity: "info", message: "a", field: "x" },
      { id: "dup", kind: "missing-field", severity: "info", message: "b", field: "y" },
    ],
  }));

  assert.equal(result.ok, false);
});

test("AN INVALID PATTERN IS A VALIDATION ISSUE, NOT A 500 ON THE FIRST EVENT", () => {
  // `([unclosed` would NOT do: JS tolerates unbalanced groups under Annex B, so it
  // compiles. An unterminated character class is genuinely uncompilable.
  const result = validateSchema(schema({
    rules: [{ id: "bad", kind: "regex", severity: "info", message: "m", pattern: "a[b" }],
  }));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((issue) => issue.reason.includes("will not compile")));
});

/* ------------------------------------------------------------------ */
/* THE REGEX PROBLEM, WHICH IS THE ONLY ONE NOT SOLVED                */
/* ------------------------------------------------------------------ */

test("A NESTED-QUANTIFIER PATTERN IS NOW ACCEPTED, BECAUSE IT CANNOT BACKTRACK", () => {
  // THE INVERSION OF D-040.2.2, and it is the point of the whole engine.
  //
  // These four patterns were refused by a heuristic, because the engine underneath
  // was V8's and V8 runs `(a+)+` in time exponential in the subject length. They
  // are now run by a Thompson NFA, which has no backtracking to be slow with, so
  // the reason for the refusal no longer exists and the refusal goes with it.
  //
  // Keeping a control whose justification has evaporated would be worse than the
  // bug it prevents: it forbids customers patterns they are entitled to write, and
  // the next engineer to read it believes the platform is more fragile than it is.
  for (const pattern of ["(a+)+", "(a*)*", "([a-z]+)+", "(x{1,3})?y"]) {
    const result = validateSchema(schema({
      rules: [{ id: "nested", kind: "regex", severity: "info", message: "m", pattern }],
    }));
    assert.equal(result.ok, true, `still refusing a pattern that is now safe: ${pattern}`);
  }
});

test("A NESTED-QUANTIFIER RULE FIRES CORRECTLY, WHICH IS WHAT MAKING IT SAFE WORTHWHILE", () => {
  const registry = new DynamicAgentRegistry();
  const { agent } = registry.register(schema({
    rules: [{ id: "nested", kind: "regex", severity: "warning", message: "run of letters", pattern: "(a+)+b" }],
  }), { tenant: T });

  return agent.diagnose({
    prompt: "",
    stream: (async function* () {
      yield { partition: "orders", fields: { note: "aaaab" } };
      yield { partition: "orders", fields: { note: "aaaa" } };
    })(),
  }).then((result) => {
    assert.equal(result.findings.length, 1, "and it still discriminates");
  });
});

test("AN ORDINARY PATTERN IS ACCEPTED", () => {
  const result = validateSchema(schema({
    rules: [{ id: "ok", kind: "regex", severity: "warning", message: "m", pattern: "^(slow|timeout) [0-9]+$" }],
  }));

  assert.equal(result.ok, true);
});

test("AN OVER-LONG PATTERN IS REFUSED, WHICH IS A COST BOUND AND NOT A SAFETY ONE", () => {
  // A long LITERAL, not a long repetition: `a{522,}` is eight characters long
  // however big the number inside it is.
  //
  // This ceiling survives the engine change on purpose, and the distinction is
  // worth keeping in the test name. It is not there because a long pattern is
  // DANGEROUS -- nothing is, any more -- it is there because a long pattern is
  // EXPENSIVE, and a customer-facing API needs a bound on what one request can
  // cost the platform. That is a quota, not a guard rail, and quoting the two as
  // the same thing is how a control ends up justified by a reason that has gone.
  const result = validateSchema(schema({
    rules: [{ id: "long", kind: "regex", severity: "info", message: "m", pattern: "a".repeat(SCHEMA_LIMITS.maxPatternLength + 10) }],
  }));

  assert.equal(result.ok, false);
});

test("A `g` FLAG IS REFUSED, BECAUSE A STATEFUL MATCH DEPENDS ON CALL ORDER", () => {
  // With `g`, `RegExp.test` remembers lastIndex, so a pattern would find every
  // second event differently depending on what preceded it.
  const result = validateSchema(schema({
    rules: [{ id: "g", kind: "regex", severity: "info", message: "m", pattern: "a", flags: "g" }],
  }));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.issues.some((issue) => issue.reason.includes("not permitted")));
});

/* ------------------------------------------------------------------ */
/* EVALUATION                                                          */
/* ------------------------------------------------------------------ */

test("A THRESHOLD RULE FIRES, AND ITS EVIDENCE CARRIES THE OBSERVED VALUE", async () => {
  const registry = new DynamicAgentRegistry();
  const { agent } = registry.register(schema(), { tenant: T });

  const result = await agent.diagnose({ prompt: "", stream: stream([at({ amount: "5000" }), at({ amount: "10" })]) });

  assert.equal(result.status, "ok");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.severity, "warning");
  assert.ok(result.findings[0]?.evidence.includes("observed:5000"));
  assert.equal(result.stats?.eventsRead, 2);
});

test("A NON-NUMERIC VALUE IS SKIPPED, NOT JUDGED AS ZERO", async () => {
  // NaN compared as zero against `> 1000` is false, which is the right answer by
  // luck; compared as zero against `< 10` it manufactures a finding out of an
  // absent value.
  const registry = new DynamicAgentRegistry();
  const { agent } = registry.register(schema({
    rules: [{ id: "low", kind: "threshold", severity: "critical", message: "m", field: "amount", operator: "<", value: 10 }],
  }), { tenant: T });

  const result = await agent.diagnose({ prompt: "", stream: stream([at({ amount: "not-a-number" })]) });

  assert.equal(result.findings.length, 0);
  assert.equal(result.stats?.unevaluableEvents, 1, "and the skip is counted rather than hidden");
});

test("A REGEX RULE SCANS EVERY FIELD, SO A SCHEMA NEEDS NO KNOWLEDGE OF THE STREAM", async () => {
  const registry = new DynamicAgentRegistry();
  const { agent } = registry.register(schema({
    rules: [{ id: "probe", kind: "regex", severity: "warning", message: "internal host in a public field", pattern: "10\\.0\\.0\\.\\d+" }],
  }), { tenant: T });

  const result = await agent.diagnose({ prompt: "", stream: stream([at({ note: "routed via 10.0.0.7" })]) });

  assert.equal(result.findings.length, 1);
  assert.ok(result.findings[0]?.title.startsWith("probe:"));
});

test("A MISSING-FIELD RULE FIRES ON ABSENCE, WHICH IS ITS WHOLE PURPOSE", async () => {
  const registry = new DynamicAgentRegistry();
  const { agent } = registry.register(schema({
    rules: [{ id: "need-trace", kind: "missing-field", severity: "warning", message: "no trace id", field: "trace_id" }],
  }), { tenant: T });

  const result = await agent.diagnose({ prompt: "", stream: stream([at({ amount: "1" }), at({ amount: "2", trace_id: "t" })]) });

  assert.equal(result.findings.length, 1);
  // `evidence` is an array, so `includes` would be an exact-element test; the
  // field name appears as part of a `field:<name>` element.
  assert.ok(result.findings[0]?.evidence.some((e) => e.includes("trace_id")));
});

test("A SCHEMA THAT DECLARED ITS STREAMS IGNORES EVERYTHING ELSE, AND SAYS HOW MUCH", async () => {
  // An agent firing on telemetry it was never written for is a false positive
  // generator, and silently evaluating the wrong stream is worse than not
  // evaluating at all.
  const registry = new DynamicAgentRegistry();
  const { agent } = registry.register(schema({ streams: ["orders"] }), { tenant: T });

  const result = await agent.diagnose({
    prompt: "",
    stream: stream([
      at({ amount: "99999" }),
      { fields: { amount: "99999" }, partition: "telemetry" },
      { fields: { amount: "99999" } },
    ]),
  });

  assert.equal(result.findings.length, 1, "only the declared stream fires");
  assert.equal(result.stats?.eventsSkippedOffStream, 2);
});

test("A RATE RULE FIRES ON THE WINDOW, NOT ON ANY SINGLE EVENT", async () => {
  // A rate is a property of a window and is not knowable while the window fills,
  // which is why it is evaluated after the stream rather than during it.
  let now = 1_000_000;
  const registry = new DynamicAgentRegistry();
  const { agent } = registry.register(schema({
    rules: [{ id: "burst", kind: "rate", severity: "critical", message: "burst", field: "amount", windowMs: 10_000, rateAbove: 3 }],
  }), { tenant: T, clock: () => now });

  const events = Array.from({ length: 5 }, () => at({ amount: "1", at: String(now) }));
  now += 1;
  const result = await agent.diagnose({ prompt: "", stream: stream(events) });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]?.severity, "critical");
  assert.ok(result.findings[0]?.evidence.some((e) => e.startsWith("resolution_ms:")));
});

test("A RATE UNDER ITS THRESHOLD FIRES NOTHING", () => {
  const window = new RateWindow(10_000);
  window.hit(0);
  window.hit(1_000);
  assert.equal(window.count(1_100) <= 3, true);
});

test("THE RATE WINDOW IS A FIXED RING, AND PUBLISHES ITS RESOLUTION", () => {
  const window = new RateWindow(60_000, 1_000);
  for (let i = 0; i < 1000; i += 1) window.hit(i * 10);

  // Memory is the ring, not the traffic: a thousand hits and ten cost the same.
  assert.equal(window.resolutionMs, 60_000);
  assert.equal(window.seen, 1000, "and the exact count is still available");
});

test("A RATE WINDOW FORGETS ONCE A FULL WINDOW HAS PASSED", () => {
  const window = new RateWindow(1_000, 1_000);
  window.hit(0);
  assert.equal(window.count(0), 1);
  // Far past the window: the answer is zero, not the stale bucket.
  assert.equal(window.count(500_000), 0);
});

/* ------------------------------------------------------------------ */
/* THE BOUNDED FINDING LIST                                            */
/* ------------------------------------------------------------------ */

test("THE FINDING LIST IS CAPPED, AND THE OMISSION IS COUNTED AND PUBLISHED", async () => {
  const registry = new DynamicAgentRegistry();
  const { agent } = registry.register(schema(), { tenant: T, sinkCap: 5 });

  const events = Array.from({ length: 50 }, () => at({ amount: "99999" }));
  const result = await agent.diagnose({ prompt: "", stream: stream(events) });

  assert.equal(result.findings.length, 5, "the array is a hard bound");
  assert.equal(result.stats?.findingsOmitted, 45);
  assert.match(result.summary, /omitted by the cap/);
});

test("A CRITICAL FINDING IS NEVER DISPLACED BY INFO NOISE", async () => {
  const sink = new FindingSink(2);
  sink.offer({ severity: "critical", title: "a", detail: "", evidence: [] });
  sink.offer({ severity: "info", title: "b", detail: "", evidence: [] });
  sink.offer({ severity: "info", title: "c", detail: "", evidence: [] });

  // The critical survives. The third info does not displace the second: on a tie
  // the EARLIER finding is kept, so a reader gets the first thing that happened
  // rather than an arbitrary later one.
  assert.deepEqual(sink.findings.map((f) => f.title), ["a", "b"]);
  assert.equal(sink.omitted, 1);
});

test("A CRITICAL FINDING DISPLACES A RETAINED INFO ONE", async () => {
  const sink = new FindingSink(2);
  sink.offer({ severity: "info", title: "noise", detail: "", evidence: [] });
  sink.offer({ severity: "info", title: "noise2", detail: "", evidence: [] });
  sink.offer({ severity: "critical", title: "real", detail: "", evidence: [] });

  assert.ok(sink.findings.some((f) => f.title === "real"));
  assert.equal(sink.findings.length, 2);
});

/* ------------------------------------------------------------------ */
/* THE REGISTRY SERVICE                                                */
/* ------------------------------------------------------------------ */

test("AN INVALID SCHEMA IS REFUSED WITH ITS ISSUES, NOT A STRING", async () => {
  const registry = new DynamicAgentRegistry();

  assert.throws(() => registry.register({ id: "x" }, { tenant: T }), (error: unknown) => {
    assert.ok(error instanceof SchemaRejected);
    assert.ok(error.issues.length > 0);
    return true;
  });
  assert.equal(registry.size, 0);
  assert.equal(registry.stats().rejections, 1);
});

test("A SCHEMA IS STORED AND RETRIEVABLE BY ID, IN BOTH FORMS", () => {
  const registry = new DynamicAgentRegistry();
  const { agent } = registry.register(schema(), { tenant: T });

  assert.equal(registry.get(T, "orders")?.id, "acme/orders", "the id is COMPOSITE: tenant/schemaId");
  assert.equal(registry.schemaOf(T, "orders")?.title, "Order anomaly detector");
  assert.deepEqual(registry.ids(T), ["acme/orders"]);
  assert.deepEqual(registry.ids(), ["acme/orders"]);
  assert.equal(registry.describeAll()[0]?.maturity, "ready");
});

test("RE-REGISTERING AN IDENTICAL SCHEMA IS A NO-OP, SO A RETRY BURNS NO CPU", () => {
  const registry = new DynamicAgentRegistry();
  const first = registry.register(schema(), { tenant: T }).agent;
  const second = registry.register(schema(), { tenant: T });

  assert.equal(second.agent, first, "the same compiled agent is returned");
  assert.equal(second.replaced, undefined);
  assert.equal(registry.size, 1);
});

test("A NEW VERSION REPLACES, AND RETURNS WHAT IT REPLACED", () => {
  // A portal may be rendered against one version while another is deployed, so the
  // previous agent must be recoverable rather than merely overwritten.
  const registry = new DynamicAgentRegistry();
  const first = registry.register(schema(), { tenant: T }).agent;
  const second = registry.register(schema({ version: "2.0.0" }), { tenant: T });

  assert.equal(second.replaced, first);
  assert.equal(registry.get(T, "orders")?.version, "2.0.0");
  assert.equal(registry.size, 1);
});

test("THE REGISTRY IS BOUNDED, BECAUSE A FACTORY THAT ACCEPTS UNLIMITED TENANTS IS A LEAK", () => {
  const registry = new DynamicAgentRegistry(2);
  registry.register(schema({ id: "a" }), { tenant: T });
  registry.register(schema({ id: "b" }), { tenant: T });

  assert.throws(() => registry.register(schema({ id: "c" }), { tenant: T }), /would be one more/);
  assert.equal(registry.size, 2);
});

test("A REMOVED SCHEMA IS GONE FROM BOTH STORES", () => {
  const registry = new DynamicAgentRegistry();
  registry.register(schema(), { tenant: T });

  assert.equal(registry.remove(T, "orders"), true);
  assert.equal(registry.get(T, "orders"), undefined);
  assert.equal(registry.schemaOf(T, "orders"), undefined);
  assert.equal(registry.remove(T, "orders"), false);
});

test("A GENERATED AGENT IS AN ORDINARY DiagnosticAgent, WITH NO SPECIAL CASE ANYWHERE", async () => {
  // The premise of the whole pivot: a customer-authored agent routes, registers and
  // publishes through exactly the same interfaces as a hand-written one.
  const registry = new DynamicAgentRegistry();
  const { agent } = registry.register(schema(), { tenant: T });

  assert.equal(agent.maturity, "ready");
  assert.equal(agent.domain, "anomaly");
  assert.deepEqual(agent.describe(), registry.describeAll()[0]);
  assert.equal(typeof agent.diagnose, "function");
});

test("SELECTION USES THE SCHEMA'S OWN VOCABULARY, AND AN EMPTY SCOPE MATCHES NOTHING", () => {
  const registry = new DynamicAgentRegistry();
  const { agent } = registry.register(schema({
    title: "Server Health Agent",
    capabilities: ["watches heap and GC pauses"],
    streams: ["jvm-metrics"],
  }), { tenant: T });

  assert.equal(agent.handles("is the server health agent unhappy?"), true);
  assert.equal(agent.handles("check jvm-metrics please"), true);
  assert.equal(agent.handles(""), false);
  assert.equal(agent.handles("something unrelated entirely"), false);
});

test("A CONSTRUCTED AGENT REFUSES AN INVALID SCHEMA RATHER THAN NEVER FIRING", () => {
  // Bypassing the registry must not produce a silently inert detector.
  assert.throws(
    () => new DynamicAgent({ id: "x", title: "t", domain: "anomaly", version: "1", capabilities: [], streams: [], rules: [] }),
    /invalid schema/,
  );
});

test("AN AGENT WITH NO STREAM ANSWERS WITH ZERO EVENTS RATHER THAN A REFUSAL", async () => {
  const registry = new DynamicAgentRegistry();
  const { agent } = registry.register(schema(), { tenant: T });

  const result = await agent.diagnose({ prompt: "" });

  assert.equal(result.status, "ok");
  assert.equal(result.stats?.eventsRead, 0);
  assert.match(result.summary, /none of its 1 rule fired/);
});

/* ------------------------------------------------------------------ */
/* THE SUBSTRATE                                                       */
/* ------------------------------------------------------------------ */

test("A LINE SPLIT ACROSS CHUNKS IS DELIVERED ONCE, NOT TWICE AND NOT NEVER", async () => {
  const seen: string[] = [];
  await streamLines(["alpha\nbe", "ta\ngam", "ma"], (line) => { seen.push(line); });

  assert.deepEqual(seen, ["alpha", "beta", "gamma"]);
});

test("A CRLF SPLIT ACROSS TWO CHUNKS DOES NOT LEAVE A CARRIAGE RETURN", async () => {
  const seen: string[] = [];
  await streamLines(["alpha\r", "\nbeta"], (line) => { seen.push(line); });

  assert.deepEqual(seen, ["alpha", "beta"]);
});

test("A TRAILING LINE WITH NO NEWLINE IS DELIVERED, AND REPORTED AS TRAILING", async () => {
  const seen: string[] = [];
  const counts = await streamLines(["alpha\nbeta"], (line) => { seen.push(line); });

  assert.deepEqual(seen, ["alpha", "beta"]);
  assert.equal(counts.trailing, true);
});

test("AN OVER-LONG LINE IS DROPPED AND COUNTED, WHICH IS WHAT MAKES THE CLASS O(1)", async () => {
  // Without the ceiling this class is O(longest line), and a single record with no
  // newline grows the heap until the container dies.
  const seen: string[] = [];
  let dropped = 0;
  const counts = await streamLines(
    [`${"x".repeat(500)}\n`, `${"y".repeat(500)}`],
    (line) => { seen.push(line); },
    { maxLineBytes: 100, onOverflow: () => { dropped += 1; } },
  );

  assert.deepEqual(seen, ["x".repeat(500)]);
  assert.equal(counts.overflows, 1);
  assert.equal(dropped, 1);
});

test("A MULTI-BYTE CHARACTER SPLIT ACROSS CHUNKS IS NOT CORRUPTED", async () => {
  const encoded = new TextEncoder().encode("café\n");
  const seen: string[] = [];
  await streamLines(
    [encoded.slice(0, 4), encoded.slice(4)],
    (line) => { seen.push(line); },
  );

  assert.deepEqual(seen, ["café"]);
});

test("readLines REFUSES TO BE USED AS A BUFFER FOR A STREAM", async () => {
  // The accumulate helper is named conspicuously and guarded, because a platform
  // whose O(1) claim rests on not accumulating should not ship one that reads
  // like a normal utility.
  async function* many() {
    for (let i = 0; i < 10; i += 1) yield `line ${i}\n`;
  }

  await assert.rejects(() => readLines(many(), 5), /Consume the stream with streamLines/);
});

test("A BOUNDED MAP EVICTS, COUNTS, AND SAYS IT SATURATED", () => {
  const map = new BoundedMap<string, number>(2);
  map.set("a", 1);
  map.set("b", 2);
  map.set("c", 3);

  assert.equal(map.size, 2);
  assert.equal(map.get("a"), undefined, "the oldest was evicted");
  assert.equal(map.get("c"), 3);
  assert.equal(map.evicted, 1);
  assert.equal(map.saturated, true);
});

test("A BOUNDED COUNTER'S TOTAL IS EXACT EVEN AFTER ITS KEYS WERE EVICTED", () => {
  // Summing surviving keys would under-report, and an agent publishing a finding
  // count it cannot stand behind is worse than one publishing a smaller number.
  const counter = new BoundedCounter(2);
  for (const key of ["a", "b", "c", "d"]) counter.bump(key);

  assert.equal(counter.total, 4);
  assert.equal(counter.tracked, 2);
  assert.equal(counter.evicted, 2);
});

test("A THROWING VISITOR PROPAGATES, BECAUSE A SILENTLY SKIPPED LINE IS A LOST FINDING", async () => {
  await assert.rejects(
    () => streamLines(["a\n"], () => { throw new Error("handler failed"); }),
    /handler failed/,
  );
});

/* ------------------------------------------------------------------ */
/* THE FORMAT PARSERS COMMITTED ALONGSIDE                              */
/* ------------------------------------------------------------------ */

test("A SARIF RESULT LINE PARSES, AND A LOG LINE DOES NOT", () => {
  const good = parseSarifLine('{"ruleId":"SQ-001","level":"error","message":{"text":"injection"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"a.js"},"region":{"startLine":12}}}]}');
  const bad = parseSarifLine("[INFO] build step 3 of 9");

  assert.equal(good?.rule, "SQ-001");
  assert.equal(good?.severity, "critical");
  assert.equal(good?.location, "a.js:12");
  assert.equal(bad, undefined, "a progress bar must not kill the scan");
});

test("SARIF LEVELS AND ZAP RISKCODES MAP ONTO ONE SEVERITY LADDER", () => {
  assert.equal(severityFromRiskCode(3), "critical");
  assert.equal(severityFromRiskCode(2), "warning");
  assert.equal(severityFromRiskCode(undefined), undefined);
});

test("THE ZAP SCANNER EMITS AN ALERT AT ITS CLOSING TAG, NOT AT THE END OF THE DOCUMENT", () => {
  const scanner = new ZapXmlScanner();
  const lines = [
    "<report><alerts>",
    "<alert><pluginid>10021</pluginid><alert>SQL Injection</alert><riskcode>3</riskcode><uri>http://x</uri></alert>",
    "<alert><pluginid>10035</pluginid><alert>XSS</alert><riskcode>2</riskcode></alert>",
    "</alerts></report>",
  ];

  const found = lines.map((line) => scanner.push(line)).filter((f) => f !== undefined);

  assert.equal(found.length, 2);
  assert.equal(found[0]?.rule, "zap:10021");
  assert.equal(found[0]?.severity, "critical");
  assert.equal(found[1]?.severity, "warning");
  assert.equal(scanner.flush(), undefined, "nothing left to flush");
});

/* ------------------------------------------------------------------ */
/* TENANCY                                                             */
/* ------------------------------------------------------------------ */

/**
 * Two customers, one id.
 *
 * This is the whole reason the registry takes a tenant on every method. Keyed on
 * the bare id, the second registration below would REPLACE the first, and
 * `acme`'s portal would quietly start rendering `globex`'s agent.
 */

test("TWO TENANTS MAY BOTH HOLD AN AGENT CALLED orders, AND BOTH SURVIVE", () => {
  const registry = new DynamicAgentRegistry();
  registry.register(schema({ id: "orders", title: "Acme orders" }), { tenant: "acme" });
  registry.register(schema({ id: "orders", title: "Globex orders" }), { tenant: "globex" });

  assert.equal(registry.size, 2);
  assert.equal(registry.get("acme", "orders")?.title, "Acme orders");
  assert.equal(registry.get("globex", "orders")?.title, "Globex orders");
});

test("THE COMPOSITE ID MAKES A CROSS-TENANT LOOKUP IMPOSSIBLE TO EXPRESS BY MISTAKE", () => {
  const registry = new DynamicAgentRegistry();
  registry.register(schema({ id: "orders" }), { tenant: "acme" });

  // The bare id no longer resolves to anything, so a call site that forgot the
  // tenant gets `undefined` rather than somebody else's agent.
  assert.equal(registry.getByCompositeId("orders"), undefined);
  assert.equal(registry.getByCompositeId("acme/orders")?.id, "acme/orders");
});

test("A LISTING IS SCOPED TO ONE TENANT", () => {
  const registry = new DynamicAgentRegistry();
  registry.register(schema({ id: "orders" }), { tenant: "acme" });
  registry.register(schema({ id: "ledger" }), { tenant: "acme" });
  registry.register(schema({ id: "orders" }), { tenant: "globex" });

  assert.deepEqual(registry.ids("acme").sort(), ["acme/ledger", "acme/orders"]);
  assert.deepEqual(registry.ids("globex"), ["globex/orders"]);
  assert.deepEqual(registry.describeFor("acme").map((d) => d.id).sort(), ["acme/ledger", "acme/orders"]);
  assert.deepEqual(registry.schemasFor("globex").map((s) => s.id), ["orders"]);
  assert.deepEqual(registry.tenants().sort(), ["acme", "globex"]);
});

test("DELETING ONE TENANT'S AGENT LEAVES THE OTHER TENANT'S IDENTICALLY NAMED ONE", () => {
  const registry = new DynamicAgentRegistry();
  registry.register(schema({ id: "orders" }), { tenant: "acme" });
  registry.register(schema({ id: "orders" }), { tenant: "globex" });

  assert.equal(registry.remove("acme", "orders"), true);

  assert.equal(registry.get("acme", "orders"), undefined);
  assert.equal(registry.get("globex", "orders")?.id, "globex/orders", "the wrong tenant's agent survived");
});

test("AN UPGRADE IN ONE TENANT DOES NOT UPGRADE THE OTHER'S", () => {
  const registry = new DynamicAgentRegistry();
  registry.register(schema({ id: "orders", version: "1.0.0" }), { tenant: "acme" });
  registry.register(schema({ id: "orders", version: "1.0.0" }), { tenant: "globex" });

  const replaced = registry.register(schema({ id: "orders", version: "2.0.0" }), { tenant: "acme" });

  assert.equal(replaced.replaced?.version, "1.0.0");
  assert.equal(registry.get("acme", "orders")?.version, "2.0.0");
  assert.equal(registry.get("globex", "orders")?.version, "1.0.0");
});

test("AN AGENT WITHOUT A TENANT IS REFUSED, BECAUSE A DEFAULT IS A SHARED BUCKET", () => {
  assert.throws(
    () => new DynamicAgent({
      id: "x", title: "t", domain: "anomaly", version: "1", capabilities: [], streams: [],
      rules: [{ id: "r", kind: "missing-field", severity: "info", message: "m", field: "f" }],
    }, { tenant: "" }),
    /no default/,
  );
});

test("A REGISTRATION WITH A BLANK TENANT IS REFUSED WITH AN ISSUE, NOT A DEFAULT", () => {
  const registry = new DynamicAgentRegistry();

  assert.throws(
    () => registry.register(schema({ id: "x" }), { tenant: "  " }),
    (error: unknown) => {
      assert.ok(error instanceof SchemaRejected);
      assert.ok(error.issues.some((issue) => issue.path === "$.tenant"));
      return true;
    },
  );
  assert.equal(registry.size, 0);
});

test("THE VERDICT SAYS WHOSE FINDINGS THESE ARE", async () => {
  // A summary of "orders@1.0.0" in a shared log tells a reader nothing about whose
  // data it describes.
  const registry = new DynamicAgentRegistry();
  const { agent } = registry.register(schema({ id: "orders" }), { tenant: "acme" });

  const result = await agent.diagnose({
    prompt: "",
    stream: (async function* () { yield { partition: "orders", fields: { amount: "5000" } }; })(),
  });

  assert.match(result.summary, /agent acme\/orders@1\.0\.0/);
  assert.equal(result.agentId, "acme/orders");
});
