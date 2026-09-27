import test from "node:test";
import assert from "node:assert/strict";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import type { PolicyDecision, PolicyEngine } from "../core/index.ts";

/**
 * F-003 regression: the no-tool finalisation lifecycle.
 *
 * A policy block never binds an execution, so a turn whose only actions were
 * blocked leaves the task with zero executions. `finishTask` then walks a
 * synthetic response lifecycle whose only legal entry point is PLANNING. These
 * tests pin both halves of that: the crash (finalising from a task that has not
 * finished starting) and the misclassification (a blocked tool call read as a
 * dead stream).
 */

const TOOLS = ["read", "bash", "write", "edit"].map((name) => toolDescriptorFromPi({ name, description: name }));

function newKernel(): KernelAdapter {
  const kernel = new KernelAdapter();
  kernel.registerTools(TOOLS);
  return kernel;
}

/**
 * A policy that blocks exactly one tool with a real `block` violation and
 * allows the rest. The kernel's contract is about what it does with a denial,
 * so the test supplies the denial directly rather than depending on the
 * project's boundary rules.
 */
class BlockingPolicy {
  readonly mode = "TRUSTED_PROJECT" as const;
  evaluate(request: { tool: { name: string } }): PolicyDecision {
    if (request.tool.name === "bash") {
      return { decision: "DENY", reason: "blocked by test policy", violation: "block" };
    }
    return { decision: "ALLOW" };
  }
  async evaluateWithApproval(request: { tool: { name: string } }): Promise<PolicyDecision> {
    return this.evaluate(request);
  }
}

function blockedKernel(): KernelAdapter {
  const kernel = newKernel();
  kernel.setPolicy(new BlockingPolicy() as unknown as PolicyEngine);
  return kernel;
}

const text = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });
const toolCallOnly = (id: string, name: string) => ({
  role: "assistant",
  content: [{ type: "toolCall", toolCallId: id, toolName: name }],
});


// --- A. a normal no-tool answer must complete, not fail --------------------

test("A. plain text response with no tool execution completes", async () => {
  const kernel = newKernel();
  await kernel.beginTask("answer from memory");
  const done = await kernel.finishTask(text("The answer is 42."));
  assert.equal(done.status, "COMPLETED", "a text-only answer must never become FAILED");
  assert.ok(kernel.recentEvents().some((e) => e.type === "TASK_COMPLETED"));
});

test("A2. text response plus stopReason completes", async () => {
  const kernel = newKernel();
  await kernel.beginTask("answer with stop reason");
  const done = await kernel.finishTask({ ...text("Done."), stopReason: "stop" });
  assert.equal(done.status, "COMPLETED");
});

test("A3. the no-tool lifecycle walks only legal states and ends COMPLETED", async () => {
  const kernel = newKernel();
  await kernel.beginTask("no tool lifecycle");
  await kernel.finishTask(text("No tools were needed."));

  const walked = kernel.transitions.map((t) => `${t.from}->${t.to}`);
  assert.deepEqual(walked, [
    "RECEIVED->UNDERSTANDING",
    "UNDERSTANDING->PLANNING",
    "PLANNING->PLAN_VALIDATION",
    "PLAN_VALIDATION->EXECUTING",
    "EXECUTING->OBSERVING",
    "OBSERVING->VALIDATING",
    "VALIDATING->COMPLETED",
  ], "the no-tool lifecycle must walk only legal transitions");
  assert.equal(kernel.currentTask?.status, "COMPLETED");
});

// --- B. the live crash: finishing from a state that never reached PLANNING ---

test("B. finishTask from UNDERSTANDING does not request an illegal transition", async () => {
  const kernel = newKernel();
  await kernel.beginTask("not yet planning");
  // Force the state the old beginTask could be observed in: the task was
  // created, but PLANNING had not been applied yet.
  (kernel as any).task = { ...(kernel as any).task, status: "UNDERSTANDING" };

  const result = await kernel.finishTask(text("The answer is 42."));

  assert.equal(result.status, "UNDERSTANDING", "the task must not be finalised from a non-PLANNING state");
  const ignored = kernel.recentEvents().filter((e) => e.type === "TOOL_RESULT_IGNORED");
  assert.ok(
    ignored.some((e) => e.payload.reason === "no_tool_finalisation_requires_planning_state"),
    "the refusal to finalise must be reported, not silently swallowed",
  );
  assert.ok(!kernel.recentEvents().some((e) => e.type === "TASK_FAILED"));
});

test("B2. the no-tool path is reachable only from PLANNING", async () => {
  for (const status of ["RECEIVED", "UNDERSTANDING"] as const) {
    const kernel = newKernel();
    await kernel.beginTask(`state ${status}`);
    (kernel as any).task = { ...(kernel as any).task, status };
    const result = await kernel.finishTask(text("answer"));
    assert.equal(result.status, status, `finishTask must not move a task out of ${status}`);
  }
});

test("B3. beginTask reaches PLANNING with no intervening yield", async () => {
  // The bug was an await between UNDERSTANDING and PLANNING. If the states are
  // now in place before the first yield, a re-entrant finishTask during the
  // TASK_CREATED emit can never observe UNDERSTANDING.
  const kernel = newKernel();
  let statusWhenCreated: string | undefined;
  kernel.events.subscribe((e) => {
    if (e.type === "TASK_CREATED") statusWhenCreated = (kernel as any).task?.status;
  });
  await kernel.beginTask("atomic start");
  assert.equal(statusWhenCreated, "PLANNING", "PLANNING must be set before the first event is emitted");
  assert.equal(kernel.currentTask?.status, "PLANNING");
});

// --- C. a blocked tool call is a real assistant action ---------------------

test("C. a policy block that ends the turn is not a dead stream", async () => {
  const kernel = blockedKernel();
  await kernel.beginTask("blocked call, nothing else");
  const { decision } = await kernel.precheckToolCall("bash", "execute", { command: "rm -rf ." }, undefined, "b1");
  assert.equal(decision.decision, "DENY");
  assert.equal(decision.violation, "block", "a policy denial carries a real violation");

  const done = await kernel.finishTask(toolCallOnly("b1", "bash"));
  assert.notEqual(done.status, "FAILED", "a refused tool call is a completed turn, not a dead stream");
  assert.ok(!done.failureReason, "no failure may be recorded for a policy block");
});

test("C2. toolCall-only plus stopReason also completes", async () => {
  const kernel = blockedKernel();
  await kernel.beginTask("blocked call with stop reason");
  await kernel.precheckToolCall("bash", "execute", { command: "rm -rf ." }, undefined, "b1");
  const done = await kernel.finishTask({ ...toolCallOnly("b1", "bash"), stopReason: "stop" });
  assert.equal(done.status, "COMPLETED");
});

test("C3. a genuinely dead stream still fails", async () => {
  const kernel = newKernel();
  await kernel.beginTask("dead stream");
  const done = await kernel.finishTask({ role: "assistant", content: [] });
  assert.equal(done.status, "FAILED", "an empty assistant message is a dead stream and must still fail");
  assert.equal(done.failureReason, "Assistant response lacked content or finish_reason");
});

// --- D. a block does not end the task --------------------------------------

test("D. after a block a later valid call still executes", async () => {
  const kernel = blockedKernel();
  await kernel.beginTask("block then continue");
  await kernel.precheckToolCall("bash", "execute", { command: "rm -rf ." }, undefined, "b1");
  const { decision } = await kernel.precheckToolCall("read", "execute", { path: "README.md" }, undefined, "r1");
  assert.equal(decision.decision, "ALLOW");
  const bound = await kernel.beginToolExecution("r1", "read", {});
  assert.ok(bound, "a later valid call must still bind an execution");
  assert.equal(kernel.diagnostics.toolExecutionCount, 1);
  assert.equal(kernel.diagnostics.denialCount, 1);
});

// --- E. an explicit abort stays terminal -----------------------------------

test("E. an explicit abort is terminal and later calls are refused", async () => {
  const kernel = newKernel();
  await kernel.beginTask("abort");
  await kernel.abortTask("operator abort");
  assert.equal(kernel.currentTask?.status, "FAILED");

  const { decision } = await kernel.precheckToolCall("read", "execute", { path: "README.md" }, undefined, "r1");
  assert.equal(decision.decision, "DENY");
  const bound = await kernel.beginToolExecution("r1", "read", {});
  assert.equal(bound, undefined, "a terminal task admits no execution");
});

// --- F. a terminal-state refusal is not a policy violation -----------------

test("F. terminal-state refusal carries refusal, never violation", async () => {
  const kernel = newKernel();
  await kernel.beginTask("terminal refusal");
  await kernel.abortTask("operator abort");

  const { decision } = await kernel.precheckToolCall("read", "execute", { path: "README.md" }, undefined, "r1");
  assert.equal(decision.decision, "DENY");
  assert.equal(decision.refusal, "task_terminal");
  assert.equal(decision.violation, undefined, "a lifecycle refusal must not be reported as a policy violation");
  assert.match(decision.reason ?? "", /no further tool calls are accepted/);
});

test("F2. a policy denial and a terminal refusal are counted separately", async () => {
  const kernel = blockedKernel();
  await kernel.beginTask("counters");
  await kernel.precheckToolCall("bash", "execute", { command: "rm -rf ." }, undefined, "b1");
  assert.equal(kernel.diagnostics.denialCount, 1);
  assert.equal(kernel.diagnostics.terminalRefusalCount, 0);

  await kernel.abortTask("operator abort");
  await kernel.precheckToolCall("read", "execute", { path: "README.md" }, undefined, "r1");
  assert.equal(kernel.diagnostics.denialCount, 1, "a terminal refusal is not a policy denial");
  assert.equal(kernel.diagnostics.terminalRefusalCount, 1, "a terminal refusal must be counted");
});

test("F3. a blocked call never becomes an execution", async () => {
  const kernel = blockedKernel();
  await kernel.beginTask("blocked never executes");
  await kernel.precheckToolCall("bash", "execute", { command: "rm -rf ." }, undefined, "b1");
  const bound = await kernel.beginToolExecution("b1", "bash", {});
  assert.equal(bound, undefined);
  assert.equal(kernel.diagnostics.toolExecutionCount, 0);
});
