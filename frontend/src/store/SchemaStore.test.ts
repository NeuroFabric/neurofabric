import { describe, expect, it, vi } from "vitest";

import { SCHEMA_CACHE_LIMIT, SchemaStore, type PortalSource } from "./SchemaStore";
import type { AgentDescriptor, AgentSchema, PortalConfig } from "../api/contracts";

/**
 * THE STATE MACHINE, TESTED WITHOUT A RENDERER.
 *
 * This is the reason the store is a plain subscription and not a React context:
 * every property below -- a malformed roster, a stale response, a cache bound --
 * is provable in a node environment. With a provider, each would need a DOM to
 * be checked at all, and in an environment where the UI cannot be seen, "cannot
 * be checked" means "is not checked".
 */

const descriptor = (id: string, maturity: AgentDescriptor["maturity"] = "ready"): AgentDescriptor => ({
  id,
  title: `${id} title`,
  domain: "anomaly",
  maturity,
  version: "1.0.0",
  capabilities: [`${id} does a thing`],
});

const roster = (...agents: AgentDescriptor[]) => ({
  at: "2026-10-03T00:00:00.000Z",
  total: agents.length,
  agents,
  ready: agents.filter((a) => a.maturity === "ready").length,
  stubCount: agents.filter((a) => a.maturity === "stub").length,
});

const config: PortalConfig = {
  tenant: "acme",
  title: "acme diagnostics",
  version: "1.0.0",
  widgets: [{ id: "w1", kind: "metric", title: "Errors", agentId: "log-anomaly", span: "recent" }],
  forms: [{ id: "new", title: "Install", fields: [{ name: "id", label: "Agent id", type: "text" }] }],
  dashboards: [{ agentId: "log-anomaly", title: "Logs", layout: "grid", columns: 2 }],
};

const schemaFor = (id: string): AgentSchema => ({
  id,
  title: `${id} title`,
  domain: "anomaly",
  version: "1.0.0",
  capabilities: ["c"],
  streams: ["app.log"],
  rules: [{ id: "r1", kind: "regex", severity: "warning", message: "matched", pattern: "boom" }],
});

function source(overrides: Partial<PortalSource> = {}): PortalSource {
  return {
    fetchPortalConfig: async () => ({ derived: false, config }),
    fetchActiveSchemas: async () => roster(descriptor("log-anomaly"), descriptor("latency", "stub")),
    fetchSchema: async (id: string) => schemaFor(id),
    ...overrides,
  };
}

describe("initial state", () => {
  it("starts idle and empty", () => {
    const store = new SchemaStore();
    expect(store.getState().status).toBe("idle");
    expect(store.getState().agents).toEqual([]);
    expect(store.getState().selectedAgentId).toBeNull();
    expect(store.getState().error).toBeNull();
  });

  it("hands out a frozen snapshot so a component cannot mutate the store's state", () => {
    const store = new SchemaStore();
    expect(Object.isFrozen(store.getState())).toBe(true);
  });
});

describe("a healthy load", () => {
  it("becomes ready and exposes the UIConfig components need", async () => {
    const store = new SchemaStore();
    await store.load(source());
    const state = store.getState();
    expect(state.status).toBe("ready");
    expect(state.tenant).toBe("acme");
    expect(state.widgets).toHaveLength(1);
    expect(state.agents.map((a) => a.id)).toEqual(["log-anomaly", "latency"]);
    expect(state.readyCount).toBe(1);
    expect(state.stubCount).toBe(1);
  });

  it("derives the counters from the roster rather than trusting the wire", async () => {
    // A roster claiming 9 ready above a list of two is refused by the validator,
    // so the only path to counters is the recount.
    const store = new SchemaStore();
    await store.load(source({ fetchActiveSchemas: async () => roster(descriptor("a"), descriptor("b", "stub")) }));
    expect(store.getState().readyCount).toBe(1);
    expect(store.getState().stubCount).toBe(1);
  });
});

describe("malformed payloads must not crash the state", () => {
  it("records a bad roster as an issue and still renders the portal", async () => {
    // The dashboard has a perfectly good layout and one broken roster. Blanking
    // the screen would lose the widgets that DID load.
    const store = new SchemaStore();
    await store.load(source({ fetchActiveSchemas: async () => ({ agents: "not-an-array" }) as never }));
    const state = store.getState();
    expect(state.status).toBe("degraded");
    expect(state.widgets).toHaveLength(1);
    expect(state.agents).toEqual([]);
    expect(state.issues.map((i) => i.path)).toContain("$.agents");
  });

  it("records a bad portal as an issue and still renders the roster", async () => {
    const store = new SchemaStore();
    await store.load(source({ fetchPortalConfig: async () => ({ derived: false, config: { ...config, version: "" } }) as never }));
    const state = store.getState();
    expect(state.status).toBe("degraded");
    expect(state.agents).toHaveLength(2);
    expect(state.issues.length).toBeGreaterThan(0);
  });

  it("survives both halves being garbage at once", async () => {
    const store = new SchemaStore();
    await store.load(
      source({
        fetchPortalConfig: async () => {
          throw new Error("boom");
        },
        fetchActiveSchemas: async () => {
          throw new Error("bang");
        },
      }),
    );
    const state = store.getState();
    expect(state.status).toBe("degraded");
    expect(state.issues).toHaveLength(2);
    expect(state.error).not.toBeNull();
  });

  it("never throws out of load(), whatever the source does", async () => {
    const store = new SchemaStore();
    await expect(
      store.load(
        source({
          fetchPortalConfig: async () => {
            // Not an Error, not a GatewayError. Anything can be thrown.
            throw "a bare string";
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(store.getState().status).toBe("degraded");
  });

  it("keeps a good schema when a later schema load is malformed", async () => {
    const store = new SchemaStore();
    await store.load(source());
    await store.loadSchema(source(), "log-anomaly");
    expect(store.getState().schema?.id).toBe("log-anomaly");

    // A DIFFERENT agent, so this is a real fetch rather than a cache hit.
    await store.loadSchema(source({ fetchSchema: async () => ({ nonsense: true }) as never }), "latency");
    // Stale-but-true beats blank. The banner says it is stale.
    expect(store.getState().schema?.id).toBe("log-anomaly");
    expect(store.getState().status).toBe("degraded");
  });

  it("clears schema faults once a valid schema loads", async () => {
    const store = new SchemaStore();
    await store.loadSchema(source({ fetchSchema: async () => ({ nonsense: true }) as never }), "log-anomaly");
    expect(store.getState().issues.length).toBeGreaterThan(0);

    await store.loadSchema(source(), "log-anomaly");
    expect(store.getState().issues).toEqual([]);
    expect(store.getState().status).toBe("ready");
  });

  it("leaves portal faults alone when a schema loads successfully", async () => {
    // A schema loading tells you nothing about whether the portal config is
    // sound, so it must not report the portal as fixed.
    const store = new SchemaStore();
    await store.load(source({ fetchActiveSchemas: async () => ({ agents: "nope" }) as never }));
    expect(store.getState().status).toBe("degraded");

    await store.loadSchema(source(), "log-anomaly");
    expect(store.getState().status).toBe("degraded");
  });
});

describe("subscriptions", () => {
  it("delivers every state change", async () => {
    const store = new SchemaStore();
    const seen: string[] = [];
    store.subscribe((state) => seen.push(state.status));
    await store.load(source());
    expect(seen).toContain("loading");
    expect(seen[seen.length - 1]).toBe("ready");
  });

  it("stops delivering after unsubscribe, and tolerates being called twice", async () => {
    const store = new SchemaStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    off(); // React StrictMode double-invokes effects; this must be harmless
    await store.load(source());
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps notifying other listeners when one throws", async () => {
    // Otherwise a single broken component freezes the whole command center on a
    // stale frame, and the trace points at the store rather than the culprit.
    const store = new SchemaStore();
    const healthy = vi.fn();
    store.subscribe(() => {
      throw new Error("component exploded");
    });
    store.subscribe(healthy);
    await expect(store.load(source())).resolves.toBeUndefined();
    expect(healthy).toHaveBeenCalled();
  });
});

describe("concurrency", () => {
  it("discards a stale schema response rather than letting it overwrite the current selection", async () => {
    // Select A then B. If A's response lands second it would show B's heading
    // with A's rules -- a UI that lies confidently.
    let releaseA: (() => void) | undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const store = new SchemaStore();
    const slow = source({
      fetchSchema: async (id: string) => {
        if (id === "log-anomaly") await gateA;
        return schemaFor(id);
      },
    });

    const first = store.loadSchema(slow, "log-anomaly");
    const second = store.loadSchema(source(), "latency");
    await second;
    releaseA?.();
    await first;

    expect(store.getState().selectedAgentId).toBe("latency");
    expect(store.getState().schema?.id).toBe("latency");
  });

  it("discards a stale portal load when a newer one has started", async () => {
    const store = new SchemaStore();
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const slowSource = source({
      fetchPortalConfig: async () => {
        await gate;
        return { derived: true, config: { ...config, title: "STALE" } };
      },
    });

    const first = store.load(slowSource);
    await store.load(source({ fetchPortalConfig: async () => ({ derived: false, config: { ...config, title: "FRESH" } }) }));
    releaseFirst?.();
    await first;

    expect(store.getState().title).toBe("FRESH");
  });

  it("ignores a blank agent id rather than issuing a request", async () => {
    const fetchSchema = vi.fn(async () => schemaFor("x"));
    const store = new SchemaStore();
    await store.loadSchema(source({ fetchSchema }), "  ");
    expect(fetchSchema).not.toHaveBeenCalled();
  });
});

describe("selection", () => {
  it("serves a cached schema without a second request", async () => {
    const fetchSchema = vi.fn(async (id: string) => schemaFor(id));
    const shared = source({ fetchSchema });
    const store = new SchemaStore();
    await store.load(shared);
    await store.loadSchema(shared, "log-anomaly");
    await store.loadSchema(shared, "log-anomaly");
    expect(fetchSchema).toHaveBeenCalledTimes(1);
  });

  it("drops a selection naming an agent that no longer exists", async () => {
    const store = new SchemaStore();
    await store.load(source());
    store.select("log-anomaly");
    expect(store.getState().selectedAgentId).toBe("log-anomaly");

    // A reload where that agent is gone must not leave a heading naming it.
    await store.load(source({ fetchActiveSchemas: async () => roster(descriptor("other")) }));
    expect(store.getState().selectedAgentId).toBeNull();
    expect(store.getState().schema).toBeNull();
  });

  it("does not republish when the selection has not changed", () => {
    const store = new SchemaStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.select(null);
    expect(listener).not.toHaveBeenCalled();
  });

  it("clears the schema when selection is cleared", async () => {
    const store = new SchemaStore();
    const shared = source();
    await store.load(shared);
    await store.loadSchema(shared, "log-anomaly");
    store.select(null);
    expect(store.getState().schema).toBeNull();
  });
});

describe("bounded retention", () => {
  it("evicts the oldest schema past the cache limit", async () => {
    // Each schema can carry 256 rules, so unbounded retention is a leak
    // reachable by ordinary clicking.
    const store = new SchemaStore();
    for (let i = 0; i < SCHEMA_CACHE_LIMIT + 5; i += 1) {
      await store.loadSchema(source(), `agent-${i}`);
    }
    const fetchSchema = vi.fn(async (id: string) => schemaFor(id));
    // The most recent is retained; the very first has been evicted.
    await store.loadSchema(source({ fetchSchema }), "agent-0");
    expect(fetchSchema).toHaveBeenCalledTimes(1);
  });

  it("keeps a revisited agent rather than evicting it next", async () => {
    const store = new SchemaStore();
    const shared = source();
    for (let i = 0; i < SCHEMA_CACHE_LIMIT - 1; i += 1) await store.loadSchema(shared, `agent-${i}`);
    await store.loadSchema(shared, "hot");
    for (let i = 0; i < SCHEMA_CACHE_LIMIT - 1; i += 1) await store.loadSchema(shared, `fresh-${i}`);

    const fetchSchema = vi.fn(async (id: string) => schemaFor(id));
    await store.loadSchema(source({ fetchSchema }), "hot");
    expect(fetchSchema).not.toHaveBeenCalled();
  });
});

describe("error reduction", () => {
  it("keeps the failure kind so the UI can pick a screen", async () => {
    const store = new SchemaStore();
    await store.load(
      source({
        fetchPortalConfig: async () => {
          throw Object.assign(new Error("no credential was proven"), { kind: "refused", issues: [] });
        },
      }),
    );
    expect(store.getState().error?.kind).toBe("refused");
  });

  it("treats a non-GatewayError as malformed rather than inventing a kind", async () => {
    // Sending a user to a sign-in screen for a programming error is its own bug.
    const store = new SchemaStore();
    await store.load(
      source({
        fetchPortalConfig: async () => {
          throw new TypeError("x is not a function");
        },
      }),
    );
    expect(store.getState().error?.kind).toBe("malformed");
  });
});