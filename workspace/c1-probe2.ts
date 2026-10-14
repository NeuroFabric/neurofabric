/**
 * C1 probe 2 — sibling shape. Throwaway measurement, gitignored workspace/.
 *
 * Probe 1 measured the lone denial: task survives, recovery CONTINUEs.
 * This probe measures the shape where the denial is a SIBLING: it settles
 * while another execution is still in flight, so observeToolResult takes the
 * early return at :1300 (attemptBlocked = true, task stays EXECUTING), and the
 * LAST execution succeeds. finishTask:1807 then consults attemptBlocked.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
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

const dir = await mkdtemp(path.join(os.tmpdir(), "nf-c1b-"));
const policyConfig: PolicyConfig = parsePolicyConfig({ ...RULES }, "d1-policy.json");
const adapter = new KernelAdapter();
adapter.setPolicy(buildPolicy({ policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] }, dir, policyConfig));
for (const name of ["read", "write", "bash"]) {
  adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
}
await adapter.beginTask("do the work", "do the work");

// Two executions bound, as sibling tool calls in one assistant message are.
await adapter.precheckToolCall("read", "execute", { path: "secrets.md" }, undefined, "call-a");
const a = await adapter.beginToolExecution("call-a", "read");
await adapter.precheckToolCall("write", "execute", { path: "out.txt" }, undefined, "call-b");
const b = await adapter.beginToolExecution("call-b", "write");
console.log("bound A/B        :", Boolean(a), Boolean(b), "active:", adapter.diagnostics.activeExecutionCount);

// The refusal settles FIRST, while B is still in flight -> early return path.
const v1 = await adapter.recordToolResult("call-a", "read", undefined, true, undefined, DENIAL_REASON);
console.log("A (refused)      :", JSON.stringify(v1));
console.log("status now       :", adapter.currentTask.status, "attemptBlocked:", adapter.diagnostics.attemptBlocked);

// B then succeeds, and is the last execution in flight.
const target = path.join(dir, "out.txt");
await writeFile(target, "ok", "utf8");
const v2 = await adapter.recordToolResult("call-b", "write", { path: target, ok: true }, false);
console.log("B (succeeded)    :", JSON.stringify(v2));
console.log("status now       :", adapter.currentTask.status, "attemptBlocked:", adapter.diagnostics.attemptBlocked);

const finished = await adapter.finishTask("done");
console.log("--- after finishTask ---");
console.log("task status      :", finished.status);
console.log("failureReason    :", finished.failureReason ?? "(none)");
console.log("denial named?    :", JSON.stringify(finished.failureReason ?? "").includes("d1-policy.json"));
console.log("event types      :", JSON.stringify(adapter.recentEvents(500).map((e) => e.type)));
