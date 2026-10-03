import test from "node:test";
import assert from "node:assert/strict";

import { AgentRegistry, fromSubagent } from "./agent-registry.ts";
import { descriptorOf, type DiagnosticAgent, type DiagnosticResult } from "./diagnostic-agent.ts";
import { SPECIALIST_TEMPLATES, complianceAgent, devsecOpsAgent, performanceAgent } from "./templates.ts";

/**
 * THE REGISTRY. Rules, not conveniences.
 *
 * The properties pinned here are the ones a list of agents would not have: unique
 * ids, meaningful precedence, a decline that is survivable, and -- the one that
 * matters most -- a stub that cannot be mistaken for a working capability.
 */

/** A working agent, so routing is tested against something that answers. */
function working(over: Partial<DiagnosticAgent> = {}): DiagnosticAgent {
  const agent: DiagnosticAgent = {
    id: "working",
    title: "Working agent",
    domain: "anomaly",
    maturity: "ready",
    version: "1.0.0",
    capabilities: ["answers everything"],
    handles: () => true,
    async diagnose(): Promise<DiagnosticResult> {
      return {
        agentId: "working",
        status: "ok",
        summary: "answered",
        findings: [{ severity: "info", title: "t", detail: "d", evidence: ["e"] }],
        at: "2025-03-01T00:00:00.000Z",
      };
    },
    describe: () => descriptorOf(agent),
    ...over,
  };
  return agent;
}

/** An agent that claims a scope and then declines it. */
function declining(id: string): DiagnosticAgent {
  return working({
    id,
    handles: () => true,
    async diagnose(): Promise<DiagnosticResult> {
      return { agentId: id, status: "declined", summary: "not mine after all", findings: [], at: "2025-03-01T00:00:00.000Z" };
    },
  });
}

/* ------------------------------------------------------------------ */
/* THE ROSTER                                                          */
/* ------------------------------------------------------------------ */

test("THE THREE SPECIALISTS ARE REGISTERED, AND EVERY ONE IS A STUB", () => {
  const registry = new AgentRegistry().registerAll(SPECIALIST_TEMPLATES);

  assert.equal(registry.size, 3);
  for (const descriptor of registry.describeAll()) {
    assert.equal(descriptor.maturity, "stub");
  }
  assert.deepEqual(
    registry.describeAll().map((d) => d.domain),
    ["supply-chain", "financial-compliance", "performance"],
  );
});

test("A DUPLICATE ID THROWS RATHER THAN SHADOWING", () => {
  // Silently keeping the first means a deployment that registered an override
  // got the original and no error; silently keeping the second means the
  // registration order no longer explains what runs.
  const registry = new AgentRegistry().register(working());
  assert.throws(() => registry.register(working()), /already registered/);
});

test("THE DESCRIPTOR CANNOT DRIFT FROM THE AGENT, because it IS derived", () => {
  const registry = new AgentRegistry().register(devsecOpsAgent);
  const listed = registry.get("devsecops");

  assert.deepEqual(registry.describeAll()[0], descriptorOf(listed!));
  assert.equal(listed!.title, "DevSecOps pipeline and supply chain");
});

/* ------------------------------------------------------------------ */
/* STUBS NEVER ANSWER                                                  */
/* ------------------------------------------------------------------ */

test("A STUB IS ASKED, REFUSES, AND PRODUCES NO FINDINGS", async () => {
  // The failure this prevents: a stub that answers "3 high-severity findings" so
  // the dashboard has something on it. That is a fabrication, and it gets quoted.
  const registry = new AgentRegistry().registerAll(SPECIALIST_TEMPLATES);
  const result = await registry.run("devsecops");

  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.findings, []);
  assert.match(result.summary, /No finding from this agent is a finding about the data/);
});

test("A STUB IS REFUSED BY DISPATCH UNLESS A CALLER EXPLICITLY OPTS IN", async () => {
  const guarded = new AgentRegistry().registerAll(SPECIALIST_TEMPLATES);
  const refused = await guarded.dispatch("audit my supply chain");

  assert.equal(refused.agent, null);
  assert.equal(refused.stubRefused, true);
  assert.match(refused.result!.summary, /stub/);

  // Opting in makes the stub SELECTABLE -- it still refuses, which is the point.
  const permitted = new AgentRegistry({ allowStubs: true }).registerAll(SPECIALIST_TEMPLATES);
  const reached = await permitted.dispatch("audit my supply chain");

  assert.equal(reached.agent?.id, "devsecops");
  assert.equal(reached.result!.status, "unavailable");
  assert.deepEqual(reached.result!.findings, []);
});

test("A STUB RECEIVED THE QUESTION, AND SAYS SO, RATHER THAN IGNORING IT", async () => {
  const registry = new AgentRegistry({ allowStubs: true }).registerAll(SPECIALIST_TEMPLATES);
  const result = await registry.run("compliance", { prompt: "check for structuring" });

  assert.match(result.summary, /check for structuring/);
});

test("A STUB WITH NO MATCH IS NOT CONSULTED AT ALL", async () => {
  const registry = new AgentRegistry({ allowStubs: true }).registerAll(SPECIALIST_TEMPLATES);
  const dispatch = await registry.dispatch("what is wrong with this file");

  assert.equal(dispatch.agent, null);
  assert.deepEqual(dispatch.consulted, []);
});

/* ------------------------------------------------------------------ */
/* SCOPE SELECTION                                                     */
/* ------------------------------------------------------------------ */

test("EACH SPECIALIST OWNS ITS OWN VOCABULARY AND NOT ITS NEIGHBOUR'S", () => {
  // Stubs must be SELECTABLE, or registering them achieves nothing. A stub whose
  // handles only matched its own name would never be reached.
  assert.equal(devsecOpsAgent.handles!("which dependencies are vulnerable?"), true);
  assert.equal(complianceAgent.handles!("is this transaction structuring?"), true);
  assert.equal(performanceAgent.handles!("find the p99 bottleneck"), true);

  assert.equal(devsecOpsAgent.handles!("is this transaction structuring?"), false);
  assert.equal(complianceAgent.handles!("find the p99 bottleneck"), false);
  assert.equal(performanceAgent.handles!("which dependencies are vulnerable?"), false);
});

test("AN EMPTY SCOPE MATCHES NOBODY", () => {
  for (const agent of SPECIALIST_TEMPLATES) {
    assert.equal(agent.handles!(""), false);
    assert.equal(agent.handles!("   "), false);
  }
});

test("FIRST MATCH WINS, IN REGISTRATION ORDER", async () => {
  const first = working({ id: "first" });
  const second = working({ id: "second" });
  const dispatch = await new AgentRegistry().register(first).register(second).dispatch("anything");

  assert.equal(dispatch.agent?.id, "first");
  assert.deepEqual(dispatch.consulted, ["first"]);
});

/* ------------------------------------------------------------------ */
/* DECLINE IS NOT A REFUSAL                                            */
/* ------------------------------------------------------------------ */

test("AN AGENT THAT CLAIMS A SCOPE AND THEN DECLINES YIELDS TO THE NEXT", async () => {
  // An agent owns a FAMILY of scopes and cannot do every member of it. The
  // decline has to be survivable or agents will over-claim instead.
  const registry = new AgentRegistry().registerAll([declining("picky"), working({ id: "generalist" })]);
  const dispatch = await registry.dispatch("anything");

  assert.equal(dispatch.agent?.id, "generalist");
  assert.deepEqual(dispatch.consulted, ["picky", "generalist"]);
});

test("AN AGENT THAT THROWS IS TREATED AS A DECLINE, NOT AS AN OUTAGE", async () => {
  const exploding = working({
    id: "exploding",
    async diagnose(): Promise<DiagnosticResult> { throw new Error("the graph is unreachable"); },
  });
  const registry = new AgentRegistry().registerAll([exploding, working({ id: "generalist" })]);

  const dispatch = await registry.dispatch("anything");

  assert.equal(dispatch.agent?.id, "generalist");
  assert.deepEqual(dispatch.consulted, ["exploding", "generalist"]);
});

test("AN AGENT WHOSE handles() THROWS IS SKIPPED, NOT ALLOWED TO TAKE THE PROCESS DOWN", async () => {
  const broken = working({ id: "broken", handles: () => { throw new Error("bad regex state"); } });
  const dispatch = await new AgentRegistry().registerAll([broken, working({ id: "generalist" })])
    .dispatch("anything");

  assert.equal(dispatch.agent?.id, "generalist");
});

/* ------------------------------------------------------------------ */
/* NOTHING ANSWERING IS AN ANSWER                                      */
/* ------------------------------------------------------------------ */

test("NO MATCH REPORTS WHO WAS CONSULTED, rather than an empty success", async () => {
  // A dashboard renders an empty success as "no problems found", which is a lie
  // when no check ever ran.
  const registry = new AgentRegistry().registerAll([working({ id: "narrow", handles: () => false })]);
  const dispatch = await registry.dispatch("anything");

  assert.equal(dispatch.agent, null);
  assert.equal(dispatch.result!.status, "declined");
  assert.match(dispatch.result!.summary, /no registered agent owned that scope/);
});

test("AN EMPTY REGISTRY SAYS IT IS EMPTY, DISTINGUISHED FROM A MISS", async () => {
  // "Nobody is registered" and "you asked the wrong question" are different
  // operational problems and get different fixes.
  const registry = new AgentRegistry();
  const dispatch = await registry.dispatch("anything");

  assert.equal(registry.size, 0);
  assert.equal(dispatch.result!.status, "declined");
  assert.match(dispatch.result!.summary, /no agents are registered/);
  assert.equal(dispatch.result!.summary.includes("owned that scope"), false);
});

test("RUNNING AN AGENT BY NAME IS NOT THE SAME AS BEING SELECTED", async () => {
  const registry = new AgentRegistry().registerAll(SPECIALIST_TEMPLATES);

  const missing = await registry.run("no-such-agent");
  assert.equal(missing.status, "unavailable");
  assert.match(missing.summary, /no agent with id/);

  // Named directly, so selection vocabulary is irrelevant -- and it still refuses.
  const named = await registry.run("performance");
  assert.equal(named.agentId, "performance");
  assert.equal(named.status, "unavailable");
});

/* ------------------------------------------------------------------ */
/* THE CONDUCTOR'S EXISTING AGENTS, WITHOUT TOUCHING THE CONDUCTOR      */
/* ------------------------------------------------------------------ */

test("THE CONDUCTOR'S AGENTS ADAPT WITHOUT ANY CONDUCTOR CODE CHANGING", async () => {
  const anomaly = {
    name: "anomaly",
    handles: (prompt: string) => prompt.includes("wrong"),
    answer: (_ctx: never, prompt: string) => ({ kind: "answer", text: `three columns are wrong: ${prompt}` }),
  };

  const registry = new AgentRegistry().register(fromSubagent(anomaly));
  const dispatch = await registry.dispatch("what is wrong here?", { context: {} as never });

  assert.equal(dispatch.agent?.id, "conductor:anomaly");
  assert.equal(dispatch.result!.status, "ok");
  assert.match(dispatch.result!.summary, /three columns are wrong/);
  assert.equal(dispatch.result!.findings[0]?.evidence[0], "conductor:anomaly");
});

test("AN ADAPTED AGENT WITH NO ANALYSED DATA SAYS SO RATHER THAN GUESSING", async () => {
  const anomaly = { name: "anomaly", handles: () => true, answer: () => null };
  const result = await new AgentRegistry().register(fromSubagent(anomaly)).run("conductor:anomaly");

  assert.equal(result.status, "unavailable");
  assert.match(result.summary, /need analysed data/);
});

test("A CONDUCTOR AGENT THAT DECLINES YIELDS, RATHER THAN ANSWERING WITH NOTHING", async () => {
  const anomaly = { name: "anomaly", handles: () => true, answer: () => null };
  const registry = new AgentRegistry().registerAll([
    fromSubagent(anomaly),
    working({ id: "specialist" }),
  ]);

  const dispatch = await registry.dispatch("anything", { context: {} as never });
  assert.equal(dispatch.agent?.id, "specialist");
});

test("THE ADAPTER DESCRIBES ITSELF WITHOUT A `this` BUG", () => {
  // `describe: () => descriptorOf(this)` inside an object literal resolves `this`
  // to the enclosing scope, so the adapter would have published a descriptor for
  // nothing. The roster listing is where that bug becomes visible.
  const adapter = fromSubagent({ name: "profiler", handles: () => false, answer: () => null });
  const listed = new AgentRegistry().register(adapter).describeAll()[0];

  assert.equal(listed?.id, "conductor:profiler");
  assert.equal(listed?.title, "Conductor profiler agent");
  assert.equal(listed?.maturity, "ready");
});

test("A DOMAIN CAN BE NARROWED, so a caller can ask what covers a discipline", () => {
  const registry = new AgentRegistry().registerAll(SPECIALIST_TEMPLATES);

  assert.deepEqual(registry.describeDomain("performance").map((d) => d.id), ["performance"]);
  assert.deepEqual(registry.describeDomain("anomaly"), []);
});
