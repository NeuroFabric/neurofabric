import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverSkills, formatSkillCatalog } from "../../platform/skill-registry.mjs";
import { KernelAdapter } from "../../platform/pi/kernel-adapter.ts";
import { PiApprovalProvider } from "../../platform/pi/approval.ts";
import { toolDescriptorFromPi } from "../../platform/pi/tool-adapter.ts";
import { buildPolicy, loadProjectPolicy, resolveAllowedRoots, type NeurofebricProjectConfig } from "../../platform/pi/project-config.ts";
import { WorkspaceBoundary } from "../../platform/core/workspace.ts";
import { createRedactingSink, redactPreview } from "../../platform/core/redaction.ts";

type TraceEntry = {
  type: string;
  timestamp: string;
  details?: Record<string, unknown>;
};

let persistTrace: ((entry: TraceEntry) => void) | undefined;


/**
 * Record a trace entry.
 *
 * Redaction happens on the way OUT, at the persistence sink installed below,
 * which is wrapped once so that no caller — including a future one — can write
 * an unredacted entry to session history.
 *
 * There is deliberately no in-memory buffer here. An earlier version kept a
 * 100-entry ring of raw, unredacted details that nothing ever read, so it was
 * unredacted state retained with no consumer, and one line wiring it into the
 * `platform` command would have surfaced whatever the entry carried. Its
 * comment also claimed redaction on the way in, which this function never did.
 */
function record(type: string, details?: Record<string, unknown>): void {
  const entry: TraceEntry = { type, timestamp: new Date().toISOString(), details };
  persistTrace?.(entry);
}

// F-006 bridge: Pi's `tool_call` preflight is the only place a denial reason
// exists; Pi's `tool_execution_end` carries only a boolean `isError`. A blocked
// call still emits tool_execution_end with isError=true, so without this map
// recordToolResult sees a generic tool failure and the recovery budget burns
// on a policy denial (the death shape). Written at the deny site, read and
// deleted at the record site, cleared per task in before_agent_start. Closes
// the EXTERNAL-WIRING LIMITATION documented at kernel-adapter.ts:1348.
const pendingDenialReasons = new Map<string, string>();


export default function platformOrchestrator(pi: ExtensionAPI): void {
  // The ONLY write path into Pi session history. It is wrapped in the shared
  // redactor so nothing can bypass sanitization by calling appendEntry here.
  persistTrace = createRedactingSink((entry: TraceEntry) => pi.appendEntry("platform-trace", entry));
  // Pi remains the only agent loop; this adapter only translates lifecycle events into kernel state.
  const kernel = new KernelAdapter();
  let config: NeurofebricProjectConfig | undefined;
  let policySource = "tier policy only";

  kernel.events.subscribe((event) => record(event.type, event.payload));

  pi.on("resources_discover", (event) => ({
    skillPaths: [path.join(event.cwd, "skills")],
  }));

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    // Resolve the trust model and the declarative policy before any tool call can
    // be evaluated. A malformed policy file throws here, at startup, by design.
    const loaded = await loadProjectPolicy(ctx.cwd);
    config = loaded.config;
    policySource = loaded.policyConfig ? path.basename(loaded.policyConfig.source) : policySource;
    kernel.setPolicy(buildPolicy(loaded.config, ctx.cwd, loaded.policyConfig));
    // Artifact verification is bounded by the SAME resolved roots policy
    // evaluation uses. Without this the production adapter checked that a
    // declared output exists but never that it lives inside the workspace, so
    // a write outside the approved roots verified as a normal artifact. The
    // policy still makes the decision; this only makes verification agree
    // with it.
    kernel.setBoundary(new WorkspaceBoundary(resolveAllowedRoots(loaded.config, ctx.cwd)));

    const tools = pi.getAllTools().map((tool) => toolDescriptorFromPi({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    kernel.registerTools(tools);
    const knownTools = tools.map((tool) => tool.name);
    const skills = await discoverSkills(path.join(ctx.cwd, "skills"), { knownTools });
    kernel.setSkills(skills);
    record("session_start", {
      toolCount: tools.length,
      skillCount: skills.length,
      policyMode: config.policyMode,
      allowedRoots: config.allowedRoots,
      policyConfig: policySource,
    });
  });



  pi.on("before_agent_start", async (event, ctx) => {
    pendingDenialReasons.clear(); // per-task bound: a leak can span one turn at most
    // A task is created per user turn. Pi still owns the conversation and model call.
    const task = await kernel.beginTask(event.prompt, event.prompt, { cwd: ctx.cwd });
    record("task_received", { taskId: task.taskId, promptPreview: redactPreview(event.prompt) });
  });

  // `tool_call` is a PREFLIGHT hook. Several can fire for one assistant message
  // before any tool actually runs, so this stage performs policy evaluation
  // ONLY and must never mutate the kernel task lifecycle.
  pi.on("tool_call", async (event, ctx) => {
    if (!kernel.currentTask) return undefined;

    // In TRUSTED_PROJECT mode the kernel policy returns ALLOW or DENY and never
    // escalates, so no approval provider is constructed and no confirmation
    // dialog can be raised. This is the code path that used to prompt
    // "Neurofebric policy approval" for every bash/edit/write call.
    const trusted = kernel.policy.mode === "TRUSTED_PROJECT";
    const approval = trusted
      ? undefined
      : new PiApprovalProvider(ctx.hasUI, async (prompt) => {
        return (await ctx.ui.confirm("Neurofebric policy approval", prompt)) === true;
      });

    const decision = await kernel.precheckToolCall(event.toolName, "execute", event.input, approval, event.toolCallId);
    
    // Capture the output references this call declares so they can be verified
    // once Pi reports the result. `tool_call` is the only lifecycle event that
    // carries the tool input.
    const declared = kernel.declareToolOutputs(event.toolCallId, event.toolName, event.input);
    record("policy_decision", {
      tool: event.toolName,
      toolCallId: event.toolCallId,
      decision: decision.decision,
      // `violation` is present ONLY when policy actually evaluated the call and
      // escalated the denial. A terminal-state refusal carries `refusal` instead:
      // nothing was evaluated, so no rule was broken. The two must never be
      // conflated, and there is deliberately no `?? "block"` fallback.
      violation: decision.decision.decision === "DENY" ? decision.decision.violation : undefined,
      refusal: decision.decision.decision === "DENY" ? decision.decision.refusal : undefined,
      declaredOutputs: declared.length,
      taskStatus: kernel.currentTask.status,
      // Augment refusal with model metadata when available.
      ...(decision.decision.decision === "DENY" && decision.decision.refusal === "task_terminal"
        ? { responseId: event.responseId, responseModel: event.responseModel }
        : {}),
    });
    if (decision.decision.decision !== "ALLOW") {
      // `decision.reason` is present on both DENY and REQUIRE_APPROVAL.
       pendingDenialReasons.set(event.toolCallId, decision.decision.reason);
      return { block: true, reason: decision.decision.reason };
    }
    return undefined;
  });

  // `tool_execution_start` is the real execution. This is where the tool call is
  // bound to the task, a plan/step is created, the plan is validated and the task
  // moves PLANNING -> PLAN_VALIDATION -> EXECUTING.
  pi.on("tool_execution_start", async (event) => {
    if (!kernel.currentTask) return;
    const bound = await kernel.beginToolExecution(event.toolCallId, event.toolName, { toolCallId: event.toolCallId });
    record("tool_execution_start", {
      toolCallId: event.toolCallId,
      tool: event.toolName,
      bound: Boolean(bound),
      taskStatus: kernel.currentTask.status,
    });
  });

  // `tool_execution_end` is observation and validation of a real bound execution.
  pi.on("tool_execution_end", async (event) => {
    if (!kernel.currentTask) return;
    // Pi owns the actual result shape; the kernel normalizes it against the
    // bound execution identity so task/step correlation cannot drift.
    //
    // F-006 Phase 2a: `recordToolResult` takes a fifth `errorRetryable`
    // argument and defaults it to false. It is NOT passed here because Pi's
    // `tool_execution_end` event carries a boolean `isError` and nothing that
    // says whether a repeat could succeed — so there is no real value to
    // forward yet, and inventing one would be guessing at an external
    // contract. When Pi (or a tool) surfaces that, this is the one line that
    // has to change, and the flag is already honoured end to end.
       const denialReason = pendingDenialReasons.get(event.toolCallId);
    pendingDenialReasons.delete(event.toolCallId);
    await kernel.recordToolResult(event.toolCallId, event.toolName, event.result, event.isError, undefined, denialReason);
    record("tool_execution_end", { toolCallId: event.toolCallId, tool: event.toolName, isError: event.isError, artifacts: kernel.artifacts.length, taskStatus: kernel.currentTask.status });
  });

  pi.on("agent_end", async (event) => {
    if (!kernel.currentTask) return;
    const lastMessage = [...event.messages].reverse().find((message) => message.role === "assistant");
    await kernel.finishTask(lastMessage);
    record("agent_end", { taskId: kernel.currentTask.taskId, status: kernel.currentTask.status });
  });

  pi.registerCommand("platform", {
    description: "Show Neurofebric kernel status and recent trace",
    handler: async (_args, ctx) => {
      const task = kernel.currentTask;
      const events = kernel.recentEvents().slice(-10).map((event) => `${event.timestamp} ${event.type}`).join("\n");
      const mode = config ? `${config.policyMode} (roots: ${config.allowedRoots.join(", ")})` : kernel.policy.mode;
      const skillSummary = formatSkillCatalog(kernel.skills);
      const artifacts = kernel.artifacts.length
        ? kernel.artifacts.map((a) => `- ${a.reference} [${a.type}] ${a.trust}`).join("\n")
        : "- No artifacts recorded.";
      const status = `${task ? `Task ${task.taskId}: ${task.status}` : "No active task"}\nPolicy: ${mode}\nArtifacts:\n${artifacts}
Skills:
${skillSummary}`;
      ctx.ui.notify(`${status}\n\nRecent events:\n${events || "No events yet"}`, "info");
    },
  });
}
