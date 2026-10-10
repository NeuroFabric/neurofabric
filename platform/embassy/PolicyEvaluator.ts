/**
 * DYNAMIC POLICY EVALUATOR — Evaluates ingested events against Embassy rules.
 *
 * Responsibilities:
 * 1. loadPolicy  — parse policies/embassy_rules.yaml and return the rule config.
 * 2. evaluateProposal  — given a service, error count, and error rate,
 *    compute confidence, blast radius, and action (AUTO_APPROVE | HITL_REQUIRED).
 *
 * Scoring logic:
 *   • Confidence starts at 50 (base). Each repeated error pattern adds 5 points,
 *     up to a max of 95. If confidence >= min_confidence (95) AND blast radius
 *     is within max_blast_radius_percent, action is AUTO_APPROVE.
 *   • Blast radius is computed as a percentage: 100 - (errorRate * sensitivity * 10),
 *     clamped to max_blast_radius_percent. If the resulting blast radius is low enough,
 *     the proposal can be auto-approved.
 *   • Otherwise, HITL_REQUIRED is returned, causing the system to present the
 *     proposal to an operator for review (via the existing HITL gate).
 */

// Simple YAML parser for the embassy rules format (no external dependencies).
function parseYaml(text: string): any {
  const lines = text.split("\n");
  const result: any = {};
  let currentPath: (string | number)[] = [];
  let current: any = result;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Top-level key: "key:"
    const keyMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:(.*)?$/);
    if (keyMatch) {
      const key = keyMatch[1];
      const value = keyMatch[2] ? keyMatch[2].trim() : "";
      currentPath = [key];
      current = result;
      // Set the key in the result object
      if (value === "") {
        // Key with no value — may have nested children
        current[key] = {};
      } else {
        current[key] = value;
      }
      continue;
    }

    // Nested key with indentation: "  subkey: value"
    const indentMatch = trimmed.match(/^(\s+)(.*)$/);
    if (indentMatch) {
      const indent = indentMatch[1];
      const content = indentMatch[2].trim();
      if (!content) continue;

      const depth = indent.length / 2; // 2-space indentation
      const keys: string[] = currentPath.slice(0, -1);
      let target = result;
      for (const k of keys) target = target[k];

      // Handle array items: "- item"
      if (content.startsWith("- ")) {
        const item = content.substring(2).trim();
        // Find the last key and add to array
        const lastKey = currentPath[currentPath.length - 1];
        if (Array.isArray(target[lastKey])) {
          target[lastKey].push(item);
        } else {
          target[lastKey] = [item];
        }
        continue;
      }

      // Regular nested key: "key: value" or "key:"
      const nestedMatch = content.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:(.*)?$/);
      if (nestedMatch) {
        const nestedKey = nestedMatch[1];
        const nestedValue = nestedMatch[2] ? nestedMatch[2].trim() : "";
        // Ensure the nested key exists
        if (!target[nestedKey]) target[nestedKey] = {};
        // If there's more depth, continue building
        if (depth > 1) {
          currentPath = [...currentPath, nestedKey];
          current = target[nestedKey];
        } else {
          if (nestedValue === "") {
            target[nestedKey] = {};
          } else {
            target[nestedKey] = nestedValue;
          }
        }
        continue;
      }
    }
  }
  return result;
}

/** Load the embassy rules from policies/embassy_rules.yaml. */
export function loadPolicy(): {
  auto_remediation: {
    min_confidence: number;
    max_blast_radius_percent: number;
    allowed_targets: string[];
  };
  hitl_escalation: {
    default_gate: string;
    anomaly_sensitivity: number;
  };
} {
  // In a production environment, read from the filesystem.
  // For now, return the hardcoded policy (same content as policies/embassy_rules.yaml).
  return {
    auto_remediation: {
      min_confidence: 95,
      max_blast_radius_percent: 10,
      allowed_targets: ["payment-gateway-service", "auth-session-worker"],
    },
    hitl_escalation: {
      default_gate: "MANUAL_APPROVAL_REQUIRED",
      anomaly_sensitivity: 0.85,
    },
  };
}

/**
 * Evaluate a telemetry proposal against Embassy policy.
 *
 * @param service       The service name generating the telemetry (e.g. "payment-gateway-service")
 * @param errorCount    Number of critical errors detected
 * @param errorRate     Error rate normalized to [0, 1] (e.g. 0.15 = 15%)
 * @returns             { confidence, blastRadius, action }
 *   • confidence: number in [0, 100], where >= min_confidence triggers auto-approve
 *   • blastRadius: number in [0, 100] representing percent, clamped to max_blast_radius_percent
 *   • action: 'AUTO_APPROVE' if criteria met, otherwise 'HITL_REQUIRED'
 */
export function evaluateProposal(
  service: string,
  errorCount: number,
  errorRate: number
): {
  confidence: number;
  blastRadius: number;
  action: "AUTO_APPROVE" | "HITL_REQUIRED";
} {
  const policy = loadPolicy();
  const { auto_remediation, hitl_escalation } = policy;

  // --- Compute confidence ---
  // Base confidence is 50. Each critical error adds 5 points, up to max 95.
  let confidence = 50 + errorCount * 5;
  if (confidence > 95) confidence = 95;

  // --- Compute blast radius ---
  // Blast radius = 100 - (errorRate * anomaly_sensitivity * 100), clamped to max_blast_radius_percent
  const rawBlastRadius = 100 - errorRate * hitl_escalation.anomaly_sensitivity * 100;
  const blastRadius = Math.min(Math.max(rawBlastRadius, 0), 100);
  const maxBlastRadius = auto_remediation.max_blast_radius_percent;

  // --- Determine action ---
  const meetsConfidence = confidence >= auto_remediation.min_confidence;
  const meetsBlastRadius = blastRadius <= maxBlastRadius;
  const isAllowedTarget = auto_remediation.allowed_targets.includes(service);

  let action: "AUTO_APPROVE" | "HITL_REQUIRED";
  if (meetsConfidence && meetsBlastRadius && isAllowedTarget) {
    action = "AUTO_APPROVE";
  } else {
    action = "HITL_REQUIRED";
  }

  return { confidence, blastRadius, action };
}

/**
 * Convert a PolicyEvaluator action into a blastRadius value and HITL gate decision.
 *
 * @param service       The service name
 * @param errorCount    Number of critical errors
 * @param errorRate     Error rate [0, 1]
 * @returns             { confidence, blastRadius, gate }
 *   • confidence: number [0, 100]
 *   • blastRadius: number [0, 100] percent
 *   • gate: 'AUTO_APPROVE' | 'MANUAL_APPROVAL_REQUIRED' | 'HITL_REQUIRED'
 */
export function evaluateGate(
  service: string,
  errorCount: number,
  errorRate: number
): {
  confidence: number;
  blastRadius: number;
  gate: "AUTO_APPROVE" | "MANUAL_APPROVAL_REQUIRED" | "HITL_REQUIRED";
} {
  const result = evaluateProposal(service, errorCount, errorRate);
  const policy = loadPolicy();

  let gate: "AUTO_APPROVE" | "MANUAL_APPROVAL_REQUIRED" | "HITL_REQUIRED";
  if (result.action === "AUTO_APPROVE") {
    gate = "AUTO_APPROVE";
  } else if (result.confidence >= policy.hitl_escalation.min_confidence) {
    // Confidence is high but some other condition failed — still requires HITL
    gate = "HITL_REQUIRED";
  } else {
    gate = hitl_escalation.default_gate;
  }

  return { ...result, gate };
}