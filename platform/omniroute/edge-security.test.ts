import test from "node:test";
import assert from "node:assert/strict";

import { createGateway } from "./omniroute-gateway.ts";
import {
  authenticate,
  guard,
  httpResponse,
  issueToken,
  readCredential,
  CREDENTIAL_HEADER,
  type EdgeRequest,
  type GatewayToken,
} from "./edge-security.ts";

/**
 * THE EDGE. What a stranger is allowed to do.
 *
 * === THE FOUR FAILURES THESE PIN DOWN ===
 *
 * 1. A KEY THAT IS PRESENT BUT WRONG IS NOT A KEY. The naive version compares
 *    strings, which leaks the value's length and prefix through timing and throws
 *    on a mismatch of different lengths -- so the comparison itself becomes an
 *    oracle. Comparison is over SHA-256 digests, which are equal length always.
 * 2. SCOPE IS A SEPARATE QUESTION FROM IDENTITY. Proving who you are is the first
 *    question, not the only one. A valid token for `payments` that can also write
 *    to `telemetry` is not scoped, and one shared token across every partner
 *    means one compromised partner owns the estate.
 * 3. THE REASON MUST NEVER CARRY THE VALUE. An error message is the most
 *    widely-read log entry a service has, and a reason that echoes the presented
 *    credential writes it to every log aggregator on the way past.
 * 4. A CLOSED GATEWAY IS THE SAFE DEFAULT. A gateway provisioned with no tokens
 *    refuses everything. The alternative -- admit until someone notices -- is the
 *    failure nobody finds.
 */

const key = (id: string, providers: string[], scope?: string, revoked?: boolean): GatewayToken => ({
  id,
  credential: `value-for-${id}`,
  providers,
  ...(scope === undefined ? {} : { scope }),
  ...(revoked === true ? { revoked } : {}),
});

const KEY: GatewayToken = key("payments-token", ["payments"]);

const request = (headers: Record<string, string | undefined>, over: Partial<EdgeRequest> = {}): EdgeRequest => ({
  headers,
  provider: "payments",
  ...over,
});

const presented = (value: string): Record<string, string> => ({ [CREDENTIAL_HEADER]: value });

test("NO CREDENTIAL IS A 401, and it says how to present one", () => {
  const decision = authenticate(request({}), [KEY]);
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 401, "absence is 401, not 400 -- the client did nothing wrong");
  assert.match(decision.reason ?? "", new RegExp(CREDENTIAL_HEADER), "the reason names the header to send");
});

test("A WRONG CREDENTIAL IS ALSO A 401", () => {
  const decision = authenticate(request(presented("not-the-value")), [KEY]);
  assert.equal(decision.status, 401);
  assert.equal(decision.tokenId, undefined, "and no hint about which token was close");
});

test("THE RIGHT CREDENTIAL IS PROVEN, and reports WHO it was", () => {
  const decision = guard(request(presented(KEY.credential)), [KEY]);
  assert.equal(decision.ok, true);
  assert.equal(decision.tokenId, "payments-token");
});

test("HEADER MATCHING IS CASE-INSENSITIVE, because HTTP headers are", () => {
  const decision = authenticate(
    request({ "X-Gateway-Token": KEY.credential }),
    [KEY],
  );
  assert.equal(decision.ok, true);
});

test("A REVOKED CREDENTIAL IS REFUSED EVEN THOUGH IT MATCHES", () => {
  const revoked = key("old", ["payments"], undefined, true);
  const decision = authenticate(request(presented(revoked.credential)), [revoked]);
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 401, "rotation has to actually take effect");
});

test("A CREDENTIAL IS SCOPED TO ITS PROVIDERS, not merely valid", () => {
  const decision = authenticate(
    request(presented(KEY.credential), { provider: "telemetry" }),
    [KEY],
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 403,
    "a PROVEN identity that is out of scope is 403 -- the caller proved who they are, and was still refused");
  assert.match(decision.reason ?? "", /not permitted/);
});

test("A SCOPED CREDENTIAL IS REFUSED OUTSIDE ITS SCOPE", () => {
  const scoped = key("topic-scoped", ["payments"], "payments-eu");
  const wrongScope = authenticate(
    request(presented(scoped.credential), { scope: "payments-us" }),
    [scoped],
  );
  assert.equal(wrongScope.status, 403);
  const rightScope = authenticate(
    request(presented(scoped.credential), { scope: "payments-eu" }),
    [scoped],
  );
  assert.equal(rightScope.ok, true);
});

test("NO REASON, LOG LINE OR RESULT EVER CONTAINS THE VALUE", () => {
  // An error message is the most widely-read log entry a service has. A reason
  // that echoes the credential writes it to every aggregator on the way past.
  const value = "super-sensitive-value-1234";
  const secretValue = key("probe", ["payments"], undefined, false);
  const token: GatewayToken = { ...secretValue, credential: value };
  for (const decision of [
    authenticate(request({}), [token]),
    authenticate(request(presented("wrong-value")), [token]),
    authenticate(request(presented(value), { provider: "telemetry" }), [token]),
    authenticate(request(presented(value)), [key("other", ["payments"])]),
  ]) {
    assert.ok(!JSON.stringify(decision).includes(value),
      `a decision leaked the value: ${JSON.stringify(decision)}`);
    assert.equal(decision.keyId, undefined, "and a refused decision names no token");
  }
});

test("COMPARISON DOES NOT SHORT-CIRCUIT ON THE FIRST KEY THAT MATCHES", () => {
  // A Map lookup returns early on a hit and runs to the end on a miss, which is a
  // timing oracle over WHICH key was guessed. The list is walked in full, so the
  // time to answer does not depend on the answer.
  const keys = [key("a", ["payments"]), key("b", ["payments"]), KEY, key("c", ["payments"])];
  const first = guard(request(presented(KEY.credential)), keys);
  const last = guard(request(presented(key("c", ["payments"]).credential)), keys);
  assert.equal(first.ok, true);
  assert.equal(last.ok, true);
  assert.equal(first.tokenId, "payments-token");
  assert.equal(last.tokenId, "c");
});

test("A GATEWAY WITH NO CREDENTIALS REFUSES EVERYTHING", () => {
  // Fail closed. A gateway that admits until someone notices is the failure
  // nobody finds; a closed one fails loudly and immediately.
  const gateway = createGateway();
  const decision = gateway.pushAdmitted(
    request(presented("anything"), { provider: "payments" }),
    { fields: { service: "checkout", latency_ms: "10" } },
  );
  assert.equal(decision.ok, false);
  assert.equal(decision.status, 401);
  assert.equal(gateway.snapshot("payments").length, 0, "and nothing reached a broker");
});

test("AN ADMITTED EVENT REACHES THE BROKER; A REFUSED ONE NEVER DOES", async () => {
  const gateway = createGateway({ tokens: [KEY] });
  gateway.connect({ name: "payments", keyColumn: "service" });
  const broker = gateway.brokerFor("payments")!;
  broker.start();

  const refused = gateway.pushAdmitted(
    request(presented(KEY.credential), { provider: "telemetry" }),
    { fields: { service: "other", latency_ms: "10" } },
  );
  assert.equal(refused.status, 403);

  const admitted = gateway.pushAdmitted(
    request(presented(KEY.credential)),
    { fields: { service: "checkout", latency_ms: "10" } },
  );
  assert.equal(admitted.ok, true);

  const deadline = Date.now() + 2_000;
  while (gateway.snapshot("payments")[0]?.records !== 1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(gateway.snapshot("payments")[0]!.records, 1,
    "exactly one event arrived: the refused push never touched the broker");
});

test("THE HTTP ADAPTER MAPS THE DECISION, and never invents one", () => {
  assert.equal(httpResponse(guard(request(presented(KEY.credential)), [KEY])).status, 200);
  const absent = httpResponse(authenticate(request({}), [KEY]));
  assert.equal(absent.status, 401);
  assert.equal(absent.body.failure?.code, "UNAUTHENTICATED");
  const wrongScope = httpResponse(authenticate(request(presented(KEY.credential), { provider: "telemetry" }), [KEY]));
  assert.equal(wrongScope.status, 403);
  assert.equal(wrongScope.body.failure?.code, "FORBIDDEN");
});

test("AN ISSUED CREDENTIAL IS DISTINCT AND IMMEDIATELY USABLE", () => {
  const issued = issueToken("fresh", ["payments"]);
  assert.notEqual(issued.credential, key("fresh", ["payments"]).credential, "and not derived from the id");
  assert.equal(guard(request(presented(issued.credential)), [issued]).ok, true);
});

test("readCredential IGNORES AN EMPTY OR WHITESPACE HEADER", () => {
  // An empty header is the most common integration mistake, and treating it as a
  // PRESENT credential turns a configuration bug into an authentication failure
  // nobody can explain.
  assert.equal(readCredential(request({ [CREDENTIAL_HEADER]: "" })), undefined);
  assert.equal(readCredential(request({ [CREDENTIAL_HEADER]: "   " })), undefined);
  assert.equal(readCredential(request({})), undefined);
});