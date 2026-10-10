import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export interface PolicyResult {
  confidence: number;
  blastRadius: string;
  action: "AUTO_APPROVE" | "HITL_REQUIRED" | "REJECT";
  gate?: string;
}

export class PolicyEvaluator {
  private static policyCache: string | null = null;

  public static loadPolicy(): string | null {
    try {
      const policyPath = path.resolve(process.cwd(), "policies", "embassy_rules.yaml");
      if (existsSync(policyPath)) {
        this.policyCache = readFileSync(policyPath, "utf8");
        return this.policyCache;
      }
    } catch (e) {
      console.warn("[PolicyEvaluator] Could not load embassy_rules.yaml:", e);
    }
    return null;
  }

  public static evaluateProposal(
    service: string,
    errorCount: number = 0,
    errorRate: number = 0
  ): PolicyResult {
    let confidence = 88;
    let blastRadius = "15%";
    let action: "AUTO_APPROVE" | "HITL_REQUIRED" | "REJECT" = "HITL_REQUIRED";

    if (service.includes("gateway") || service.includes("ingress")) {
      blastRadius = "25%";
      confidence = errorCount > 50 ? 75 : 88;
    } else if (service.includes("redis") || service.includes("cache")) {
      blastRadius = "10%";
      confidence = 92;
    }

    if (errorRate > 0.5) {
      action = "HITL_REQUIRED";
    } else if (confidence >= 90 && parseInt(blastRadius, 10) <= 10) {
      action = "AUTO_APPROVE";
    } else {
      action = "HITL_REQUIRED";
    }

    return { confidence, blastRadius, action, gate: action };
  }

  public static evaluateGate(
    service: string,
    errorCount: number = 0,
    errorRate: number = 0
  ): PolicyResult {
    return this.evaluateProposal(service, errorCount, errorRate);
  }
}

export default PolicyEvaluator;