import { describe, expect, it } from "vitest";

import { GatewayClient } from "./gateway-client";
import { PollPolicy, CREDENTIAL_BACKOFF_FLOOR_MS } from "./credential-state";
import { TelemetryPoller } from "./telemetry-poller";
import { describeCredentialState } from "./credential-state";
import type { LiveSnapshot } from "./live-contracts";

/**
 * THE LIVE PATH, AGAINST A RUNNING WEDGE.
 *
 * === WHY THIS FILE IS OPT-IN AND NOT PART OF THE GATE ===
 *
 * Everything else in this suite runs against an injected transport, which is
 * right for unit tests and wrong for the one question a unit test cannot answer:
 * does the real client, carrying the real header name, actually authenticate
 * against the real process on the real port?
 *
 * So this asks it directly, and SKIPS unless a wedge is running and a credential
 * is supplied. A test that needs a server and cannot skip is a test that breaks
 * the suite the first time someone runs it alone -- and this suite runs in CI
 * where no wedge exists.
 *
 * === HOW TO RUN IT ===
 *
 *   cd frontend
 *   # terminal 1, from the repository root
 *   npm run dev
 *   # terminal 2
 *   node --experimental-strip-types start-ui.mjs --port 8080
 *   # terminal 3
 *   $env:COMMAND_CENTER_LIVE="1"; $env:COMMAND_CENTER_TOKEN="<the dev token>"
 *   npx vitest run src/api/live-path.live.test.ts
 *
 * The token is read from the environment and never printed, logged, or asserted
 * on. A credential that reaches a test file is a credential that reaches CI logs.
 *
 * === WHAT IT STILL DOES NOT COVER ===
 *
 * Nothing visual. No browser renders here, so "the page looks right" is covered
 * by the refusal-screen markup tests and by a person, not by this file. Stating
 * that is cheaper than letting a green run imply more than it proved.
 */

const LIVE = process.env.COMMAND_CENTER_LIVE === "1";
const TOKEN = process.env.COMMAND_CENTER_TOKEN ?? "";
/** The dev proxy, which is the base URL the browser itself uses. */
const BASE = process.env.COMMAND_CENTER_BASE ?? "http://127.0.0.1:5173";

/** A deliberately wrong value: the real one plus a suffix the server cannot know. */
const WRONG = `${TOKEN}-deliberately-wrong`;

/**
 * Wait for a condition, up to a deadline.
 *
 * Needed because a real request takes milliseconds and a fake one takes none. The
 * unit tests settle within a single microtask because their transport resolves
 * immediately; against a real socket the poll may not have been answered when an
 * immediate assertion runs, and the test would then assert about a request that
 * had not happened yet and report it as a product bug.
 *
 * Bounded on purpose: an unbounded wait is a test that hangs instead of failing.
 */
async function until(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Counted against the backoff floor, with slack for a slow machine. */
const FLOOR_WINDOW_MS = CREDENTIAL_BACKOFF_FLOOR_MS + 1_500;

/**
 * A pollable that COUNTS its requests and RECORDS the delays it asked for.
 *
 * Both halves are needed and they are not the same thing. The delay list is what
 * proves the loop stopped SCHEDULING. The counter is what proves it stopped
 * ASKING -- and only the counter can be true at t=0 and false later, which is
 * exactly what a flood looks like. Asserting on the delay list alone would pass on
 * a loop that was about to fire.
 */
function countingPoller(source: () => Promise<LiveSnapshot>) {
  const requested: number[] = [];
  const calls = { n: 0 };
  /**
   * Wraps a source so ITS requests are counted.
   *
   * Exposed rather than applied once inside the factory for a reason this file
   * paid for: `configure` REPLACES the source with whatever the caller passes, so
   * a replacement that is not wrapped stops being counted and the counter appears
   * to freeze. The first version of this test waited for a second request that
   * could never be recorded, and read the timeout as a product fault.
   */
  const counted = (next: () => Promise<LiveSnapshot>) => ({
    fetchLive: () => {
      calls.n += 1;
      return next();
    },
  });
  const poller = new TelemetryPoller({
    source: counted(source),
    intervalMs: 500,
    setTimer: (_fn, ms) => {
      requested.push(ms);
      return ms;
    },
    clearTimer: () => {},
  });
  return { poller, requested, calls, counted };
}

const suite = LIVE && TOKEN !== "" ? describe : describe.skip;

suite("the command center, against a running wedge", () => {
  /**
   * Built lazily, inside each test.
   *
   * A `describe` body runs even when the suite is skipped, so constructing these
   * at describe scope threw "a gateway credential is required" on every machine
   * where the token is absent -- which is every machine, including this one.
   */
  const good = () => new GatewayClient({ gatewayToken: TOKEN, baseUrl: BASE });
  const bad = () => new GatewayClient({ gatewayToken: WRONG, baseUrl: BASE });

  it("reads the portal config", async () => {
    const { derived, config } = await good().fetchPortalConfig();
    expect(typeof config.tenant).toBe("string");
    expect(Array.isArray(config.widgets)).toBe(true);
    // `derived` is asserted as a boolean rather than as `true`: a tenant that has
    // stored its own portal is not a failure, and this test must not punish one.
    expect(typeof derived).toBe("boolean");
  });

  it("reads the agent roster", async () => {
    const roster = await good().fetchActiveSchemas();
    expect(roster.total).toBe(roster.agents.length);
  });

  it("reads a live snapshot whose verdict is renderable", async () => {
    const snapshot = await good().fetchLive();

    expect(snapshot.provider).not.toBe("");
    expect(snapshot.enabled).toBe(true);
    // A verdict arriving from the wire is real, and `synthetic` must say so
    // explicitly rather than being absent and read as false.
    expect(snapshot.verdict?.synthetic).toBe(false);
    // Throughput is null until two observations exist, which is by design and not
    // an error -- so it is asserted to be well-formed when present, not present.
    if (snapshot.throughput !== null) expect(snapshot.throughput.windowMs).toBeGreaterThan(0);
  });

  it(
    "halts after ONE refusal and stays silent for a whole backoff window",
    async () => {
    const { poller, requested, calls } = countingPoller(() => bad().fetchLive());

    let sample = poller.sample;
    poller.subscribe((next) => {
      sample = next;
    });
    poller.start();
    await until(() => poller.halted, "the first refusal to halt the poller");

    // Exactly one request, answered, and nothing scheduled.
    expect(calls.n).toBe(1);
    expect(requested).toEqual([]);
    expect(poller.halted).toBe(true);

    // AND THE PART THAT WAS MISSING. `requested` being empty is true the instant
    // the refusal lands, so on its own it proves nothing about what happens next --
    // a loop that fired one more request a second later would still pass. So the
    // count is watched across a window longer than the backoff floor. This is the
    // 62-errors-in-31-seconds claim, bounded.
    const atHalt = calls.n;
    await new Promise((resolve) => setTimeout(resolve, FLOOR_WINDOW_MS));
    expect(calls.n).toBe(atHalt);
    expect(requested).toEqual([]);
    expect(poller.halted).toBe(true);

    // And the screen names the RIGHT fault: something was presented and refused.
    expect(sample.state).toBe("rejected");
    expect(sample.credentialRequired).toBe(true);
    expect(describeCredentialState(sample.state)).toContain("does not recognise");
    // The reason survives to the UI, which is the whole point of carrying it.
    expect(sample.error).toContain("responded 401");
    },
    // Raised for THIS test only: the window is longer than the default timeout, and
    // a generous global timeout would hide the next test that hangs.
    20_000,
  );

  it("recovers when a valid credential is configured", async () => {
    const requested: number[] = [];
    const poller = new TelemetryPoller({
      source: { fetchLive: () => bad().fetchLive() },
      setTimer: (_fn, ms) => {
        requested.push(ms);
        return ms;
      },
      clearTimer: () => {},
    });
    poller.start();
    await until(() => poller.halted, "the first refusal to halt the poller");
    expect(poller.halted).toBe(true);

    // What `Root` does when the operator submits a credential.
    poller.configure({ source: { fetchLive: () => good().fetchLive() } });
    await until(() => requested.length > 0 && requested[requested.length - 1] === 500, "the healthy cadence to be scheduled again");

    expect(poller.halted).toBe(false);
    expect(requested[requested.length - 1]).toBe(500);
  });

  it(
    "RE-HALTS if the replacement credential is refused too",
    async () => {
      // Recovery is not a one-way latch. A person who types a second wrong value
      // must get the same single request and the same silence -- otherwise the
      // recovery path becomes a new place a flood can start.
      const { poller, requested, calls, counted } = countingPoller(() => bad().fetchLive());
      poller.start();
      await until(() => calls.n >= 1, "the first refusal");
      await until(() => poller.halted, "the first refusal to halt the poller");

      // `configure` clears the halt, so waiting for `halted` alone would pass on
      // the state it already had. The observable fact is a request being MADE --
      // and the replacement source is wrapped so it is counted too.
      poller.configure({ source: counted(() => bad().fetchLive()) });
      await until(() => calls.n >= 2, "a request to follow the reconfigured credential");

      // Now the assertion that could not pass by accident: the count is frozen and
      // watched across a window longer than the backoff floor. If the second halt
      // were not earned, the 500ms cadence would put dozens of requests in here.
      const afterProbe = calls.n;
      await new Promise((resolve) => setTimeout(resolve, FLOOR_WINDOW_MS));

      expect(calls.n).toBe(afterProbe);
      expect(requested).toEqual([]);
      expect(poller.halted).toBe(true);
    },
    // The window is longer than the default per-test timeout, so the budget is
    // raised here rather than globally -- a generous timeout on every test in the
    // suite would hide the next test that hangs.
    20_000,
  );
});

describe("the backoff policy, as shipped", () => {
  it("floors at five seconds and doubles to a ceiling", () => {
    // Asserted outside the opt-in suite deliberately: this is the shipped default,
    // not a property of any particular server, and it must hold on a machine where
    // no wedge is running. This is the "the floor is 5s" claim made testable
    // without a network.
    const policy = new PollPolicy();
    expect(policy.fail("other")).toBe(5_000);
    expect(policy.fail("other")).toBe(10_000);
    expect(policy.fail("other")).toBe(20_000);
    expect(policy.fail("rejected")).toBeNull();
    expect(policy.halted).toBe(true);
  });
});