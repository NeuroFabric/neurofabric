import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { buildPolicy } from "./project-config.ts";
import { parsePolicyConfig, type PolicyConfig } from "../core/policy-config.ts";
import type { NeurofebricProjectConfig } from "./project-config.ts";

/**
 * F-008: the tool-call budget gave no signal until it killed the task.
 *
 * A task that spent half its budget re-reading the same file region died at the
 * next call with `maxToolCallsPerTask exceeded (40)`, both planned edits
 * already applied and nothing committed. The limit did its job; the failure was
 * that the budget was invisible until it was terminal.
 *
 * What is asserted here, and what is NOT:
 *  - the limit itself is untouched. The 41st call is still denied, with the same
 *    reason, by the same check in the same place (AC6, AC7);
 *  - nothing below emits a warning (AC4);
 *  - each band warns ONCE, so the signal is not buried (AC3);
 *  - a repeated identical call is visible as a count (AC7);
 *  - two different calls are not the same repeat (AC8);
 *  - a new turn starts with a fresh budget and fresh warnings (AC9);
 *  - a policy that does not meter is untouched (AC10);
 *  - a superseded handler reports nothing for the task that replaced it (AC11).
 */

const LIMIT = 40;
const TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "write", "edit"];

const TRUSTED: NeurofebricProjectConfig = { policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] };
const APPROVAL: NeurofebricProjectConfig = { policyMode: "APPROVAL", allowedRoots: ["."] };

// Only the limits matter to this finding, so the config carries only limits.
// The content patterns are left at their defaults and are never exercised here.
const RULES = {
  version: 1,
  deniedTools: [],
  allowedTools: [],
  fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
  destructiveCommandPatterns: ["rm -rf"],
  destructiveCommandTokens: ["rm", "rmdir", "del"],
  limits: { maxToolCallsPerTask: LIMIT, maxFileWritesPerTask: 10, maxBytesPerWrite: 2_000_000 },
  onViolation: "block",
} as const;

async function sandbox(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "nf-f008-"));
}

/** A metered adapter, exactly as the extension builds it: a ConfiguredPolicy in front of the tier policy. */
async function meteredAdapter(
  root: string,
  config: NeurofebricProjectConfig = TRUSTED,
  overrides: Record<string, unknown> = {},
) {
  const policyConfig: PolicyConfig = parsePolicyConfig({ ...RULES, ...overrides }, "f008-policy.json");
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy(config, root, policyConfig));
  for (const name of TOOL_NAMES) adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
  await adapter.beginTask("do the work", "do the work");
  return adapter;
}

const types = (k: KernelAdapter, type: string) => k.recentEvents(500).filter((e) => e.type === type);
const budgetWarnings = (k: KernelAdapter) => types(k, "BUDGET_LOW");
const repeatWarnings = (k: KernelAdapter) => types(k, "TOOL_CALL_REPEATED");

/**
 * `n` distinct reads, so a budget test is not also a repeat test: each call
 * names a different file, which is what the finding describes as useful work.
 */
async function readTimes(adapter: KernelAdapter, n: number, prefix = "c"): Promise<void> {
  for (let i = 1; i <= n; i += 1) {
    const { decision } = await adapter.precheckToolCall("read", "execute", { path: `notes-${i}.md` }, undefined, `${prefix}-${i}`);
    assert.equal(decision.decision, "ALLOW", `call ${i} of ${n} must be allowed`);
  }
}

test("A. no budget warning below 75% of the limit", async () => {
  const root = await sandbox();
  const adapter = await meteredAdapter(root);

  // 29 of 40 is the last count below the 75% band, which is ceil(0.75 * 40) = 30.
  await readTimes(adapter, 29);

  assert.equal(budgetWarnings(adapter).length, 0, "a task below 75% must be left alone");
  assert.equal(adapter.budget?.level, "ok");
  assert.equal(adapter.budget?.used, 29);
  assert.equal(adapter.budget?.remaining, LIMIT - 29);
});

test("B. the 75% band warns once, with the numbers that matter", async () => {
  const root = await sandbox();
  const adapter = await meteredAdapter(root);

  await readTimes(adapter, 30);

  const warnings = budgetWarnings(adapter);
  assert.equal(warnings.length, 1, "crossing 75% warns exactly once");
  assert.equal(warnings[0].payload.level, "low");
  assert.equal(warnings[0].payload.used, 30);
  assert.equal(warnings[0].payload.limit, LIMIT);
  assert.equal(warnings[0].payload.remaining, 10, "the agent is told what is left while it can still use it");

  // The warning is not repeated on every later call.
  await readTimes(adapter, 5, "later");
  assert.equal(budgetWarnings(adapter).length, 1, "the 75% band must not repeat");
});

test("C. the 90% band warns once, separately from the 75% band", async () => {
  const root = await sandbox();
  const adapter = await meteredAdapter(root);

  await readTimes(adapter, 36);

  const warnings = budgetWarnings(adapter);
  assert.equal(warnings.length, 2, "two bands crossed, two warnings");
  assert.deepEqual(warnings.map((w) => w.payload.level), ["low", "critical"]);
  assert.equal(warnings[1].payload.used, 36);
  assert.equal(warnings[1].payload.remaining, 4);

  await readTimes(adapter, 3, "tail");
  assert.equal(budgetWarnings(adapter).length, 2, "neither band may repeat");
});

test("D. a repeated identical call is visible as a count", async () => {
  const root = await sandbox();
  const adapter = await meteredAdapter(root);
  let call = 0;
  const read = () => adapter.precheckToolCall("read", "execute", { path: "anchor.md", offset: 12 }, undefined, `r-${(call += 1)}`);

  await read();
  assert.equal(repeatWarnings(adapter).length, 0, "the first occurrence is not a repeat");

  await read();
  await read();

  const repeats = repeatWarnings(adapter);
  assert.equal(repeats.length, 2, "the second and third occurrences are repeats");
  assert.equal(repeats[0].payload.repeatCount, 2);
  assert.equal(repeats[1].payload.repeatCount, 3, "the count is the number of occurrences, not a boolean");
  assert.equal(adapter.budget?.repeatCount, 3);
});

test("E. a different call is not the same repeat", async () => {
  const root = await sandbox();
  const adapter = await meteredAdapter(root);

  await adapter.precheckToolCall("read", "execute", { path: "a.md", offset: 1 }, undefined, "1");
  await adapter.precheckToolCall("read", "execute", { path: "b.md", offset: 1 }, undefined, "2");
  assert.equal(repeatWarnings(adapter).length, 0, "a different path is a different call");

  await adapter.precheckToolCall("read", "execute", { path: "a.md", offset: 2 }, undefined, "3");
  assert.equal(repeatWarnings(adapter).length, 0, "a different offset is a different call");

  await adapter.precheckToolCall("grep", "execute", { path: "a.md", pattern: "x" }, undefined, "4");
  assert.equal(repeatWarnings(adapter).length, 0, "a different tool is a different call");

  // Key order is construction detail, not a different call: the finding is about
  // re-reading a region, and a caller cannot help how it built the object.
  await adapter.precheckToolCall("read", "execute", { offset: 1, path: "a.md" }, undefined, "5");
  assert.equal(repeatWarnings(adapter).length, 1, "the same read with reordered keys is a repeat");
  assert.equal(repeatWarnings(adapter)[0].payload.repeatCount, 2);
});

test("F. a warning changes nothing about the call or the task", async () => {
  const root = await sandbox();
  const adapter = await meteredAdapter(root);

  await readTimes(adapter, 36);
  const { decision } = await adapter.precheckToolCall("read", "execute", { path: "final.md" }, undefined, "final");

  assert.equal(decision.decision, "ALLOW", "a warning is not a denial");
  assert.equal(adapter.currentTask?.status, "PLANNING", "a warning does not move the task");
  assert.equal(adapter.currentTask?.failureReason, undefined);
  assert.equal(adapter.diagnostics.denialCount, 0, "a warning is not counted as a denial");
  assert.equal(adapter.diagnostics.terminalRefusalCount, 0, "and not as a terminal refusal");
  assert.equal(adapter.diagnostics.toolExecutionCount, 0, "preflight alone never binds an execution");
  assert.equal(budgetWarnings(adapter).length, 2, "the warnings were purely observational");
});

test("G. the limit itself is unchanged, and the denial still explains itself", async () => {
  const root = await sandbox();
  const adapter = await meteredAdapter(root);

  for (let call = 1; call <= LIMIT; call += 1) {
    const { decision } = await adapter.precheckToolCall("read", "execute", { path: `notes-${call}.md` }, undefined, `c-${call}`);
    assert.equal(decision.decision, "ALLOW", `call ${call} of ${LIMIT} must be allowed`);
  }
  // The agent was warned at 30 and 36, well before this.
  assert.equal(budgetWarnings(adapter).length, 2);

  const overflow = await adapter.precheckToolCall("read", "execute", { path: "notes-41.md" }, undefined, "c-41");
  assert.equal(overflow.decision.decision, "DENY", "the 41st call is still denied");
  assert.match(
    (overflow.decision as { reason: string }).reason,
    /maxToolCallsPerTask exceeded \(40\)/,
    "with the same reason as before F-008",
  );
  assert.equal(await adapter.beginToolExecution("c-41", "read"), undefined, "the refused call must not execute");

  // on_violation is block, so the task is untouched and can continue.
  assert.equal(adapter.currentTask!.status, "PLANNING");
  assert.equal(adapter.currentTask!.failureReason, undefined);
  assert.equal(adapter.diagnostics.denialCount, 1, "the limit denial is still one policy denial");
  assert.equal(budgetWarnings(adapter).length, 2, "the denial does not produce a new budget warning");
});

test("H. a new turn gets a fresh budget and fresh warnings", async () => {
  const root = await sandbox();
  const adapter = await meteredAdapter(root);

  await readTimes(adapter, 36, "one");
  assert.equal(budgetWarnings(adapter).length, 2);

  await adapter.beginTask("second turn", "second turn");
  assert.equal(adapter.budget, undefined, "a new turn starts with no budget state");

  // The previous turn already warned in both bands, so a suppressed warning
  // here would be exactly the failure mode AC9 exists to prevent.
  await readTimes(adapter, 30, "two");
  const warnings = budgetWarnings(adapter);
  assert.equal(warnings.length, 3, "the new turn warns again: 2 from the first, 1 from this one");
  assert.equal(warnings[2].payload.used, 30);
  assert.equal(warnings[2].taskId, adapter.currentTask!.taskId, "and the warning belongs to the new task");

  // And the first turn's calls do not count against it.
  const overflow = await adapter.precheckToolCall("read", "execute", { path: "more.md" }, undefined, "two-31");
  assert.equal(overflow.decision.decision, "ALLOW", "the new turn has its own 40 calls");
});

test("I. a policy that does not meter is completely unchanged", async () => {
  const root = await sandbox();
  const adapter = new KernelAdapter();
  // No declarative policy file, so the tier policy is installed on its own and
  // has no budget to report.
  adapter.setPolicy(buildPolicy(TRUSTED, root));
  for (const name of TOOL_NAMES) adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
  await adapter.beginTask("unmetered", "unmetered");

  for (let call = 1; call <= 45; call += 1) {
    const { decision } = await adapter.precheckToolCall("read", "execute", { path: `n-${call}.md` }, undefined, `c-${call}`);
    assert.equal(decision.decision, "ALLOW", `call ${call} must still be allowed: no metering means no limit`);
  }

  assert.equal(adapter.budget, undefined, "nothing to report when nothing is metered");
  assert.equal(budgetWarnings(adapter).length, 0, "and so no warnings");
  assert.equal(repeatWarnings(adapter).length, 0, "and no repeat tracking");
});

test("J. a superseded handler reports nothing for the task that replaced it", async () => {
  const root = await sandbox();
  // APPROVAL mode so a write escalates and the precheck yields at
  // APPROVAL_REQUIRED, which is the interleaving point.
  const adapter = await meteredAdapter(root, APPROVAL);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let parked = false;
  adapter.events.subscribe((e) => {
    if (e.type !== "APPROVAL_REQUIRED" || parked) return;
    parked = true;
    return gate;
  });

  const stale = adapter.precheckToolCall("write", "execute", { path: "x.md", content: "x" }, undefined, "w-1");
  await new Promise((resolve) => setImmediate(resolve));
  const next = await adapter.beginTask("second turn", "second turn");
  release();
  const result = await stale;

  assert.equal(result.decision.decision, "DENY", "the stale handler is refused as before");
  assert.equal((result.decision as { refusal?: string }).refusal, "stale_task");
  assert.equal(adapter.budget, undefined, "the stale handler wrote no budget state onto the new task");
  assert.equal(budgetWarnings(adapter).length, 0, "and emitted no budget warning for it");
  assert.equal(repeatWarnings(adapter).length, 0, "and no repeat warning");
  assert.equal(adapter.currentTask?.taskId, next.taskId);
  assert.equal(adapter.currentTask?.status, "PLANNING");
});
