import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { buildPolicy } from "./project-config.ts";
import { parsePolicyConfig, type PolicyConfig } from "../core/policy-config.ts";
import type { DenialTier } from "../core/index.ts";

/**
 * THE PAYLOAD-POSITION TIERING, 2026-10-01.
 *
 * Ruling: the destructive-token scan classifies by TOKEN POSITION.
 *
 *   COMMAND position -- the token IS the operation being run. HARD_DENY, and the
 *     run terminates. This is the security floor and it does not move.
 *
 *   PAYLOAD position -- the token is DATA: a commit message, a grep pattern, a
 *     quoted string. SOFT_REFUSE, and the run continues so the agent can
 *     rephrase and carry on.
 *
 * Both tiers refuse execution. They differ ONLY in whether the task ends.
 *
 * WHY ONE TOKEN, TWO POSITIONS. This file deliberately uses a SINGLE configured
 * token and places it in two positions, because that is the whole claim: if the
 * tier is a property of the token, both cases agree; if the tier is a property
 * of the POSITION, they disagree. A test built from two different tokens could
 * not tell those apart, and would pass just as happily against a rule that had
 * memorised both spellings.
 *
 * WHY THE TOKEN IS COMPOSED. As in `d1-refusal-tiers.test.ts`: the string has to
 * exist for the rule to match it, and writing it literally would put a live
 * destructive token into the repository, which this same policy refuses.
 */
const TOKEN = ["sh", "red"].join("");

const RULES = {
  version: 1,
  deniedTools: [],
  allowedTools: [],
  fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
  destructiveCommandPatterns: [],
  destructiveCommandTokens: [TOKEN],
  secretWritePatterns: [],
  limits: { maxToolCallsPerTask: 200, maxFileWritesPerTask: 30, maxBytesPerWrite: 2_000_000 },
  onViolation: "block",
} as const;

const TOOLS = ["read", "write", "bash"].map((name) => toolDescriptorFromPi({ name, description: name }));

async function governed() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-payload-tier-"));
  const config: PolicyConfig = parsePolicyConfig({ ...RULES }, "payload-tier.json");
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy({ policyMode: "TRUSTED_PROJECT", allowedRoots: [dir] }, dir, config));
  adapter.registerTools(TOOLS);
  await adapter.beginTask("do the work", "do the work");
  return { adapter, dir };
}

const lastPayload = (k: KernelAdapter, type: string) =>
  k.recentEvents(500).filter((e) => e.type === type).at(-1)?.payload as Record<string, unknown> | undefined;

/** Preflight only: which tier did the RULE assign? */
async function tierOf(k: KernelAdapter, command: string, id: string): Promise<DenialTier | undefined> {
  const { decision } = await k.precheckToolCall("bash", "execute", { command }, undefined, id);
  assert.equal(decision.decision, "DENY", `"${command}" must be refused, or this pin proves nothing`);
  return (decision as { tier?: DenialTier }).tier;
}

/** The PRODUCTION order for a refusal: bind, preflight, then report the reason. */
async function refuseThenReport(k: KernelAdapter, command: string, id: string): Promise<string> {
  const bound = await k.beginToolExecution(id, "bash", { toolCallId: id });
  assert.ok(bound, `${id}: the start event binds before the preflight runs`);
  const { decision } = await k.precheckToolCall("bash", "execute", { command }, undefined, id);
  assert.equal(decision.decision, "DENY", `${id}: the call must actually be refused`);
  await k.recordToolResult(id, "bash", undefined, true, undefined, decision.reason, undefined,
    (decision as { tier?: DenialTier }).tier);
  return decision.reason;
}

// === T1. PAYLOAD position: refused, but the run lives =====================

test("P1 a token inside a commit message is SOFT_REFUSE", async () => {
  const { adapter } = await governed();
  const tier = await tierOf(adapter, `git commit -m "docs: note the ${TOKEN} step"`, "p1");
  assert.equal(tier, "SOFT_REFUSE",
    "a word in a message is DATA the agent can rephrase, not an operation it attempted");
});

test("P1b a soft payload refusal leaves the task ALIVE and books no budget", async () => {
  const { adapter } = await governed();
  const reason = await refuseThenReport(adapter, `git commit -m "docs: note the ${TOKEN} step"`, "p1b");
  const task = adapter.currentTask!;
  assert.notEqual(task.status, "FAILED", "the run survives a payload refusal, or it cannot rephrase");
  assert.equal(task.retryCount, 0, "and it is not retried");
  assert.equal(task.replanCount, 0, "nor replanned");
  assert.equal(lastPayload(adapter, "RECOVERY_STARTED")?.reason, "POLICY_SOFT_REFUSED");
  assert.ok(reason.length > 0, "and the reason survives so the agent knows what to rephrase");
});

test("P1c the payload refusal still names the rule that made it", async () => {
  const { adapter } = await governed();
  const reason = await refuseThenReport(adapter, `git commit -m "docs: note the ${TOKEN} step"`, "p1c");
  const refusal = lastPayload(adapter, "SOFT_REFUSAL_CONTINUED");
  assert.equal(refusal?.denialReason, reason, "survivable, but never anonymous");
  assert.equal(adapter.lastFailureReport!.tier, "SOFT_REFUSE", "and the tier travels with it");
});

test("P1d a grep PATTERN is exempt outright, and the run is untouched", async () => {
  // The ruling lists grep patterns under payload position -> SOFT_REFUSE. The
  // committed carve-out in command-position.ts already EXEMPTS them, so the call
  // is ALLOWED rather than softly refused. That is strictly stronger than the
  // ruling asks for, and it is pinned separately by
  // command-position-corpus.test.ts. Turning it into a refusal would be a new
  // behaviour change rather than a tiering, which this task does not authorise.
  // Recorded here so the gap between the ruling's wording and the shipped
  // carve-out is visible instead of silent.
  const { adapter } = await governed();
  const { decision } = await adapter.precheckToolCall("bash", "execute", { command: `grep -r "${TOKEN}" .` }, undefined, "p1d");
  assert.equal(decision.decision, "ALLOW", "the pattern-position carve-out exempts this outright");
  assert.notEqual(adapter.currentTask!.status, "FAILED", "and a payload-position token never ends the run");
});

// === T2. COMMAND position: the floor. Must not move. =====================

test("P2 the same token AS THE COMMAND is HARD_DENY", async () => {
  const { adapter } = await governed();
  const tier = await tierOf(adapter, `${TOKEN} notes.txt`, "p2");
  assert.equal(tier, "HARD_DENY",
    "the token is the operation here, so this is the security floor and it does not move");
});

test("P2b a command-position refusal TERMINATES the run", async () => {
  const { adapter } = await governed();
  const reason = await refuseThenReport(adapter, `${TOKEN} notes.txt`, "p2b");
  const task = adapter.currentTask!;
  assert.equal(task.status, "FAILED", "a real deletion ends the run");
  assert.match(task.failureReason!, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "and the certificate names WHICH rule refused it");
  assert.equal(lastPayload(adapter, "TASK_FAILED")?.reasonCode, "POLICY_DENIED_TERMINATED");
});

test("P2c the floor holds through a wrapper", async () => {
  // A deletion reached through a wrapper is still a deletion. If position
  // classification only understood a bare command, this is what would slip.
  const { adapter } = await governed();
  assert.equal(await tierOf(adapter, `xargs ${TOKEN} < list.txt`, "p2c"), "HARD_DENY",
    "the wrapper is not the operation; the token after it is");
});

test("P2d the floor holds inside a shell payload", async () => {
  const { adapter } = await governed();
  assert.equal(await tierOf(adapter, `bash -c "${TOKEN} notes.txt"`, "p2d"), "HARD_DENY",
    "a nested command line is parsed, not waved through");
});

/**
 * The two halves are the same rule seen from both sides. If either pair were
 * satisfied by a rule that ignored position, this would fail -- which is the
 * only reason to keep them adjacent.
 */
test("P2e the same token yields opposite tiers by position alone", async () => {
  const payloadSide = await governed();
  const commandSide = await governed();
  const soft = await tierOf(payloadSide.adapter, `git commit -m "docs: note the ${TOKEN} step"`, "pair-soft");
  const hard = await tierOf(commandSide.adapter, `${TOKEN} notes.txt`, "pair-hard");
  assert.equal(soft, "SOFT_REFUSE");
  assert.equal(hard, "HARD_DENY");
});