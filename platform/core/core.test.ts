import test from "node:test";
import assert from "node:assert/strict";
import { CoreError } from "./errors.ts";
import { createTask, transitionTask } from "./state-machine.ts";
import { readySteps, validatePlan } from "./plan.ts";
import { DefaultPolicy } from "./policy.ts";
import { executeTool } from "./execution.ts";
import { chooseRecovery } from "./recovery.ts";
import { selectContext, InMemoryStore } from "./context-memory.ts";
import { validateLimits } from "./limits.ts";
import { DefaultValidator } from "./validation.ts";
import { ToolRegistry } from "./tool-registry.ts";
import { skillsForCapabilities, toSkillDescriptor } from "./skill-catalog.ts";
import type { Plan, SkillDescriptor, ToolDescriptor } from "./types.ts";

const tool: ToolDescriptor = {
  name: "read_file",
  version: "1",
  description: "Read a file",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  capabilities: ["file.read"],
  permissions: ["file:read"],
  riskLevel: "READ_ONLY",
  timeoutMs: 1000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
  idempotency: "IDEMPOTENT",
  sideEffect: "PURE",
};

const skill: SkillDescriptor = {
  name: "file-analysis",
  version: "1",
  description: "Analyze files",
  capabilities: ["file.read"],
  supportedInputs: ["file"],
  supportedOutputs: ["report"],
  requiredTools: ["read_file"],
  optionalTools: [],
  dependencies: [],
  constraints: [],
  riskLevel: "READ_ONLY",
  examples: [],
};

function plan(): Plan {
  return {
    planId: "plan-1",
    objective: "Read a file",
    assumptions: [],
    selectedSkills: ["file-analysis"],
    selectedTools: ["read_file"],
    expectedOutputs: ["report"],
    validationCriteria: ["report exists"],
    riskLevel: "READ_ONLY",
    steps: [
      {
        stepId: "read",
        description: "Read the file",
        skill: "file-analysis",
        tools: ["read_file"],
        dependencies: [],
        expectedOutput: "file content",
        validationCriteria: ["content is present"],
        retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
        timeoutMs: 1000,
        status: "PENDING",
      },
    ],
  };
}

test("task state machine rejects illegal transitions", () => {
  const task = createTask({ taskId: "task-1", userRequest: "read", objective: "read" });
  assert.throws(() => transitionTask(task, "EXECUTING"), (error: unknown) => error instanceof CoreError && error.category === "TASK_ERROR");
  const planning = transitionTask(task, "UNDERSTANDING");
  assert.equal(planning.status, "UNDERSTANDING");
});

test("plan validation rejects cycles and unknown tools", () => {
  assert.throws(() => validatePlan({ ...plan(), steps: [
    { ...plan().steps[0], stepId: "a", dependencies: ["b"] },
    { ...plan().steps[0], stepId: "b", dependencies: ["a"] },
  ] }, [skill], [tool]), /Cyclic plan dependency/);
  const invalid = plan();
  invalid.steps[0].tools = ["missing"];
  assert.throws(() => validatePlan(invalid, [skill], [tool]), /Unknown tool/);
  assert.equal(readySteps(plan(), []).length, 1);
});

test("policy allows reads and requires approval for writes", () => {
  const policy = new DefaultPolicy();
  assert.deepEqual(policy.evaluate({ taskId: "task-1", tool, operation: "read", input: {} }).decision, "ALLOW");
  const writeTool = { ...tool, name: "write_file", riskLevel: "WRITE" as const, sideEffect: "SIDE_EFFECTING" as const };
  assert.equal(policy.evaluate({ taskId: "task-1", tool: writeTool, operation: "write", input: {} }).decision, "REQUIRE_APPROVAL");
});

test("execution preserves structured failures and successful metadata", async () => {
  const task = createTask({ taskId: "task-1", userRequest: "read", objective: "read" });
  const result = await executeTool({
    task,
    stepId: "read",
    tool,
    input: { path: "sample.txt" },
    runner: { run: async () => ({ data: { content: "ok" }, metadata: { bytes: 2 } }) },
  });
  assert.equal(result.success, true);
  assert.equal(result.execution.status, "COMPLETED");
  await assert.rejects(() => executeTool({
    task,
    stepId: "read",
    tool,
    input: {},
    runner: { run: async () => { throw new Error("broken"); } },
  }), (error: unknown) => error instanceof CoreError && error.execution?.status === "FAILED");
});

test("recovery is bounded and does not retry non-idempotent tools", () => {
  const limits = { maxToolRetries: 1, maxReplans: 1, maxRecoveryDepth: 2, maxExecutionTimeMs: 1000 };
  assert.equal(chooseRecovery({ failure: "TRANSIENT", limits, retryCount: 0, replanCount: 0, depth: 0, idempotency: "IDEMPOTENT" }), "RETRY");
  assert.equal(chooseRecovery({ failure: "TRANSIENT", limits, retryCount: 0, replanCount: 0, depth: 0, idempotency: "NON_IDEMPOTENT" }), "ESCALATE");
  assert.equal(chooseRecovery({ failure: "TRANSIENT", limits, retryCount: 0, replanCount: 0, depth: 2, idempotency: "IDEMPOTENT" }), "TERMINATE");
});

test("limits, validator, tool registry, and capability matching are deterministic", async () => {
  assert.throws(() => validateLimits({ maxToolRetries: 0 }), /Invalid core limit/);
  const validator = new DefaultValidator();
  const result = await validator.validateStep(plan().steps[0], {
    success: true,
    data: { content: "ok" },
    artifacts: [],
    warnings: [],
    provenance: [],
    execution: {
      executionId: "execution-1", taskId: "task-1", stepId: "read", tool: "read_file",
      startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), status: "COMPLETED", retryNumber: 0,
    },
  });
  assert.equal(result.status, "VALID");
  const registry = new ToolRegistry();
  registry.register(tool);
  assert.equal(registry.byCapability("file.read")[0]?.name, "read_file");
  const descriptor = toSkillDescriptor({ name: "file-analysis", description: "Analyze files", capabilities: ["file.read"] });
  assert.equal(skillsForCapabilities([descriptor], ["file.read"]).length, 1);
});

test("context selection is bounded and memory is scoped", async () => {
  const selected = selectContext([
    { id: "required", kind: "task", priority: 100, estimatedTokens: 8, content: "task", required: true },
    { id: "optional", kind: "history", priority: 1, estimatedTokens: 100, content: "history" },
  ], 20);
  assert.deepEqual(selected.map((source) => source.id), ["required"]);
  const store = new InMemoryStore();
  await store.write({ scope: "PROJECT", content: "decision" });
  assert.equal((await store.read("PROJECT", "decision")).length, 1);
  assert.equal((await store.read("SESSION", "decision")).length, 0);
});
