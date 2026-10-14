/**
 * C1 probe — throwaway measurement, NOT a pin. Lives in gitignored workspace/.
 *
 * Question: after the D1 reversal, a mid-execution policy refusal is CONTINUEd
 * by recovery. Does the task still survive to the end of the turn, or does the
 * VALIDATION/finalisation path fail it anyway?
 *
 * Read from source before measuring, both readings live:
 *   - observeToolResult:1270  !result.success -> {INVALID, validator:"pi-result"}
 *   - observeToolResult:1294  INVALID -> this.attemptBlocked = true
 *   - finishTask:1807         attemptBlocked -> advance("FAILED", "...could not be verified")
 */
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KernelAdapter } from "../platform/pi/kernel-adapter.ts";
import { toolDescriptorFromPi } from "../platform/pi/tool-adapter.ts";
import { buildPolicy } from "../platform/pi/project-config.ts";
import { parsePolicyConfig, type PolicyConfig } from "../platform/core/policy-config.ts";

const RULES = {
  version: 1,
  deniedTools: ["bash"],
  allowedTools: [],
  fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
  destructiveCommandPatterns: ["rm -rf"],
  destructiveCommandTokens: ["rm"],
  limits: { maxToolCallsPerTask: 40, maxFileWritesPerTask: 10, maxBytesPerWrite: 2_000_000 },
  onViolation: "block",
} as const;

const DENIAL_REASON = "policy <d1-policy.json> denied 'read': path 'secrets.md' is outside the allowed roots";

const dir = await mkdtemp(path.join(os.tmpdir(), "nf-c1-"));
const policyConfig: PolicyConfig = parsePolicyConfig({ ...RULES }, "d1-policy.json");
const adapter = new KernelAdapter();
adapter.setPolicy(buildPolicy({ policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] }, dir, policyConfig));
for (const name of ["read", "bash", "write"]) {
  adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
}
await adapter.beginTask("do the work", "do the work");

const callId = "call-1";
const pre = await adapter.precheckToolCall("read", "execute", { path: "secrets.md" }, undefined, callId);
console.log("precheck          :", pre.decision.decision);
const bound = await adapter.beginToolExecution(callId, "read");
console.log("execution bound   :", Boolean(bound));
const validation = await adapter.recordToolResult(callId, "read", undefined, true, undefined, DENIAL_REASON);
console.log("returned to caller:", JSON.stringify(validation));
console.log("task status now   :", adapter.currentTask.status);
console.log("failureReason now :", adapter.currentTask.failureReason ?? "(none)");
console.log("diagnostics       :", JSON.stringify(adapter.diagnostics));

// Now the turn ends, exactly as the orchestrator would end it.
const finished = await adapter.finishTask("done");
console.log("--- after finishTask ---");
console.log("task status       :", finished.status);
console.log("failureReason     :", finished.failureReason ?? "(none)");
console.log("observations      :", JSON.stringify(finished.observations));
console.log("validationResults :", JSON.stringify(finished.validationResults));
console.log("event types       :", JSON.stringify(adapter.recentEvents(500).map((e) => e.type)));
