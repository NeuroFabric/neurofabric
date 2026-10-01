import path from "node:path";
import { KernelAdapter } from "../pi/kernel-adapter.ts";
import { WorkspaceBoundary } from "../core/workspace.ts";
import { buildPolicy, resolveAllowedRoots, type NeurofebricProjectConfig } from "../pi/project-config.ts";
import { csvRead, renderPage, STAGE1_CAPABILITIES, type CsvReadResult } from "./capabilities.ts";
import type { PolicyConfig, PolicyEngine } from "../core/index.ts";

/**
 * The product spine. See `platform/conductor/DESIGN.md` for the design and the
 * one rule it is built on: the kernel is a black box.
 *
 * Every state below is either a kernel state or a state the kernel deliberately
 * does not have (asking a human is not an action, so it is not governed). Every
 * capability runs as a real governed tool call through the same four calls the
 * Pi bridge uses: precheck, bind, observe, record. Nothing here reaches into
 * recovery, edits a limit, or interprets a policy.
 */

/** The product's clarify budget, from PRODUCT.md. Not a kernel limit. */
export const MAX_CLARIFY_ROUNDS = 3;

/**
 * Ruling 3's escalation threshold. Also a product rule, not a kernel control: the
 * kernel makes the refusal count readable, and the product decides when a human
 * is worth interrupting for. Three matches the clarify budget on purpose — the
 * agent gets the same number of chances to rephrase as it does to be asked.
 */
export const REFUSAL_ESCALATION_THRESHOLD = 3;

export type ConductorState =
  | "ASK" | "CLARIFY" | "PLAN" | "EXECUTE" | "DELIVER" | "ITERATE"
  | "CLARIFY_EXHAUSTED" | "FAILED";

export interface ProgressEvent {
  /** What the Conductor is doing. */
  state: ConductorState;
  /** The kernel event this was derived from, when it came from one. */
  kernelEvent?: string;
  detail?: string;
  at: string;
}

export interface ClarifyQuestion {
  /** Machine-readable, so a caller can route it without reading prose. */
  code: "MISSING_INPUT_FILE" | "AMBIGUOUS_CSV" | "UNSUPPORTED_REQUEST" | "MISSING_MEASURE";
  question: string;
  /** Enough for a person or a UI to answer it. */
  detail?: Record<string, unknown>;
}

/**
 * What a run ended with. Always explicit: there is no path through this
 * conductor that ends without an outcome a caller can read.
 */
export interface ConductorResult {
  status: "DELIVERED" | "CLARIFY_EXHAUSTED" | "FAILED";
  state: ConductorState;
  /** The questions that were asked, in order, including any left unanswered. */
  questions: ClarifyQuestion[];
  clarifyRounds: number;
  /** Produced artifacts, referenced by path. */
  artifacts: string[];
  /** Set when the run did not deliver. Never a bare string: always structured. */
  failure?: { code: string; reason: string; kernelReasonCode?: string };
  /** Every kernel event the run produced, in order. */
  kernelEvents: { type: string; payload: Record<string, unknown> }[];
  progress: ProgressEvent[];
}

export interface ConductorOptions {
  cwd: string;
  projectConfig?: NeurofebricProjectConfig;
  policyConfig?: PolicyConfig;
  /** Injected for tests; defaults to the project's own policy composition. */
  policy?: PolicyEngine;
}

export class Conductor {
  private readonly kernel: KernelAdapter;
  private readonly cwd: string;
  private readonly boundary: WorkspaceBoundary;
  private progress: ProgressEvent[] = [];

  constructor(private readonly options: ConductorOptions) {
    this.cwd = options.cwd;
    this.kernel = new KernelAdapter();
    const config = options.projectConfig ?? { policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] };
    this.boundary = new WorkspaceBoundary(resolveAllowedRoots(config, options.cwd));
    this.kernel.setBoundary(this.boundary);
    this.kernel.setPolicy(options.policy ?? buildPolicy(config, options.cwd, options.policyConfig));
    this.kernel.registerTools(STAGE1_CAPABILITIES);
  }

  /** The kernel, exposed read-only for telemetry. Not a second control plane. */
  get adapter(): KernelAdapter { return this.kernel; }

  private emit(state: ConductorState, detail?: string, kernelEvent?: string): void {
    this.progress.push({ state, detail, kernelEvent, at: new Date().toISOString() });
  }

  /**
   * ASK -> CLARIFY -> PLAN -> EXECUTE -> DELIVER -> ITERATE.
   *
   * `resolve` is the seam where a model replaces the deterministic planner: it
   * answers the Conductor's questions and nothing else. It is a parameter rather
   * than a hard-coded call so that swapping in a model does not rewrite the loop.
   */
  async run(
    request: string,
    options: {
      /** Answers a question. Returns undefined when it cannot. */
      resolve?: (question: ClarifyQuestion) => string | undefined;
      /** Where the dashboard is written, when the request implies one. */
      output?: string;
    } = {},
  ): Promise<ConductorResult> {
    this.emit("ASK", request);
    const kernelEvents: { type: string; payload: Record<string, unknown> }[] = [];
    const off = this.kernel.events.subscribe((event) => {
      kernelEvents.push({ type: event.type, payload: event.payload as Record<string, unknown> });
    });

    try {
      // --- CLARIFY (bounded, and never silent) ---
      this.emit("CLARIFY");
      const questions: ClarifyQuestion[] = [];
      let rounds = 0;
      let input = this.locateInput(request);
      while (input === undefined && rounds < MAX_CLARIFY_ROUNDS) {
        rounds += 1;
        const question: ClarifyQuestion = { code: "MISSING_INPUT_FILE", question: "Which CSV file should I read?", detail: { request } };
        questions.push(question);
        const answer = options.resolve?.(question);
        if (answer === undefined) {
          // The round produced no answer. That is a fact about the run, so it is
          // reported as one, rather than retried until the bound hides it.
          this.emit("CLARIFY", `round ${rounds}: unanswered`);
          continue;
        }
        input = this.locateInput(answer);
        this.emit("CLARIFY", `round ${rounds}: ${input ?? "still unresolved"}`);
      }

      if (input === undefined) {
        this.emit("CLARIFY_EXHAUSTED");
        return {
          status: "CLARIFY_EXHAUSTED",
          state: "CLARIFY_EXHAUSTED",
          questions, clarifyRounds: rounds, artifacts: [], kernelEvents, progress: this.progress,
          failure: {
            code: "CLARIFY_EXHAUSTED",
            reason: `No CSV input after ${rounds} clarify round(s); the last question was: "${questions.at(-1)?.question ?? "none asked"}"`,
          },
        };
      }

      // --- PLAN (the kernel takes over here) ---
      this.emit("PLAN", input);
      await this.kernel.beginTask(request, request, { input });

      // --- EXECUTE: two governed calls, through the real bridge sequence ---
      this.emit("EXECUTE", "csv_read");
      const read = await this.callTool("csv-read-1", "csv_read", { path: input });
      if (!read.ok) return this.failed(read.failure, questions, rounds, kernelEvents);

      // A malformed file is a QUESTION, not a crash. The run stops and asks.
      const csv = read.value as CsvReadResult;
      if (csv.problems.length > 0) {
        const question: ClarifyQuestion = {
          code: "AMBIGUOUS_CSV",
          question: `"${path.basename(input)}" is malformed: ${csv.problems[0]}. Repair it, or tell me to continue with the rows that parsed.`,
          detail: { problems: csv.problems, path: input },
        };
        questions.push(question);
        const answer = options.resolve?.(question);
        if (answer === undefined) {
          this.emit("CLARIFY_EXHAUSTED", "the CSV is malformed and no repair instruction was given");
          return {
            status: "CLARIFY_EXHAUSTED",
            state: "CLARIFY_EXHAUSTED",
            questions, clarifyRounds: rounds + 1, artifacts: [], kernelEvents, progress: this.progress,
            failure: { code: "MALFORMED_CSV", reason: question.question, },
          };
        }
      }

      this.emit("EXECUTE", "render_page");
      const rendered = await this.callTool("render-1", "render_page", {
        path: options.output ?? path.join(this.cwd, "workspace", "dashboard.html"),
        title: "Sales dashboard",
        columns: csv.columns,
        sample: csv.sample,
        rowCount: csv.rowCount,
      });
      if (!rendered.ok) return this.failed(rendered.failure, questions, rounds, kernelEvents);

      // --- DELIVER ---
      const task = await this.kernel.finishTask({ ok: true });
      this.emit("DELIVER", task.status);
      const artifacts = this.kernel.artifacts.map((artifact) => artifact.reference);
      if (task.status !== "COMPLETED") {
        return this.failed({ code: task.failureReason ?? "TASK_NOT_COMPLETED", reason: task.failureReason ?? "the task did not complete" }, questions, rounds, kernelEvents);
      }
      return { status: "DELIVERED", state: "DELIVER", questions, clarifyRounds: rounds, artifacts, kernelEvents, progress: this.progress };
    } finally {
      off();
    }
  }

  private failed(
    failure: { code: string; reason: string },
    questions: ClarifyQuestion[], rounds: number,
    kernelEvents: { type: string; payload: Record<string, unknown> }[],
  ): ConductorResult {
    this.emit("FAILED", failure.code);
    return { status: "FAILED", state: "FAILED", questions, clarifyRounds: rounds, artifacts: [], kernelEvents, progress: this.progress, failure };
  }

  /**
   * ONE governed tool call, in the exact order the Pi bridge uses.
   *
   * The order is the whole contract and it is not negotiable: `tool_execution_start`
   * binds BEFORE the preflight refuses, because a call that is refused after it
   * has bound is one whose reason can still reach recovery. Reverse it and a
   * refusal is discarded as out-of-order, which is the pre-bridge defect.
   */
  private async callTool(
    callId: string, tool: string, input: Record<string, unknown>,
  ): Promise<{ ok: true; value: unknown } | { ok: false; failure: { code: string; reason: string } }> {
    const bound = await this.kernel.beginToolExecution(callId, tool, { toolCallId: callId });
    if (bound === undefined) {
      return { ok: false, failure: { code: "CALL_NOT_BOUND", reason: `the kernel refused to bind ${tool} (task is ${this.kernel.currentTask?.status})` } };
    }
    const precheck = await this.kernel.precheckToolCall(tool, "execute", input, undefined, callId);
    const decision = precheck.decision;
    if (decision.decision === "DENY") {
      // Declared before the call runs, exactly as the bridge does it, so the
      // artifact is verified once it exists rather than assumed.
      await this.kernel.declareToolOutputs(callId, tool, input);
      await this.kernel.recordToolResult(callId, tool, undefined, true, undefined, decision.reason, decision.violation, decision.tier);
      return { ok: false, failure: { code: `POLICY_${decision.tier ?? "SOFT_REFUSE"}`, reason: decision.reason } };
    }
    if (decision.decision === "REQUIRE_APPROVAL") {
      // An approval gate that survived precheck authorises nothing, so the tool
      // must not run. It is NOT a policy violation: the decision carries no
      // ViolationAction and no tier. Reporting it as SOFT_REFUSE would invent a
      // refusal the policy never made, so it is recorded under its own code.
      await this.kernel.declareToolOutputs(callId, tool, input);
      await this.kernel.recordToolResult(callId, tool, undefined, true, undefined, decision.reason);
      return { ok: false, failure: { code: "APPROVAL_REQUIRED", reason: decision.reason } };
    }
    await this.kernel.declareToolOutputs(callId, tool, input);
    try {
      const value = tool === "csv_read"
        ? await csvRead({ path: String(input.path) }, { boundary: this.boundary })
        : await renderPage(input as Parameters<typeof renderPage>[0]);
      await this.kernel.recordToolResult(callId, tool, value, false);
      return { ok: true, value };
    } catch (error) {
      // An ordinary failure. It goes to the kernel as an ordinary failure, which
      // is the whole of D4B: the kernel retries it before it replans, and the
      // Conductor never invents its own recovery.
      await this.kernel.recordToolResult(callId, tool, undefined, true);
      return { ok: false, failure: { code: "TOOL_ERROR", reason: error instanceof Error ? error.message : String(error) } };
    }
  }

  /**
   * The one input this conductor understands. Anything that does not resolve to
   * a CSV inside the workspace becomes a clarify question rather than a guess.
   */
  private locateInput(text: string): string | undefined {
    const match = /[\w./\\-]+\.csv\b/i.exec(text);
    if (match === null) return undefined;
    const resolved = path.resolve(this.cwd, match[0]);
    return this.boundary.check(resolved).allowed ? resolved : undefined;
  }
}