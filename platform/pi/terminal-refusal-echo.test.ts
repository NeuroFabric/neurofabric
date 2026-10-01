import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { buildPolicy } from "./project-config.ts";
import { parsePolicyConfig, type PolicyConfig } from "../core/policy-config.ts";

/**
 * THE ECHO MR. A terminal refusal must not replay a dead task's failure as if
 * it were the reason the call in front of it was refused.
 *
 * WHAT WAS MEASURED, in three sessions, before this file existed. A policy
 * denial killed a task. The next tool call — naming no denied construct at all
 * — was refused with a certificate naming the earlier denial, complete with
 * that death's counters. The agent read it, believed its own unrelated call had
 * been denied, and reported a cause belonging to a call it had never made. One
 * session was lost to the artefact itself; the next could not even run a search
 * for the construct it was investigating, because its own search pattern
 * tripped the guard whose case it was collecting.
 *
 * The defect is not the replay. The task's failureReason is the only thing that
 * explains why the task is dead, and suppressing it would be worse. The defect
 * is that the replay was UNLABELLED, so the earliest reading of the string — by
 * a person or an agent — attributed a dead task's cause to a live call.
 *
 * The contract, asserted below:
 *
 *   1. The refusal names the call that triggered it: tool, operation, id.
 *   2. It states that call was NOT evaluated and that no rule refused it.
 *   3. The stored reason is labelled ORIGINAL and attributed to the termination
 *      moment, so its counters are auditable against the death.
 *   4. The trace carries the same three facts structurally, not only in prose.
 *
 * NO TRIGGER LITERALS APPEAR IN THIS FILE. Every test asserts the STRUCTURE of
 * a refusal, never the text of a denial, so none of them needs to name a
 * destructive token or a secret pattern. The denial below is triggered by a
 * tool name on `deniedTools`, which is a real denial through the real policy
 * and costs the scan nothing. Corpus entries, which must quote the constructs
 * they test, build those from fragments instead.
 *
 * EVERY TEST ASSERTS ITS PRECONDITION FIRST. A refusal-echo test that reaches
 * its assertions against a task that never actually died proves nothing, and
 * that is how the previous 46-character pin came to look intentional: it was
 * written against a hand-edited status rather than a real one.
 */

const FORBIDDEN_TOOL = "withheld_tool";

const RULES = {
  version: 1,
  // A name-based denial. Real, deterministic, and free of any construct the
  // write-scan or the deletion guard could object to.
  deniedTools: [FORBIDDEN_TOOL],
  allowedTools: [],
  fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
  destructiveCommandPatterns: [],
  destructiveCommandTokens: [],
  limits: { maxToolCallsPerTask: 40, maxFileWritesPerTask: 10, maxBytesPerWrite: 2_000_000 },
  // `abort`, and this is the load-bearing change of the re-base. Under the D1
  // reversal a delivered denial no longer ends the task, so the OLD driver for
  // this file - deliver a denial, let recovery terminate - produces a LIVE task
  // and every echo assertion below would pass vacuously. `abort` still ends a
  // task, at `precheckToolCall` -> `abortTask`, so a real death is still
  // available. And a death is the right substrate: this file is about what a
  // caller is told when the task is ALREADY dead. `abort` is the only path to
  // that state now, so the file is pinned on the one route that still exists.
  onViolation: "abort",
} as const;

const TOOLS = [FORBIDDEN_TOOL, "read", "bash", "write"].map((name) =>
  toolDescriptorFromPi({ name, description: name }));

async function adapterFor(): Promise<KernelAdapter> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-echo-"));
  const policyConfig: PolicyConfig = parsePolicyConfig({ ...RULES }, "echo-policy.json");
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy({ policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] }, dir, policyConfig));
  for (const tool of TOOLS) adapter.registerTools([tool]);
  await adapter.beginTask("do the work", "do the work");
  return adapter;
}

/**
    * There is no hand-built denial reason any more, and that is an improvement.
    *
    * This file used to assemble a realistic-looking refusal sentence from string
    * fragments, so that no trigger literal appeared in the source and authoring
    * the file could not itself become a denied write. The re-base removes the need:
    * the death is now produced by a REAL policy decision, so `deadTask()` returns
    * the reason the policy itself produced. The pin is therefore now driven by
    * live policy output rather than by a string this file made up - which is
    * strictly stronger, since a hand-built reason can drift from the real shape
    * without any test noticing.
    */
const lifecycleRefusals = (k: KernelAdapter) => k.recentEvents(500).filter((e) => e.type === "LIFECYCLE_REFUSED");
const lastRefusalPayload = (k: KernelAdapter) =>
  lifecycleRefusals(k).at(-1)?.payload as Record<string, unknown> | undefined;

/** Force a task state, for the one branch production does not reach naturally. */
function forceState(adapter: KernelAdapter, patch: { status: string; failureReason?: string }): void {
  const holder = adapter as unknown as { task: Record<string, unknown> };
  holder.task = { ...holder.task, ...patch };
}

/**
 * Drive the task to its death the way production does: a real preflight denial,
 * delivered to `recordToolResult`, classified, and terminated by recovery.
 *
 * Returns the id of the call that CAUSED the death. Every test then makes a
 * DIFFERENT call and asserts the resulting refusal is about THAT call.
 */
async function deadTask(): Promise<{ adapter: KernelAdapter; causingCallId: string; denialReason: string }> {
  const adapter = await adapterFor();

  // The death is caused by the reason the boundary ACTUALLY emits for the
  // forbidden tool — probed live, not hand-built — so the preconditions below
  // verify a real denial, not a string we authored.
  const probe = await adapter.precheckToolCall(FORBIDDEN_TOOL, FORBIDDEN_TOOL, {}, undefined, "reason-probe");
  assert.equal(probe.decision.decision, "DENY", "precondition: the forbidden tool must be denied by policy");
  const denialReason = probe.decision.reason ?? "";

  const causingCallId = "call-that-died";
  await adapter.beginToolExecution(causingCallId, FORBIDDEN_TOOL, "execute");
  await adapter.recordToolResult(causingCallId, FORBIDDEN_TOOL, undefined, true, undefined, denialReason);

  // PRECONDITIONS, asserted before any test below asserts an outcome. Without
  // these, every echo assertion in this file would pass against a live task.
  assert.equal(
    adapter.currentTask?.status,
    "FAILED",
    "precondition: the delivered denial must terminate the task, or this file tests nothing",
  );
  const stored = adapter.currentTask?.failureReason ?? "";
  assert.ok(
    stored.includes(denialReason),
    `precondition: the denial must reach the task as its failureReason, got: ${stored}`,
  );
    assert.equal(
    stored,
    denialReason,
    "precondition: the death's failureReason must be the policy's own words, verbatim — the re-base stores the refusal unlabelled, so identity is the strongest available check",
  );

  return { adapter, causingCallId, denialReason };
}

test("1. a refusal after a death names the CALL THAT TRIGGERED IT, not the earlier one", async () => {
  const { adapter, causingCallId } = await deadTask();
  // An unrelated, entirely benign call — the shape that produced the misread.
  const later = await adapter.precheckToolCall("read", "read", { path: "notes.md" }, undefined, "later-call-1");

  assert.equal(later.decision.decision, "DENY");
  assert.match(
    later.decision.reason ?? "",
    /the call that triggered this refusal is tool=read operation=read toolCallId=later-call-1/,
    "the refusal must identify the call in front of the reader, or it reads as a verdict on the dead one",
  );
  assert.equal(
    lastRefusalPayload(adapter)?.toolCallId,
    "later-call-1",
    "the trace must attribute the refusal to the triggering call, not to the one that caused the death",
  );
  assert.notEqual(lastRefusalPayload(adapter)?.toolCallId, causingCallId);
});

test("2. the stored reason is labelled ORIGINAL, never presented as this call's refusal", async () => {
  const { adapter } = await deadTask();
  const later = await adapter.precheckToolCall("read", "read", { path: "notes.md" }, undefined, "later-call-1");
  const reason = later.decision.reason ?? "";

  assert.match(
    reason,
    /the task's ORIGINAL failure, recorded when the task terminated and unchanged since, is:/,
    "a replayed reason must say that it is a replay and when it was recorded",
  );
  assert.doesNotMatch(
    reason,
    /failureReason:/,
    "the old `failureReason:` tail is what made a dead task's cause read as this call's verdict",
  );
});

test("3. the triggering call is stated NOT evaluated — no rule refused it", async () => {
  const { adapter } = await deadTask();
  const later = await adapter.precheckToolCall("read", "read", { path: "notes.md" }, undefined, "later-call-1");

  assert.match(
    later.decision.reason ?? "",
    /it was NOT evaluated and no policy rule refused it/,
    "this is the fact most easily lost, and the one that decides whether the caller retries or stops",
  );
  assert.equal(later.decision.refusal, "task_terminal", "still a lifecycle refusal, never a policy violation");
});

test("4. a replayed certificate's counters are attributable to the DEATH, not to this call", async () => {
  const { adapter, denialReason } = await deadTask();
  const later = await adapter.precheckToolCall("read", "read", { path: "notes.md" }, undefined, "later-call-1");
  const reason = later.decision.reason ?? "";

  assert.ok(reason.includes(denialReason), "the death's own words must survive into the replay, in full");
  assert.match(
    reason,
    /recorded when the task terminated and unchanged since/,
    "counters in a replayed certificate describe the death; the wording must attribute them to it",
  );
  assert.equal(lastRefusalPayload(adapter)?.originalFailureReason, adapter.currentTask?.failureReason);
  assert.equal(lastRefusalPayload(adapter)?.evaluated, false);
  assert.equal(lastRefusalPayload(adapter)?.replayed, true);
});

test("5. each post-death call gets its OWN identity, not a shared one", async () => {
  const { adapter } = await deadTask();

  const first = await adapter.precheckToolCall("read", "read", { path: "a.md" }, undefined, "call-A");
  const second = await adapter.precheckToolCall("write", "write", { path: "b.md", content: "x" }, undefined, "call-B");

  assert.match(first.decision.reason ?? "", /tool=read operation=read toolCallId=call-A/);
  assert.match(second.decision.reason ?? "", /tool=write operation=write toolCallId=call-B/);

  const ids = lifecycleRefusals(adapter).map((e) => (e.payload as Record<string, unknown>).toolCallId);
  assert.deepEqual(ids, ["call-A", "call-B"], "every refusal must be separately attributable in the trace");
});

test("6. a call with no id is named as such rather than silently unlabelled", async () => {
  const { adapter } = await deadTask();
  const later = await adapter.precheckToolCall("read", "read", { path: "notes.md" });
  assert.match(
    later.decision.reason ?? "",
    /toolCallId=<none>/,
    "an absent id is a fact to state; silently omitting it leaves the refusal uncorrelatable",
  );
});

test("7. WATCH (F006 ledger section 3): a post-denial refusal is never reason-less", async () => {
  // The ledger's standing condition: a preflight denial producing NEITHER a
  // POLICY_DENIED certificate NOR a reason-bearing trace entry means delivery
  // is broken. Expressed as a test, so it is checked every run rather than
  // remembered and checked by hand after the next death.
  const { adapter } = await deadTask();
  await adapter.precheckToolCall("read", "read", { path: "notes.md" }, undefined, "later-call-1");

  const refusals = lifecycleRefusals(adapter);
  assert.ok(refusals.length > 0, "precondition: the post-death call must have produced a trace entry");

  for (const entry of refusals) {
    const payload = entry.payload as Record<string, unknown>;
    assert.equal(payload.refusal, "task_terminal");
    assert.equal(payload.evaluated, false, "a lifecycle refusal evaluates nothing, and must say so structurally");
    assert.ok(
      typeof payload.reason === "string" && payload.reason.trim() !== "",
      "LIFECYCLE_REFUSED must always carry a non-empty reason",
    );
    assert.ok(
      typeof payload.originalFailureReason === "string" && payload.originalFailureReason !== "",
      "after a policy denial, every refusal must carry the ORIGINAL failure it is replaying",
    );
  }
});

test("8. a task that died WITHOUT a failureReason says so, and invents nothing", async () => {
  // The one branch production does not reach naturally: a terminal task with no
  // stored reason. Forced here deliberately, and labelled as forced, because a
  // fabricated precondition is only acceptable when the test says so. The
  // precondition is still asserted before the outcome.
  const adapter = await adapterFor();
  forceState(adapter, { status: "FAILED", failureReason: "" });
  assert.equal(adapter.currentTask?.status, "FAILED", "precondition: the task is terminal");
  assert.equal(adapter.currentTask?.failureReason, "", "precondition: and carries no stored reason");

  const later = await adapter.precheckToolCall("read", "read", { path: "notes.md" }, undefined, "c1");
  assert.match(
    later.decision.reason ?? "",
    /terminated WITHOUT recording a failureReason/,
    "an absent original failure must be stated, not elided",
  );
  assert.equal(
    lastRefusalPayload(adapter)?.replayed,
    false,
    "nothing was replayed, and the trace must not claim that it was",
  );
});
