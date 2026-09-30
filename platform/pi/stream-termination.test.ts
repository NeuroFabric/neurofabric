import test from "node:test";
import assert from "node:assert/strict";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";

test("stream death never completes task (F-000 regression)", async () => {
  const adapter = new KernelAdapter();
  adapter.registerTools([toolDescriptorFromPi({ name: "read", description: "Read file" })]);
  await adapter.beginTask("Task with stream termination", "Task with stream termination");

  // Simulate stream death (no content, no finish reason)
  const deadMessage = {
    role: "assistant",
    content: [],
  };

  const finished = await adapter.finishTask(deadMessage);
  assert.equal(finished.status, "FAILED", "Stream death must never transition task to COMPLETED");
  assert.ok(adapter.recentEvents().some((e) => e.type === "TASK_FAILED"));
  assert.ok(!adapter.recentEvents().some((e) => e.type === "TASK_COMPLETED"));
});

test("failed task refusal includes failureReason", async () => {
  const adapter = new KernelAdapter();
    adapter.registerTools([toolDescriptorFromPi({ name: "read", description: "Read file" })]);
  await adapter.beginTask("Task", "Task");
  (adapter as any).task = { ...(adapter as any).task, status: "FAILED", failureReason: "Boom" };
  
  const refusal = await adapter.precheckToolCall("read", "read", {});
  // CHANGED BY THE ECHO MR. The stored reason is no longer appended as a bare
  // `failureReason:` tail, because that presented the task's ORIGINAL failure as
  // if it described the call being refused. It is now labelled and attributed.
  assert.match(refusal.decision.reason, /ORIGINAL failure, recorded when the task terminated and unchanged since, is: Boom/);
});

test("completed task refusal includes completion instructions", async () => {
  const adapter = new KernelAdapter();
    adapter.registerTools([toolDescriptorFromPi({ name: "read", description: "Read file" })]);
  await adapter.beginTask("Task", "Task");
  (adapter as any).task = { ...(adapter as any).task, status: "COMPLETED" };
  
  const refusal = await adapter.precheckToolCall("read", "read", {});
  assert.match(refusal.decision.reason, /turn completed successfully/);
});

test("escalated task refusal includes escalation status", async () => {
  const adapter = new KernelAdapter();
    adapter.registerTools([toolDescriptorFromPi({ name: "read", description: "Read file" })]);
  await adapter.beginTask("Task", "Task");
  (adapter as any).task = { ...(adapter as any).task, status: "ESCALATED" };
  
  const refusal = await adapter.precheckToolCall("read", "read", {});
  assert.match(refusal.decision.reason, /task escalated/);
});

test("clean text-only completion completes successfully", async () => {
  const adapter = new KernelAdapter();
  await adapter.beginTask("Task with text response", "Task with text response");

  const cleanMessage = {
    role: "assistant",
    content: [{ type: "text", text: "Here is the response to your request." }],
    stopReason: "stop",
  };

  const finished = await adapter.finishTask(cleanMessage);
  assert.equal(finished.status, "COMPLETED");
  assert.ok(adapter.recentEvents().some((e) => e.type === "TASK_COMPLETED"));
});

test("tools remain available in RECOVERING; locked in COMPLETED and FAILED", async () => {
  const adapter = new KernelAdapter();
  adapter.registerTools([
    toolDescriptorFromPi({ name: "read", description: "Read file" }),
    toolDescriptorFromPi({ name: "write", description: "Write file" }),
  ]);
  const task = await adapter.beginTask("Recovery and lockout test", "Recovery and lockout test");

  // Manually force RECOVERING state
  (adapter as any).task = { ...task, status: "RECOVERING" };
  
  // Precheck tool in RECOVERING should be evaluated, not denied by terminal state check
  const recoveringPrecheck = await adapter.precheckToolCall("read", "read", { path: "test.txt" });
  assert.equal(recoveringPrecheck.decision.decision, "ALLOW"); // read tool is ALLOW under default policy

  // Now transition to FAILED
  (adapter as any).task = { ...(adapter as any).task, status: "FAILED" };
  const failedPrecheck = await adapter.precheckToolCall("read", "read", { path: "test.txt" });
  assert.equal(failedPrecheck.decision.decision, "DENY");
  // F-006 Phase 2a / ITEM 8 PART A: this string is what the agent actually
  // reads. It was pinned at exactly 46 characters and told the model only THAT
  // the task was dead. The refusal now appends the task's failureReason when
  // the task carries one; with none, the string must be unchanged.
  //
  // CHANGED BY THE ECHO MR. The old pin asserted the 46-character string
  // VERBATIM, which pinned the echo: a refusal that named the dead task and
  // nothing about the call that triggered it. The property that pin was
  // actually protecting — no dangling separator when there is no failureReason
  // to append — is still asserted below, and is now joined by the two facts
  // the echo MR requires: the triggering call is named, and its absence of any
  // stored reason is stated rather than left as an empty tail.
  assert.equal(
    failedPrecheck.decision.reason,
    "Task is FAILED; no further tool calls are accepted; "
    + "the call that triggered this refusal is tool=read operation=read toolCallId=<none>; "
    + "it was NOT evaluated and no policy rule refused it; "
    + "the task terminated WITHOUT recording a failureReason, so there is no original failure to replay",
    "a task with no failureReason must say so outright, with no dangling separator",
  );
  assert.match(failedPrecheck.decision.reason ?? "", /^Task is FAILED; no further tool calls are accepted;/);

  // Now transition to COMPLETED
  (adapter as any).task = { ...(adapter as any).task, status: "COMPLETED" };
  const completedPrecheck = await adapter.precheckToolCall("read", "read", { path: "test.txt" });
  assert.equal(completedPrecheck.decision.decision, "DENY");
  assert.match(completedPrecheck.decision.reason ?? "", /Task is COMPLETED; no further tool calls are accepted/);
});

test("a FAILED task's refusal carries its failureReason (death certificate)", async () => {
  const adapter = new KernelAdapter();
  adapter.registerTools([toolDescriptorFromPi({ name: "read", description: "Read file" })]);
  await adapter.beginTask("Task that dies with a reason", "Task that dies with a reason");

  // A real terminal path, not a hand-edited status: `abortTask` is what sets
  // `failureReason` when a policy abort kills the task.
  await adapter.abortTask("Policy abort: workspace boundary violation");
  assert.equal(adapter.currentTask?.status, "FAILED");

  const precheck = await adapter.precheckToolCall("read", "read", { path: "test.txt" });
  assert.equal(precheck.decision.decision, "DENY");
  assert.equal(precheck.decision.refusal, "task_terminal", "a lifecycle refusal is never a policy violation");
  // CHANGED BY THE ECHO MR: the certificate is now labelled as the task's
  // ORIGINAL failure, so a reader (and an agent) cannot mistake it for a reason
  // attributable to the call in front of them.
  assert.equal(
    precheck.decision.reason,
    "Task is FAILED; no further tool calls are accepted; "
    + "the call that triggered this refusal is tool=read operation=read toolCallId=<none>; "
    + "it was NOT evaluated and no policy rule refused it; "
    + "the task's ORIGINAL failure, recorded when the task terminated and unchanged since, is: "
    + "Policy abort: workspace boundary violation",
    "the agent must be able to read WHY the task is dead, not only that it is",
  );

  // The same reason must reach the emitted event, so it is in the trace too.
 // const denied = adapter.recentEvents(500).filter((e) => e.type === "APPROVAL_DENIED").at(-1);
   // 86b2d3a renamed the terminal refusal event APPROVAL_DENIED -> LIFECYCLE_REFUSED;
  // the lookup follows the rename; the asserted payload is unchanged.
  const denied = adapter.recentEvents(500).filter((e) => e.type === "LIFECYCLE_REFUSED").at(-1);
 assert.equal(
    (denied?.payload as Record<string, unknown> | undefined)?.reason,
    "Task is FAILED; no further tool calls are accepted; "
    + "the call that triggered this refusal is tool=read operation=read toolCallId=<none>; "
    + "it was NOT evaluated and no policy rule refused it; "
    + "the task's ORIGINAL failure, recorded when the task terminated and unchanged since, is: "
    + "Policy abort: workspace boundary violation",
  );
});

test("a recovery-terminated task's refusal carries the recovery certificate", async () => {
  const adapter = new KernelAdapter();
  adapter.registerTools([toolDescriptorFromPi({ name: "edit", description: "edit a file" })]);
  await adapter.beginTask("Task that dies in recovery", "Task that dies in recovery");

  // Exactly the shape of the observed deaths: a deterministic edit failure
  // consuming the replan budget, terminated with a structured certificate.
  const certificate = "Recovery TERMINATE [REPLAN_BUDGET_EXHAUSTED]: failure=TOOL_FAILURE, "
    + "replanCount=2/2, retryCount=0/2, recoveryDepth=1/3, elapsedMs=209741/1800000";
  (adapter as any).task = { ...(adapter as any).task, status: "FAILED", failureReason: certificate };

  const precheck = await adapter.precheckToolCall("edit", "edit", { path: "a.txt", oldText: "x", newText: "y" });
  assert.equal(precheck.decision.decision, "DENY");
  assert.equal(
    precheck.decision.reason,
    `Task is FAILED; no further tool calls are accepted; `
    + `the call that triggered this refusal is tool=edit operation=edit toolCallId=<none>; `
    + `it was NOT evaluated and no policy rule refused it; `
    + `the task's ORIGINAL failure, recorded when the task terminated and unchanged since, is: ${certificate}`,
    "the whole certificate, counters included, must be legible to the agent",
  );
  assert.match(precheck.decision.reason ?? "", /retryCount=0\/2/, "the unused retry budget must be visible in the refusal");
});

test("untyped result object never completes a task", async () => {
  const adapter = new KernelAdapter();
  await adapter.beginTask("Untyped result object", "Untyped result object");

  // Simulate an untyped object that is not a valid assistant message
  const untypedResult = { status: "ok" };

  const finished = await adapter.finishTask(untypedResult);
  assert.equal(finished.status, "FAILED", "Untyped result object must never transition task to COMPLETED");
  assert.equal(finished.failureReason, "Expected assistant response, got role: undefined");
});
