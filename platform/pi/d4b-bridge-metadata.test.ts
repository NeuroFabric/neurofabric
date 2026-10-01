import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import platformOrchestrator from "../../.pi/extensions/platform-orchestrator.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";

/**
 * D4B R5 / T4 — failure metadata on the EXTERNAL Pi execution-result path.
 *
 * Everything the kernel classifies is invisible to an operator unless it
 * survives the bridge. The bridge is
 * `.pi/extensions/platform-orchestrator.ts` -> `KernelAdapter.recordToolResult`,
 * and it is the only path a real Pi session takes: Pi reports an outcome as a
 * boolean `isError` plus an opaque payload, and everything the kernel knows
 * about WHY must be reconstructed on the way in or it never reaches recovery, the
 * events, or the trace.
 *
 * This file imports the REAL extension and drives it with a stub Pi. It does not
 * re-transcribe the extension's sequence — an earlier revision of this work
 * proved that approach worthless by pinning a call order the file may not use.
 * If the extension stops forwarding the metadata, this file fails; if the
 * adapter stops classifying, this file fails.
 *
 * The trace entries collected here are the assertion surface: they are what the
 * operator actually reads after a session dies, so "the metadata is observable"
 * has to mean it is in THEM and not merely inside the adapter's memory.
 */

interface TraceEntry { type: string; timestamp: string; details?: Record<string, unknown> }

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown | Promise<unknown>;

/** A stub Pi that records every event it is asked about, and every trace entry. */
function stubPi(toolNames: string[]) {
  const handlers = new Map<string, Handler[]>();
  const entries: TraceEntry[] = [];
  const pi = {
    on: (name: string, fn: Handler) => {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    appendEntry: (_kind: string, entry: TraceEntry) => { entries.push(entry); },
    getAllTools: () => toolNames.map((name) => toolDescriptorFromPi({ name, description: name })),
    registerCommand: () => {},
  };
  return {
    pi,
    entries,
    async fire(name: string, event: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}

async function bridgeHarness(toolNames = ["bash", "read"]) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "nf-d4b-bridge-"));
  await mkdir(path.join(cwd, "skills"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi", "neurofebric.json"),
    JSON.stringify({ policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] }),
    "utf8",
  ).catch(async () => {
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(path.join(cwd, ".pi", "neurofebric.json"), JSON.stringify({ policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] }), "utf8");
  });

  const harness = stubPi(toolNames);
  platformOrchestrator(harness.pi as unknown as Parameters<typeof platformOrchestrator>[0]);
  await harness.fire("session_start", {}, { cwd });
  await harness.fire("before_agent_start", { prompt: "summarise sales.csv" }, { cwd });
  return { ...harness, cwd };
}

const traceOf = (entries: TraceEntry[], type: string) =>
  entries.filter((entry) => entry.type === type).at(-1)?.details;

/**
 * Two refusals the real policy produces, one per RULING 1 tier. Both are built
 * at runtime for the same reason the D1 tier tests build theirs: a literal
 * credential path in this repository would be a credential pattern in it.
 * OUTSIDE_READ is SOFT (scope), CREDENTIAL_PATH is HARD (secret access).
 */
const OUTSIDE_READ = path.join(os.tmpdir(), "nf-d4b-outside", "notes.md");
const CREDENTIAL_PATH = [".", "env"].join("");

/**
 * The production Pi order, transcribed from the extension itself:
 *   tool_execution_start -> tool_call (preflight) -> tool_execution_end
 */
async function runBashFailure(harness: Awaited<ReturnType<typeof bridgeHarness>>, callId: string, result: unknown) {
  await harness.fire("tool_execution_start", { toolCallId: callId, toolName: "bash" });
  await harness.fire("tool_call", { toolCallId: callId, toolName: "bash", input: { command: "grep -q needle haystack.txt" } });
  await harness.fire("tool_execution_end", { toolCallId: callId, toolName: "bash", result, isError: true });
}

test("T4.1 an ordinary command failure is classified ON THE BRIDGE and traced", async () => {
  const harness = await bridgeHarness();
  await runBashFailure(harness, "b1", { output: "exit status 2" });

  const ended = traceOf(harness.entries, "tool_execution_end");
  assert.ok(ended, "the execution-result handler must record its trace entry");
  assert.equal(
    ended!.failureClassification, "TOOL_FAILURE",
    "the classification the kernel acted on must be visible in the session trace, not only in adapter memory",
  );
  assert.equal(ended!.recoveryStrategy, "RETRY", "and so must the move it funded");
  assert.equal(ended!.denialReason, undefined, "an ordinary failure must not borrow a rule's words");
});

test("T4.2 a refusal carries the policy's own words to the trace, whichever tier it is", async () => {
  const harness = await bridgeHarness();
  await harness.fire("tool_execution_start", { toolCallId: "b2", toolName: "read" });
  await harness.fire("tool_call", { toolCallId: "b2", toolName: "read", input: { path: OUTSIDE_READ } });
  const precheck = traceOf(harness.entries, "policy_decision");
  assert.equal(precheck!.decision.decision, "DENY", "the real policy must actually refuse this call, or the rest proves nothing");
  const policyReason = (precheck!.decision as { reason: string }).reason;
  await harness.fire("tool_execution_end", { toolCallId: "b2", toolName: "read", result: undefined, isError: true });

  const ended = traceOf(harness.entries, "tool_execution_end");
  assert.equal(ended!.failureClassification, "POLICY_DENIED", "the refusal keeps its identity across the bridge");
  // EQUALITY, not a pattern: the reason recorded at the deny site and the one
  // delivered at the result site are the same string. A pattern here would pass
  // on two different messages and on an empty one.
  assert.equal(typeof policyReason, "string", "the deny site records WHY, in the policy's own words");
  assert.equal(ended!.denialReason, policyReason, "and the result site delivers that identical reason");
  assert.equal(ended!.denialTier, "SOFT_REFUSE", "RULING 1: a read outside the workspace is survivable");
  assert.equal(ended!.recoveryStrategy, "CONTINUE", "and the trace says the task carried on");

  // The same string reached the kernel's own refusal record, so the metadata is
  // carried all the way in and not merely logged by the bridge.
  const refusal = traceOf(harness.entries, "SOFT_REFUSAL_CONTINUED");
  assert.ok(refusal, "the refusal is reported to the kernel");
  assert.equal(refusal!.failure, "POLICY_DENIED");
  assert.equal(refusal!.denialReason, policyReason, "one reason, three places, byte for byte");
});

test("T4.2c a HARD refusal ends the run and says so in the trace", async () => {
  // RULING 1 (2026-10-01). A credential read is a hazard, so the bridge's
  // metadata has to be what tells an operator the run ENDED rather than merely
  // reporting that a call was refused — those are the same words.
  const harness = await bridgeHarness();
  await harness.fire("tool_execution_start", { toolCallId: "b2h", toolName: "read" });
  await harness.fire("tool_call", { toolCallId: "b2h", toolName: "read", input: { path: CREDENTIAL_PATH } });
  const precheck = traceOf(harness.entries, "policy_decision");
  assert.equal(precheck!.decision.decision, "DENY", "the real policy must refuse this call for real");
  await harness.fire("tool_execution_end", { toolCallId: "b2h", toolName: "read", result: undefined, isError: true });

  const ended = traceOf(harness.entries, "tool_execution_end");
  assert.equal(ended!.failureClassification, "POLICY_DENIED", "same class: a refusal is a refusal");
  assert.equal(ended!.denialTier, "HARD_DENY", "a credential read is a hazard by the ruling");
  assert.equal(ended!.recoveryStrategy, "TERMINATE", "so the run ends rather than continuing");
  assert.equal(ended!.taskStatus, "FAILED", "and the trace says the task is finished");
  assert.equal(ended!.denialReason, (precheck!.decision as { reason: string }).reason,
    "with the same rule's words the deny site recorded");
});

test("T4.2b a successful call reports no failure at all", async () => {
  const harness = await bridgeHarness();
  await harness.fire("tool_execution_start", { toolCallId: "b2b", toolName: "bash" });
  await harness.fire("tool_call", { toolCallId: "b2b", toolName: "bash", input: { command: "ls" } });
  await harness.fire("tool_execution_end", { toolCallId: "b2b", toolName: "bash", result: { output: "sales.csv" }, isError: false });

  const ended = traceOf(harness.entries, "tool_execution_end");
  assert.equal(ended!.isError, false);
  assert.equal(ended!.failureClassification, undefined, "a success is not a failure with an empty classification");
  assert.equal(ended!.denialReason, undefined);
});

test("T4.3 an unmarked result is classified, not left undefined", async () => {
  const harness = await bridgeHarness();
  await runBashFailure(harness, "b3", { output: "exit status 2" });
  const ended = traceOf(harness.entries, "tool_execution_end");
  assert.notEqual(ended!.failureClassification, undefined,
    "a failure whose classification is missing cannot be told apart from a bridge that never looked");
});