import test from "node:test";
import assert from "node:assert/strict";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { callSignature, stableStringify } from "../core/call-signature.ts";
import type { PolicyRequest } from "../core/types.ts";

/**
 * F006.4c C3b: lifecycle and normalizer pins for the adapter-derived signature.
 *
 * C3 extracted `callSignature` into `platform/core/call-signature.ts` and gave
 * the adapter a `lastAttemptSignature` in its per-task recovery state. No pin
 * could tell any of it from nothing, so it landed inert and unproven.
 *
 * Three claims:
 *   1. the lifecycle - recorded on execution, reset on the VALID boundary,
 *      cleared on supersession, and never written by a stale handler
 *      (C3.1-C3.4b). C3.4 is the load-bearing one: a superseded handler must
 *      not write the newer task's recovery state, which is the H2-H6 invariant
 *      applied to a new counter.
 *   2. the value is never observable, only WHETHER one was recorded (C3.5).
 *   3. the normalizer itself (C3.6a-c). The extraction nearly shipped a
 *      collision: the NUL separator was transcribed as a space, which a tool
 *      name may legitimately contain. Nothing in the suite caught it. These
 *      pins are why the next transcription cannot be silent either.
 */

const TOOLS = ["read", "bash", "write"].map((name) => toolDescriptorFromPi({ name, description: name }));

function newKernel(): KernelAdapter {
  const k = new KernelAdapter();
  k.registerTools(TOOLS);
  return k;
}

const recorded = (k: KernelAdapter) => k.diagnostics.attemptSignatureRecorded;

/**
 * An ALLOWed call that binds a real execution, WITHOUT recording its result.
 *
 * Split from `allowAndRun` deliberately: the signature is recorded when the
 * attempt executes, and a VALID result then clears it on the same boundary as
 * `recoveryDepth`. A helper that ran the whole sequence would observe only the
 * cleared state, and could not tell "recorded then reset" from "never
 * recorded" at all.
 */
async function allowAndBind(k: KernelAdapter, callId: string, input: unknown = { path: "notes.md" }): Promise<void> {
  const { decision } = await k.precheckToolCall("read", "execute", input, undefined, callId);
  assert.equal(decision.decision, "ALLOW", "the call must be allowed");
  const bound = await k.beginToolExecution(callId, "read");
  assert.ok(bound, "an execution must be bound");
}

/** The full sequence: the attempt executes, and its VALID result resets the state. */
async function allowAndRun(k: KernelAdapter, callId: string, input: unknown = { path: "notes.md" }): Promise<void> {
  await allowAndBind(k, callId, input);
  await k.recordToolResult(callId, "read", { ok: true }, false);
}

// --- 1. recording ---------------------------------------------------------

test("C3.1 an allowed, bound attempt records a signature", async () => {
  const k = newKernel();
  await k.beginTask("one");
  assert.equal(recorded(k), false, "a fresh task has recorded nothing");
  await allowAndBind(k, "c1");
  assert.equal(recorded(k), true, "the executed attempt recorded one");
});

test("C3.1b a call that binds no execution records nothing", async () => {
  // A refused call never ran, so it has no identity to repeat. Recording it
  // would make the next attempt look like a repeat of a call that never
  // happened, and would spend a strategy change on a fiction.
  const k = newKernel();
  await k.beginTask("one");
  const { decision } = await k.precheckToolCall("bash", "execute", { cmd: "rm -rf x" }, undefined, "d1");
  if (decision.decision === "ALLOW") return; // tier policy allows bash: nothing to assert
  assert.equal(recorded(k), false, "a refused call records no signature");
});

// --- 2. the VALID boundary ------------------------------------------------

test("C3.2 a VALID result clears the signature, on the same boundary as recoveryDepth", async () => {
  const k = newKernel();
  await k.beginTask("one");
  await allowAndBind(k, "c1");
  assert.equal(recorded(k), true, "precondition: the executed attempt recorded one");

  await k.recordToolResult("c1", "read", { ok: true }, false);

  // recoveryDepth is 0 because a VALID result resets it. The signature must be
  // reset by the SAME boundary, not by bookkeeping of its own.
  assert.equal(k.diagnostics.recoveryDepth, 0, "the VALID boundary reset depth");
  assert.equal(recorded(k), false, "and it reset the signature in the same place");
});

test("C3.2b a FAILED result does not clear it: the failed attempt is the one recovery is asked about", async () => {
  const k = newKernel();
  await k.beginTask("one");
  await allowAndBind(k, "c1");
  assert.equal(recorded(k), true);
  await k.recordToolResult("c1", "read", undefined, true);
  assert.equal(k.diagnostics.recoveryDepth, 1, "the failure accumulated a recovery round");
  assert.equal(recorded(k), true, "and the failed attempt is still recorded");
});

// --- 3. supersession and staleness (H2-H6 applied) ------------------------

test("C3.3 a newer task starts with no recorded signature", async () => {
  const k = newKernel();
  await k.beginTask("one");
  await allowAndBind(k, "c1");
  assert.equal(recorded(k), true, "precondition: the first turn recorded one");
  await k.beginTask("two");
  assert.equal(recorded(k), false, "a new turn has its own recovery state, not the last one's");
});

test("C3.4 a stale ALLOW does not record onto the newer task", async () => {
  // The H2-H6 invariant for this counter. The stale guard runs BEFORE the
  // ALLOW branch, so a handler superseded mid-decision must write nothing. If
  // the record site ever moves above that guard, this is the pin that catches
  // it, and nothing else in the suite would.
  const k = newKernel();
  await k.beginTask("one");
  let arrived!: () => void;
  const atPrompt = new Promise<void>((res) => { arrived = res; });
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const approval = { requestApproval: async (): Promise<boolean> => { arrived(); await gate; return true; } };

  const first = k.precheckToolCall("write", "execute", { path: "report.md" }, approval, "a1");
  await atPrompt;              // the first handler is parked in the prompt
  await k.beginTask("two");    // the newer turn now owns the lifecycle
  assert.equal(recorded(k), false, "the newer task starts clean");
  release();
  await first;                 // the stale handler resumes and resolves ALLOW

  assert.equal(recorded(k), false, "a stale ALLOW must not record onto the newer task");
  assert.equal(k.currentTask!.status, "PLANNING", "and must not move it");
});

test("C3.4b the staleness pin is live, not inert", async () => {
  // H5's shape: prove the recording path still works for the CURRENT task, so
  // C3.4 cannot pass merely because recording is broken everywhere.
  const k = newKernel();
  await k.beginTask("one");
  await allowAndBind(k, "live1");
  assert.equal(recorded(k), true, "a current-task ALLOW does record");
});

// --- 4. the value is never observable -------------------------------------

test("C3.5 diagnostics exposes only whether a signature was recorded, never the signature", async () => {
  const k = newKernel();
  // The distinctive string appears ONLY in the tool input. It must not be put
  // in the task prompt: `beginTask` legitimately echoes the user request into
  // the trace, and that would make this pin pass or fail for the wrong reason.
  await k.beginTask("do the work");
  await allowAndBind(k, "c1", { path: "/secret-place/notes.md" });

  const serialised = JSON.stringify(k.diagnostics);
  assert.equal(typeof k.diagnostics.attemptSignatureRecorded, "boolean");
  assert.equal(serialised.includes("secret-place"), false, "the signature must not leak through diagnostics");
  assert.equal(serialised.includes("notes.md"), false, "nor the input it was derived from");
});

test("C3.5b no event payload carries the signature", async () => {
  const k = newKernel();
  await k.beginTask("do the work");
  await allowAndBind(k, "c1", { path: "/secret-place/notes.md" });
  const trace = JSON.stringify(k.recentEvents(500));
  assert.equal(trace.includes("secret-place"), false,
    "a signature must not reach the trace: no event may carry the tool input it hashes");
});

// --- 5. the normalizer (C3.6a-c) -----------------------------------------

const tool = (name: string) => ({ name, description: name, riskLevel: "READ", sideEffect: "PURE" } as unknown as PolicyRequest["tool"]);

const request = (over: Partial<PolicyRequest> = {}): PolicyRequest => ({
  taskId: "t1",
  tool: tool("read"),
  operation: "execute",
  input: {},
  ...over,
});

test("C3.6a key order is construction detail, not a different call", () => {
  // This is the claim that nearly broke: two structurally identical calls must
  // compare equal, so a reordered object is the SAME attempt and cannot be
  // mistaken for a new strategy.
  const a = callSignature(request({ input: { path: "a.md", offset: 1, pattern: "x" } }));
  const b = callSignature(request({ input: { pattern: "x", offset: 1, path: "a.md" } }));
  assert.equal(a, b, "a reordered input is the same call");
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
});

test("C3.6b array order is meaning, and must NOT be normalized away", () => {
  // The mirror of C3.6a. Sorting object keys is right; sorting an array would
  // silently merge two genuinely different calls into one, and the strategy
  // fund would then read the second as a REPEAT of the first.
  const a = callSignature(request({ input: { steps: ["one", "two"] } }));
  const b = callSignature(request({ input: { steps: ["two", "one"] } }));
  assert.notEqual(a, b, "a reordered array is a DIFFERENT call");
});

test("C3.6c the separator is NUL, so a space in a tool name cannot cause a collision", () => {
  // Had the extraction transcribed the separator as a space, a tool named
  // "a b" and one named "a" with operation "b c" would collide, and nothing
  // else in the suite would notice.
  const sig = callSignature(request({ tool: tool("read"), operation: "execute" }));
  assert.ok(
    sig.includes(String.fromCharCode(0)),
    "the separator must be NUL, which cannot occur in a tool name",
  );
  assert.equal(sig.includes(" "), false, "and must not be a space");

  const one = callSignature(request({ tool: tool("a b"), operation: "c" }));
  const two = callSignature(request({ tool: tool("a"), operation: "b c" }));
  assert.notEqual(one, two, "a space-separated pair must not collide with a single spaced name");
  assert.equal(callSignature(request({ tool: tool("a b"), operation: "c" })), one,
    "and the same tool and operation still hash identically");
});
