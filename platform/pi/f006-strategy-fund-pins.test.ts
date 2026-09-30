import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LIMITS,
  chooseRecoveryDetailed,
  describeTerminalRecovery,
  type FailureCategory,
  type Idempotency,
  type RecoveryDecision,
  type RecoveryLimits,
} from "../core/index.ts";

/**
 * F006.4c: pins for the strategy fund and the new-approach fork.
 *
 * C1 declared the fork, the `maxStrategyChanges` fund, and the optional
 * defaults that keep it inert. Nothing pinned any of it: the suite was
 * 405/403/0/2 before and after C1, so no existing pin could tell the new
 * branch from the old table. These pins are that missing evidence.
 *
 * Three claims, in order of how much damage getting them wrong would do:
 *   1. the defaults are bit-identical legacy (the sweep — subsumes a2);
 *   2. the fork says what Decision 1 says it says (the table);
 *   3. the certificate names both budgets.
 */

const LIMITS: RecoveryLimits = {
  maxToolRetries: 2,
  maxReplans: 2,
  maxStrategyChanges: 2,
  maxRecoveryDepth: 3,
  maxExecutionTimeMs: 1000,
};

/** Every failure class the contract declares. */
const FAILURES: FailureCategory[] = [
  "TRANSIENT", "PERMISSION", "INVALID_INPUT", "TOOL_FAILURE", "TIMEOUT",
  "RATE_LIMIT", "MODEL_FAILURE", "VALIDATION_FAILURE", "DEPENDENCY_FAILURE", "UNKNOWN",
];
const IDEMPOTENCIES: Idempotency[] = ["IDEMPOTENT", "NON_IDEMPOTENT", "UNKNOWN"];

/**
 * The class in which a retry of the same attempt is still legal.
 *
 * Mirrors the table's own view on purpose rather than importing an internal:
 * the pin states the policy independently, so a change to either side alone
 * shows up as a disagreement instead of being masked by a shared constant.
 */
const RETRY_CLASS_LEGAL: ReadonlySet<FailureCategory> =
  new Set<FailureCategory>(["TRANSIENT", "TIMEOUT", "RATE_LIMIT", "MODEL_FAILURE"]);

/**
 * The failure classes that actually REACH the fork.
 *
 * PERMISSION and INVALID_INPUT do not: both fail closed with ESCALATE in the
 * guards that precede the fork, on either branch, because no strategy can buy
 * permission or fix an invalid input. Pinned separately by C2.2g.
 */
const FORKED: FailureCategory[] = FAILURES.filter(
  (f) => f !== "PERMISSION" && f !== "INVALID_INPUT",
);

/** The legacy table, as it stood before the fund was declared. */
const legacy = (o: {
  failure: FailureCategory; retryCount: number; replanCount: number;
  depth: number; idempotency: Idempotency;
}): RecoveryDecision => chooseRecoveryDetailed({ ...o, limits: LIMITS, attemptMatchesLastFailure: true });

// --- 1. The default contract: the sweep ------------------------------------

test("C2.1 omitting the new args is bit-identical to the explicit legacy call, over the whole input space", () => {
  let combinations = 0;
  for (const failure of FAILURES) {
    for (const idempotency of IDEMPOTENCIES) {
      // retryCount and replanCount run past their limits on purpose: an
      // over-budget counter must still reach the same decision, not wrap.
      for (let retryCount = 0; retryCount <= 4; retryCount++) {
        for (let replanCount = 0; replanCount <= 4; replanCount++) {
          for (let depth = 0; depth <= 5; depth++) {
            const base = { failure, retryCount, replanCount, depth, idempotency };
            const byDefault = chooseRecoveryDetailed({ ...base, limits: LIMITS });
            assert.deepEqual(
              byDefault,
              legacy(base),
              `defaulting diverged from legacy at ${failure}/${idempotency} `
              + `retry=${retryCount} replan=${replanCount} depth=${depth}`,
            );
            combinations += 1;
          }
        }
      }
    }
  }
  // 10 failures x 3 idempotencies x 5 x 5 x 6 depths. Pinned so that narrowing
  // the sweep cannot silently reduce what this pin actually covers.
  assert.equal(combinations, 4500);
});

test("C2.1b the default is a real default, not an accidental one: both args are optional in the type", () => {
  // A required arg would make this file fail to compile rather than fail this
  // assertion. Compiling IS the assertion.
  const decision = chooseRecoveryDetailed({
    failure: "TRANSIENT", limits: LIMITS, retryCount: 0, replanCount: 0, depth: 0, idempotency: "IDEMPOTENT",
  });
  assert.deepEqual(decision, { strategy: "RETRY", reason: "TRANSIENT_RETRY" });
});

test("C2.1c the default can only preserve legacy decisions, never change them", () => {
  // A silent default is dangerous when it silently CHANGES behaviour. This
  // states the direction of the risk: supplying the legacy signal explicitly
  // must give the same answer as supplying nothing, for every failure class.
  for (const failure of FAILURES) {
    for (const idempotency of IDEMPOTENCIES) {
      const base = { failure, retryCount: 2, replanCount: 2, depth: 1, idempotency };
      assert.deepEqual(
        chooseRecoveryDetailed({ ...base, limits: LIMITS }),
        chooseRecoveryDetailed({ ...base, limits: LIMITS, attemptMatchesLastFailure: true }),
        `${failure}/${idempotency}: the default must not diverge from the repeat path`,
      );
    }
  }
});

test("C2.1d an explicitly false signal is the only thing that opens the fork", () => {
  // The default is `!== false`, so `false` must genuinely fork and `true` must
  // not. If the default were ever loosened to `?? true`, this still holds.
  for (const failure of FORKED) {
    for (const idempotency of IDEMPOTENCIES) {
      const base = { failure, retryCount: 1, replanCount: 1, depth: 0, idempotency };
      const forked = chooseRecoveryDetailed({ ...base, limits: LIMITS, attemptMatchesLastFailure: false });
      if (RETRY_CLASS_LEGAL.has(failure) && idempotency === "IDEMPOTENT") continue;
      assert.equal(
        forked.strategy,
        "REPLAN",
        `${failure}/${idempotency}: a fork with a funded strategy must plan, not repeat`,
      );
    }
  }
});

// --- 2. The fork table -----------------------------------------------------

test("C2.2 the true branch is legacy verbatim, whatever the strategy fund holds", () => {
  for (const failure of FAILURES) {
    for (const idempotency of IDEMPOTENCIES) {
      for (const strategyCount of [0, 1, 2, 3]) {
        for (let retryCount = 0; retryCount <= 3; retryCount++) {
          for (let replanCount = 0; replanCount <= 3; replanCount++) {
            assert.deepEqual(
              chooseRecoveryDetailed({
                failure, limits: LIMITS, retryCount, replanCount,
                strategyCount, depth: 0, idempotency, attemptMatchesLastFailure: true,
              }),
              legacy({ failure, retryCount, replanCount, depth: 0, idempotency }),
              `the repeat path must ignore the strategy fund entirely at ${failure}/${idempotency}`,
            );
          }
        }
      }
    }
  }
});

test("C2.2a Decision 1 row 1: a funded strategy takes the strategy path", () => {
  for (const failure of FORKED) {
    for (const idempotency of IDEMPOTENCIES) {
      for (let strategyCount = 0; strategyCount < LIMITS.maxStrategyChanges; strategyCount++) {
        const decision = chooseRecoveryDetailed({
          failure, limits: LIMITS, retryCount: 0, replanCount: LIMITS.maxReplans,
          strategyCount, depth: 0, idempotency, attemptMatchesLastFailure: false,
        });
        assert.deepEqual(
          decision,
          { strategy: "REPLAN", reason: "STRATEGY_CHANGE_REPLAN" },
          `${failure}/${idempotency} with ${strategyCount} funded: a new approach is planned by the strategy fund`,
        );
      }
    }
  }
});

test("C2.2b Decision 1 row 2: an exhausted fund with a retry-legal failure takes the legacy retry path verbatim", () => {
  for (const failure of FAILURES) {
    if (!RETRY_CLASS_LEGAL.has(failure)) continue;
    for (let retryCount = 0; retryCount <= 3; retryCount++) {
      for (let replanCount = 0; replanCount <= 3; replanCount++) {
        for (let strategyCount = LIMITS.maxStrategyChanges; strategyCount <= 3; strategyCount++) {
          const decision = chooseRecoveryDetailed({
            failure, limits: LIMITS, retryCount, replanCount,
            strategyCount, depth: 0, idempotency: "IDEMPOTENT", attemptMatchesLastFailure: false,
          });
          assert.deepEqual(
            decision,
            legacy({ failure, retryCount, replanCount, depth: 0, idempotency: "IDEMPOTENT" }),
            `transient idempotent ${failure} must still get its retry at ${strategyCount}/${LIMITS.maxStrategyChanges} changes`,
          );
        }
      }
    }
  }
});

test("C2.2c Decision 1 row 3: an exhausted fund with no legal retry terminates, naming the strategy fund", () => {
  for (const failure of FORKED) {
    for (const idempotency of IDEMPOTENCIES) {
      if (RETRY_CLASS_LEGAL.has(failure) && idempotency === "IDEMPOTENT") continue;
      for (let strategyCount = LIMITS.maxStrategyChanges; strategyCount <= 3; strategyCount++) {
        const decision = chooseRecoveryDetailed({
          failure, limits: LIMITS, retryCount: 0, replanCount: 0,
          strategyCount, depth: 0, idempotency, attemptMatchesLastFailure: false,
        });
        assert.deepEqual(
          decision,
          { strategy: "TERMINATE", reason: "STRATEGY_BUDGET_EXHAUSTED" },
          `${failure}/${idempotency} is not retry-legal, so the strategy fund is what ran out`,
        );
      }
    }
  }
});

test("C2.2d the fork never reaches RETRY on a deterministic failure (F006.2 still holds)", () => {
  for (const failure of FORKED) {
    for (const idempotency of IDEMPOTENCIES) {
      for (const strategyCount of [0, 1, 2, 3]) {
        for (const retryCount of [0, 1, 2]) {
          const decision = chooseRecoveryDetailed({
            failure, limits: LIMITS, retryCount, replanCount: 0,
            strategyCount, depth: 0, idempotency, attemptMatchesLastFailure: false,
          });
          if (RETRY_CLASS_LEGAL.has(failure) && idempotency === "IDEMPOTENT") continue;
          assert.notEqual(
            decision.strategy, "RETRY",
            `${failure}/${idempotency} must not be blindly retried on the fork either`,
          );
        }
      }
    }
  }
});

test("C2.2e the guards that precede the fork are shared, not forked", () => {
  // Elapsed time and depth are not strategies and buy no more time, so they
  // must terminate identically whether the attempt repeats or forks.
  for (const attemptMatchesLastFailure of [true, false]) {
    assert.deepEqual(
      chooseRecoveryDetailed({
        failure: "TRANSIENT", limits: LIMITS, retryCount: 0, replanCount: 0,
        strategyCount: 0, depth: 0, idempotency: "IDEMPOTENT",
        attemptMatchesLastFailure, elapsedMs: LIMITS.maxExecutionTimeMs + 1,
      }),
      { strategy: "TERMINATE", reason: "EXECUTION_TIME_EXHAUSTED" },
    );
    assert.deepEqual(
      chooseRecoveryDetailed({
        failure: "TRANSIENT", limits: LIMITS, retryCount: 0, replanCount: 0,
        strategyCount: 0, depth: LIMITS.maxRecoveryDepth, idempotency: "IDEMPOTENT",
        attemptMatchesLastFailure,
      }),
      { strategy: "TERMINATE", reason: "RECOVERY_DEPTH_EXHAUSTED" },
    );
  }
});

test("C2.2f the default fund is declared and defaults at parity with maxReplans", () => {
  // Explicit because it RAISES the aggregate ceiling: repeats and strategy
  // changes each get the old full budget rather than sharing one. That is the
  // feature. It is also profile-tunable, and it is inert only because the fork
  // is unreachable until the adapter supplies the signal.
  assert.equal(DEFAULT_LIMITS.maxStrategyChanges, DEFAULT_LIMITS.maxReplans);
});

test("C2.2g the fail-closed classes never reach the fork, funded or not", () => {
  // PERMISSION and INVALID_INPUT are decided in the guards ahead of the fork.
  // A new approach must not become a way to retry a denial: no strategy can
  // buy permission, and an invalid input is the caller's to fix.
  for (const failure of ["PERMISSION", "INVALID_INPUT"] as const) {
    for (const idempotency of IDEMPOTENCIES) {
      for (const strategyCount of [0, 1, 2, 3]) {
        for (const attemptMatchesLastFailure of [true, false]) {
          assert.deepEqual(
            chooseRecoveryDetailed({
              failure, limits: LIMITS, retryCount: 0, replanCount: 0,
              strategyCount, depth: 0, idempotency, attemptMatchesLastFailure,
            }),
            { strategy: "ESCALATE", reason: failure === "PERMISSION" ? "PERMISSION_FAILURE_ESCALATED" : "INVALID_INPUT_ESCALATED" },
            `${failure} must fail closed regardless of the fork or the fund`,
          );
        }
      }
    }
  }
});

// --- 3. The certificate ----------------------------------------------------

test("C2.3 the terminal certificate reports BOTH counters, whichever budget blocked the move", () => {
  const cases = [
    { strategyCount: 1, replanCount: 0 },
    { strategyCount: 0, replanCount: 2 },
    { strategyCount: 2, replanCount: 2 },
    { strategyCount: 0, replanCount: 0 },
  ];
  for (const { strategyCount, replanCount } of cases) {
    const options = {
      failure: "TOOL_FAILURE" as const, limits: LIMITS,
      retryCount: 1, replanCount, strategyCount, depth: 1,
    };
    const decision = chooseRecoveryDetailed({ ...options, idempotency: "IDEMPOTENT" });
    const text = describeTerminalRecovery(decision, options);
    assert.match(
      text, new RegExp(`replanCount=${replanCount}/${LIMITS.maxReplans}`),
      "the replan counter must always be visible",
    );
    assert.match(
      text, new RegExp(`strategyCount=${strategyCount}/${LIMITS.maxStrategyChanges}`),
      "the strategy counter must always be visible",
    );
    assert.match(text, /retryCount=1\/2/);
    assert.match(text, /recoveryDepth=1\/3/);
  }
});

test("C2.3b a STRATEGY_BUDGET_EXHAUSTED certificate names the strategy fund and the counters", () => {
  const options = {
    failure: "TOOL_FAILURE" as const, limits: LIMITS,
    retryCount: 0, replanCount: 0, strategyCount: LIMITS.maxStrategyChanges,
    depth: 0, idempotency: "IDEMPOTENT" as const, attemptMatchesLastFailure: false,
  };
  const decision = chooseRecoveryDetailed(options);
  assert.deepEqual(decision, { strategy: "TERMINATE", reason: "STRATEGY_BUDGET_EXHAUSTED" });
  const text = describeTerminalRecovery(decision, options);
  assert.match(text, /STRATEGY_BUDGET_EXHAUSTED/);
  assert.match(text, new RegExp(`strategyCount=${LIMITS.maxStrategyChanges}/${LIMITS.maxStrategyChanges}`));
  assert.match(text, new RegExp(`replanCount=0/${LIMITS.maxReplans}`),
    "a strategy-funded termination must still show an unspent replan budget");
});

test("C2.3c an absent strategy count reads as zero rather than undefined", () => {
  const decision = chooseRecoveryDetailed({
    failure: "TOOL_FAILURE", limits: LIMITS, retryCount: 0, replanCount: 2, depth: 3, idempotency: "IDEMPOTENT",
  });
  const text = describeTerminalRecovery(decision, {
    failure: "TOOL_FAILURE", limits: LIMITS, retryCount: 0, replanCount: 2, depth: 3,
  });
  assert.match(text, /strategyCount=0\//, "a certificate must never print `undefined`");
  assert.doesNotMatch(text, /undefined/);
});
