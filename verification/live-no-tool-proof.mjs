// Live proof for the no-tool finalisation lifecycle.
// Replays the orchestrator's real handlers, including the re-entrancy that
// produced the live crash: agent_end fires from inside the TASK_CREATED sink,
// while beginTask is still in flight.
import { pathToFileURL } from "node:url";
import path from "node:path";
const ROOT = path.resolve(import.meta.dirname, "..");
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { KernelAdapter } = await imp("platform/pi/kernel-adapter.ts");
const { toolDescriptorFromPi } = await imp("platform/pi/tool-adapter.ts");
const { buildPolicy, loadProjectPolicy } = await imp("platform/pi/project-config.ts");

const cfg = await loadProjectPolicy(ROOT);
const mk = () => {
  const k = new KernelAdapter();
  k.setPolicy(buildPolicy(cfg.config, ROOT, cfg.policyConfig));
  for (const n of ["read", "bash", "write", "edit", "grep", "find", "ls"]) {
    k.registerTools([toolDescriptorFromPi({ name: n, description: n })]);
  }
  return k;
};

console.log("1. re-entrant agent_end during beginTask (the live crash):");
const k1 = mk();
let reenter = true;
k1.events.subscribe(async (e) => {
  if (e.type === "TASK_CREATED" && reenter) {
    reenter = false;
    try {
      const t = await k1.finishTask({ role: "assistant", content: [{ type: "text", text: "The answer is 42." }] });
      console.log("   re-entrant agent_end status=" + t.status);
    } catch (err) {
      console.log("   re-entrant agent_end THREW: " + err.message);
    }
  }
});
await k1.beginTask("live no-tool proof");
console.log("   state after re-entrant agent_end = " + k1.currentTask.status);

console.log("");
console.log("2. normal no-tool completion:");
const k2 = mk();
await k2.beginTask("plain answer");
const done = await k2.finishTask({ role: "assistant", content: [{ type: "text", text: "The answer is 42." }] });
console.log("   status=" + done.status + "  failureReason=" + (done.failureReason ?? "<none>"));
console.log("   walked: " + k2.transitions.map((t) => t.from + "->" + t.to).join("  "));

console.log("");
console.log("3. F-003 shape: two blocks then toolCall-only end:");
const k3 = mk();
await k3.beginTask("blocked only");
for (const id of ["b1", "b2"]) {
  const r = await k3.precheckToolCall("bash", "execute", { command: "cat /etc/passwd" }, undefined, id);
  console.log("   [" + id + "] " + r.decision.decision + " violation=" + r.decision.violation + " refusal=" + r.decision.refusal);
}
const f = await k3.finishTask({ role: "assistant", content: [{ type: "toolCall", toolCallId: "b2", toolName: "bash" }] });
console.log("   status=" + f.status + "  failureReason=" + (f.failureReason ?? "<none>"));
console.log("   diagnostics: denials=" + k3.diagnostics.denialCount + " executions=" + k3.diagnostics.toolExecutionCount);

console.log("");
console.log("4. explicit abort stays terminal:");
const k4 = mk();
await k4.beginTask("abort");
await k4.abortTask("operator abort");
const later = await k4.precheckToolCall("read", "execute", { path: "README.md" }, undefined, "r1");
console.log("   after abort=" + k4.currentTask.status);
console.log("   later call: " + later.decision.decision + " violation=" + later.decision.violation + " refusal=" + later.decision.refusal);
console.log("   bound=" + (await k4.beginToolExecution("r1", "read", {})));
console.log("   diagnostics: terminalRefusals=" + k4.diagnostics.terminalRefusalCount + " denials=" + k4.diagnostics.denialCount);
