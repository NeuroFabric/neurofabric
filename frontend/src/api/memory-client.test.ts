import { describe, expect, it } from "vitest";

import { CREDENTIAL_HEADER, GatewayClient, GatewayError, MEMORY_PATHS } from "./gateway-client";

/**
 * THE CLIENT'S DIFF HALF.
 *
 * === WHY THIS FILE IS NOT A SUBSET OF `gateway-client.test.ts` ===
 *
 * Because the diff is the one route whose SILENT failure is catastrophic
 * everywhere else it would be cosmetic. Every other read here losing its shape
 * loses a panel; this one losing its shape would render an EMPTY DIFF, which
 * reads as "the record agrees with everything" on the single screen whose entire
 * job is to say when it does not.
 *
 * So the assertions here are about refusal, not convenience:
 *
 *  - a malformed envelope THROWS rather than returning something drawable,
 *  - an unknown difference kind is REFUSED rather than dropped,
 *  - the credential travels in the header and never in the path,
 *  - there is no verb on the client that resolves anything.
 */

const GATEWAY_TOKEN = "gw-live-9f3a2c8e";

function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

const clientWith = (impl: typeof fetch): GatewayClient =>
  new GatewayClient({ gatewayToken: GATEWAY_TOKEN, fetchImpl: impl });

const DIFF = {
  at: "2023-11-14T22:13:20.000Z",
  source: "the record",
  tenant: "acme",
  recordVersion: 2,
  expectedVersion: 2,
  summary: "1 difference(s) to look at. Nothing has been changed for you.",
  differences: [
    {
      key: "no-live-window-yet|agent log-anomaly",
      kind: "no-live-window-yet",
      tenant: "acme",
      subject: "agent log-anomaly",
      recorded: "registered",
      live: "nothing observed yet",
      whatToDo: "Nothing to do unless it stays this way.",
      acknowledged: false,
      acknowledgedAt: null,
      seenCount: 0,
    },
  ],
  corruptions: [],
  recorded: { verdicts: [], alerts: [] },
};

describe("fetchReconciliation", () => {
  it("asks the diff route and travels no tenant in the path", async () => {
    const { impl, calls } = stubFetch(DIFF);
    await clientWith(impl).fetchReconciliation();
    expect(calls[0]?.url).toBe(MEMORY_PATHS.diff);
    // A tenant in a path is a tenant a caller can choose. The tenant comes from
    // the proven credential, so there is nowhere on this call to put one.
    expect(calls[0]?.url).not.toContain("acme");
    expect((calls[0]?.init.headers as Record<string, string>)[CREDENTIAL_HEADER]).toBe(GATEWAY_TOKEN);
  });

  it("returns the diff when the envelope is whole", async () => {
    const { impl } = stubFetch(DIFF);
    const diff = await clientWith(impl).fetchReconciliation();
    expect(diff.source).toBe("the record");
    expect(diff.differences).toHaveLength(1);
    expect(diff.differences[0]?.whatToDo).toContain("Nothing to do");
  });

  it("REFUSES an unknown kind rather than dropping the row", async () => {
    const { impl } = stubFetch({
      ...DIFF,
      differences: [{ ...DIFF.differences[0], kind: "a-kind-nobody-has-heard-of" }],
    });
    // THE ASSERTION THAT MATTERS. A dropped row is a disagreement the operator
    // never sees, and it is invisible precisely because the rest renders fine.
    await expect(clientWith(impl).fetchReconciliation()).rejects.toThrow(GatewayError);
  });

  it("REFUSES a response with no timestamp, rather than rendering an empty age", async () => {
    const { at: _dropped, ...withoutAt } = DIFF;
    const { impl } = stubFetch(withoutAt);
    await expect(clientWith(impl).fetchReconciliation()).rejects.toThrow(/reconciliation diff/);
  });

  it("REFUSES a refusal body -- 404 -- rather than treating it as an empty diff", async () => {
    // THE MOST IMPORTANT CASE. The diff route is not mounted when no record is
    // open, so a 404 is the ordinary answer on a fresh deployment. Reading it as
    // "no differences" would have every such deployment reporting perfect
    // agreement, forever.
    const { impl } = stubFetch({ error: "no such resource" }, 404);
    await expect(clientWith(impl).fetchReconciliation()).rejects.toThrow(GatewayError);
  });
});

describe("acknowledgeDifference", () => {
  it("posts the key the diff handed out, and nowhere else", async () => {
    const { impl, calls } = stubFetch({
      acknowledged: { key: "k", kind: "no-live-window-yet", subject: "agent log-anomaly", at: 1, actor: "token:acme", seenCount: 1 },
      stillOpen: true,
      subject: "agent log-anomaly",
      whatToDo: "Nothing to do unless it stays this way.",
    });
    const result = await clientWith(impl).acknowledgeDifference("no-live-window-yet|agent log-anomaly");
    expect(calls[0]?.url).toBe(MEMORY_PATHS.ack);
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ key: "no-live-window-yet|agent log-anomaly" });
    // The client sends the key and nothing else. `kind` and `subject` are the
    // SERVER's to state -- a client that sent them would be offering its own
    // account of what the system said, which is what an audit trail must not hold.
    expect(JSON.parse(String(calls[0]?.init.body))).not.toHaveProperty("subject");
    expect(result.stillOpen).toBe(true);
  });

  it("refuses an empty key before it reaches the network", async () => {
    const { impl, calls } = stubFetch({});
    await expect(clientWith(impl).acknowledgeDifference("  ")).rejects.toThrow(/key is required/);
    expect(calls).toHaveLength(0);
  });

  it("has NO resolve method, and there is nothing to call", () => {
    // A test for an endpoint that does not exist is the honest way to say the
    // absence is a decision rather than an oversight. Writing one would be
    // writing it.
    const client = clientWith(stubFetch({}).impl) as unknown as Record<string, unknown>;
    expect(client.resolveDifference).toBeUndefined();
    expect(client.dismissDifference).toBeUndefined();
    expect(client.migrate).toBeUndefined();
    expect(Object.keys(client).some((key) => /resolve|dismiss|migrate/i.test(key))).toBe(false);
  });
});
