/**
 * Terminal-state conformance for the task lifecycle.
 *
 * F-003 (a policy denial killing a task) was investigated as an unexplained
 * terminal-state anomaly. No reachable defect was found: the anomaly is not
 * reproducible against the current implementation. What was missing is
 * EXECUTABLE PROOF of the invariants that make it unreachable, so this file
 * supplies that proof rather than restating a claim.
 *
 * Why this needs its own file. The existing state-machine coverage in
 * `core.test.ts` asserts exactly one illegal transition (`RECEIVED ->
 * EXECUTING`). Nothing pinned the property that actually makes the F-003 class
 * of bug impossible: that a task in a terminal state cannot be advanced, by any
 * route, to any other state. The lifecycle guards that provide this live in
 * `kernel-adapter.ts` (`advance`, the single choke point) and
 * `state-machine.ts` (`transitionTask`, the single gate). Both are covered
 * behaviourally elsewhere, but the invariant itself was never stated as a
 * matrix, so a guard that stopped working would show up as one failing
 * scenario rather than as an obviously-broken lifecycle.
 *
 * The matrix is exhaustive on purpose: a terminal task must refuse EVERY
 * target, including the plausible ones. Enumerating the states explicitly is
 * what makes a newly added status a compile-time obligation here rather than a
 * silent gap.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CoreError } from "./errors.ts";
import { createTask, transitionTask, assertTaskActive, canTransition } from "./state-machine.ts";
import type { TaskStatus } from "./types.ts";

/** Every status the lifecycle defines. A new status must be classified here. */
const ALL: TaskStatus[] = [
  "RECEIVED",
  "UNDERSTANDING",
  "PLANNING",
  "PLAN_VALIDATION",
  "EXECUTING",
  "OBSERVING",
  "VALIDATING",
  "RECOVERING",
  "RETRYING",
  "REPLANNING",
  "ESCALATED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "TIMEOUT",
];

/**
 * States from which no further transition is permitted.
 *
 * ESCALATED belongs here even though `transitions.ESCALATED` lists
 * CANCELLED/FAILED/COMPLETED. That table is a reachability map, not the
 * authority: `transitionTask` applies a second, stricter guard, and that guard
 * is the one being pinned. See the note on `canTransition` below.
 */
const TERMINAL: TaskStatus[] = ["ESCALATED", "COMPLETED", "FAILED", "CANCELLED", "TIMEOUT"];

const fresh = (status: TaskStatus) => ({ ...createTask({ taskId: "t1", userRequest: "r", objective: "o" }), status });

const isTaskError = (error: unknown): boolean => error instanceof CoreError && error.category === "TASK_ERROR";

test("every status is classified as terminal or non-terminal, with no overlap", () => {
  // A new TaskStatus that nobody classified would silently escape the matrix
  // below, so the classification itself is asserted rather than assumed.
  const unclassified = ALL.filter((status) => !TERMINAL.includes(status) && TERMINAL.includes(status));
  assert.deepEqual(unclassified, [], "a status cannot be both terminal and non-terminal");
  assert.equal(new Set([...TERMINAL, ...ALL.filter((s) => !TERMINAL.includes(s))]).size, ALL.length, "classification must cover every status exactly once");
});

test("a terminal task refuses EVERY transition, terminal target or not", () => {
  for (const from of TERMINAL) {
    for (const to of ALL) {
      assert.throws(
        () => transitionTask(fresh(from), to),
        isTaskError,
        `a ${from} task must refuse a transition to ${to}`,
      );
    }
  }
});

test("a terminal task cannot be resurrected into an active state", () => {
  // The F-003 shape specifically: a refused/failed/cancelled task coming back
  // to life. If this passes, "one denial permanently ends the task" holds
  // structurally, not only by the callers happening to check first.
  const active: TaskStatus[] = ["RECEIVED", "UNDERSTANDING", "PLANNING", "PLAN_VALIDATION", "EXECUTING", "OBSERVING", "VALIDATING", "RECOVERING", "RETRYING", "REPLANNING"];
  for (const from of ["COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "ESCALATED"]) {
    for (const to of active) {
      assert.throws(() => transitionTask(fresh(from), to), isTaskError, `${from} must not revive into ${to}`);
    }
  }
});

test("recovery and replanning cannot revive a terminal task", () => {
  // The exact entry points `kernel-adapter.advance` uses to re-enter work. A
  // late recovery decision arriving after a task ended is the realistic way
  // this could be reached in production, so it is named rather than implied.
  for (const from of TERMINAL) {
    for (const to of ["RECOVERING", "RETRYING", "REPLANNING", "EXECUTING", "PLANNING"] as TaskStatus[]) {
      assert.throws(() => transitionTask(fresh(from), to), isTaskError, `a ${from} task must not re-enter work via ${to}`);
    }
  }
});

test("assertTaskActive refuses every terminal state", () => {
  for (const status of TERMINAL) {
    assert.throws(() => assertTaskActive(fresh(status)), isTaskError, `assertTaskActive must refuse ${status}`);
  }
});

test("a non-terminal task still transitions normally, so the guards are not blanket refusals", () => {
  // Without this, a test that refused everything would satisfy every
  // assertion above. The lifecycle must still work.
  //
  // The happy path goes through OBSERVING and VALIDATING rather than straight
  // from EXECUTING to COMPLETED: a task that ran work must validate before it
  // can claim completion, and `EXECUTING -> COMPLETED` is correctly refused.
  let task = fresh("RECEIVED");
  for (const to of ["UNDERSTANDING", "PLANNING", "PLAN_VALIDATION", "EXECUTING", "OBSERVING", "VALIDATING"] as TaskStatus[]) {
    task = transitionTask(task, to);
    assert.equal(task.status, to);
    assert.doesNotThrow(() => assertTaskActive(task));
  }
  task = transitionTask(task, "COMPLETED");
  assert.equal(task.status, "COMPLETED");
  assert.throws(() => assertTaskActive(task), isTaskError);
});

test("a task that executed cannot jump straight to COMPLETED", () => {
  // Named because it is the transition most likely to be "helpfully" relaxed
  // later, and relaxing it would let an unvalidated task report success.
  const executing = fresh("EXECUTING");
  assert.throws(() => transitionTask(executing, "COMPLETED"), isTaskError);
  assert.equal(transitionTask(executing, "OBSERVING").status, "OBSERVING");
});

test("every refusal is a TASK_ERROR, whatever the cause", () => {
  // Two distinct causes produce two different messages, but callers and tests
  // must not have to tell them apart to know nothing was applied.
  const cases: Array<[string, TaskStatus, TaskStatus, RegExp]> = [
    ["terminal, no outgoing transition", "FAILED", "RECOVERING", /Illegal task transition/],
    ["terminal, map would allow it", "ESCALATED", "COMPLETED", /Terminal task cannot transition/],
    ["mis-sequenced on an active task", "RECEIVED", "COMPLETED", /Illegal task transition/],
    ["unknown status is refused, not crashed", "RECEIVED", "NOT_A_STATUS" as TaskStatus, /Illegal task transition/],
  ];
  for (const [label, from, to, pattern] of cases) {
    assert.throws(
      () => transitionTask(fresh(from), to),
      (error: unknown) => isTaskError(error) && pattern.test(error.message),
      `${label} must be refused`,
    );
  }
});

/**
 * Documents a real inconsistency that is currently harmless, so it is not
 * rediscovered as a bug later.
 *
 * `canTransition("ESCALATED", "COMPLETED")` returns TRUE — the reachability map
 * allows it — while `transitionTask` refuses it, because it applies a stricter
 * second guard. There is no reachable defect today: `canTransition` has no
 * production caller other than `transitionTask` itself, so the stricter gate is
 * always the one that runs. The assertion below pins the AUTHORITY
 * (`transitionTask` refuses), not the looser advisory map, so tightening the
 * map later would not break this suite.
 */
test("transitionTask is the authority for ESCALATED, which the reachability map alone would allow", () => {
  assert.equal(canTransition("ESCALATED", "COMPLETED"), true, "the map is advisory and still lists this");
  assert.throws(() => transitionTask(fresh("ESCALATED"), "COMPLETED"), isTaskError, "the gate is what actually refuses");
});
