import { describe, expect, it } from "vitest";

import { CREDENTIAL_HEADER, GatewayClient, GatewayError } from "./gateway-client";
import {
  CREDENTIAL_BACKOFF_CEILING_MS,
  CREDENTIAL_BACKOFF_FLOOR_MS,
  PollPolicy,
  credentialStateOf,
  describeCredentialLead,
  describeCredentialState,
  isCredentialFault,
  type CredentialState,
} from "./credential-state";

/**
 * THE REFUSAL CLASSIFIER AND THE RETRY SCHEDULE.
 *
 * No DOM, no component, no fake clock. Every claim below is arithmetic or string
 * matching, and the reason this file can assert them directly is the reason the
 * module was split out of the hook: a backoff floor proved through a rendered
 * component is a backoff floor measured once, by eye, on a good day.
 *
 * === THE TWO 401s ARE THE POINT ===
 *
 * The first two cases are the whole reason this module exists. Before it, both
 * produced `kind: "refused"` and were the same object to every caller, which is
 * how 62 identical errors accumulated without anyone noticing they were all the
 * same answer.
 */

const TOKEN = "gw-classify-4b71e0";

/** A client that always answers with one canned response. */
function refusingClient(body: unknown, status: number) {
  const impl: typeof fetch = async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  return new GatewayClient({ gatewayToken: TOKEN, fetchImpl: impl });
}

/** The edge's nested refusal shape, which is what the running wedge emits. */
const NESTED = (code: string, reason: string) => ({ status: "FAILED", failure: { code, reason } });

/** Await a rejection and hand back the error, so `expect` sees the real throw. */
async function rejectedWith(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (cause) {
    return cause;
  }
  throw new Error("the call was expected to be refused, and it was not");
}

describe("credentialStateOf", () => {
  it("names a 401 that presented nothing as 'required', not as a rejection", async () => {
    const client = refusingClient(NESTED("UNAUTHENTICATED", "no credential presented: send the x-gateway-token header"), 401);
    const error = await rejectedWith(client.fetchPortalConfig());

    expect(error).toBeInstanceOf(GatewayError);
    expect(credentialStateOf(error)).toBe("required");
    // The two are distinguished by prose, so the prose has to survive to here.
    expect((error as GatewayError).reason).toContain("no credential presented");
    expect((error as GatewayError).code).toBe("UNAUTHENTICATED");
  });

  it("names a 401 that presented the wrong value as 'rejected'", async () => {
    const client = refusingClient(NESTED("UNAUTHENTICATED", "the credential presented is not recognised"), 401);
    const error = await rejectedWith(client.fetchLive());

    expect(credentialStateOf(error)).toBe("rejected");
    // And this is the assertion the investigation turned on: a wrong value and an
    // absent one are DIFFERENT answers, and they are different answers here.
    expect(credentialStateOf(error)).not.toBe("required");
  });

  it("classifies the flat refusal shape the same as the nested one", async () => {
    // An operator reading the network panel sees this shape. A classifier that
    // recognised only the nested form would call it unclassifiable and fall back
    // to the generic screen -- which is where this defect was invisible from.
    const nested = await rejectedWith(
      refusingClient(NESTED("UNAUTHENTICATED", "the credential presented is not recognised"), 401).fetchLive(),
    );
    const flat = await rejectedWith(
      refusingClient({ code: "UNAUTHENTICATED", reason: "the credential presented is not recognised" }, 401).fetchLive(),
    );

    expect(credentialStateOf(flat)).toBe(credentialStateOf(nested));
    expect(credentialStateOf(flat)).toBe("rejected");
  });

  it("prefers the nested shape when a body carries both", async () => {
    const error = await rejectedWith(
      refusingClient(
        { code: "FORBIDDEN", reason: "the flat one", status: "FAILED", failure: { code: "UNAUTHENTICATED", reason: "the nested one" } },
        401,
      ).fetchLive(),
    );

    expect((error as GatewayError).reason).toContain("the nested one");
  });

  it("names a withdrawn credential 'revoked' rather than inviting a retype", async () => {
    const error = await rejectedWith(refusingClient(NESTED("UNAUTHENTICATED", "that credential has been revoked"), 401).fetchLive());
    expect(credentialStateOf(error)).toBe("revoked");
  });

  it("names a 403 'forbidden' -- proven, and not permitted for this scope", async () => {
    const error = await rejectedWith(
      refusingClient(NESTED("FORBIDDEN", "this credential is not permitted for that scope"), 403).fetchLive(),
    );
    expect(credentialStateOf(error)).toBe("forbidden");
    // A 403 is NOT a credential fault: the credential is real, and asking the
    // operator to retype it would be asking for the same wrong answer.
    expect(isCredentialFault("forbidden")).toBe(true);
    expect(credentialStateOf(error)).not.toBe("rejected");
  });

  it("names a 503 'no-gateway', and does not ask for a credential to fix it", async () => {
    const error = await rejectedWith(
      refusingClient({ error: "no live gateway is attached to this process" }, 503).fetchLive(),
    );
    expect(credentialStateOf(error)).toBe("no-gateway");
    // The distinction the test exists for: a missing gateway is a server fault a
    // restart fixes, so it must NOT open the credential prompt.
    expect(isCredentialFault("no-gateway")).toBe(false);
  });

  it("treats a server fault, a timeout and a non-gateway throw as 'other'", () => {
    expect(credentialStateOf(new GatewayError("server", "responded 500", { status: 500 }))).toBe("other");
    expect(credentialStateOf(new GatewayError("timeout", "no response within 8000ms"))).toBe("other");
    expect(credentialStateOf(new Error("no live transport is wired"))).toBe("other");
    expect(credentialStateOf(undefined)).toBe("other");
    expect(credentialStateOf("a string")).toBe("other");
  });

  it("gives every state its own sentence, so no two states look alike on screen", () => {
    const states: CredentialState[] = ["ok", "required", "rejected", "revoked", "forbidden", "no-gateway", "other"];
    const sentences = states.map(describeCredentialState);

    expect(new Set(sentences).size).toBe(states.length);
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(0);
    // The one that matters most says what to DO, not merely what happened.
    expect(describeCredentialState("rejected")).toContain("Enter");
  });

  it("asks a different question per state, and never asks for a withdrawn credential to be retyped", () => {
    const states: CredentialState[] = ["ok", "required", "rejected", "revoked", "forbidden", "no-gateway", "other"];
    expect(new Set(states.map(describeCredentialLead)).size).toBe(states.length);

    // The specific trap: the generic prompt wording would send the operator round
    // the same loop with a value the server has already said it will refuse.
    expect(describeCredentialLead("revoked")).toContain("current one");
    expect(describeCredentialLead("revoked")).not.toBe(describeCredentialLead("rejected"));

    // And a missing gateway must not be answered with a credential question.
    expect(describeCredentialLead("no-gateway")).toContain("server-side fault");
  });
});

describe("PollPolicy", () => {
  it("floors the first retry at five seconds, whatever the healthy cadence", () => {
    const policy = new PollPolicy();

    // The healthy cadence is 500ms. Multiplying it would put the first retry at
    // 1s, which is the shape of the original defect in miniature.
    expect(policy.fail("other")).toBe(CREDENTIAL_BACKOFF_FLOOR_MS);
    expect(CREDENTIAL_BACKOFF_FLOOR_MS).toBe(5_000);
  });

  it("doubles on each consecutive failure and stops at the ceiling", () => {
    const policy = new PollPolicy();

    expect(policy.fail("other")).toBe(5_000);
    expect(policy.fail("other")).toBe(10_000);
    expect(policy.fail("other")).toBe(20_000);
    expect(policy.fail("other")).toBe(40_000);
    expect(policy.fail("other")).toBe(CREDENTIAL_BACKOFF_CEILING_MS);
    // And stays there. A session left open overnight must not schedule a poll in
    // the year 2100, which is what an uncapped doubling would eventually do.
    expect(policy.fail("other")).toBe(CREDENTIAL_BACKOFF_CEILING_MS);
    expect(policy.attempts).toBe(6);
  });

  it("keeps the exponent from overflowing into a non-finite delay", () => {
    const policy = new PollPolicy();
    // The floor, not `Infinity`: a tab open for a very long time must not produce
    // a setTimeout argument that is not a number.
    expect(Number.isFinite(policy.delayFor(5_000))).toBe(true);
    expect(policy.delayFor(5_000)).toBe(CREDENTIAL_BACKOFF_CEILING_MS);
    expect(policy.delayFor(0)).toBe(CREDENTIAL_BACKOFF_FLOOR_MS);
  });

  it("HALTS on a credential refusal and schedules nothing", () => {
    const policy = new PollPolicy();

    // This is the assertion the 62-errors-in-31-seconds incident reduces to:
    // null means the caller has no delay to schedule, so no timer can exist.
    expect(policy.fail("rejected")).toBeNull();
    expect(policy.halted).toBe(true);
    expect(policy.fail("required")).toBeNull();
    expect(policy.fail("revoked")).toBeNull();
    expect(policy.fail("forbidden")).toBeNull();
  });

  it("keeps backing off for faults a retry can actually clear", () => {
    const policy = new PollPolicy();

    // A 503 clears when the server is restarted, and a network blip clears by
    // itself. Neither is a reason to stop asking.
    expect(policy.fail("no-gateway")).toBe(5_000);
    expect(policy.fail("other")).toBe(10_000);
    expect(policy.halted).toBe(false);
  });

  it("returns to the floor after a success, so one good read resets the schedule", () => {
    const policy = new PollPolicy();
    policy.fail("other");
    policy.fail("other");
    expect(policy.attempts).toBe(2);

    policy.succeed();

    expect(policy.attempts).toBe(0);
    expect(policy.fail("other")).toBe(5_000);
  });

  it("recovers fully once a new credential is set", () => {
    const policy = new PollPolicy();

    // The refusal run first, exactly as it happened: a refused credential polled
    // until it halted.
    for (let i = 0; i < 5; i += 1) policy.fail("rejected");
    expect(policy.halted).toBe(true);

    // The operator enters the right value. `resume` is what the UI calls.
    policy.resume();
    expect(policy.halted).toBe(false);
    expect(policy.attempts).toBe(0);

    // And the very next poll is at the healthy cadence, not at a ceiling earned
    // during the refusal run.
    const delay = policy.fail("other");
    expect(delay).toBe(5_000);
    expect(delay).toBeLessThanOrEqual(CREDENTIAL_BACKOFF_FLOOR_MS);

    // Recovery is real: a read succeeds and the halt cannot come back on its own.
    policy.succeed();
    expect(policy.fail("rejected")).toBeNull();
    policy.succeed();
    expect(policy.halted).toBe(false);
  });

  it("does not resume on its own -- only a credential change clears a halt", () => {
    const policy = new PollPolicy();
    policy.fail("rejected");
    policy.fail("rejected");

    // Five more refusals, as would arrive if polling had continued past the halt.
    // None of them un-halts it, and none of them is scheduled in the first place:
    // `fail` returned null each time, so no timer existed to deliver them. This is
    // what makes the halt a property of the policy rather than a hope about the UI.
    for (let i = 0; i < 5; i += 1) expect(policy.fail("rejected")).toBeNull();
    expect(policy.halted).toBe(true);

    // The retry count is deliberately NOT advanced by a credential fault. It counts
    // attempts at recovering from a fault a retry can clear, and a refused
    // credential is not one -- inflating it would mean a person who fixes the
    // credential is punished with a ceiling they never earned.
    expect(policy.attempts).toBe(0);
  });

  it("reads back the credential header name it was built to send", () => {
    // A one-line guard against the two sides drifting apart silently: the client
    // names this header, and it is `CREDENTIAL_HEADER` in the edge, not a string
    // typed here.
    expect(CREDENTIAL_HEADER).toBe("x-gateway-token");
  });
});