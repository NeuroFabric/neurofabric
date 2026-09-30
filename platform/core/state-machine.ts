import { CoreError } from "./errors.ts";
import type { Task, TaskStatus } from "./types.ts";

const transitions: Record<TaskStatus, TaskStatus[]> = {
  RECEIVED: ["UNDERSTANDING", "CANCELLED", "FAILED"],
  UNDERSTANDING: ["PLANNING", "CANCELLED", "FAILED"],
  PLANNING: ["PLAN_VALIDATION", "CANCELLED", "FAILED"],
  PLAN_VALIDATION: ["EXECUTING", "REPLANNING", "CANCELLED", "FAILED"],
  EXECUTING: ["OBSERVING", "RECOVERING", "CANCELLED", "TIMEOUT", "FAILED"],
  OBSERVING: ["VALIDATING", "RECOVERING", "CANCELLED", "FAILED"],
  VALIDATING: ["PLANNING", "COMPLETED", "REPLANNING", "RECOVERING", "CANCELLED", "FAILED"],
  RECOVERING: ["PLANNING", "RETRYING", "REPLANNING", "EXECUTING", "ESCALATED", "CANCELLED", "FAILED"],
  RETRYING: ["PLANNING", "EXECUTING", "RECOVERING", "CANCELLED", "FAILED"],
  ESCALATED: ["CANCELLED", "FAILED", "COMPLETED"],
  REPLANNING: ["PLANNING", "PLAN_VALIDATION", "CANCELLED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  TIMEOUT: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from]?.includes(to) ?? false;
}

export function transitionTask(task: Task, to: TaskStatus, now = new Date().toISOString()): Task {
  if (!canTransition(task.status, to)) {
    throw new CoreError("TASK_ERROR", `Illegal task transition: ${task.status} -> ${to}`, { taskId: task.taskId });
  }
  if (task.status === "CANCELLED" || task.status === "COMPLETED" || task.status === "FAILED" || task.status === "TIMEOUT" || task.status === "ESCALATED") {
    throw new CoreError("TASK_ERROR", `Terminal task cannot transition: ${task.status} -> ${to}`, { taskId: task.taskId });
  }
  return { ...task, status: to, updatedAt: now };
}

export function assertTaskActive(task: Task): void {
  if (task.status === "CANCELLED" || task.status === "COMPLETED" || task.status === "FAILED" || task.status === "TIMEOUT" || task.status === "ESCALATED") {
    throw new CoreError("TASK_ERROR", `Task is not active: ${task.status}`, { taskId: task.taskId });
  }
}

export function createTask(input: {
  taskId: string;
  rootTaskId?: string;
  parentTaskId?: string;
  userRequest: string;
  objective: string;
  constraints?: Record<string, unknown>;
  priority?: Task["priority"];
  now?: string;
}): Task {
  const now = input.now ?? new Date().toISOString();
  return {
    taskId: input.taskId,
    parentTaskId: input.parentTaskId,
    rootTaskId: input.rootTaskId ?? input.taskId,
    userRequest: input.userRequest,
    objective: input.objective,
    constraints: input.constraints ?? {},
    priority: input.priority ?? "normal",
    status: "RECEIVED",
    createdAt: now,
    updatedAt: now,
    completedSteps: [],
    failedSteps: [],
    observations: [],
    artifacts: [],
    selectedSkills: [],
    selectedTools: [],
    validationResults: [],
    retryCount: 0,
    replanCount: 0,
    context: { estimatedTokens: 0, maxTokens: 200_000 },
    execution: {},
  };
}
