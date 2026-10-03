import { afterEach, describe, expect, it, vi } from "vitest";

import { CREDENTIAL_HEADER, GatewayClient, GatewayError, PORTAL_PATHS } from "./gateway-client";
import type { AgentDescriptor, AgentRoster, PortalConfig } from "./contracts";

/**
 * THE GATEWAY CLIENT, TESTED AGAINST A MOCKED TRANSPORT.
 *
 * `fetch` is injected rather than stubbed globally, so these tests assert the
 * EXACT request the client makes -- method, path, headers, body -- rather than
 * asserting on a response a global stub was told to return. A global stub can
 * only prove the client did not crash; an injected one proves it asked the right
 * question of the right place.
 */

const GATEWAY_TOKEN = "gw-live-9f3a2c8e";

// Annotated rather than inferred: without it `domain` widens to `string` and the
// literal stops being a DiagnosticDomain, so this fixture would not type-check as
// the thing it stands in for.
const descriptor: AgentDescriptor = {
  id: "log-anomaly",
  title: "Log anomalies",
  domain: "anomaly",
  maturity: "ready",
  version: "1.0.0",
  capabilities: ["find bursts"],
};

const config: PortalConfig = {
  tenant: "acme",
  title: "acme diagnostics",
  version: "1.0.0",
  widgets: [{ id: "w1", kind: "metric", title: "Errors", agentId: "log-anomaly", span: "recent" }],
  forms: [{ id: "new", title: "Install", fields: [{ name: "id", label: "Agent id", type: "text", required: true }] }],
  dashboards: [{ agentId: "log-anomaly", title: "Logs", layout: "grid", columns: 2 }],
};

/** A `fetch` that records its call and returns a canned response. */
function stubFetch(body: unknown, init: { readonly status?: number; readonly headers?: Record<string, string> } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl: typeof fetch = async (url, requestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", ...init.headers },
    });
  };
  return { impl, calls };
}

function clientWith(impl: typeof fetch, overrides: { timeoutMs?: number; baseUrl?: string } = {}) {
  return new GatewayClient({ gatewayToken: GATEWAY_TOKEN, fetchImpl: impl, ...overrides });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("construction", () => {
  it.each([
    ["an empty token", ""],
    ["whitespace only", "   "],
  ])("refuses to build with %s", (_label, token) => {
    // Fail closed at construction, not at first request. A client that builds and
    // then refuses every call reads as "the API is broken".
    expect(() => new GatewayClient({ gatewayToken: token })).toThrowError(GatewayError);
    try {
      new GatewayClient({ gatewayToken: token });
    } catch (error) {
      expect((error as GatewayError).kind).toBe("misconfigured");
    }
  });

  it("reports misconfigured when a fetch impl is absent but a token is present", () => {
    // Sanity: construction with a valid token must not throw.
    expect(() => new GatewayClient({ gatewayToken: GATEWAY_TOKEN })).not.toThrow();
  });
});

describe("the credential", () => {
  it("is sent in the header the backend reads", async () => {
    const { impl, calls } = stubFetch({ derived: false, config });
    await clientWith(impl).fetchPortalConfig();
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers[CREDENTIAL_HEADER]).toBe(GATEWAY_TOKEN);
    // Pinned literally: renaming this header silently authenticates nothing.
    expect(CREDENTIAL_HEADER).toBe("x-gateway-token");
  });

  it("never appears in the URL, in a query string or in the body", async () => {
    const { impl, calls } = stubFetch({ agent: descriptor, replacedVersion: null });
    await clientWith(impl).uploadSchema({ id: "a", title: "A" });
    const call = calls[0];
    expect(call?.url).not.toContain(GATEWAY_TOKEN);
    expect(JSON.stringify(call?.init.body)).not.toContain(GATEWAY_TOKEN);
  });

  it("does not carry ambient cookies", async () => {
    const { impl, calls } = stubFetch({ derived: false, config });
    await clientWith(impl).fetchPortalConfig();
    // Otherwise a 401 is ambiguous: was the credential refused, or was a cookie
    // silently satisfying the request?
    expect(calls[0]?.init.credentials).toBe("omit");
  });
});

describe("requests", () => {
  it("reads the portal config from the documented path", async () => {
    const { impl, calls } = stubFetch({ derived: true, config });
    const result = await clientWith(impl).fetchPortalConfig();
    expect(calls[0]?.url).toBe(PORTAL_PATHS.config);
    expect(calls[0]?.init.method).toBe("GET");
    expect(result.derived).toBe(true);
    expect(result.config.tenant).toBe("acme");
  });

  it("prefixes a baseUrl and does not double the slash", async () => {
    const { impl, calls } = stubFetch({ derived: false, config });
    await clientWith(impl, { baseUrl: "http://127.0.0.1:3000/" }).fetchPortalConfig();
    expect(calls[0]?.url).toBe("http://127.0.0.1:3000/api/portal/config");
  });

  it("reads the active schemas from the roster route", async () => {
    const roster: AgentRoster = { at: "2026-10-03T00:00:00.000Z", total: 1, agents: [descriptor], ready: 1, stubCount: 0 };
    const { impl, calls } = stubFetch(roster);
    const result = await clientWith(impl).fetchActiveSchemas();
    expect(calls[0]?.url).toBe(PORTAL_PATHS.agents);
    expect(result.agents[0]?.id).toBe("log-anomaly");
  });

  it("encodes a schema id so it cannot address a different resource", async () => {
    const { impl, calls } = stubFetch({ schema: { ...descriptor, capabilities: [], streams: [], rules: [] } });
    await clientWith(impl).fetchSchema("../../vault");
    // Unencoded, this id walks out of /schema/ and addresses something else.
    expect(calls[0]?.url).toBe("/api/portal/schema/..%2F..%2Fvault");
  });

  it("refuses a blank schema id before making a request", async () => {
    const { impl, calls } = stubFetch({});
    await expect(clientWith(impl).fetchSchema("  ")).rejects.toMatchObject({ kind: "misconfigured" });
    expect(calls).toHaveLength(0);
  });

  it("posts a schema document as JSON", async () => {
    const { impl, calls } = stubFetch({ agent: descriptor, replacedVersion: "0.9.0" });
    const result = await clientWith(impl).uploadSchema({ id: "a", title: "A", rules: [] });
    const call = calls[0];
    expect(call?.url).toBe(PORTAL_PATHS.schema);
    expect(call?.init.method).toBe("POST");
    expect((call?.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(call?.init.body))).toEqual({ id: "a", title: "A", rules: [] });
    expect(result.replacedVersion).toBe("0.9.0");
  });

  it("refuses a non-object schema document before sending it", async () => {
    const { impl, calls } = stubFetch({});
    await expect(clientWith(impl).uploadSchema("a string")).rejects.toMatchObject({ kind: "misconfigured" });
    expect(calls).toHaveLength(0);
  });
});

describe("failure classification", () => {
  const edgeRefusal = { status: "FAILED", failure: { code: "UNAUTHENTICATED", reason: "no credential was proven" } };

  it.each([
    [401, "refused"],
    [403, "refused"],
    [404, "not-found"],
    [409, "conflict"],
    [400, "invalid"],
    [418, "unexpected-status"],
    [500, "server"],
    [503, "server"],
  ])("classifies %i as %s", async (status, kind) => {
    const { impl } = stubFetch({ error: "nope" }, { status });
    await expect(clientWith(impl).fetchPortalConfig()).rejects.toMatchObject({ kind, status });
  });

  it("classifies 429 as throttled and reads retry-after", async () => {
    const { impl } = stubFetch(edgeRefusal, { status: 429, headers: { "retry-after": "12" } });
    await expect(clientWith(impl).fetchPortalConfig()).rejects.toMatchObject({
      kind: "throttled",
      retryAfterSeconds: 12,
    });
  });

  it("ignores a nonsense retry-after rather than propagating NaN", async () => {
    const { impl } = stubFetch(edgeRefusal, { status: 429, headers: { "retry-after": "soon" } });
    await expect(clientWith(impl).fetchPortalConfig()).rejects.toMatchObject({ kind: "throttled" });
    try {
      await clientWith(impl).fetchPortalConfig();
    } catch (error) {
      expect((error as GatewayError).retryAfterSeconds).toBeUndefined();
    }
  });

  it("surfaces the edge's reason, which is often the only explanation given", async () => {
    const { impl } = stubFetch(edgeRefusal, { status: 401 });
    try {
      await clientWith(impl).fetchPortalConfig();
      expect.unreachable("a 401 must throw");
    } catch (error) {
      expect((error as GatewayError).message).toContain("no credential was proven");
    }
  });

  it("carries field-named validation issues from a 400", async () => {
    const body = { error: "schema refused", issues: [{ path: "$.id", reason: "id is required" }] };
    const { impl } = stubFetch(body, { status: 400 });
    try {
      await clientWith(impl).uploadSchema({ title: "no id" });
      expect.unreachable("a 400 must throw");
    } catch (error) {
      expect((error as GatewayError).issues).toEqual([{ path: "$.id", reason: "id is required" }]);
    }
  });

  it("still reports by status when the body cannot be read at all", async () => {
    // The status arrived, so the request demonstrably connected. Reporting a bare
    // network error here would discard the more useful half of the answer.
    const broken = {
      ok: false,
      status: 502,
      headers: new Headers(),
      text: () => Promise.reject(new Error("socket hang up")),
    } as unknown as Response;
    const impl: typeof fetch = async () => broken;
    await expect(clientWith(impl).fetchPortalConfig()).rejects.toMatchObject({ kind: "server", status: 502 });
  });
});

describe("the credential never reaches an error", () => {
  it("withholds it from a server message that echoes it back", async () => {
    // A server that can see the credential can echo it. A client that quotes the
    // server re-broadcasts whatever the server said.
    const { impl } = stubFetch({ error: `bad credential ${GATEWAY_TOKEN}` }, { status: 401 });
    try {
      await clientWith(impl).fetchPortalConfig();
      expect.unreachable("a 401 must throw");
    } catch (error) {
      expect((error as GatewayError).message).not.toContain(GATEWAY_TOKEN);
      expect((error as GatewayError).message).toContain("[withheld]");
    }
  });

  it("withholds it from a shape-mismatch issue list", async () => {
    const { impl } = stubFetch({ derived: false, config: { ...config, title: GATEWAY_TOKEN, version: "" } });
    try {
      await clientWith(impl).fetchPortalConfig();
      expect.unreachable("a malformed config must throw");
    } catch (error) {
      expect(JSON.stringify((error as GatewayError).toJSON())).not.toContain(GATEWAY_TOKEN);
    }
  });

  it("withholds it from a network error message", async () => {
    const impl: typeof fetch = async () => {
      throw new TypeError(`connect ECONNREFUSED while sending ${GATEWAY_TOKEN}`);
    };
    try {
      await clientWith(impl).fetchPortalConfig();
      expect.unreachable("a refused connection must throw");
    } catch (error) {
      expect((error as GatewayError).message).not.toContain(GATEWAY_TOKEN);
    }
  });

  it("serialises to something safe to log", async () => {
    const { impl } = stubFetch({ error: "nope" }, { status: 500 });
    try {
      await clientWith(impl).fetchPortalConfig();
      expect.unreachable("a 500 must throw");
    } catch (error) {
      const gatewayError = error as GatewayError;
      expect(gatewayError.toJSON()).toMatchObject({ kind: "server", status: 500 });
      expect(JSON.stringify(gatewayError.toJSON())).not.toContain(GATEWAY_TOKEN);
    }
  });
});

describe("malformed responses", () => {
  it("reports a non-JSON body as malformed and quotes only a bounded snippet", async () => {
    const { impl } = stubFetch("<html>gateway down</html>");
    try {
      await clientWith(impl).fetchPortalConfig();
      expect.unreachable("a non-JSON body must throw");
    } catch (error) {
      expect((error as GatewayError).kind).toBe("malformed");
      expect((error as GatewayError).message).toContain("did not return JSON");
    }
  });

  it("truncates a very large hostile body", async () => {
    const { impl } = stubFetch("x".repeat(50_000));
    try {
      await clientWith(impl).fetchPortalConfig();
      expect.unreachable("a huge non-JSON body must throw");
    } catch (error) {
      const message = (error as GatewayError).message;
      expect(message.length).toBeLessThan(400);
      expect(message).toContain("truncated");
    }
  });

  it("reports an empty body where a document was promised", async () => {
    const { impl } = stubFetch("");
    await expect(clientWith(impl).fetchPortalConfig()).rejects.toMatchObject({ kind: "malformed" });
  });

  it("reports a shape mismatch with a path rather than a crash", async () => {
    const { impl } = stubFetch({ derived: false, config: { ...config, version: undefined } });
    try {
      await clientWith(impl).fetchPortalConfig();
      expect.unreachable("a config without a version must throw");
    } catch (error) {
      const gatewayError = error as GatewayError;
      expect(gatewayError.kind).toBe("malformed");
      expect(gatewayError.issues.map((i) => i.path)).toContain("$.config$.version");
    }
  });

  it("never lets a roster with inconsistent counters through", async () => {
    const { impl } = stubFetch({ at: "now", total: 9, agents: [descriptor], ready: 9, stubCount: 0 });
    await expect(clientWith(impl).fetchActiveSchemas()).rejects.toMatchObject({ kind: "malformed" });
  });
});

describe("the timeout budget", () => {
  it("aborts a request that outlives its budget", async () => {
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    await expect(clientWith(hanging, { timeoutMs: 10 }).fetchPortalConfig()).rejects.toMatchObject({ kind: "timeout" });
  });

  it("reports a timeout as a timeout rather than as a network failure", async () => {
    // These want different screens: one is "try again", the other is "check your
    // connection". Collapsing them makes the UI give the wrong advice.
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    try {
      await clientWith(hanging, { timeoutMs: 10 }).fetchPortalConfig();
      expect.unreachable("a hanging request must throw");
    } catch (error) {
      expect((error as GatewayError).kind).toBe("timeout");
      expect((error as GatewayError).message).toContain("10ms");
    }
  });

  it("reports a connection failure as a network failure", async () => {
    const impl: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(clientWith(impl).fetchPortalConfig()).rejects.toMatchObject({ kind: "network" });
  });

  it("clears its timer on success so no handle outlives the request", async () => {
    // A timer left running outlives its request and holds the event loop open.
    // That is the exact shape of the handle that hung this repository's own test
    // suite once, so it is pinned rather than trusted.
    vi.useFakeTimers();
    try {
      const { impl } = stubFetch({ derived: false, config });
      await clientWith(impl, { timeoutMs: 30_000 }).fetchPortalConfig();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its timer on failure too", async () => {
    vi.useFakeTimers();
    try {
      const impl: typeof fetch = async () => {
        throw new TypeError("fetch failed");
      };
      await clientWith(impl, { timeoutMs: 30_000 }).fetchPortalConfig().catch(() => undefined);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});