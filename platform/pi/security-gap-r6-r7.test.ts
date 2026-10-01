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
 * THE TWO GAPS IN handoff.md 10a, CLOSED. Both are named in the backlog as
 * places where the guard is WEAKER THAN THE RULE IT IS DESCRIBED BY, and both
 * fail in the direction that lets something through.
 *
 * GAP 3 -- OPTION-VALUE UNDER-DETECTION. `delegatedOperand` assumed that `-X`
 * consumes the next token, which is unverifiable for an unmeasured program.
 * Where the option genuinely takes a value the token is still reached, so it
 * fails CLOSED. Where it takes none, one operand too many is skipped and the
 * token is never reached: `sudo -n <token> notes.txt` names `notes.txt` as the
 * delegated program and never sees the token at all. The fix is to stop guessing
 * WHICH token is delegated and treat every plausible candidate as delegated,
 * because over-detecting on an unmeasured head is the direction R6 already
 * fails and under-detecting is the one that gets something through.
 *
 * GAP 4 -- COMBINED SHELL FLAGS. `sh -lc "<token> ..."` was never read: `-lc`
 * is neither `-c` nor any other payload flag, so the payload was not parsed and
 * the token inside it was in no position at all. A single-letter flag cluster is
 * the normal way people write `sh -lc`, so the documented shape was also the
 * common one. Fixed by reading clusters, and by recognising that a command which
 * IS a shell should have its payload parsed -- `sh -lc` never delegates to a
 * shell, it IS one.
 *
 * The token is composed, never written literally: it has to exist for the rule
 * to match it, and writing it plainly would put a live destructive token into
 * the repository, which this same policy refuses.
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-r6r7-"));
  const config: PolicyConfig = parsePolicyConfig({ ...RULES }, "r6r7.json");
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy({ policyMode: "TRUSTED_PROJECT", allowedRoots: [dir] }, dir, config));
  adapter.registerTools(TOOLS);
  await adapter.beginTask("do the work", "do the work");
  return { adapter, dir };
}

async function decide(k: KernelAdapter, command: string, id: string): Promise<{ decision: string; tier?: DenialTier }> {
  const { decision } = await k.precheckToolCall("bash", "execute", { command }, undefined, id);
  return decision as { decision: string; tier?: DenialTier };
}

/** Preflight only: which tier did the RULE assign? Asserts it was refused. */
async function tierOf(k: KernelAdapter, command: string, id: string): Promise<DenialTier | undefined> {
  const d = await decide(k, command, id);
  assert.equal(d.decision, "DENY", `"${command}" must be refused, or this pin proves nothing`);
  return d.tier;
}

/** For commands that must be ALLOWED. Asserting DENY here would be a fake test. */
async function allows(k: KernelAdapter, command: string, id: string): Promise<void> {
  const d = await decide(k, command, id);
  assert.equal(d.decision, "ALLOW", `"${command}" must not be refused: ${d.tier ?? ""}`);
}

// === GAP 3. OPTION-VALUE UNDER-DETECTION ==================================

test("G3a sudo -n, whose flag takes NO value, no longer hides the token", async () => {
  const { adapter } = await governed();
  const tier = await tierOf(adapter, `sudo -n ${TOKEN} notes.txt`, "g3a");
  assert.equal(tier, "HARD_DENY",
    "an option that takes no value must not cause the operand after it to be skipped as though it were one");
});

test("G3b sudo -u root, whose flag DOES take a value, stays HARD_DENY", async () => {
  // The direction that already worked. Pinned so the fix for G3a cannot quietly
  // cost the case that was never broken.
  const { adapter } = await governed();
  assert.equal(await tierOf(adapter, `sudo -u root ${TOKEN} notes.txt`, "g3b"), "HARD_DENY");
});

test("G3c the token is reached through several valueless option shapes", async () => {
  const { adapter } = await governed();
  for (const [i, command] of [
    `sudo -n ${TOKEN} notes.txt`,
    `sudo -H ${TOKEN} notes.txt`,
    `sudo -k ${TOKEN} notes.txt`,
    `sudo -n -H ${TOKEN} notes.txt`,
    `doas -n ${TOKEN} notes.txt`,
  ].entries()) {
    assert.equal(await tierOf(adapter, command, `g3c${i}`), "HARD_DENY", `${command} must not slip through`);
  }
});

// === GAP 4. COMBINED SHELL FLAGS ==========================================

test("G4a sh -lc is read, which it never was", async () => {
  const { adapter } = await governed();
  assert.equal(await tierOf(adapter, `sh -lc "${TOKEN} notes.txt"`, "g4a"), "HARD_DENY",
    "-lc is a flag cluster containing c, so the payload behind it is command position");
});

test("G4b the other clusters people actually type", async () => {
  const { adapter } = await governed();
  for (const [i, command] of [
    `sh -ic "${TOKEN} notes.txt"`,
    `bash -lc "${TOKEN} notes.txt"`,
    `dash -xc "${TOKEN} notes.txt"`,
    `zsh -lic "${TOKEN} notes.txt"`,
    `sh -c -l "${TOKEN} notes.txt"`,
  ].entries()) {
    assert.equal(await tierOf(adapter, command, `g4b${i}`), "HARD_DENY", `${command} must not slip through`);
  }
});

test("G4c through an unmeasured wrapper as well", async () => {
  const { adapter } = await governed();
  assert.equal(await tierOf(adapter, `sudo sh -lc "${TOKEN} notes.txt"`, "g4c"), "HARD_DENY");
});

test("G4d a benign payload behind a cluster is still allowed, not terminal", async () => {
  // The blast radius of reading clusters. If reading a cluster turned "token in a
  // payload" into "any command ending in a flag cluster is terminal", that would
  // be the same over-blocking the harness guard was corrected for in D-024. An
  // ordinary payload has to keep working normally.
  const { adapter } = await governed();
  await allows(adapter, `sh -lc "ls -la ."`, "g4d");
  await allows(adapter, `bash -lc "cat notes.txt"`, "g4f");
  await allows(adapter, `sh -lic "grep -rn pattern src/"`, "g4g");
});

test("G4e a token as an argument to an UNMEASURED head is still command position", async () => {
  // Not a new behaviour, and worth pinning so nobody later mistakes it for one.
  // `echo` is not in the measured tables, so R6 treats its operand as something
  // the program might run rather than something it merely prints, and says so.
  // That is the pre-existing fail-closed stance for unmeasured heads and it
  // predates cluster reading; asserting SOFT here would be encoding a wish
  // about echo rather than a property of the guard.
  const { adapter } = await governed();
  assert.equal(await tierOf(adapter, `sh -lc "echo ${TOKEN}"`, "g4e"), "HARD_DENY");
  assert.equal(await tierOf(adapter, `sh -c "echo ${TOKEN}"`, "g4h"), "HARD_DENY",
    "and identically for the form that already worked, which is what makes it pre-existing");
});

// === REGRESSIONS. The fix must not cost what already worked ===============

test("R1 a commit message is still a payload, not an operation", async () => {
  const { adapter } = await governed();
  assert.equal(await tierOf(adapter, `git commit -m "docs: note the ${TOKEN} step"`, "r1"), "SOFT_REFUSE");
});

test("R2 grep patterns and file arguments are still patterns", async () => {
  const { adapter } = await governed();
  await allows(adapter, `grep -rn "${TOKEN}" src/`, "r2");
});

test("R3 plain command position is still HARD_DENY", async () => {
  const { adapter } = await governed();
  assert.equal(await tierOf(adapter, `${TOKEN} notes.txt`, "r3"), "HARD_DENY");
});

test("R4 an unmeasured head does not become a blanket denial of its own arguments", async () => {
  // The over-detection risk. `someprogram --config settings.json` delegates to
  // nothing, and treating every bare token as delegated must not make ordinary
  // operand text into a command position.
  const { adapter } = await governed();
  await allows(adapter, "someunknownprogram --config settings.json", "r4");
});

test("R5 an attached option value is not treated as two tokens", async () => {
  const { adapter } = await governed();
  assert.equal(await tierOf(adapter, `sudo -n ${TOKEN}`, "r5"), "HARD_DENY",
    "with no trailing operand the token is still the delegated command");
});