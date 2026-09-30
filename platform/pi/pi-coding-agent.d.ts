/**
 * SHADOW DECLARATION — replace when the real package ships types.
 *
 * `@earendil-works/pi-coding-agent` is Pi's own runtime and is not a dependency
 * of this repository; it is not installed under `node_modules`, so
 * `tsc --noEmit` could not see `.pi/extensions/platform-orchestrator.ts` at all.
 * That file is the ENFORCEMENT layer — it is where a policy denial is refused
 * and where a denial reason is captured for recovery — and it was therefore
 * unchecked while it carried the security control. A duplicate `const` in it
 * (the TS2451 fixed on 2026-09-30) reached runtime as a hard SyntaxError with
 * nothing to catch it.
 *
 * This file closes that hole: it is a hand-written, minimal stand-in for the
 * package's exported types, covering ONLY the surface the extension actually
 * touches. It is deliberately not a full declaration file and must never grow
 * into one — an unverified surface that looks verified is worse than a missing
 * one. When the package ships its own types, delete this file.
 *
 * Every member below corresponds to a real call site in
 * `.pi/extensions/platform-orchestrator.ts`. Adding a member means adding a call
 * site, not the other way round.
 */

declare module "@earendil-works/pi-coding-agent" {
  /** A tool as Pi reports it at registration time. */
  export interface PiToolDescriptor {
    name: string;
    description: string;
    parameters: unknown;
  }

  /**
   * A tool-call lifecycle event. One union rather than per-event interfaces: the
   * extension subscribes with narrow literal names, so the handler parameter is
   * contextually narrowed by `pi.on("…", handler)` at each call site, and every
   * field the extension reads is present on the union.
   */
  export interface PiEvent {
    /** `resources_discover` */
    cwd: string;
    /** `before_agent_start` */
    prompt: string;
    /** `tool_call`, `tool_execution_start`, `tool_execution_end` */
    toolName: string;
    /** The identity that correlates all three stages of one call. */
    toolCallId: string;
    /** `tool_call` */
    input: unknown;
    /** `tool_execution_end` */
    result: unknown;
    /** `tool_execution_end` — the only result signal Pi carries. */
    isError: boolean;
    /** `tool_call`, when the model turn is identifiable. */
    responseId?: string;
    responseModel?: string;
    /** `agent_end` */
    messages: readonly { role: string }[];
  }

  /** The block verdict a `tool_call` handler may return. */
  export interface ToolCallBlock {
    block: true;
    reason: string;
  }

  export interface ExtensionContext {
    cwd: string;
    hasUI: boolean;
    ui: {
      /** Prompt for a policy approval. Resolves `false` when there is no UI. */
      confirm(title: string, message: string): Promise<boolean>;
      notify(message: string, level?: "info" | "warn" | "error"): void;
    };
  }

  export interface CommandDefinition {
    description: string;
    handler(args: string, ctx: ExtensionContext): Promise<void> | void;
  }

  export interface ExtensionAPI {
    /**
     * Subscribe to a lifecycle event. The handler's `event` parameter is typed
     * from the literal name, which is what gives each call site its own shape.
     */
    on<E extends keyof PiEventMap>(
      event: E,
      handler: (event: PiEventMap[E], ctx: ExtensionContext) => unknown,
    ): void;
    /** The ONLY write path into Pi session history. */
    appendEntry(kind: string, data: unknown): void;
    getAllTools(): PiToolDescriptor[];
    registerCommand(name: string, command: CommandDefinition): void;
  }

  /** Maps each event name to the fields that event actually carries. */
  export interface PiEventMap {
    resources_discover: { cwd: string };
    session_start: Record<string, never>;
    before_agent_start: { prompt: string };
    tool_call: PiEvent;
    tool_execution_start: Pick<PiEvent, "toolCallId" | "toolName">;
    tool_execution_end: Pick<PiEvent, "toolCallId" | "toolName" | "result" | "isError">;
    agent_end: { messages: readonly { role: string }[] };
  }
}
