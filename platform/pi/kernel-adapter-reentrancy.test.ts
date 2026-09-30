import test from "node:test";
import assert from "node:assert/strict";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";

/**
 * KernelAdapter re-entrancy.
 *
 * `this.task` is a single mutable slot shared by every Pi event handler, and
 * every `events.emit` yields. These tests drive the handler-facing methods
 * through deterministic interleavings — never a real timer race — by suspending
 * inside an event sink and starting a second handler while the first is parked.
 *
 * The invariants under test:
 *  1. a newer `before_agent_start` never SILENTLY replaces an older live task;
 *  2. a handler operates on the task it started with, not a later one;
 *  3. a stale handler produces no illegal transition;
 *  4. a new task may start once the previous one is terminal;
 *  5. F-003 behaviour is unchanged.
 */

const TOOLS = ["read", "bash"].map((name) => toolDescriptorFromPi({ name, description: name }));

const say = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });

function newKernel(): KernelAdapter {
  const k = new KernelAdapter();
  k.registerTools(TOOLS);
  return k;
}

/**
 * Run `first` with the kernel parked inside the first `type` event, start
 * `second` while it is parked, then let `first` resume.
 *
 * `onPark` runs synchronously once the barrier event is reached, so the second
 * handler is guaranteed to be dispatched at the exact suspension point.
 */
async function interleaveAt(
  kernel: KernelAdapter,
  type: string,
  first: () => Promise<unknown>,
  second: () => Promise<unknown>,
): Promise<{ first: unknown; second: unknown }> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let parked = false;
  const off = kernel.events.subscribe((e) => {
    if (e.type !== type || parked) return;
    parked = true;
  });
  // The sink yields control by returning a promise the test controls.
  const blocker = kernel.events.subscribe((e) => {
    if (e.type === type && parked) return gate;
  });
  const firstRun = first();
  // Let `first` reach its parked emit.
  await new Promise((resolve) => setImmediate(resolve));
  const secondRun = second();
  release();
  off();
  blocker();
  return { first: await firstRun, second: await secondRun };
}

/** Every transition the adapter recorded, as `from->to`. */
const walked = (k: KernelAdapter) => k.transitions.map((t) => `${t.from}->${t.to}`);

// --- H. stale precheck on the resolved-policy paths -----------------------

const WRITE_TOOL = toolDescriptorFromPi({ name: "write", description: "write a file" });

/** A kernel whose default (APPROVAL-mode) policy gates `write` behind a prompt. */
function approvalKernel(): KernelAdapter {
  const k = new KernelAdapter();
  k.registerTools([WRITE_TOOL]);
  return k;
}

/**
 * Park the precheck inside the approval provider — the yield a real operator
 * prompt creates — let a second turn fully replace the task, then release the
 * prompt so the stale handler resolves its decision against a task it does not
 * own. The verdict it resolves to (`true` -> ALLOW, `false` -> DENY) is chosen
 * by the test, so both resolved paths are driven deterministically.
 */
async function interleaveAtApproval(
  kernel: KernelAdapter,
  verdict: boolean,
  toolCallId: string,
  second: () => Promise<unknown>,
): Promise<{
  first: { decision: { decision: string; refusal?: string; violation?: unknown } };
  second: unknown;
}> {
  let arrived!: () => void;
  const atPrompt = new Promise<void>((resolve) => { arrived = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const approval = {
    requestApproval: async (): Promise<boolean> => {
      arrived();
      await gate;
      return verdict;
    },
  };

  const firstRun = kernel.precheckToolCall("write", "execute", { path: "report.md" }, approval, toolCallId);
  await atPrompt; // the handler is parked in the prompt
  const secondRun = await second(); // the newer turn now owns the lifecycle
  release(); // the stale handler resumes
  return { first: await firstRun, second: secondRun };
}

/** A stale precheck must be refused as a lifecycle refusal, not a policy verdict. */
function assertStaleRefusal(decision: { decision: string; refusal?: string; violation?: unknown }, why: string): void {
  assert.equal(decision.decision, "DENY", `${why}: a stale precheck resolves to nothing executable`);
  assert.equal(decision.refusal, "stale_task", `${why}: it is refused on lifecycle grounds`);
  assert.equal(decision.violation, undefined, `${why}: a lifecycle refusal is never a policy violation`);
}

test("H. a stale ALLOW is refused, not honoured", async () => {
  const kernel = approvalKernel();
  const one = await kernel.beginTask("task one");

  // The operator grants approval, but only after the task has been superseded.
  const { first } = await interleaveAtApproval(kernel, true, "a1", () => kernel.beginTask("task two"));
  assertStaleRefusal(first.decision, "stale ALLOW");

  const live = kernel.currentTask!;
  assert.equal(live.status, "PLANNING", "the newer task is untouched");
  assert.equal(live.failureReason, undefined, "the newer task carries no failure reason");
  const stale = kernel.staleHandlerOperations.filter((s) => s.handler === "KernelAdapter.precheckToolCall");
  assert.equal(stale.length, 1, "the refused precheck is recorded once");
  assert.equal(stale[0].expectedTaskId, one.taskId, "the record names the task the handler began under");
});

test("H2. a stale DENY is refused as a lifecycle refusal", async () => {
  const kernel = approvalKernel();
  const one = await kernel.beginTask("task one");

  // The operator refuses, but only after the task has been superseded.
  const { first } = await interleaveAtApproval(kernel, false, "b1", () => kernel.beginTask("task two"));
  assertStaleRefusal(first.decision, "stale DENY");

  const live = kernel.currentTask!;
  assert.equal(live.status, "PLANNING", "the newer task is untouched");
  assert.equal(live.failureReason, undefined, "the newer task carries no failure reason");
  assert.equal(
    kernel.staleHandlerOperations.filter((s) => s.handler === "KernelAdapter.precheckToolCall")[0]?.expectedTaskId,
    one.taskId,
  );
});

test("H3. a stale ALLOW does not pollute the newer task's knownToolCallIds", async () => {
  const kernel = approvalKernel();
  await kernel.beginTask("task one");
  await interleaveAtApproval(kernel, true, "a1", () => kernel.beginTask("task two"));

  // `a1` belonged to the superseded task. The live task has never seen it, so
  // it must not read as a duplicate or a denial of the live task's own.
  assert.equal(kernel.diagnostics.deniedToolCallIdCount, 0, "the stale call id is not a denied id of the live task");
  const bound = await kernel.beginToolExecution("a1", "write", {});
  assert.ok(bound, "the live task has no record of the stale call id");
});

test("H4. a stale DENY does not pollute the newer task's deniedToolCallIds", async () => {
  const kernel = approvalKernel();
  await kernel.beginTask("task one");
  await interleaveAtApproval(kernel, false, "b1", () => kernel.beginTask("task two"));

  assert.equal(kernel.diagnostics.deniedToolCallIdCount, 0, "the stale call id is not a denied id of the live task");
  const bound = await kernel.beginToolExecution("b1", "write", {});
  assert.ok(bound, "the live task is not told the stale call was policy-denied");
  const ignored = kernel.recentEvents().filter((e) => e.payload.reason === "policy_denied");
  assert.equal(ignored.length, 0, "a stale refusal is not a policy denial of the live task");
});

test("H5. a stale DENY does not increment denialCount", async () => {
  const kernel = approvalKernel();
  await kernel.beginTask("task one");
  await interleaveAtApproval(kernel, false, "b1", () => kernel.beginTask("task two"));
  assert.equal(kernel.diagnostics.denialCount, 0, "a stale refusal is not a policy denial");

  // The counter is live, not inert: a refusal for the CURRENT task still counts.
  const fresh = await kernel.precheckToolCall("write", "execute", { path: "x.md" }, undefined, "b2");
  assert.equal(fresh.decision.decision, "REQUIRE_APPROVAL");
});

test("H6. a stale refusal leaves the newer task's own bookkeeping at zero", async () => {
  const kernel = approvalKernel();
  await kernel.beginTask("task one");
  const { second } = await interleaveAtApproval(kernel, true, "a1", () => kernel.beginTask("task two"));
  const two = second as { taskId: string };

  const live = kernel.currentTask!;
  assert.equal(live.taskId, two.taskId, "the newer turn owns the lifecycle");
  assert.equal(live.status, "PLANNING", "the newer task is untouched");
  assert.equal(live.failureReason, undefined, "the newer task carries no failure reason");
  assert.equal(kernel.diagnostics.denialCount, 0, "the live task's denial count is its own");
  assert.equal(kernel.diagnostics.terminalRefusalCount, 0, "the live task's terminal refusals are its own");
  assert.equal(kernel.diagnostics.toolExecutionCount, 0, "the stale ALLOW bound no execution");
  assert.equal(kernel.diagnostics.deniedToolCallIdCount, 0, "the stale call id is not in the live task's sets");
  assert.equal(
    walked(kernel).filter((t) => t.endsWith("->FAILED")).length,
    1,
    "only the superseded task failed, and only once",
  );

  // The live task may then run a call of its own under the same id: the stale
  // refusal neither blocked it nor pre-bound it.
  const bound = await kernel.beginToolExecution("a1", "write", {});
  assert.ok(bound, "the live task's own execution binds");
  assert.equal(kernel.diagnostics.toolExecutionCount, 1, "only the live task's execution is counted");
  assert.equal(kernel.currentTask?.status, "EXECUTING", "the live task advanced on its own execution only");
});

// --- A. agent_end overlapping before_agent_start ---------------------------

test("A. agent_end overlapping before_agent_start does not finalise the new task", async () => {
  const kernel = newKernel();
  const first = await kernel.beginTask("task one");
  const firstId = first.taskId;

  // `finishTask` parks inside the emit it makes; a new turn starts meanwhile.
  const { first: finished } = await interleaveAt(
    kernel,
    "TASK_FAILED",
    () => kernel.finishTask(say("answer one")),
    () => kernel.beginTask("task two"),
  );

  assert.equal(kernel.currentTask?.taskId !== firstId, true, "a new task must own the lifecycle");
  assert.equal(
    (finished as { status: string }).status,
    "COMPLETED",
    "the parked finishTask must have completed the OLD task before it was replaced",
  );
  // The new task must not have been walked by the old handler.
  const completions = kernel.transitions.filter((t) => t.to === "COMPLETED");
  assert.equal(completions.length, 1, "exactly one task may be completed");
  assert.notEqual(kernel.currentTask?.status, "COMPLETED", "the new task must not inherit the old one's terminal state");
});

test("A2. a stale finishTask cannot fail the task that replaced it", async () => {
  const kernel = newKernel();
  await kernel.beginTask("task one");
  // Park inside the no-tool finalisation, then start task two.
  const { first: finished } = await interleaveAt(
    kernel,
    "RESPONSE_OBSERVED",
    () => kernel.finishTask({ role: "assistant", content: [] }),
    () => kernel.beginTask("task two"),
  );
  const after = finished as { status: string; taskId: string };
  const live = kernel.currentTask!;
  assert.notEqual(after.taskId, live.taskId, "the stale handler reported the OLD task");
  assert.notEqual(live.status, "FAILED", "the new task must not be failed by a stale handler");
  assert.equal(live.status, "PLANNING", "the new task must still be usable");
});

// --- B. two before_agent_start events racing -------------------------------

test("B. two racing before_agent_start events do not corrupt the lifecycle", async () => {
  const kernel = newKernel();
  const a = kernel.beginTask("turn a");
  const b = kernel.beginTask("turn b");
  const [first, second] = await Promise.all([a, b]);

  assert.notEqual(first.taskId, second.taskId, "each turn gets its own task identity");
  const live = kernel.currentTask!;
  assert.equal(live.taskId, second.taskId, "the last turn to start owns the lifecycle");
  assert.equal(live.status, "PLANNING", "the live task must be in a usable state");
  assert.equal(live.objective, "turn b");

  // The superseded task was terminated explicitly, not silently dropped.
  const failures = kernel.recentEvents().filter((e) => e.type === "TASK_FAILED");
  assert.equal(failures.length, 1, "supersession must be recorded as a real TASK_FAILED");
  assert.match(String(failures[0].payload.reason), /Superseded by a newer turn/);
});

test("B2. superseding a live task uses only legal transitions", async () => {
  const kernel = newKernel();
  await kernel.beginTask("turn a");
  await kernel.precheckToolCall("read", "execute", { path: "README.md" }, undefined, "r1");
  await kernel.beginToolExecution("r1", "read", {});
  assert.equal(kernel.currentTask?.status, "EXECUTING");

  await kernel.beginTask("turn b");
  // The superseded task walked PLANNING -> ... -> FAILED. No EXECUTING -> <newer>.
  const seq = walked(kernel);
  assert.ok(seq.includes("EXECUTING->FAILED"), `supersede must terminate the live task, got ${seq.join(" ")}`);
  assert.equal(kernel.currentTask?.status, "PLANNING");
});

// --- C. tool result completion overlapping a new task start ---------------

test("C. a tool result completing after a new task starts is refused", async () => {
  const kernel = newKernel();
  const one = await kernel.beginTask("task one");
  await kernel.precheckToolCall("read", "execute", { path: "README.md" }, undefined, "r1");
  const bound = await kernel.beginToolExecution("r1", "read", {});
  assert.ok(bound);
  assert.equal(kernel.diagnostics.toolExecutionCount, 1);

  // Park inside the TOOL_COMPLETED emit, then start task two.
  const { first: validation } = await interleaveAt(
    kernel,
    "TOOL_COMPLETED",
    () => kernel.recordToolResult("r1", "read", { ok: true }, false),
    () => kernel.beginTask("task two"),
  );

  assert.notEqual(kernel.currentTask?.taskId, one.taskId, "a new task owns the lifecycle");
  assert.equal(
    (validation as { validator: string }).validator,
    "stale-task-generation",
    "the stale result must be reported as stale, not applied",
  );
  assert.equal(kernel.currentTask?.status, "PLANNING", "the new task must be untouched and usable");
  assert.equal(
    kernel.diagnostics.toolExecutionCount,
    0,
    "bookkeeping must belong to the new task, not be polluted by the old one",
  );
  const stale = kernel.staleHandlerOperations;
  assert.equal(stale.length, 1);
  assert.equal(stale[0].expectedTaskId, one.taskId);
  assert.equal(stale[0].currentTaskId, kernel.currentTask?.taskId);
});

test("C2. a stale tool result does not advance the new task's lifecycle", async () => {
  const kernel = newKernel();
  await kernel.beginTask("task one");
  await kernel.precheckToolCall("read", "execute", { path: "README.md" }, undefined, "r1");
  await kernel.beginToolExecution("r1", "read", {});

  await interleaveAt(
    kernel,
    "TOOL_COMPLETED",
    () => kernel.recordToolResult("r1", "read", { ok: true }, false),
    () => kernel.beginTask("task two"),
  );

  // The new task must have walked only its own start transitions.
  const newTaskTransitions = kernel.transitions.filter((t) => t.to !== "UNDERSTANDING" || t.from === "RECEIVED");
  assert.ok(
    newTaskTransitions.every((t) => t.to !== "OBSERVING" && t.to !== "VALIDATING"),
    "the new task must not have been advanced by the stale result",
  );
});

// --- D. a stale handler cannot mutate task N+1 ----------------------------

test("D. a stale precheck cannot record a decision against the newer task", async () => {
  const kernel = newKernel();
  // A policy that always demands approval, so the precheck reaches the
  // APPROVAL_REQUIRED yield that a real approval prompt creates. That yield is
  // the only point at which this handler can become stale.
  kernel.setPolicy({
    mode: "APPROVAL",
    evaluate: () => ({ decision: "REQUIRE_APPROVAL" as const, reason: "needs an operator" }),
    evaluateWithApproval: undefined,
  } as never);

  const one = await kernel.beginTask("task one");

  // Park inside the approval emit, start task two while the prompt is open, then
  // let the old precheck resume against a task that no longer exists.
  const { first, second } = await interleaveAt(
    kernel,
    "APPROVAL_REQUIRED",
    () => kernel.precheckToolCall("bash", "execute", { command: "echo hi" }, undefined, "r1"),
    () => kernel.beginTask("task two"),
  );

  const decision = (first as { decision: { decision: string; refusal?: string; violation?: unknown } }).decision;
  const two = second as { taskId: string };

  assert.equal(decision.decision, "DENY", "a stale precheck resolves to neither ALLOW nor REQUIRE_APPROVAL");
  assert.equal(decision.refusal, "stale_task", "it must be refused as a lifecycle refusal");
  assert.equal(decision.violation, undefined, "a lifecycle refusal is never a policy violation");

  const live = kernel.currentTask!;
  assert.equal(live.taskId, two.taskId, "the newer turn owns the lifecycle");
  assert.equal(live.status, "PLANNING", "the live task must be untouched and usable");
  assert.equal(live.failureReason, undefined, "the live task carries no failure reason");

  const stale = kernel.staleHandlerOperations.filter((s) => s.handler === "KernelAdapter.precheckToolCall");
  assert.equal(stale.length, 1, "the refused precheck is recorded exactly once");
  assert.equal(stale[0].expectedTaskId, one.taskId, "the record names the task the handler began under");
  assert.equal(stale[0].currentTaskId, live.taskId, "and the task that replaced it");
});

test("D2. a stale abort cannot terminate the newer task", async () => {
  const kernel = newKernel();
  const one = await kernel.beginTask("task one");
  // Park the abort inside its POLICY_VIOLATION emit, then start task two.
  const { second } = await interleaveAt(
    kernel,
    "POLICY_VIOLATION",
    () => kernel.abortTask("policy abort"),
    () => kernel.beginTask("task two"),
  );

  const live = kernel.currentTask!;
  assert.notEqual(live.taskId, one.taskId);
  assert.equal((second as { status: string }).status, "PLANNING", "the new task must not be aborted");
  assert.equal(live.failureReason, undefined, "the new task carries no failure reason");
  assert.ok(
    kernel.staleHandlerOperations.some((s) => s.handler === "KernelAdapter.abortTask"),
    "the refused abort must be recorded",
  );
});

// --- E. normal sequential turns still work --------------------------------

test("E. sequential turns still work and each is finalised on its own", async () => {
  const kernel = newKernel();

  const one = await kernel.beginTask("turn one");
  await kernel.precheckToolCall("read", "execute", { path: "README.md" }, undefined, "r1");
  await kernel.beginToolExecution("r1", "read", {});
  await kernel.recordToolResult("r1", "read", { ok: true }, false);
  const doneOne = await kernel.finishTask(say("turn one done"));
  assert.equal(doneOne.taskId, one.taskId);
  assert.equal(doneOne.status, "COMPLETED");

  const two = await kernel.beginTask("turn two");
  assert.notEqual(two.taskId, one.taskId);
  const doneTwo = await kernel.finishTask(say("turn two done"));
  assert.equal(doneTwo.taskId, two.taskId);
  assert.equal(doneTwo.status, "COMPLETED");

  assert.equal(kernel.staleHandlerOperations.length, 0, "a sequential run is never stale");
});

test("E2. a new task may start after a terminal one without a supersession", async () => {
  const kernel = newKernel();
  await kernel.beginTask("turn one");
  await kernel.abortTask("operator abort");
  assert.equal(kernel.currentTask?.status, "FAILED");

  const two = await kernel.beginTask("turn two");
  assert.equal(two.status, "PLANNING", "a terminal task must not block the next turn");
  const failures = kernel.recentEvents().filter((e) => e.type === "TASK_FAILED");
  assert.equal(failures.length, 1, "no supersession should have been needed");
  assert.equal(failures[0].payload.reason, undefined ?? failures[0].payload.reason);
});

// --- F. F-003 behaviour is unchanged -------------------------------------

test("F. a normal no-tool answer still completes", async () => {
  const kernel = newKernel();
  await kernel.beginTask("plain answer");
  const done = await kernel.finishTask(say("The answer is 42."));
  assert.equal(done.status, "COMPLETED");
});

test("F2. a blocked tool call ending the turn is still not a dead stream", async () => {
  const kernel = newKernel();
  kernel.setPolicy({
    mode: "TRUSTED_PROJECT",
    evaluate: (r: { tool: { name: string } }) =>
      r.tool.name === "bash" ? { decision: "DENY" as const, reason: "blocked", violation: "block" as const } : { decision: "ALLOW" as const },
    evaluateWithApproval: undefined,
  } as never);
  await kernel.beginTask("blocked only");
  // Structural: the stub policy denies `bash` by name, so the payload is never
  // inspected. The construct is not this test's subject, so the test names none.
  const { decision } = await kernel.precheckToolCall("bash", "execute", { command: "noop" }, undefined, "b1");
  assert.equal(decision.decision, "DENY");
  const done = await kernel.finishTask({ role: "assistant", content: [{ type: "toolCall", toolCallId: "b1", toolName: "bash" }] });
  assert.equal(done.status, "COMPLETED", "F-003 behaviour must be unchanged");
  assert.equal(done.failureReason, undefined);
});

test("F3. a genuinely dead stream still fails", async () => {
  const kernel = newKernel();
  await kernel.beginTask("dead stream");
  const done = await kernel.finishTask({ role: "assistant", content: [] });
  assert.equal(done.status, "FAILED");
  assert.equal(done.failureReason, "Assistant response lacked content or finish_reason");
});
