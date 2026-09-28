import { CoreError, type Plan, type Planner, type PlannerInput } from "../core/index.ts";
import { validatePlan } from "../core/plan.ts";

export interface StructuredModelAdapter {
  generatePlan(input: PlannerInput): Promise<unknown>;
}

function retryPolicy() {
  return { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 };
}

function parsePlan(value: unknown): Plan {
  if (!value || typeof value !== "object") throw new CoreError("PLANNING_ERROR", "Planner output must be an object");
  const candidate = value as Partial<Plan>;
  if (typeof candidate.planId !== "string" || typeof candidate.objective !== "string" || !Array.isArray(candidate.steps)) {
    throw new CoreError("PLANNING_ERROR", "Planner output is missing planId, objective, or steps");
  }
  const steps = candidate.steps.map((step, index) => {
    if (!step || typeof step !== "object") throw new CoreError("PLANNING_ERROR", `Planner step ${index} is invalid`);
    const value = step as unknown as Record<string, unknown>;
    if (typeof value.stepId !== "string" || typeof value.description !== "string" || !Array.isArray(value.tools) || !Array.isArray(value.dependencies)) {
      throw new CoreError("PLANNING_ERROR", `Planner step ${index} is missing required fields`);
    }
    return {
      stepId: value.stepId,
      description: value.description,
      skill: typeof value.skill === "string" ? value.skill : undefined,
      tools: value.tools.filter((tool): tool is string => typeof tool === "string"),
      dependencies: value.dependencies.filter((dependency): dependency is string => typeof dependency === "string"),
      expectedOutput: typeof value.expectedOutput === "string" ? value.expectedOutput : "result",
      validationCriteria: Array.isArray(value.validationCriteria) ? value.validationCriteria.filter((item): item is string => typeof item === "string") : ["result is present"],
      retryPolicy: retryPolicy(),
      timeoutMs: typeof value.timeoutMs === "number" ? value.timeoutMs : 30_000,
      status: "PENDING" as const,
    };
  });
  return {
    planId: candidate.planId,
    objective: candidate.objective,
    assumptions: Array.isArray(candidate.assumptions) ? candidate.assumptions.filter((item): item is string => typeof item === "string") : [],
    steps,
    selectedSkills: Array.isArray(candidate.selectedSkills) ? candidate.selectedSkills.filter((item): item is string => typeof item === "string") : [],
    selectedTools: Array.isArray(candidate.selectedTools) ? candidate.selectedTools.filter((item): item is string => typeof item === "string") : [],
    expectedOutputs: Array.isArray(candidate.expectedOutputs) ? candidate.expectedOutputs.filter((item): item is string => typeof item === "string") : [],
    validationCriteria: Array.isArray(candidate.validationCriteria) ? candidate.validationCriteria.filter((item): item is string => typeof item === "string") : [],
    riskLevel: candidate.riskLevel === "CONTROLLED" || candidate.riskLevel === "WRITE" || candidate.riskLevel === "DESTRUCTIVE" ? candidate.riskLevel : "READ_ONLY",
  };
}

export class StructuredModelPlanner implements Planner {
  private readonly model: StructuredModelAdapter;

  constructor(model: StructuredModelAdapter) {
    this.model = model;
  }

  async createPlan(input: PlannerInput): Promise<Plan> {
    const plan = parsePlan(await this.model.generatePlan(input));
    validatePlan(plan, input.availableSkills, input.availableTools);
    return plan;
  }

  async replan(input: PlannerInput & { previousPlan: Plan }): Promise<Plan> {
    return this.createPlan(input);
  }
}
