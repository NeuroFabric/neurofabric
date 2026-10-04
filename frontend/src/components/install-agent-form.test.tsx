import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { InstallAgentForm, buildSchemaDocument } from "./InstallAgentForm";
import type { PortalForm } from "../api/contracts";

/**
 * THE INSTALL LOOP. What is provable without a browser, and what is not.
 *
 * `renderToStaticMarkup` does not run effects, so a submit cannot be driven from
 * here. What IS provable, and is the part that was completely missing: that the
 * form renders REAL inputs, that it builds a document the registry's grammar
 * accepts, and that the states are labelled.
 *
 * The click itself is the operator's browser test. That limit is stated rather
 * than worked around.
 */

const FORM: PortalForm = {
  id: "new-schema",
  title: "Install an agent",
  fields: [
    { name: "id", label: "Agent id", type: "text", required: true },
    { name: "title", label: "Title", type: "text", required: true },
  ],
};

const markup = (node: React.ReactElement): string => renderToStaticMarkup(node);
const words = (node: React.ReactElement): string => markup(node).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("the install form is a form", () => {
  it("renders a real input per declared field, not a description of one", () => {
    const html = markup(<InstallAgentForm form={FORM} source={{ uploadSchema: vi.fn() }} />);
    expect(html).toContain("<input");
    expect(html).toContain('id="install-id"');
    expect(html).toContain('id="install-title"');
    // The previous version rendered a TABLE of field names. This asserts the
    // absence of the shape it used to have, so nobody restores it thinking it
    // still works.
    expect(html).not.toContain("<thead>");
    expect(html).not.toContain("<th ");
  });

  it("labels every input, so it is usable with a screen reader", () => {
    const html = markup(<InstallAgentForm form={FORM} source={{ uploadSchema: vi.fn() }} />);
    for (const field of FORM.fields) expect(html).toContain(`for="install-${field.name}"`);
  });

  it("says what it will do before the operator does it", () => {
    // A starter rule is created, and the panel says so. An agent that silently
    // arrived with a rule nobody chose is worse than one that visibly does.
    expect(words(<InstallAgentForm form={FORM} source={{ uploadSchema: vi.fn() }} />)).toContain("starter rule");
  });

  it("uses the portal's own title for the button, because the portal declared it", () => {
    expect(markup(<InstallAgentForm form={FORM} source={{ uploadSchema: vi.fn() }} />)).toContain(FORM.title);
  });
});

describe("the document it builds", () => {
  const RULES_ALLOWED = new Set([
    "id", "kind", "severity", "message", "field", "pattern",
    "flags", "operator", "value", "windowMs", "rateAbove",
  ]);

  it("uses ONLY rule fields the registry accepts", () => {
    // The first demo agent invented `column` and `factor` and the POST answered
    // 400 -- the front door broken in exactly the situation it exists for. Same
    // allowed set, asserted so it cannot drift back.
    const doc = buildSchemaDocument({ id: "a", title: "A" });
    for (const rule of doc["rules"] as Record<string, unknown>[]) {
      for (const key of Object.keys(rule)) expect(RULES_ALLOWED.has(key), `rule field "${key}"`).toBe(true);
    }
  });

  it("carries at least one rule, because the registry refuses a schema with none", () => {
    const doc = buildSchemaDocument({ id: "a", title: "A" });
    expect(Array.isArray(doc["rules"])).toBe(true);
    expect((doc["rules"] as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("takes what the person typed and supplies the rest", () => {
    const doc = buildSchemaDocument({ id: "checkout-lag", title: "Checkout lag" });
    expect(doc["id"]).toBe("checkout-lag");
    expect(doc["title"]).toBe("Checkout lag");
    expect(typeof doc["domain"]).toBe("string");
    expect(Array.isArray(doc["streams"])).toBe(true);
  });

  it("falls back to the id when only one of the two is given", () => {
    // A title of "" would install an agent nobody can find in a list.
    expect(buildSchemaDocument({ id: "checkout-lag" })["title"]).toBe("checkout-lag");
  });

  it("trims, so a pasted value with a trailing space does not become the id", () => {
    expect(buildSchemaDocument({ id: "  checkout-lag  ", title: "  Checkout  " })["id"]).toBe("checkout-lag");
    expect(buildSchemaDocument({ id: "  checkout-lag  ", title: "  Checkout  " })["title"]).toBe("Checkout");
  });
});

describe("the states, in the customer's words", () => {
  it("starts idle and offers the action", () => {
    const html = markup(<InstallAgentForm form={FORM} source={{ uploadSchema: vi.fn() }} />);
    expect(html).toContain('data-install-phase="idle"');
    expect(html).toContain('type="submit"');
  });

  it("contains none of the internal vocabulary the operator enumerated", () => {
    const text = words(<InstallAgentForm form={FORM} source={{ uploadSchema: vi.fn() }} />).toLowerCase();
    for (const banned of ["schema", "endpoint", "registry", "portal api"]) {
      expect(text, `the install form says "${banned}"`).not.toContain(banned);
    }
  });
});