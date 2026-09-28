import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { buildPolicy } from "./project-config.ts";
import { parsePolicyConfig } from "../core/policy-config.ts";
import type { ApprovalProvider, PolicyDecision, PolicyEngine } from "../core/index.ts";

/**
 * F-003 regression: the no-tool finalisation lifecycle, and the denial
 * semantics that decide whether a rejection ends a run.
 *
 * A policy block never binds an execution, so a turn whose only actions were
 * blocked leaves the task with zero executions. `finishTask` then walks a
 * synthetic response lifecycle whose only legal entry point is PLANNING. These
 * tests pin both halves of that: the crash (finalising from a task that has not
 * finished starting) and the misclassification (a blocked tool call read as a
 * dead stream).
 *
 * Sections G and H cover the same question from two directions. G drives a stub
 * policy that returns a hand-built decision. H drives the REAL declarative
 * composition through the approval path, which is where a substituted policy
 * used to strip the `violation` label that G depends on.
 */

/** The same locally-constructed rules used by the approval composition suite. */
const TEST_RULES = {
  version: 1,
  deniedTools: [],
  allowedTools: [],
  fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
  destructiveCommandPatterns: ["rm -rf", "format c:"],
  destructiveCommandTokens: ["rm", "rmdir", "del", "erase", "unlink", "shred", "remove-item"],
  secretWritePatterns: ["zzcredentialzz", "zztokenzz"],
  limits: { maxToolCallsPerTask: 40, maxFileWritesPerTask: 10, maxBytesPerWrite: 2_000_000 },
  onViolation: "block",
} as const;

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

/**
 * A policy that aborts instead of blocking, used to pin the other half of the
 * violation semantics: an abort is the one denial that may end a run.
 */
class AbortingPolicy {
  readonly mode = "TRUSTED_PROJECT" as const;
  evaluate(request: { tool: { name: string } }): PolicyDecision {
    if (request.tool.name === "bash") {
      return { decision: "DENY", reason: "aborted by test policy", violation: "abort" };
    }
    return { decision: "ALLOW" };
  }
  async evaluateWithApproval(request: { tool: { name: string } }): Promise<PolicyDecision> {
    return this.evaluate(request);
  }
}

// --- G. the legacy entry point honours the declared violation ---------------

test("G. a legacy `block` denial does not fail the task", async () => {
  const kernel = blockedKernel();
  await kernel.beginTask("legacy blocked call");
  const { decision } = await kernel.evaluateToolCall("bash", "execute", { command: "rm -rf ." });
  assert.equal(decision.decision, "DENY");
  assert.equal(decision.violation, "block");

  const task = kernel.currentTask!;
  assert.notEqual(task.status, "FAILED", "a blocked call is not a failed task");
  assert.equal(task.failureReason, undefined, "no failure may be recorded for a block");
  assert.equal(kernel.recentEvents().some((e) => e.type === "TASK_FAILED"), false);
  // The denial is still fully traced, and the task can still be finalised.
  assert.ok(kernel.recentEvents().some((e) => e.type === "APPROVAL_DENIED"));
  assert.equal(kernel.diagnostics.denialCount, 1, "and it is still counted as a policy denial");
  // Finalising the turn must not report a failure either. The legacy path
  // planned the call, so the task sits in EXECUTING with an execution counted
  // and no result ever observed; that is the state it is honestly reported in.
  const finished = await kernel.finishTask(toolCallOnly("b1", "bash"));
  assert.notEqual(finished.status, "FAILED", "a blocked turn is never reported as failed");
});

test("G2. a legacy `abort` denial terminates the task", async () => {
  const kernel = newKernel();
  kernel.setPolicy(new AbortingPolicy() as unknown as PolicyEngine);
  await kernel.beginTask("legacy aborted call");
  const { decision } = await kernel.evaluateToolCall("bash", "execute", { command: "rm -rf ." });
  assert.equal(decision.decision, "DENY");
  assert.equal(decision.violation, "abort");

  assert.equal(kernel.currentTask?.status, "FAILED", "an abort ends the run");
  assert.match(String(kernel.currentTask?.failureReason), /aborted by test policy/);
  assert.ok(kernel.recentEvents().some((e) => e.type === "POLICY_ABORTED"), "the abort is traced");
  // Exactly one termination: the abort must not also drive a second, illegal
  // transition out of FAILED.
  assert.equal(kernel.transitions.filter((t) => t.to === "FAILED").length, 1);
});

test("G3. an unlabelled legacy denial still fails closed", async () => {
  const kernel = newKernel();
  await kernel.beginTask("legacy unlabelled denial");
  const { decision } = await kernel.evaluateToolCall(
    "write",
    "write",
    { path: "x", content: "x" },
    { requestApproval: async () => false },
  );
  assert.equal(decision.decision, "DENY");
  assert.equal(decision.violation, undefined, "the tier policy labels no violation");
  assert.equal(kernel.currentTask?.status, "FAILED", "with no declared violation the old fail-closed behaviour stands");
});

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

// --- H. the same invariant on the APPROVAL path ------------------------------
//
// This is the half of F-003 that no test covered, and the reason it matters
// is a bug that has since been fixed. On the approval path a provider used to
// be handled by SUBSTITUTING a bare tier policy for the installed one, so a
// declarative denial arrived with NO `violation` label at all. An unlabelled
// denial is the one case the legacy entry point still fails closed on (test
// G3), which means the original F-003 complaint — one policy rejection
// terminating the whole task — was still reachable on exactly the path an
// interactive operator uses.
//
// With the installed policy authoritative, a declarative denial carries the
// configured `onViolation` again, so `block` blocks and `abort` aborts. Both
// halves are pinned here through the real composition, not a stub policy.

test("H. a declarative `block` denial on the approval path does not fail the task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-f003-"));
  try {
    const workspace = path.join(root, "app");
    await mkdir(workspace, { recursive: true });
    const policyConfig = parsePolicyConfig({ ...TEST_RULES, onViolation: "block" }, "test-policy.json");
    const kernel = new KernelAdapter();
    kernel.setPolicy(buildPolicy({ policyMode: "APPROVAL", allowedRoots: ["."] }, workspace, policyConfig));
    kernel.registerTools(TOOLS);
    await kernel.beginTask("write the report");

    const approving: ApprovalProvider = { async requestApproval() { return true; } };
    const denied = await kernel.precheckToolCall(
      "write",
      "execute",
      { path: path.join(root, "escape.md"), content: "x" },
      approving,
      "h1",
    );

    // Denied by the workspace boundary, and labelled as a block.
    assert.equal(denied.decision.decision, "DENY");
    assert.equal(denied.decision.violation, "block", "a declarative denial must carry the configured violation");

    // The original F-003 complaint: the task must still be alive.
    assert.notEqual(kernel.currentTask!.status, "FAILED", "a blocked call must not terminate the task");
    assert.equal(kernel.diagnostics.denialCount, 1);

    // A later compliant call still runs: the denial refused one call, not the run.
    const later = await kernel.precheckToolCall(
      "write",
      "execute",
      { path: path.join(workspace, "notes.md"), content: "ordinary" },
      approving,
      "h2",
    );
    assert.equal(later.decision.decision, "ALLOW", "a compliant call after a block must still be allowed");
    assert.notEqual(kernel.currentTask!.status, "FAILED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("H2. a declarative `abort` denial on the approval path is terminal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-f003-"));
  try {
    const workspace = path.join(root, "app");
    await mkdir(workspace, { recursive: true });
    const policyConfig = parsePolicyConfig({ ...TEST_RULES, onViolation: "abort" }, "test-policy.json");
    const kernel = new KernelAdapter();
    kernel.setPolicy(buildPolicy({ policyMode: "APPROVAL", allowedRoots: ["."] }, workspace, policyConfig));
    kernel.registerTools(TOOLS);
    await kernel.beginTask("write the report");

    const approving: ApprovalProvider = { async requestApproval() { return true; } };
    const denied = await kernel.precheckToolCall(
      "write",
      "execute",
      { path: path.join(root, "escape.md"), content: "x" },
      approving,
      "h3",
    );

    assert.equal(denied.decision.decision, "DENY");
    assert.equal(denied.decision.violation, "abort");
    assert.equal(kernel.currentTask!.status, "FAILED", "an aborting violation is the one denial that ends a run");

    const types = kernel.recentEvents(200).map((event) => event.type);
    for (const expected of ["POLICY_VIOLATION", "POLICY_ABORTED", "TASK_FAILED"]) {
      assert.ok(types.includes(expected), `expected ${expected} in the trace`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("H3. an approval refusal carries no violation and still fails closed on the legacy path", async () => {
  // The deliberate asymmetry: an approval refusal is not a policy violation, so
  // it carries no `violation` label, and the legacy entry point fails closed on
  // an unlabelled denial (test G3). Pinned so the labelling contract is not
  // "tidied up" into a block, which would silently change terminal behaviour.
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-f003-"));
  try {
    const policyConfig = parsePolicyConfig({ ...TEST_RULES, onViolation: "block" }, "test-policy.json");
    const kernel = new KernelAdapter();
    kernel.setPolicy(buildPolicy({ policyMode: "APPROVAL", allowedRoots: ["."] }, root, policyConfig));
    kernel.registerTools(TOOLS);
    await kernel.beginTask("write the report");

    const refusing: ApprovalProvider = { async requestApproval() { return false; } };
    const { decision } = await kernel.evaluateToolCall(
      "write",
      "execute",
      { path: path.join(root, "notes.md"), content: "ordinary" },
      refusing,
    );

    assert.equal(decision.decision, "DENY");
    assert.equal(decision.violation, undefined, "an approval refusal is not a policy violation");
    assert.equal(kernel.currentTask!.status, "FAILED", "an unlabelled denial fails closed on the legacy path");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
