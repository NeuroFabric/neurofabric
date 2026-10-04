import test from "node:test";
import assert from "node:assert/strict";

import { createEvaluationScheduler } from "../omniroute/evaluation-scheduler.ts";

/**
 * THE EVALUATION LOOP, AND THE OWNER IT WAS PROMISED.
 *
 * === WHY THIS FILE EXISTS ===
 *
 * `GET /api/portal/live` used to run the alert policy in the request handler, so
 * an alert was raised when something asked how the stream was doing. The code
 * said so at the call site and named the fix -- "a scheduler this platform does
 * not have" -- and this is that scheduler. The property under test is not "it
 * evaluates"; it is that **the deployment decides when evaluation happens, and a
 * failure never becomes the reason evaluation stops.**
 *
 * === WHY EVERY TEST HERE DRIVES THE CLOCK BY HAND ===
 *
 * A timer in a test file is a handle that outlives the object that owns it, and
 * this repository has been hung by exactly that shape once already. So the
 * scheduler takes its interval function as a parameter and no test waits on real
 * time. A real timer only exists inside `start()`.
 */

interface FakeHandle {
  unref(): void;
  ref(): void;
}

/** A clock the test drives by hand, so nothing here waits on wall time. */
function fakeClock() {
  const state = { ticks: [] as (() => void)[], unrefCalls: 0, cleared: 0 };

  const api = {
    setIntervalFn: (fn: () => void): FakeHandle => {
      state.ticks.push(fn);
      return {
        unref: () => {
          state.unrefCalls += 1;
        },
        ref: () => {},
      };
    },
    clearIntervalFn: (): void => {
      state.cleared += 1;
      state.ticks.length = 0;
    },
  };

  return {
    state,
    api,
    fire() {
      for (const tick of [...state.ticks]) tick();
    },
  };
}

test("EVALUATION RUNS ON THE CLOCK, not on somebody reading a dashboard", () => {
  const evaluated: string[] = [];
  const clock = fakeClock();
  const scheduler = createEvaluationScheduler({
    gateway: {
      evaluate: (provider?: string) => {
        evaluated.push(provider ?? "");
        return [];
      },
    },
    providers: () => ["pega", "logs"],
    intervalMs: 1_000,
    ...clock.api,
  });

  scheduler.start();
  clock.fire();
  clock.fire();

  assert.deepEqual(evaluated, ["pega", "logs", "pega", "logs"], "each tick evaluates every provider");
  scheduler.stop();
});

test("A FAILING PROVIDER IS CAUGHT AND THE NEXT ONE STILL RUNS", () => {
  const evaluated: string[] = [];
  const seen: string[] = [];
  const clock = fakeClock();
  const scheduler = createEvaluationScheduler({
    gateway: {
      evaluate: (provider?: string) => {
        const name = provider ?? "";
        evaluated.push(name);
        if (name === "broken") throw new Error("database is locked");
        return [];
      },
    },
    providers: () => ["pega", "broken", "logs"],
    intervalMs: 1_000,
    onError: (error, context) => seen.push(`${context.provider}:${(error as Error).message}`),
    ...clock.api,
  });

  scheduler.start();
  clock.fire();

  assert.deepEqual(
    evaluated,
    ["pega", "broken", "logs"],
    "one provider throwing must not cost the providers after it their turn",
  );
  assert.deepEqual(seen, ["broken:database is locked"], "the failure is reported, once, by provider");
  scheduler.stop();
});

test("A FAILURE DOES NOT BECOME THE REASON EVALUATION STOPS", () => {
  // This is the whole reason the module exists. A loop that throws once and
  // never runs again is a monitor that is silently dead, which is worse than one
  // that never started: it looks healthy while it misses every breach.
  const clock = fakeClock();
  let shouldThrow = true;
  let evaluations = 0;
  const scheduler = createEvaluationScheduler({
    gateway: {
      evaluate: () => {
        evaluations += 1;
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error("SQLITE_BUSY: database is locked");
        }
        return [];
      },
    },
    providers: () => ["pega"],
    intervalMs: 1_000,
    onError: () => {},
    ...clock.api,
  });

  scheduler.start();
  clock.fire();
  assert.equal(evaluations, 1);

  clock.fire();
  clock.fire();

  assert.equal(evaluations, 3, "the loop keeps running after a throw");
  assert.equal(scheduler.stats().failures, 1, "and the failure is still counted afterwards");
  scheduler.stop();
});

test("PROVIDERS ARE RESOLVED PER TICK, so a provider attached later is evaluated", () => {
  // Resolving the list once at construction is the mistake that makes a
  // scheduler quietly evaluate nothing: a gateway is often wired after the
  // scheduler exists, and a scheduler holding an empty list captured at the
  // wrong moment is a monitor with no subject.
  const clock = fakeClock();
  const attached: string[] = [];
  let providerIsAttached = false;
  const scheduler = createEvaluationScheduler({
    gateway: {
      evaluate: (provider?: string) => {
        attached.push(provider ?? "");
        return [];
      },
    },
    providers: () => (providerIsAttached ? ["pega"] : []),
    intervalMs: 1_000,
    ...clock.api,
  });

  scheduler.start();
  clock.fire();
  assert.deepEqual(attached, [], "nothing to evaluate yet is not a failure");

  providerIsAttached = true;
  clock.fire();
  assert.deepEqual(attached, ["pega"], "a provider attached after start is picked up");
  scheduler.stop();
});

test("A PROVIDER LIST THAT ITSELF THROWS IS A FAILED TICK, NOT A DEAD LOOP", () => {
  const clock = fakeClock();
  let ticks = 0;
  const reported: string[] = [];
  const scheduler = createEvaluationScheduler({
    gateway: { evaluate: () => [] },
    providers: () => {
      ticks += 1;
      throw new Error("registry not ready");
    },
    intervalMs: 1_000,
    onError: (error) => reported.push((error as Error).message),
    ...clock.api,
  });

  scheduler.start();
  clock.fire();
  clock.fire();

  assert.equal(ticks, 2, "the loop keeps asking after the list resolver throws");
  assert.deepEqual(reported, ["registry not ready", "registry not ready"]);
  assert.equal(scheduler.stats().failures, 2);
  scheduler.stop();
});

// THE LIFECYCLE, WHICH IS THE PART THAT HUNG THIS REPOSITORY BEFORE.

test("THE INTERVAL IS UNREF'D, so it can never be why a process stays up", () => {
  const clock = fakeClock();
  const scheduler = createEvaluationScheduler({
    gateway: { evaluate: () => [] },
    providers: () => ["pega"],
    intervalMs: 1_000,
    ...clock.api,
  });

  scheduler.start();

  assert.equal(clock.state.unrefCalls, 1, "an armed loop must not hold the process open");
  scheduler.stop();
});

test("STARTING TWICE DOES NOT ARM A SECOND LOOP", () => {
  const clock = fakeClock();
  let evaluations = 0;
  const scheduler = createEvaluationScheduler({
    gateway: {
      evaluate: () => {
        evaluations += 1;
        return [];
      },
    },
    providers: () => ["pega"],
    intervalMs: 1_000,
    ...clock.api,
  });

  scheduler.start();
  scheduler.start();
  clock.fire();

  assert.equal(evaluations, 1, "one tick means one evaluation, however often start was called");
  assert.equal(clock.state.unrefCalls, 1);
  scheduler.stop();
});

test("STOP RELEASES THE HANDLE, AND STOP ON AN UNSTARTED LOOP IS NOT AN ERROR", () => {
  const clock = fakeClock();
  let evaluations = 0;
  const scheduler = createEvaluationScheduler({
    gateway: {
      evaluate: () => {
        evaluations += 1;
        return [];
      },
    },
    providers: () => ["pega"],
    intervalMs: 1_000,
    ...clock.api,
  });

  scheduler.stop();

  assert.equal(clock.state.cleared, 0, "stopping something that never ran touches nothing");

  scheduler.start();
  assert.equal(scheduler.stats().running, true);

  scheduler.stop();
  assert.equal(scheduler.stats().running, false);
  assert.equal(clock.state.cleared, 1, "the handle is released, so a finished test can exit");

  clock.fire();
  assert.equal(evaluations, 0, "a stopped loop evaluates nothing");
});

test("A TICK ALREADY RUNNING IS SKIPPED, NOT QUEUED", () => {
  // evaluate persists synchronously on a first observation, so a tick can
  // outrun the interval. Re-entering would amplify the load that made it slow.
  const clock = fakeClock();
  let evaluations = 0;
  let scheduler: ReturnType<typeof createEvaluationScheduler>;
  scheduler = createEvaluationScheduler({
    gateway: {
      evaluate: () => {
        evaluations += 1;
        // Re-entering from inside the tick is the shape this guard exists for.
        scheduler.tick();
        return [];
      },
    },
    providers: () => ["pega"],
    intervalMs: 1_000,
    ...clock.api,
  });

  scheduler.start();
  clock.fire();

  assert.equal(evaluations, 1, "a tick must not recurse into itself");
  scheduler.stop();
});

test("A REPORTER THAT THROWS DOES NOT BECOME A DEAD LOOP", () => {
  const clock = fakeClock();
  let evaluations = 0;
  const scheduler = createEvaluationScheduler({
    gateway: {
      evaluate: () => {
        evaluations += 1;
        throw new Error("database is locked");
      },
    },
    providers: () => ["pega"],
    intervalMs: 1_000,
    onError: () => {
      throw new Error("the log sink is down too");
    },
    ...clock.api,
  });

  scheduler.start();
  clock.fire();
  clock.fire();

  assert.equal(evaluations, 2, "the loop survived both the failure and the failed report of it");
  assert.equal(scheduler.stats().failures, 2, "and both failures are still counted");
  scheduler.stop();
});

test("THE FAILURES ARE READABLE AFTERWARDS, so a degraded loop can be diagnosed", () => {
  const clock = fakeClock();
  const scheduler = createEvaluationScheduler({
    gateway: {
      evaluate: (provider?: string) => {
        if (provider === "broken") throw new Error("database is locked");
        return [];
      },
    },
    providers: () => ["broken"],
    intervalMs: 1_000,
    ...clock.api,
  });

  scheduler.start();
  clock.fire();

  const [failure] = scheduler.failures();
  assert.ok(failure !== undefined, "a failure the operator cannot read is a failure they cannot fix");
  assert.equal(failure.provider, "broken");
  assert.equal(failure.reason, "database is locked");
  assert.equal(typeof failure.at, "number");
  scheduler.stop();
});