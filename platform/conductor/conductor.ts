import path from "node:path";
import { KernelAdapter } from "../pi/kernel-adapter.ts";
import { WorkspaceBoundary } from "../core/workspace.ts";
import { buildPolicy, resolveAllowedRoots, type NeurofebricProjectConfig } from "../pi/project-config.ts";
import { csvRead, pdfRead, renderPage, sqliteRead, STAGE1_CAPABILITIES, type CsvReadResult, type PdfReadResult } from "./capabilities.ts";
import { PDF_READ, SQLITE_READ } from "./capabilities.ts";
import type { ToolDescriptor } from "../core/types.ts";
export const STAGE2_CAPABILITIES: ToolDescriptor[] = [SQLITE_READ, PDF_READ];
import { renderBottleneckReport, RENDER_BOTTLENECK_REPORT, toBottleneckMarkdown } from "./bottleneck-report.ts";
import { titleFor } from "./semantics.ts";
import { analyseBottlenecks, type BottleneckAnalysis } from "./bottlenecks.ts";
import { resolveSchemaMemory, type ResolvedSchema } from "./schema-memory.ts";
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
 * How much of the kernel's event history one run's stream is read back from.
 * Matches the bus's own retention, so a reconstructed stream can never be
 * shorter than the events the kernel retained for this task.
 */
const EVENT_HISTORY_LIMIT = 500;

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
  /** The Markdown report, when the run was asked for one. Never a guess at one. */
  report?: { markdown: string; analysis: BottleneckAnalysis; schema?: ResolvedSchema; pdf?: PdfReadResult };
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
  /**
   * Where `configs/default-schemas.json` lives. Defaults to `cwd`, which is the
   * product layout; the web server passes the install root so a data workspace
   * does not have to carry a copy of the schemas.
   */
  defaultsRoot?: string;
}

export class Conductor {
  private readonly kernel: KernelAdapter;
  private readonly cwd: string;
  private readonly boundary: WorkspaceBoundary;
  private progress: ProgressEvent[] = [];
  private readonly options: ConductorOptions;

  // `options` is a plain field rather than a constructor parameter property:
  // `npm run test:ts` runs the whole tree through --experimental-strip-types,
  // whose strip-only mode cannot erase parameter properties. Anything under
  // platform/ has to be erasable by stripping alone.
  constructor(options: ConductorOptions) {
    this.options = options;
    this.cwd = options.cwd;
    this.kernel = new KernelAdapter();
    const config = options.projectConfig ?? { policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] };
    this.boundary = new WorkspaceBoundary(resolveAllowedRoots(config, options.cwd));
    this.kernel.setBoundary(this.boundary);
    this.kernel.setPolicy(options.policy ?? buildPolicy(config, options.cwd, options.policyConfig));
    this.kernel.registerTools([...STAGE1_CAPABILITIES, ...STAGE2_CAPABILITIES, RENDER_BOTTLENECK_REPORT]);
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
      /**
       * `dashboard` (default) is the Stage 1 pair. `bottleneck` is the Stage 2
       * report: the same governed read, then the analysis, then a governed
       * WRITE of the report itself.
       */
      mode?: "dashboard" | "bottleneck";
      /** Report title, and the rendering the caller wants back. */
      title?: string;
      format?: "html" | "markdown";
    } = {},
  ): Promise<ConductorResult> {
    // The request text is NOT recorded here. This progress list travels to a
    // browser in the response body, and a request carries whatever filename a
    // person typed, so recording it verbatim hands that string back inside the
    // JSON the page renders. The resolved path is recorded at PLAN instead,
    // which is safe precisely because a name that survived locating is one the
    // filesystem could actually have.
    this.emit("ASK");
    // THE STREAM IS READ BACK FROM THE KERNEL, NOT FROM A SUBSCRIPTION.
    //
    // A subscription here silently lost the second half of every run. The
    // kernel emitted all fifteen records -- verified against the bus's own
    // history -- while this sink held eight, so a caller received a truncated
    // stream for a run that had in fact completed, and TASK_COMPLETED was
    // simply absent. The bus is not the kernel's stable identity across a run,
    // so a handle taken before `beginTask` is not a handle on the bus that
    // served it.
    //
    // The kernel's own history is the authoritative record: it is written
    // before delivery, it survives the bus being replaced, and scoping it to
    // this run's task id keeps it about THIS run. A stream reconstructed from
    // history cannot be missing an event the kernel recorded.
    let taskId = "";
    const taskEvents = (): { type: string; payload: Record<string, unknown> }[] =>
      taskId === "" ? [] : this.kernel.events.recent(EVENT_HISTORY_LIMIT)
        .filter((event) => event.taskId === taskId)
        .map((event) => ({ type: event.type, payload: event.payload as Record<string, unknown> }));

    try {
      // --- CLARIFY (bounded, and never silent) ---
      this.emit("CLARIFY");
      const questions: ClarifyQuestion[] = [];
      let rounds = 0;
      let input = this.locateInput(request);
      while (input === undefined && rounds < MAX_CLARIFY_ROUNDS) {
        rounds += 1;
        // The raw request is NOT echoed here. This detail travels back to a
        // browser in the response body, and a request can carry any filename a
        // person typed, so reflecting it verbatim hands an attacker's string
        // back inside the JSON the page renders.
        const question: ClarifyQuestion = { code: "MISSING_INPUT_FILE", question: "Which CSV file should I read?", detail: { requestLength: request.length } };
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
          questions, clarifyRounds: rounds, artifacts: [], kernelEvents: taskEvents(), progress: this.progress,
          failure: {
            code: "CLARIFY_EXHAUSTED",
            reason: `No CSV input after ${rounds} clarify round(s); the last question was: "${questions.at(-1)?.question ?? "none asked"}"`,
          },
        };
      }

// --- PLAN (the kernel takes over here) ---
      this.emit("PLAN", input);
      await this.kernel.beginTask(request, request, { input });
      taskId = this.kernel.currentTask?.taskId ?? taskId;

      // --- EXECUTE: Branch based on file extension ---
      const ext = path.extname(input).toLowerCase();
      if (ext === '.pdf') {
        this.emit("EXECUTE", "pdf_read");
        const read = await this.callTool("pdf-read-1", "pdf_read", { path: input });
        if (!read.ok) return this.failed(read.failure, questions, rounds, taskEvents());

        const pdf = read.value as PdfReadResult;
        const task = await this.kernel.finishTask({ ok: true });
        this.emit("DELIVER", task.status);
        const artifacts = this.kernel.artifacts.map((artifact) => artifact.reference);
        if (task.status !== "COMPLETED") {
          return this.failed({ code: task.failureReason ?? "TASK_NOT_COMPLETED", reason: task.failureReason ?? "the task did not complete" }, questions, rounds, taskEvents());
        }

        return {
          status: "DELIVERED", state: "DELIVER", questions, clarifyRounds: rounds, artifacts,
          kernelEvents: taskEvents(), progress: this.progress,
          report: {
            markdown: pdf.text,
            analysis: { purpose: "PDF Text Extraction", bottlenecks: [] } as unknown as BottleneckAnalysis,
            pdf,
          },
        };
      }

      if (ext === '.sqlite' || ext === '.db') {
        this.emit("EXECUTE", "sqlite_read");
        const read = await this.callTool("sqlite-read-1", "sqlite_read", { path: input });
        if (!read.ok) return this.failed(read.failure, questions, rounds, taskEvents());

        this.emit("EXECUTE", "schema_analysis");
        
        // --- DELIVER SQLITE RESULT ---
        const task = await this.kernel.finishTask({ ok: true });
        this.emit("DELIVER", task.status);
        const artifacts = this.kernel.artifacts.map((artifact) => artifact.reference);
        if (task.status !== "COMPLETED") {
          return this.failed({ code: task.failureReason ?? "TASK_NOT_COMPLETED", reason: task.failureReason ?? "the task did not complete" }, questions, rounds, taskEvents());
        }
        
        return { 
          status: "DELIVERED", state: "DELIVER", questions, clarifyRounds: rounds, artifacts, 
          kernelEvents: taskEvents(), progress: this.progress,
          // Return the raw SQLite payload instead of rendering HTML
          report: { markdown: "SQLite Database loaded successfully.", analysis: { purpose: "Database Inspection", bottlenecks: [] } as any, schema: read.value as any }
        };
      }

      // --- EXECUTE CSV PIPELINE ---
      this.emit("EXECUTE", "csv_read");
      const read = await this.callTool("csv-read-1", "csv_read", { path: input });
      if (!read.ok) return this.failed(read.failure, questions, rounds, taskEvents());

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
            questions, clarifyRounds: rounds + 1, artifacts: [], kernelEvents: taskEvents(), progress: this.progress,
            failure: { code: "MALFORMED_CSV", reason: question.question, },
          };
        }
      }

      this.emit("EXECUTE", "render_page");
      if (options.mode === "bottleneck") {
        return this.bottleneck(csv, input, options, questions, rounds, taskEvents);
      }
      const rendered = await this.callTool("render-1", "render_page", {
        path: options.output ?? path.join(this.cwd, "workspace", "dashboard.html"),
        title: "Sales dashboard",
        columns: csv.columns,
        sample: csv.sample,
        rowCount: csv.rowCount,
      });
      if (!rendered.ok) return this.failed(rendered.failure, questions, rounds, taskEvents());

      // --- DELIVER ---
      const task = await this.kernel.finishTask({ ok: true });
      this.emit("DELIVER", task.status);
      const artifacts = this.kernel.artifacts.map((artifact) => artifact.reference);
      if (task.status !== "COMPLETED") {
        return this.failed({ code: task.failureReason ?? "TASK_NOT_COMPLETED", reason: task.failureReason ?? "the task did not complete" }, questions, rounds, taskEvents());
      }
      return { status: "DELIVERED", state: "DELIVER", questions, clarifyRounds: rounds, artifacts, kernelEvents: taskEvents(), progress: this.progress };
    } finally {
      // Nothing to release: the stream is read from the kernel's history, so
      // there is no subscription to take down, and no handle for a slow sink to
      // outlive the run.
    }
  }

  /**
   * STAGE 2, THROUGH THE SAME LOOP: read (governed) -> analyse -> write
   * (governed).
   *
   * The analysis is a PURE function of the rows the governed read returned, so
   * it runs in process and is not dressed up as a tool call. Putting a
   * computation with no I/O and no policy surface through the kernel would
   * manufacture the appearance of governance rather than the substance of it.
   * Everything that touches the filesystem is a real governed call.
   */
  private async bottleneck(
    csv: CsvReadResult, input: string,
    options: { output?: string; title?: string; format?: "html" | "markdown" },
    questions: ClarifyQuestion[], rounds: number,
    /**
     * Read the stream when the result is built, not once up front: the report
     * write is the second half of this run's events and they do not exist
     * until it has happened.
     */
    taskEvents: () => { type: string; payload: Record<string, unknown> }[],
  ): Promise<ConductorResult> {
    // Schema memory is consulted HERE, after the read, because it matches on the
    // header row the read actually produced.
    //
    // THE ROWS ARE PASSED, AND OMITTING THEM SILENTLY BROKE LEARNING.
    //
    // `rows` is optional in the resolver, and when they are absent it gives up
    // rather than profile: a profile needs values to look at, and a half-answer
    // is not an answer. That is right on its own. But it made this call site a
    // dead end for the correction loop, because the resolver only consults the
    // archive for a file whose headers a stored schema does NOT already match --
    // and every file a user corrects is, by definition, a file they are
    // correcting BECAUSE no stored schema fitted it.
    //
    // So the branch that lets a user correction outrank the profiler never ran
    // from here. The correction was written, the endpoint answered 200, the
    // archive on disk held the mapping, and the next file analysed was profiled
    // as if nobody had said anything. The user was told they had fixed it.
    //
    // The rows are ALREADY records keyed by header -- `CsvReadResult.rows` is
    // not a list of cell arrays, and treating it as one is a mistake this call
    // site made first. `cells[i]` on a record is `undefined` for every column,
    // so the profiler received rows of empty strings, inferred nothing, found
    // every required role unfilled, and returned undefined -- which is the same
    // silent no-learning as before, one layer further down and harder to see.
    const schema = await resolveSchemaMemory({
      cwd: this.cwd,
      headers: csv.headers,
      defaultsRoot: this.options.defaultsRoot,
      rows: csv.rows,
    });
    if (schema !== undefined) {
      this.emit("EXECUTE", `schema memory: ${schema.source} (${schema.id})`);
    } else {
      this.emit("EXECUTE", "no stored schema matched; inferring from column names");
    }
    const analysis = await analyseBottlenecks(csv, schema);
    // ONE TITLE, COMPUTED ONCE, for the artifact and the returned Markdown.
    //
    // It used to be the string "Bottleneck report: <file>", written out at four
    // call sites. It is a hypothesis about the file's shape, applied to every
    // file including the sales exports and access logs where it was simply
    // wrong. The title now names the FILE -- which is always true and never a
    // guess -- and the purpose travels separately, in the greeting, where it is
    // shown as a claim with its evidence attached.
    const title = options.title ?? titleFor({ fileName: path.basename(input), purpose: analysis.purpose });

    this.emit("EXECUTE", "render_bottleneck_report");
    const written = await this.callTool("report-1", "render_bottleneck_report", {
      path: options.output ?? path.join(this.cwd, "workspace", "bottleneck-report.md"),
      title,
      csv, workspaceCwd: this.cwd, defaultsRoot: this.options.defaultsRoot,
      format: options.format ?? "markdown",
    });
    if (!written.ok) return this.failed(written.failure, questions, rounds, taskEvents());
    if (!written.value || (written.value as { rendered?: boolean }).rendered !== true) {
      return this.failed({
        code: "REPORT_NOT_RENDERED",
        reason: `the renderer declined the file: ${((written.value as { problems?: string[] })?.problems ?? []).join("; ") || "no reason given"}`,
      }, questions, rounds, taskEvents());
    }

    const task = await this.kernel.finishTask({ ok: true });
    this.emit("DELIVER", task.status);
    const artifacts = this.kernel.artifacts.map((artifact) => artifact.reference);
    if (task.status !== "COMPLETED") {
      return this.failed({ code: task.failureReason ?? "TASK_NOT_COMPLETED", reason: task.failureReason ?? "the task did not complete" }, questions, rounds, taskEvents());
    }
    // The Markdown is produced from the SAME analysis object the artifact was
    // rendered from, so the text in the response and the file on disk cannot
    // disagree about what was found.
    const markdown = toBottleneckMarkdown(analysis, title);
    return {
      status: "DELIVERED", state: "DELIVER", questions, clarifyRounds: rounds, artifacts,
      report: { markdown, analysis, schema }, kernelEvents: taskEvents(), progress: this.progress,
    };
  }

  private failed(
    failure: { code: string; reason: string; kernelReasonCode?: string },
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
  ): Promise<{ ok: true; value: unknown } | { ok: false; failure: { code: string; reason: string; kernelReasonCode?: string } }> {
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
      // The kernel's own tier travels out. A caller that has to guess whether
      // this was a boundary question or a hazard cannot report it honestly, and
      // the wedge's whole security claim rests on this being the kernel's
      // refusal rather than the UI's.
      return { ok: false, failure: { code: `POLICY_${decision.tier ?? "SOFT_REFUSE"}`, reason: decision.reason, kernelReasonCode: decision.tier ?? "SOFT_REFUSE" } };
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
      // An explicit dispatch, not a default branch. A tool this Conductor does
      // not implement must FAIL CLOSED rather than fall through to whichever
      // capability happened to be written last.
      let value: unknown;
      switch (tool) {
        case "csv_read":
          value = await csvRead({ path: String(input.path) }, { boundary: this.boundary });
          break;
        case "render_page":
          value = await renderPage(input as Parameters<typeof renderPage>[0]);
          break;
        case "render_bottleneck_report":
          value = await renderBottleneckReport(input as Parameters<typeof renderBottleneckReport>[0]);
          break;
        case "sqlite_read":
          value = await sqliteRead({ path: String(input.path), query: input.query }, { boundary: this.boundary });
          break;
        case "pdf_read":
          value = await pdfRead({ path: String(input.path) }, { boundary: this.boundary });
          break;
        default:
          await this.kernel.recordToolResult(callId, tool, undefined, true);
          return { ok: false, failure: { code: "TOOL_NOT_IMPLEMENTED", reason: `this conductor does not implement '${tool}'` } };
      }
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
   * a CSV becomes a clarify question rather than a guess.
   *
   * THE BOUNDARY IS NOT CHECKED HERE. That check used to live in this method,
   * and it was a control in the wrong place: it turned a path outside the
   * workspace into a clarifying QUESTION ("which CSV should I read?"), so the
   * kernel never saw the attempt and nothing was recorded. A refusal the user
   * cannot see is not a control, it is a shrug.
   *
   * So the path is resolved and handed to the governed `csv_read`, and the
   * kernel's policy classifier refuses it (SOFT_REFUSE for out of bounds, a
   * higher tier for a hazard) with a real event in the stream. Same decision,
   * same tier, and now it is visible and counted.
   */
  private locateInput(text: string): string | undefined {
    // An explicitly framed input is taken verbatim to its end, so a name that
    // contains spaces survives intact. Guessing backwards out of the prose
    // around it is what truncated `rm -rf.csv` to `-rf.csv` and hid a
    // destructive payload from the kernel entirely.
    const framed = /(?:^|[;\s])input=(.*)$/s.exec(text);
    const named = framed?.[1].trim();
    const raw = named !== undefined && named !== ""
      ? named
      : /[\w./\-]+?\.(csv|tsv|jsonl|jsonlines|ndjson|log|sqlite|db|pdf)\b/i.exec(text)?.[0];
    console.log("locateInput raw:", raw);
    if (raw === undefined) return undefined;
    // A NAME THAT CANNOT EXIST ON DISK IS NOT AN INPUT. This is the filesystem
    // speaking, not a security control: `<`, `>` and a NUL cannot appear in a
    // filename on the supported platforms, so there is nothing there for the
    // kernel to rule on. Anything the kernel COULD rule on is passed on.
    if (/[<>:"|?*\u0000-\u001f]/.test(raw.replace(/^[A-Za-z]:/, ""))) return undefined;
    return path.resolve(this.cwd, raw);
  }
}