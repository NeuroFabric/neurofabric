import { describe, expect, it } from "vitest";

import {
  readIssueList,
  validateAgentRoster,
  validateAgentSchema,
  validatePortalConfig,
  validatePortalEnvelope,
  validateSchemaInstall,
  validateSchemaEnvelope,
} from "./contracts";

/**
 * THE SHAPE GUARDS, TESTED WITHOUT A NETWORK.
 *
 * These validators are the only thing standing between a payload the frontend
 * did not write and a component that is about to call `.length` on it. Their job
 * is to refuse, and the property worth pinning hardest is that they refuse with a
 * PATH rather than by throwing, so a caller can point an editor at the field.
 */

const validWidget = { id: "w1", kind: "metric", title: "Errors", agentId: "log-anomaly", span: "recent" };
const validField = { name: "id", label: "Agent id", type: "text", required: true };
const validDashboard = { agentId: "log-anomaly", title: "Logs", layout: "grid", columns: 2 };

const validConfig = {
  tenant: "acme",
  title: "acme diagnostics",
  version: "1.0.0",
  widgets: [validWidget],
  forms: [{ id: "new", title: "Install", fields: [validField] }],
  dashboards: [validDashboard],
};

const validDescriptor = {
  id: "log-anomaly",
  title: "Log anomalies",
  domain: "anomaly",
  maturity: "ready",
  version: "1.0.0",
  capabilities: ["find bursts"],
};

const validRule = { id: "r1", kind: "regex", severity: "warning", message: "matched", pattern: "boom" };

const validSchema = {
  id: "log-anomaly",
  title: "Log anomalies",
  domain: "anomaly",
  version: "1.0.0",
  capabilities: ["find bursts"],
  streams: ["app.log"],
  rules: [validRule],
};

describe("portal config", () => {
  it("accepts a well-formed config", () => {
    const verdict = validatePortalConfig(validConfig);
    expect(verdict.ok).toBe(true);
  });

  it("keeps an absent agentId absent rather than making it undefined", () => {
    const verdict = validatePortalConfig({
      ...validConfig,
      widgets: [{ id: "w1", kind: "metric", title: "Static" }],
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    // Presence is how a renderer tells a static widget from an agent-backed one.
    // `agentId: undefined` would make `"agentId" in widget` true and lie.
    expect("agentId" in (verdict.value.widgets[0] as object)).toBe(false);
  });

  it("reports the path of a bad nested field", () => {
    const verdict = validatePortalConfig({
      ...validConfig,
      forms: [{ id: "f", title: "F", fields: [{ name: "", label: "L", type: "text" }] }],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.issues.map((i) => i.path)).toContain("$.forms[0].fields[0].name");
  });

  it.each([
    ["a non-object", "nope"],
    ["an array", []],
    ["null", null],
  ])("refuses %s", (_label, input) => {
    expect(validatePortalConfig(input).ok).toBe(false);
  });

  it.each([
    ["an unknown widget kind", "$.widgets[0].kind", { ...validWidget, kind: "hologram" }],
    ["a missing title", "$.widgets[0].title", { id: "w1", kind: "metric", title: "  " }],
    ["an out-of-range column count", "$.dashboards[0].columns", { ...validDashboard, columns: 44 }],
    ["an unknown field type", "$.forms[0].fields[0].type", { ...validField, type: "colour" }],
  ])("refuses %s at %s", (_label, path, widgetOrField) => {
    const config =
      typeof widgetOrField === "object" && "kind" in widgetOrField
        ? { ...validConfig, widgets: [widgetOrField] }
        : typeof widgetOrField === "object" && "agentId" in widgetOrField
          ? { ...validConfig, dashboards: [widgetOrField] }
          : { ...validConfig, forms: [{ id: "f", title: "F", fields: [widgetOrField] }] };
    const verdict = validatePortalConfig(config);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.issues.map((i) => i.path)).toContain(path);
  });

  it("ignores unknown fields rather than refusing them", () => {
    // The server owns this shape and may grow it. A frontend that refused every
    // unrecognised field would break the first time a field was added.
    const verdict = validatePortalConfig({ ...validConfig, somethingNew: { deeply: ["nested"] } });
    expect(verdict.ok).toBe(true);
  });

  it("treats a missing widgets array as empty, not as an error", () => {
    const verdict = validatePortalConfig({ tenant: "a", title: "t", version: "1" });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.value.widgets).toEqual([]);
  });
});

describe("portal envelope", () => {
  it("unwraps derived and config", () => {
    const verdict = validatePortalEnvelope({ derived: true, config: validConfig });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.value.derived).toBe(true);
  });

  it("prefixes a nested issue path with $.config", () => {
    const verdict = validatePortalEnvelope({ derived: false, config: { ...validConfig, version: "" } });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.issues[0]?.path).toBe("$.config$.version");
  });

  it("refuses a non-boolean derived flag", () => {
    expect(validatePortalEnvelope({ derived: "yes", config: validConfig }).ok).toBe(false);
  });
});

describe("agent roster", () => {
  const roster = (overrides: Record<string, unknown> = {}) => ({
    at: "2026-10-03T00:00:00.000Z",
    total: 1,
    agents: [validDescriptor],
    ready: 1,
    stubCount: 0,
    ...overrides,
  });

  it("accepts a consistent roster", () => {
    expect(validateAgentRoster(roster()).ok).toBe(true);
  });

  it("cross-checks the published counters against the roster", () => {
    // "3 ready" above a list of two ready agents is a confidently wrong badge,
    // which is worse than a missing one.
    const verdict = validateAgentRoster(roster({ ready: 3 }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.issues[0]?.path).toBe("$.ready");
  });

  it("refuses a descriptor with an unknown domain", () => {
    const verdict = validateAgentRoster(roster({ agents: [{ ...validDescriptor, domain: "astrology" }], ready: 0 }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.issues.map((i) => i.path)).toContain("$.agents[0].domain");
  });

  it("recomputes counters rather than echoing the server's", () => {
    const verdict = validateAgentRoster(roster({ agents: [validDescriptor, { ...validDescriptor, id: "b", maturity: "stub" }], total: 2, ready: 1, stubCount: 1 }));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.value.ready).toBe(1);
    expect(verdict.value.stubCount).toBe(1);
    expect(verdict.value.total).toBe(2);
  });

  it("refuses a non-array agents field", () => {
    expect(validateAgentRoster(roster({ agents: "many" })).ok).toBe(false);
  });
});

describe("agent schema", () => {
  it("accepts a well-formed schema", () => {
    expect(validateAgentSchema(validSchema).ok).toBe(true);
  });

  it("refuses a rule with an unknown kind and reports the rule index", () => {
    const verdict = validateAgentSchema({ ...validSchema, rules: [{ ...validRule, kind: "astrology" }] });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.issues.map((i) => i.path)).toContain("$.rules[0].kind");
  });

  it("refuses an unknown severity", () => {
    const verdict = validateAgentSchema({ ...validSchema, rules: [{ ...validRule, severity: "apocalyptic" }] });
    expect(verdict.ok).toBe(false);
  });

  it("does not mistake a zero value for an absent one", () => {
    // `value: 0` is a legitimate threshold value. A truthiness check would drop
    // it, and a threshold rule that silently loses its threshold matches nothing.
    const verdict = validateAgentSchema({
      ...validSchema,
      rules: [{ id: "r", kind: "threshold", severity: "info", message: "m", operator: ">=", value: 0 }],
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.value.rules[0]?.value).toBe(0);
  });

  it("refuses non-string streams", () => {
    expect(validateAgentSchema({ ...validSchema, streams: [1, 2] }).ok).toBe(false);
  });
});

describe("schema envelope", () => {
  it("unwraps a { schema } document", () => {
    // The route wraps the document. Validating the envelope as though it were
    // the schema refuses every real response.
    expect(validateSchemaEnvelope({ schema: validSchema }).ok).toBe(true);
  });

  it("refuses a bare schema that is not wrapped", () => {
    expect(validateSchemaEnvelope(validSchema).ok).toBe(false);
  });

  it("prefixes a nested issue path with $.schema", () => {
    const verdict = validateSchemaEnvelope({ schema: { ...validSchema, id: "" } });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.issues[0]?.path).toBe("$.schema$.id");
  });
});

describe("schema install result", () => {
  it("accepts a first install with a null replacedVersion", () => {
    const verdict = validateSchemaInstall({ agent: validDescriptor, replacedVersion: null });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.value.replacedVersion).toBeNull();
  });

  it("accepts a replacement carrying the previous version", () => {
    const verdict = validateSchemaInstall({ agent: validDescriptor, replacedVersion: "0.9.0" });
    expect(verdict.ok).toBe(true);
  });

  it("refuses an omitted replacedVersion, which is not the same as null", () => {
    expect(validateSchemaInstall({ agent: validDescriptor }).ok).toBe(false);
  });
});

describe("readIssueList", () => {
  it("reads field-named issues from a refusal", () => {
    const issues = readIssueList({ error: "schema refused", issues: [{ path: "$.id", reason: "id is required" }] });
    expect(issues).toEqual([{ path: "$.id", reason: "id is required" }]);
  });

  it.each([
    ["a non-object", "boom"],
    ["a missing issues array", { error: "nope" }],
    ["an issue missing a reason", { issues: [{ path: "$.id" }] }],
    ["null", null],
  ])("returns an empty list for %s rather than throwing", (_label, body) => {
    expect(readIssueList(body)).toEqual([]);
  });
});