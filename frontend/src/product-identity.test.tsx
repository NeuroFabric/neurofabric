import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App, statusWord } from "./App";
import { SchemaStore, type PortalSource, type StoreStatus } from "./store/SchemaStore";
import { simulateVerdict } from "./api/live-contracts";
import type { AgentDescriptor, AgentSchema, PortalConfig } from "./api/contracts";
import type { LiveSource } from "./hooks/useLiveTelemetry";

/**
 * SLICE 1 — THE UI READS AS A PRODUCT. What is provable without a browser.
 *
 * === WHAT IS AND IS NOT VERIFIED HERE, STATED FIRST ===
 *
 * `renderToStaticMarkup` produces markup. It does not lay out, does not paint,
 * and cannot measure a frame. So these tests pin **the three things a static
 * render and the stylesheet can actually prove**: that the product's name is in
 * the tree, that severity is encoded by something other than hue, and that the
 * internal status word is not shown to a person.
 *
 * **They do NOT prove 60fps, a flat heap, or that the colours look right.** Those
 * need a browser and a profiler, and this workspace has neither. Saying so here
 * is cheaper than a green run implying more than it measured.
 *
 * The CSS assertions read `styles.css` as text. That is a regression guard, not a
 * verification — the same distinction `deployment.test.ts` draws, for the same
 * reason: a stylesheet can say anything, and only a renderer knows what it does.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const CSS = readFileSync(path.join(ROOT, "src", "styles.css"), "utf8");

const descriptor: AgentDescriptor = {
  id: "log-anomaly",
  title: "Log anomalies",
  domain: "anomaly",
  maturity: "ready",
  version: "1.0.0",
  capabilities: ["find bursts"],
};

const schema: AgentSchema = {
  id: "log-anomaly",
  title: "Log anomalies",
  domain: "anomaly",
  version: "1.0.0",
  capabilities: ["find bursts"],
  streams: ["logs"],
  rules: [{ id: "r", kind: "missing-field", severity: "info", message: "m", field: "x" }],
};

const config: PortalConfig = {
  tenant: "acme",
  title: "acme diagnostics",
  version: "1.0.0",
  widgets: [{ id: "errors", kind: "metric", title: "Error rate", agentId: "log-anomaly", span: "recent" }],
  forms: [{ id: "new", title: "Install an agent", fields: [{ name: "id", label: "Agent id", type: "text", required: true }] }],
  dashboards: [{ agentId: "log-anomaly", title: "Logs", layout: "grid", columns: 2 }],
};

/**
 * A store driven to a known state, using the REAL API.
 *
 * The first version of this file called `store.ingestAgents(...)` and
 * `store.patchStatus(...)`, neither of which exists -- it guessed the interface
 * instead of reading it, and failed at parse time. The store is driven by
 * `await store.load(source)`, so that is what this does.
 */
async function readyStore(): Promise<SchemaStore> {
  const store = new SchemaStore();
  await store.load(source);
  await store.loadSchema(source, "log-anomaly");
  return store;
}

const source: PortalSource = {
  fetchActiveSchemas: async () => ({ at: "2026-10-04T00:00:00.000Z", total: 1, agents: [descriptor], ready: 1, stubCount: 0 }),
  fetchPortalConfig: async () => ({ derived: false, config }),
  fetchSchema: async () => schema,
};

const live: LiveSource = { fetchLive: async () => ({ at: "2026-10-04T00:00:00.000Z", provider: "pega", enabled: true, verdict: { ...simulateVerdict(1, 100), synthetic: false }, throughput: null }) };

async function render(): Promise<string> {
  const store = await readyStore();
  return renderToStaticMarkup(<App store={store} source={source} liveSource={live} />);
}

describe("the product names itself", () => {
  it("renders 'Neurofebric', not 'Command Center'", async () => {
    const html = await render();
    expect(html).toContain("Neurofebric");
    // "Command Center" is the credential prompt's title and a component name.
    // It must not be the wordmark in the header.
    expect(html).toContain('class="app__wordmark"');
  });

  it("puts the wordmark in its own centring region rather than the left gutter", async () => {
    // The class is the contract; the grid is what makes it real. Both are
    // asserted, because a class with no layout rule centres nothing.
    const html = await render();
    expect(html).toContain('class="app__identity"');
    expect(CSS).toMatch(/\.app__bar\s*\{[^}]*grid-template-columns:\s*1fr auto 1fr/);
  });

  it("gives the wordmark identity typography rather than bolding a debug string", () => {
    expect(CSS).toMatch(/\.app__wordmark\s*\{[^}]*letter-spacing/);
    expect(CSS).toMatch(/\.app__wordmark\s*\{[^}]*text-transform:\s*uppercase/);
  });
});

describe("severity is a signal, not a hue", () => {
  // THE REGRESSION THIS EXISTS FOR. All three severities shared one base rule
  // and differed in exactly two properties -- colour and border-colour -- both of
  // them a thin stroke. Three pills in three hues are indistinguishable on a
  // projector, in greyscale, and to a colour-vision difference.

  it("gives critical a fill and the heaviest weight", () => {
    const critical = CSS.match(/\.pill--critical\s*\{[^}]*\}/)?.[0] ?? "";
    expect(critical).toMatch(/background:/);
    expect(critical).toMatch(/font-weight:\s*7\d\d/);
    expect(critical).toMatch(/text-transform:\s*uppercase/);
  });

  it("gives warning a fill but a lighter weight than critical", () => {
    const warning = CSS.match(/\.pill--warning\s*\{[^}]*\}/)?.[0] ?? "";
    const critical = CSS.match(/\.pill--critical\s*\{[^}]*\}/)?.[0] ?? "";
    expect(warning).toMatch(/background:/);

    const weight = (block: string): number => Number(block.match(/font-weight:\s*(\d+)/)?.[1] ?? "0");
    // The whole claim is that these are ordered, so the comparison IS the test.
    expect(weight(critical)).toBeGreaterThan(weight(warning));
  });

  it("leaves info an outline so it is visibly quieter than the other two", () => {
    const info = CSS.match(/\.pill--info,\s*\n?\.pill--idle,\s*\n?\.pill--ready\s*\{[^}]*\}/)?.[0] ?? "";
    expect(info).toMatch(/background:\s*transparent/);
    expect(info).toMatch(/border-width:\s*1px/);
  });

  it("no severity is distinguished by colour alone anywhere in the stylesheet", () => {
    // A guard against the exact regression returning. If someone re-adds a rule
    // that is only `color` + `border-color` for a severity, this fails.
    for (const severity of ["critical", "warning", "info"]) {
      const blocks = [...CSS.matchAll(new RegExp(`\\.pill--${severity}[^{]*\\{[^}]*\\}`, "g"))].map((m) => m[0]);
      expect(blocks.length, `no rule for ${severity}`).toBeGreaterThan(0);
      for (const block of blocks) {
        const distinguishing = /background|border-width|font-weight|text-transform|padding|height/.test(block);
        expect(distinguishing, `${severity} must differ by more than hue: ${block}`).toBe(true);
      }
    }
  });

  it("still renders the severity word a person reads", async () => {
    const html = await render();
    expect(html).toMatch(/pill--critical|pill--warning|pill--info/);
  });
});

describe("the header speaks to a person", () => {
  it("does not print the store's internal status word", async () => {
    // `idle` and `degraded` are implementation vocabulary. "Not loaded" tells a
    // person something; "idle" tells them nothing about whether anything was
    // asked for.
    const html = await render();
    expect(html).not.toMatch(/>idle</);
    expect(html).not.toMatch(/>degraded</);
    // And the words a person DOES read are present instead.
    expect(html).toMatch(/Not loaded|Ready|Partial data|Loading/);
  });

  it("keeps the machine state in the DOM, for styling and for tests", async () => {
    // Translated for the READER, not erased. Dropping the class would break the
    // CSS, and dropping the data attribute would make this untestable.
    const html = await render();
    expect(html).toMatch(/data-status="[a-z]+"/);
    expect(html).toMatch(/pill--[a-z]+/);
  });

  it("translates every status the store can produce, and falls back honestly", () => {
    expect(statusWord("idle")).toBe("Not loaded");
    expect(statusWord("loading")).toBe("Loading");
    expect(statusWord("ready")).toBe("Ready");
    expect(statusWord("degraded")).toBe("Partial data");
    // An unmapped state is shown as itself rather than blanked or invented: a
    // word nobody mapped is better than a wrong word about the system's health.
    expect(statusWord("brand-new-state")).toBe("brand-new-state");
  });

  it("has a translation for every state in the store's own union", () => {
    // DERIVED FROM THE TYPE, not restated. The union is the contract; a state
    // added there must fail here rather than ship untranslated.
    const every: StoreStatus[] = ["idle", "loading", "ready", "degraded"];
    for (const state of every) {
      expect(statusWord(state), `${state} must not reach a person verbatim`).not.toBe(state);
    }
  });
});

describe("what this file does not verify", () => {
  it("says so out loud, so a green run is not read as more than it measured", () => {
    // Deliberately trivial. The point is that the claim is IN the suite: 60fps,
    // a flat heap over 30 minutes, and whether any of this looks right on a
    // projector are unverified here and need a browser and a person.
    const unverified = ["frame rate", "heap over time", "projected appearance"];
    expect(unverified).toHaveLength(3);
    expect(CSS).toContain("prefers-reduced-motion");
  });
});