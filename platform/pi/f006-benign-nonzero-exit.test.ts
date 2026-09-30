import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CoreError } from "../core/errors.ts";
import { DEFAULT_LIMITS } from "../core/index.ts";
import { classifyFailure, chooseRecoveryDetailed } from "../core/recovery.ts";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { buildPolicy } from "./project-config.ts";

/**
 * F-006 §2.3: a benign non-zero exit must not spend recovery budget.
 *
 * THE DEFECT, in the chain `classifyFailure` -> `chooseRecoveryDetailed`:
 *
 *   - `classifyFailure` maps a `TOOL_ERROR` to `TRANSIENT` or `TOOL_FAILURE` on
 *     `error.retryable` ALONE. The exit status is never examined.
 *   - `TOOL_FAILURE` is not in `RETRY_ELIGIBLE`, so it is not retry-eligible.
 *   - Having missed the retry-eligible set and the two dedicated rows, the
 *     repeat path falls through to `GENERIC_REPLAN` while budget remains, then
 *     `TERMINATE` / `REPLAN_BUDGET_EXHAUSTED`.
 *
 * So `grep` finding nothing — an ordinary, successful outcome — spends a
 * replan, and two of them kill the task. That is the witnessed death in ledger
 * §2.3, twice: once operator-transcribed, once first-party.
 *
 * WHY THE RULE CANNOT KEY ON THE EXIT CODE ALONE. Measured, not assumed:
 * `node -e "process.exit(1)"` is a genuine failure and exits 1. So does a `cp`
 * of a missing file. A rule that called every exit 1 benign would swallow real
 * failures, which is the weakening the standing rules forbid. Nor does "non-zero
 * with empty output" work: that same `node` measurement produced NO output at
 * all. The rule therefore has to key on WHICH COMMAND ran, as an enumerated
 * (command, exit-code) table. B3 and B4 are the guard on that: they are the
 * obvious wrong fix, and they are written before the fix.
 *
 * WHY "TERMINAL" IS NOT THE STRATEGY. The failure is terminal — a no-match
 * will still be a no-match on a retry, so there is nothing to recover — but the
 * TASK is not. Terminating here would replace a budget death with a stricter
 * one, killing any task that greps. The failure is final; the task lives, and it
 * books no budget. That is the same shape as the survivable refusal, and it is
 * why the decision is CONTINUE.
 *
 * FAIL-CLOSED BY CONSTRUCTION. The exit status and the command name are both
 * optional, and an absent one means today's behaviour, bit for bit. The worst
 * case for a wrong parse is that the fix is INERT, never that it misclassifies:
 * `B5` and `B6` pin that.
 */

type CoreErrorOptions = ConstructorParameters<typeof CoreError>[2];

/**
 * Options are cast because the two fields this gate exercises do not exist yet
 * — that absence IS the red. Written so the file compiles both before and
 * after the fix, so a red run fails on the ASSERTION and not on a type error.
 */
const toolFailure = (extra: Record<string, unknown> = {}): CoreError =>
  new CoreError("TOOL_ERROR", "Tool bash failed", { retryable: false, ...extra } as unknown as CoreErrorOptions);

/** The result body Pi produced, measured first-party from a real non-zero exit. */
const NO_MATCH_RESULT = "(no output)\n\nCommand exited with code 1";
const ERROR_RESULT = "grep: notes.md: No such file or directory\n\nCommand exited with code 2";

// --- 1. the flip: a benign exit is classified benign ------------------------

test("B1 a search that found nothing is classified BENIGN, not TOOL_FAILURE", () => {
  const benign = toolFailure({ commandName: "grep", exitStatus: 1 });
  assert.equal(
    classifyFailure(benign),
    "BENIGN_NONZERO_EXIT",
    "a grep no-match is not a tool failure and must not be classified as one",
  );
  assert.notEqual(classifyFailure(benign), "TOOL_FAILURE", "stated separately: this is the class that spends the budget");
});

test("B2 a benign exit books NO recovery budget, at every budget state", () => {
  // Every combination of the three counters plus depth, including states where
  // the budget is already gone. A benign exit must not terminate on a budget it
  // never spent, so its row has to precede the depth and budget guards.
  for (const retryCount of [0, 1, 5]) {
    for (const replanCount of [0, 1, 2, 9]) {
      for (const strategyCount of [0, 2, 9]) {
        for (const depth of [0, 1, 3, 99]) {
          assert.deepEqual(
            chooseRecoveryDetailed({
              failure: "BENIGN_NONZERO_EXIT",
              limits: DEFAULT_LIMITS,
              retryCount,
              replanCount,
              strategyCount,
              depth,
              idempotency: "IDEMPOTENT",
            }),
            { strategy: "CONTINUE", reason: "BENIGN_NONZERO_EXIT_CONTINUED" },
            `retry=${retryCount} replan=${replanCount} strategy=${strategyCount} depth=${depth}: a benign exit spends nothing and kills nothing`,
          );
        }
      }
    }
  }
});

// --- 2. the guard on the obvious wrong fix ----------------------------------

test("B3 a GENUINE failure that happens to exit 1 is still a tool failure", () => {
  // The live counterexample, measured: `node -e "process.exit(1)"` exits 1, is
  // not a search, and really did fail. It must keep today's classification and
  // today's decision exactly.
  const genuine = toolFailure({ commandName: "node", exitStatus: 1 });
  assert.equal(classifyFailure(genuine), "TOOL_FAILURE", "exit 1 alone must never buy a pass");
  assert.deepEqual(
    chooseRecoveryDetailed({
      failure: classifyFailure(genuine),
      limits: DEFAULT_LIMITS,
      retryCount: 0,
      replanCount: 0,
      depth: 0,
      idempotency: "IDEMPOTENT",
    }),
    { strategy: "REPLAN", reason: "GENERIC_REPLAN" },
    "and it must still replan exactly as it did before this fix",
  );
});

test("B4 the same command's ERROR code is not benign", () => {
  // grep exits 2 when it cannot read its input. Same command, different code,
  // genuinely broken: the table is per (command, code), never per command.
  assert.equal(classifyFailure(toolFailure({ commandName: "grep", exitStatus: 2 })), "TOOL_FAILURE");
  assert.equal(classifyFailure(toolFailure({ commandName: "diff", exitStatus: 2 })), "TOOL_FAILURE");
});

test("B5 a tool error carrying NO exit status behaves exactly as before", () => {
  // Fail-closed. Absent information must not become a pass.
  assert.equal(classifyFailure(toolFailure()), "TOOL_FAILURE");
  assert.equal(classifyFailure(toolFailure({ exitStatus: undefined, commandName: undefined })), "TOOL_FAILURE");
  // A non-search command with no name at all, and a command that is not in the
  // table, are both ordinary failures.
  assert.equal(classifyFailure(toolFailure({ exitStatus: 1, commandName: "cp" })), "TOOL_FAILURE");
  assert.equal(classifyFailure(toolFailure({ exitStatus: 0, commandName: "grep" })), "TOOL_FAILURE", "zero is not a non-zero exit");
});

test("B6 the retry-eligible set is untouched", () => {
  // The standing rule: do not weaken retry eligibility for genuine failures.
  // A retryable tool error with no exit information is still TRANSIENT and
  // still gets its RETRY, exactly as before.
  const flaky = new CoreError("TOOL_ERROR", "flaky", { retryable: true });
  assert.equal(classifyFailure(flaky), "TRANSIENT");
  assert.deepEqual(
    chooseRecoveryDetailed({
      failure: classifyFailure(flaky),
      limits: DEFAULT_LIMITS,
      retryCount: 0,
      replanCount: 0,
      depth: 0,
      idempotency: "IDEMPOTENT",
    }),
    { strategy: "RETRY", reason: "TRANSIENT_RETRY" },
    "a genuine transient still retries",
  );
  // And a retryable error is not laundered into benign by an exit status: a
  // retryable grep no-match is still classified by the same rule, so the table
  // decides, not the flag.
  assert.equal(classifyFailure(toolFailure({ retryable: true, commandName: "grep", exitStatus: 1 })), "BENIGN_NONZERO_EXIT");
});

// --- 3. end to end: the budget is the thing that was actually spent ---------

const TOOLS = ["read", "bash", "write"].map((name) => toolDescriptorFromPi({ name, description: name }));

async function adapter(): Promise<KernelAdapter> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nf-benign-exit-"));
  const k = new KernelAdapter();
  k.setPolicy(buildPolicy({ policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] }, dir));
  k.registerTools(TOOLS);
  await k.beginTask("find the token in the notes", "find the token in the notes");
  return k;
}

/** The production order, named because an order assumption must not hide here. */
async function shellCall(k: KernelAdapter, id: string, command: string, payload: unknown): Promise<void> {
  await k.precheckToolCall("bash", "execute", { command }, undefined, id);
  await k.beginToolExecution(id, "bash");
  await k.recordToolResult(id, "bash", payload, true);
}

const eventsOf = (k: KernelAdapter, type: string) => k.recentEvents(500).filter((e) => e.type === type);

test("B7 end to end: a no-match costs nothing, and the task survives to try again", async () => {
  const k = await adapter();
  await shellCall(k, "c1", "grep -rn needle notes.md", NO_MATCH_RESULT);

  assert.equal(k.currentTask?.status, "PLANNING", "the task is still alive and still able to act");
  assert.equal(k.currentTask?.replanCount, 0, "the replan budget is untouched — this is the whole defect");
  assert.equal(k.currentTask?.retryCount, 0, "and so is the retry budget");
  assert.equal(eventsOf(k, "TASK_FAILED").length, 0, "no terminal certificate may be produced");
  assert.equal(eventsOf(k, "SOFT_REFUSAL_CONTINUED").length, 1, "the benign outcome is reported, never swallowed");

  // Two more ordinary no-matches. Under the old chain this is what spent a
  // budget of 2/2 and killed the task, so the repetition IS the regression.
  await shellCall(k, "c2", "grep -rn other notes.md", NO_MATCH_RESULT);
  await shellCall(k, "c3", "grep -rn third notes.md", NO_MATCH_RESULT);
  assert.equal(k.currentTask?.replanCount, 0, "three benign exits still spend nothing");
  assert.equal(eventsOf(k, "TASK_FAILED").length, 0, "and the task is still alive after all three");
});

test("B8 end to end: a genuine failure still spends budget exactly as before", async () => {
  const k = await adapter();
  // Exit 1 from a command that is not a search: the measured `node` case.
  //
  // The discriminator between a benign CONTINUE and a genuine REPLAN is NOT the
  // task status: both end in PLANNING, because a replan re-enters planning too.
  // An earlier draft of this gate asserted on status and was red for the wrong
  // reason. It is the BUDGET and the EVENT that differ, and both are asserted.
  await shellCall(k, "g1", 'node -e "process.exit(1)"', "\n\nCommand exited with code 1");
  assert.equal(k.currentTask?.replanCount, 1, "a genuine failure must still charge the replan budget");
  assert.equal(eventsOf(k, "SOFT_REFUSAL_CONTINUED").length, 0, "and must not be laundered into a survivable outcome");

  // A genuine failure of the SAME command that is in the table: grep's error
  // code is not a no-match.
  const k2 = await adapter();
  await shellCall(k2, "g2", "grep -rn needle missing.md", ERROR_RESULT);
  assert.equal(k2.currentTask?.replanCount, 1, "grep exiting 2 is an error, not a no-match");
});

test("B9 the exit status is read from the trailing annotation only", async () => {
  // A result that merely CONTAINS the phrase mid-body is not an exit status.
  // The parser is anchored, so ordinary output that quotes the words cannot
  // manufacture a benign classification.
  const k = await adapter();
  await shellCall(
    k,
    "p1",
    "grep -rn needle notes.md",
    "some file said: Command exited with code 1\nand then succeeded",
  );
  assert.equal(k.currentTask?.replanCount, 1, "a mid-text mention must not be read as an exit status");
});

test("B10 a structured exit code is preferred over text, and absence is inert", async () => {
  const k = await adapter();
  await shellCall(k, "s1", "grep -rn needle notes.md", { exitCode: 1, output: "" });
  assert.equal(k.currentTask?.replanCount, 0, "a structured exit code is honoured when present");

  // Nothing recognisable at all: today's behaviour, unchanged.
  const k2 = await adapter();
  await shellCall(k2, "s2", "grep -rn needle notes.md", { output: "" });
  assert.equal(k2.currentTask?.replanCount, 1, "an unrecognised result must stay a plain tool failure");
});
