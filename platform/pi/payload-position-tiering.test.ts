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

// === 3. COMPOUND COMMANDS: classified per segment ========================
//
// A compound command is several command lines joined by `;`, `|` or `&&`. Each
// is a command line in its own right and must be judged on its own.
//
// The bug these pin: `parseCommandLine` used to stop at the FIRST segment it
// could not classify, discarding every exemption it had already earned. So one
// unrelated `echo` anywhere in the line could void a legitimate grep exemption
// elsewhere in the same line. That is the compound command that ended the
// session that produced this file.
//
// The floor moved the other way at the same time, and that is the important
// half: before this, a deletion sitting AFTER an unclassifiable segment was
// never parsed at all, so it was tiered as payload and the run continued. The
// fix makes the floor STRONGER than it was, not merely different.

test("P3a a grep pattern survives an unclassifiable sibling segment", async () => {
  // This is the session-killer shape: a grep for a real word, then an echo,
  // then an ls. The token appears ONLY in the grep's pattern position.
  const { adapter } = await governed();
  const { decision } = await adapter.precheckToolCall(
    "bash", "execute", { command: `grep -rn "${TOKEN}" docs; echo done; ls docs` }, undefined, "p3a",
  );
  assert.equal(decision.decision, "ALLOW",
    "an unclassifiable sibling must not cost a sibling segment its exemption");
  assert.notEqual(adapter.currentTask!.status, "FAILED");
});

test("P3b the floor holds for a deletion in the FIRST segment", async () => {
  const { adapter } = await governed();
  assert.equal(await tierOf(adapter, `${TOKEN} notes.txt; echo done`, "p3b"), "HARD_DENY",
    "command position in any segment is command position");
});

test("P3c the floor holds for a deletion AFTER an unclassifiable segment", async () => {
  // RED before the fix: the echo was unclassifiable, the parser stopped there,
  // the deletion was never seen as an operation, and the run continued.
  const { adapter } = await governed();
  assert.equal(await tierOf(adapter, `echo done; ${TOKEN} notes.txt`, "p3c"), "HARD_DENY",
    "a deletion behind an unclassifiable segment must not be softened into payload");
});

test("P3c2 that deletion still terminates the run", async () => {
  const { adapter } = await governed();
  await refuseThenReport(adapter, `echo done; ${TOKEN} notes.txt`, "p3c2");
  assert.equal(adapter.currentTask!.status, "FAILED", "the floor is about the run, not only the tier");
});

test("P3d an unclassifiable segment is SOFT_REFUSE and the run continues", async () => {
  // An option the wrapper table never measured. The parser cannot know what the
  // program does with what follows, so nothing is positively identified as the
  // operation - and the ruling is that ambiguity never terminates.
  const { adapter } = await governed();
  const reason = await refuseThenReport(adapter, `env --unmeasured-option ${TOKEN} notes.txt`, "p3d");
  const task = adapter.currentTask!;
  assert.notEqual(task.status, "FAILED", "ambiguity must not end the run");
  assert.equal(lastPayload(adapter, "RECOVERY_STARTED")?.reason, "POLICY_SOFT_REFUSED");
  assert.ok(reason.length > 0, "and the reason still travels, so the agent can rephrase");
});

test("P3e a pipeline is judged segment by segment too", async () => {
  const grepSide = await governed();
  const commandSide = await governed();
  // Per R2 a pattern position is exempt outright, so this is ALLOW rather than
  // a soft refusal -- and the exemption still has to survive the pipe, which is
  // the whole point of this section.
  const { decision } = await grepSide.adapter.precheckToolCall(
    "bash", "execute", { command: `cat notes | grep -n "${TOKEN}"` }, undefined, "p3e-soft",
  );
  assert.equal(decision.decision, "ALLOW", "the pattern exemption survives a pipeline sibling");
  const hard = await tierOf(commandSide.adapter, `echo done | ${TOKEN} notes.txt`, "p3e-hard");
  assert.equal(hard, "HARD_DENY", "and the operation behind the pipe is still the operation");
});

// === 4. R6: a destructive token behind an UNMEASURED WRAPPER =============
//
// Ruling: when an unmeasured wrapper precedes a known destructive token, the
// token is COMMAND POSITION -- HARD_DENY, terminate. An unmeasured wrapper
// makes operation identity unverifiable, and unverifiable identity with a
// destructive token present fails closed hard.
//
// WHICH TOKEN, THOUGH, is the whole difficulty, and getting it wrong breaks
// everything above. `sudo rm notes.txt` must be hard. But `git commit -m
// "... rm ..."` must NOT, or every payload refusal in section 1 becomes a
// termination and the ruling is worse than the bug.
//
// The line that separates them: a wrapper DELEGATES. Its first bare operand is
// the program it will run. `git`'s first bare operand is `commit`, and the token
// sits behind `-m`, an option value -- so the token is data. `sudo`'s first
// bare operand IS the token -- so the token is the operation, unverifiably.
//
// A rule of "any unmeasured head implies hard" would fail the second case, so
// it is not that rule.

test("P4a a token delegated to an unmeasured wrapper is HARD_DENY", async () => {
  const { adapter } = await governed();
  assert.equal(await tierOf(adapter, `sudo ${TOKEN} notes.txt`, "p4a"), "HARD_DENY",
    "the wrapper's whole purpose is to run this program, and we cannot verify that it does");
});

test("P4b that refusal terminates the run", async () => {
  const { adapter } = await governed();
  await refuseThenReport(adapter, `sudo ${TOKEN} notes.txt`, "p4b");
  assert.equal(adapter.currentTask!.status, "FAILED", "a deletion behind sudo is still a deletion");
});

test("P4c the delegation survives options that take values", async () => {
  const { adapter } = await governed();
  assert.equal(await tierOf(adapter, `sudo -u root ${TOKEN} notes.txt`, "p4c"), "HARD_DENY",
    "an option's value is not the command; the first bare operand after it is");
});

test("P4d an unmeasured wrapper with NO token is untouched", async () => {
  for (const command of ["sudo ls .", "sudo cat notes.txt", "sudo -u root ls -la"]) {
    const { adapter } = await governed();
    const { decision } = await adapter.precheckToolCall("bash", "execute", { command }, undefined, `p4d-${command}`);
    assert.equal(decision.decision, "ALLOW",
      `"${command}" carries no token and must be untouched by R6; got ${decision.decision} ${JSON.stringify((decision as { reason?: string }).reason)}`);
  }
});

test("P4e R6 does not reach a token behind an option value", async () => {
  // This is the boundary that keeps section 1 standing. `git`'s first bare
  // operand is `commit`; the token is `-m`'s value. Delegation does not reach it.
  const { adapter } = await governed();
  assert.equal(await tierOf(adapter, `git commit -m "docs: note the ${TOKEN} step"`, "p4e"), "SOFT_REFUSE",
    "payload tiering must survive R6, or the ruling is worse than the bug it fixes");
});

test("P4f R6 leaves an unmeasured OPTION on a MEASURED wrapper alone", async () => {
  // P3d's case. `env` is measured; its option is not. There is no unmeasured
  // WRAPPER here, so 1b's "ambiguity never terminates" still governs.
  const { adapter } = await governed();
  const reason = await refuseThenReport(adapter, `env --unmeasured-option ${TOKEN} notes.txt`, "p4f");
  assert.notEqual(adapter.currentTask!.status, "FAILED",
    "an unmeasured option is not an unmeasured wrapper, and the two must not be conflated");
  assert.ok(reason.length > 0);
});

test("P4g an unmeasured wrapper does not change a measured wrapper's tiers", async () => {
  const { adapter } = await governed();
  assert.equal(await tierOf(adapter, `xargs ${TOKEN} < list.txt`, "p4g"), "HARD_DENY",
    "a measured wrapper reaching the same conclusion is unchanged by R6");
});