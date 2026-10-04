import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "./App";
import { LiveStreamView } from "./components/LiveStreamView";
import { SchemaStore, type PortalSource } from "./store/SchemaStore";
import { simulateVerdict } from "./api/live-contracts";
import type { AgentDescriptor, AgentSchema, PortalConfig } from "./api/contracts";
import type { LiveVerdict } from "./api/live-contracts";
import type { ReconciliationDiff } from "./api/memory-contracts";

/**
 * THE WORKSPACE GRID'S ARITY. The anti-collapse test.
 *
 * === THE DEFECT THIS EXISTS TO STOP COMING BACK ===
 *
 * `.app__main` is `grid-template-columns: minmax(0, 2fr) minmax(0, 1fr)` --
 * exactly TWO tracks. It was handed THREE direct children: the record panel, the
 * dashboard, and the live column. The third was auto-placed into an implicit
 * THIRD ROW, so the whole primary column collapsed to the height of its tallest
 * child and the two-column workspace became a stack with a stray column under
 * it.
 *
 * **A grid does not complain about this.** The layout renders. Nothing throws,
 * nothing overflows, no attribute is malformed, `tsc` is silent, and all 413
 * tests passed while the page was visibly broken. The browser resolved a
 * well-formed request into a layout nobody wanted, which is the entire reason
 * this file exists: the failure mode had NO signal except a human looking at it.
 *
 * === WHY THE FIX IS A WRAPPER AND NOT A RULE ===
 *
 * `:nth-child(3) { grid-column: 1 / -1 }` would have hidden the symptom and
 * left the cause: the next panel dropped in would land in a track nobody chose.
 * `.app__primary` makes the child count two BY CONSTRUCTION, so "a third thing
 * was added here" is now a visible extra element in the markup rather than a
 * silent reflow. The wrapper is the fix; the CSS is the consequence.
 *
 * === WHY THE GUARD CHECKS BOTH SIDES, NOT JUST ONE ===
 *
 * Asserting only on the markup would pass if someone widened
 * `grid-template-columns` to three tracks and the third child stopped wrapping.
 * Asserting only on the CSS would pass if someone deleted `.app__primary` and the
 * markup went back to three children. The layout is correct only when the track
 * count and the child count are the SAME NUMBER, and neither half of that
 * agreement is visible from the other half. So both are read here and compared.
 *
 * === WHAT IT STILL CANNOT PROVE ===
 *
 * That it looks right. `renderToStaticMarkup` does not lay out or paint, so
 * "the primary column no longer collapses" is proved here only as a structural
 * claim -- the two-column grid has two children, and that is the condition the
 * collapse required. The pixels remain the operator's eyes.
 */

const STYLES = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

const VOID_ELEMENTS = new Set([
  "br", "hr", "img", "input", "meta", "link", "source", "area", "base",
  "col", "embed", "param", "track", "wbr",
]);

/** One open tag, as far as the markup is concerned. */
interface OpenTag {
  readonly name: string;
  readonly className: string;
  readonly index: number;
  readonly length: number;
  readonly closing: boolean;
  readonly void: boolean;
}

const TAG = /<(\/?)(\w+)([^>]*?)(\/?)>/g;

/** Every open tag in the document, in order, void elements included. */
function* openTags(html: string): Generator<OpenTag> {
  for (const match of html.matchAll(TAG)) {
    const name = (match[2] ?? "").toLowerCase();
    yield {
      name,
      className: /class="([^"]*)"/.exec(match[3] ?? "")?.[1] ?? "",
      index: match.index,
      length: match[0].length,
      closing: (match[1] ?? "/") === "/",
      void: VOID_ELEMENTS.has(name) || match[4] === "/",
    };
  }
}

/** True when `cls` is a whole token of a `class` attribute value. */
function hasClass(className: string, cls: string): boolean {
  return className.split(/\s+/).includes(cls);
}

/**
 * The direct ELEMENT children of the first element carrying class `cls`.
 *
 * Walks the tag stream counting DEPTH rather than matching tag names, for two
 * reasons, both of which a regex would get wrong:
 *
 *   - A `<div>` nested inside a child is not a child. A naive match would count
 *     the record panel's inner wrapper as `.app__main`'s third child and cry
 *     wolf on a perfectly correct layout -- and a guard that cries wolf gets
 *     deleted, taking the real assertion with it.
 *   - `</section>` closes the `<div>` inside it. Depth is what knows that.
 *
 * Void elements are skipped so `<input>` does not open a depth it never closes.
 * This is not a general HTML parser and does not need to be: the input is
 * `renderToStaticMarkup` output, which is well-formed by construction.
 */
function directChildren(html: string, cls: string): OpenTag[] {
  const tags = [...openTags(html)];
  const start = tags.findIndex((tag) => !tag.closing && hasClass(tag.className, cls));
  if (start === -1) return [];

  const found: OpenTag[] = [];
  // `depth` counts the open elements we are currently INSIDE, below the parent.
  // A closing tag seen while `depth` is 0 can only be the PARENT's own close --
  // a child's close always happens at depth >= 1, and that is what tells the two
  // apart. Treating them the same would stop the walk at the first child.
  let depth = 0;
  for (const tag of tags.slice(start + 1)) {
    if (tag.void) continue;
    if (tag.closing) {
      if (depth === 0) return found; // the parent closed; we are done
      depth -= 1;
      continue;
    }
    if (depth === 0) found.push(tag);
    depth += 1;
  }
  return found;
}

const AGENT: AgentDescriptor = {
  id: "dev/sla-monitor",
  title: "SLA monitor",
  domain: "anomaly",
  maturity: "ready",
  version: "0.0.0.dev+derived",
  capabilities: ["Flags a breached service level"],
};

const SCHEMA: AgentSchema = {
  id: "sla-monitor",
  title: "SLA monitor",
  domain: "anomaly",
  version: "0.0.0.dev+derived",
  capabilities: ["Flags a breached service level"],
  streams: ["elapsed_time", "threshold"],
  rules: [{ id: "elapsed-beyond-threshold", kind: "threshold", severity: "critical", message: "Elapsed time is beyond the agreed service level", field: "elapsed_time", operator: ">", value: 1000, windowMs: 60000 }],
} as unknown as AgentSchema;

const CONFIG: PortalConfig = {
  tenant: "dev",
  title: "demo diagnostics",
  version: "0.0.0.dev+derived",
  widgets: [{ id: "w", kind: "metric", title: "Elapsed time", agentId: "dev/sla-monitor", span: "recent" }],
  forms: [{ id: "new", title: "Add an agent", fields: [{ name: "id", label: "Agent id", type: "text", required: true }] }],
  dashboards: [{ agentId: "dev/sla-monitor", title: "SLA", layout: "grid", columns: 2 }],
} as unknown as PortalConfig;

const VERDICT = { ...simulateVerdict(3, 240), synthetic: false };

/** The same verdict on a quiet feed: records held, nothing new arriving. */
const QUIET_VERDICT = { ...simulateVerdict(3, 240), synthetic: false, records: 20_000 } as LiveVerdict;

const source: PortalSource = {
  fetchActiveSchemas: async () => ({ at: "2026-10-04T09:00:00.000Z", total: 1, agents: [AGENT], ready: 1, stubCount: 0 }),
  fetchPortalConfig: async () => ({ derived: true, config: CONFIG }),
  fetchSchema: async () => SCHEMA,
} as unknown as PortalSource;

const live = {
  fetchLive: async () => ({
    at: "2026-10-04T09:00:00.000Z",
    provider: "pega",
    enabled: true,
    verdict: VERDICT,
    throughput: { records: 240, delta: 240, windowMs: 1000, eventsPerSecond: 240 },
  }),
};

/** A real difference, so the record panel actually renders. */
const DIFF: ReconciliationDiff = {
  at: "2023-11-14T22:13:20.000Z",
  source: "the record",
  tenant: "dev",
  recordVersion: 2,
  expectedVersion: 2,
  summary: "1 difference(s) to look at. Nothing has been changed for you.",
  differences: [
    {
      key: "no-live-window-yet|agent sla-monitor",
      kind: "no-live-window-yet",
      subject: "sla-monitor",
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

/**
 * The assembled page, with a store driven to a real state.
 *
 * === WHY THE RECORD PANEL IS PASSED, AND NOT `null` ===
 *
 * The first version of this fixture passed `reconciliation={null}`, and the
 * count assertion PASSED against the reintroduced three-children defect. That
 * looked like the guard working and was the opposite: with no diff the record
 * panel renders nothing, `.app__main` had two children anyway, and the exact bug
 * this file exists to catch was invisible to it. A guard that passes for the
 * wrong reason is worse than no guard, because it is trusted.
 *
 * The panel only appears when there IS a difference, so a diff is supplied. The
 * third child is now genuinely there to be counted, which is the only state in
 * which the collapse can happen at all -- and therefore the only state worth
 * asserting on.
 */
async function page(): Promise<string> {
  const store = new SchemaStore();
  await store.load(source);
  await store.loadSchema(source, "sla-monitor");
  return renderToStaticMarkup(
    <App
      store={store}
      source={source}
      liveSource={live}
      reconciliation={DIFF}
    />,
  );
}

/**
 * The same page on a QUIET feed: a zero rate with records still held.
 *
 * Unreachable through `App`, and that is a fact about the harness rather than
 * about the product: `App` fetches its live snapshot from an EFFECT, and
 * `renderToStaticMarkup` does not run effects. The assembled page above is
 * therefore permanently "Connecting", which is why the explanation is asserted
 * through `LiveStreamView` directly in the block below. Building a second
 * transport to work around it would prove less about the thing that matters --
 * the shape of the markup around `.quiet` is entirely inside this one component.
 */

describe("the workspace grid: the track count and the child count agree", () => {
  it("`.app__main` has exactly TWO direct children", async () => {
    const children = directChildren(await page(), "app__main");
    expect(children.map((child) => child.name)).toEqual(["div", "aside"]);
  });

  it("and they are the primary column and the side column, in that order", async () => {
    // Order matters as much as count. `.app__main` declares `2fr` FIRST, so a
    // swap would hand the narrow track to the record panel and the wide one to
    // the live column -- a legal two-child grid that is the wrong page.
    const children = directChildren(await page(), "app__main");
    expect(children[0]?.className).toContain("app__primary");
    expect(children[1]?.className).toContain("app__side");
  });

  it("the STYLESHEET declares exactly TWO tracks for it", () => {
    // The other half of the agreement. Two children under a three-track grid is
    // an empty column; three children under a two-track grid is the collapse.
    const rule = /^\.app__main\s*\{([^}]*)\}/m.exec(STYLES);
    expect(rule, "`.app__main` has no rule in styles.css").not.toBeNull();
    const tracks = /grid-template-columns:\s*([^;]+)/.exec(rule?.[1] ?? "")?.[1] ?? "";
    expect(tracks).toBeTruthy();
    // Two column definitions, each a `minmax(0, Nfr)`.
    expect(tracks.match(/minmax\(/g) ?? []).toHaveLength(2);
  });

  it("the primary column is a GRID, so the panels inside it keep a rhythm", () => {
    // A plain `div` wrapper would fix the arity and lose the vertical spacing
    // between the record panel and the dashboard. `gap` is what replaced the
    // margins, so the wrapper has to be able to hold a gap.
    const rule = /^\.app__primary\s*\{([^}]*)\}/m.exec(STYLES);
    expect(rule?.[1] ?? "").toMatch(/display:\s*grid/);
    expect(rule?.[1] ?? "").toMatch(/gap:/);
  });

  it("`.quiet` is NOT inside a `<dl>`, so the key/value grid cannot narrow it", () => {
    // The second half of the same rescue. `.quiet` was a `<div>` holding
    // `<dt>`/`<dd>` INSIDE the readout's `<dl>`, so the grid auto-placed a bare
    // `<div>` into the `max-content` label track and squeezed two paragraphs of
    // explanation into the width of the word "throughput".
    //
    // Rendered through `LiveStreamView` directly, because the branch needs a
    // quiet feed and `App` only ever learns its feed from an effect.
    const html = renderToStaticMarkup(
      <LiveStreamView
        verdict={{ ...QUIET_VERDICT }}
        throughput={{ records: 20_000, delta: 0, windowMs: 500, eventsPerSecond: 0 }}
        loading={false}
      />,
    );
    const quietAt = html.indexOf('<div class="quiet"');
    expect(quietAt, "the quiet-feed explanation is not in the markup at all").toBeGreaterThan(-1);

    // The readout's `<dl>` is CLOSED before `.quiet` opens. A `.quiet` inside one
    // would be auto-placed into the `max-content` label track again.
    expect(html.lastIndexOf("</dl>", quietAt)).toBeGreaterThan(html.lastIndexOf("<dl", quietAt));
  });

  it("and `.quiet` is a ONE-COLUMN grid, so the prose gets the full width", () => {
    // The CSS half. Moving the block out of the `<dl>` fixed the invalid HTML;
    // this is the other half, because it had INHERITED a two-column key/value
    // grid and would otherwise have kept squeezing the prose into the label
    // track. One explicit `1fr` rather than no declaration at all, so the block
    // cannot be re-narrowed by anything above it.
    const rule = /^\.quiet\s*\{([^}]*)\}/m.exec(STYLES);
    const body = rule?.[1] ?? "";
    expect(body, "`.quiet` has no rule in styles.css").not.toBe("");
    const columns = /grid-template-columns:\s*([^;]+)/.exec(body)?.[1] ?? "";
    expect(columns).toContain("1fr");
    expect(columns).not.toContain("max-content");
  });
});
