import assert from "node:assert/strict";

import { DASHBOARD_DATA_ID } from "./react-report.ts";

/**
 * THE EVALUATING HARNESS, SHARED.
 *
 * Every test in this area used to hold the generated document as a STRING. That
 * is why a dashboard which threw `ReferenceError: h is not defined` on first
 * paint -- a blank page -- passed a suite of well over a thousand green tests.
 * Parse and evaluate are different claims and only one of them was being made.
 *
 * So the emitted application is EXECUTED here, against the payload the page
 * actually embeds, and the tree it builds is returned in render order.
 *
 * Two design rules make the harness trustworthy rather than merely green:
 *
 *   1. Every stub THROWS on a property it does not know. A global the app uses
 *      that nobody stubbed must fail loudly, or a stub that silently returns
 *      undefined turns an application error into a passing test -- which is
 *      precisely how the first version of this harness passed with `h` deleted.
 *   2. `render` INVOKES component functions rather than returning a
 *      placeholder. A component is only DEFINED at module scope; without calling
 *      it, not one render call site is reached and the whole tree is empty.
 *
 * React itself is stubbed. The point is to exercise this repository's own code,
 * not to re-test React.
 */

export interface FlatElement {
  readonly tag: string;
  readonly type: string | null;
  readonly ariaLabel: string | null;
  readonly placeholder: string | null;
  readonly className: string;
}

export interface EvaluateResult {
  readonly rendered: boolean;
  readonly errors: string[];
  readonly tree: FlatElement[];
}

export function appSourceOf(html: string): string {
  const open = '<script type="text/babel"';
  const start = html.indexOf(open);
  assert.ok(start > 0, "the page must carry its application as a babel script");
  const from = html.indexOf(">", start) + 1;
  return html.slice(from, html.indexOf("</script>", from));
}

export function evaluateApp(html: string): EvaluateResult {
  const src = appSourceOf(html);
  const errors: string[] = [];
  const tree: FlatElement[] = [];
  let rendered = false;

  const DATA_ID = DASHBOARD_DATA_ID;
  const openData = html.indexOf(`id="${DATA_ID}"`);
  assert.ok(openData > 0, "the page must embed its data block");
  const dataFrom = html.indexOf(">", openData) + 1;
  const payload = html.slice(dataFrom, html.indexOf("</script>", dataFrom));

  const strictElement = (name: string, text: string) => new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === "textContent") return text;
      if (prop === "addEventListener") return () => undefined;
      if (prop === "scrollTop") return 0;
      if (prop === "files") return [];
      if (prop === "value") return "";
      if (prop === "click") return () => undefined;
      if (prop === "focus") return () => undefined;
      if (prop === Symbol.toPrimitive) return () => name;
      throw new Error(`un-stubbed property ${String(prop)} on ${name}`);
    },
  });

  const documentStub = {
    getElementById: (id: string) => strictElement(id, id === DATA_ID ? payload : "{}"),
    createElement: () => strictElement("created", "{}"),
  };

  const elementStub = (type: unknown, props: unknown, ...children: unknown[]) =>
    ({ __element: true, type, props, children });

  const renderTree = (node: unknown, depth = 0): void => {
    if (depth > 60) throw new Error("the element tree did not terminate");
    if (typeof node === "function") { renderTree((node as () => unknown)(), depth + 1); return; }
    if (Array.isArray(node)) { for (const child of node) renderTree(child, depth + 1); return; }
    if (node !== null && typeof node === "object" && (node as { __element?: boolean }).__element === true) {
      const e = node as { type: unknown; props: unknown; children: unknown[] };
      if (typeof e.type === "function") {
        renderTree((e.type as (p: unknown) => unknown)(e.props), depth + 1);
        return;
      }
      const props = (e.props ?? {}) as Record<string, unknown>;
      tree.push({
        tag: typeof e.type === "string" ? e.type : "Component",
        type: typeof props.type === "string" ? props.type : null,
        ariaLabel: typeof props["aria-label"] === "string" ? (props["aria-label"] as string) : null,
        placeholder: typeof props.placeholder === "string" ? props.placeholder : null,
        className: typeof props.className === "string" ? props.className : "",
      });
      for (const child of e.children) renderTree(child, depth + 1);
    }
  };

  const reactStub = new Proxy(function () {} as unknown as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === "createElement") return elementStub;
      if (prop === "Fragment") return "Fragment";
      if (prop === "useState") return (init: unknown) => {
        const value = typeof init === "function" ? (init as () => unknown)() : init;
        return [value, () => undefined];
      };
      if (prop === "useRef") return (init: unknown) => ({ current: init ?? null });
      if (prop === "useEffect") return () => undefined;
      if (prop === "useMemo") return (fn: () => unknown) => fn();
      throw new Error(`un-stubbed React.${String(prop)}`);
    },
    apply() { return ({}); },
  });

  const reactDomStub = {
    createRoot: () => ({ render: (node: unknown) => { renderTree(node); rendered = true; } }),
  };

  const sandbox: Record<string, unknown> = {
    document: documentStub,
    React: reactStub,
    ReactDOM: reactDomStub,
    window: { location: { href: "", pathname: "/" } },
    console: { log: () => undefined, error: (...a: unknown[]) => { errors.push(String(a[0])); } },
    JSON, Math, String, Number, Object, Array, Set, Map, Date,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    fetch: () => Promise.reject(new Error("no network in this test")),
    setTimeout: () => 0, clearTimeout: () => undefined,
    navigator: { userAgent: "test" },
  };

  const names = Object.keys(sandbox);
  try {
    const fn = new Function(...names, `"use strict";\n${src}\n`);
    fn(...names.map((n) => sandbox[n]));
  } catch (error) {
    errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
  return { rendered, errors, tree };
}

/** Assert the app renders cleanly, and return its tree in render order. */
export function evaluateAppForTest(html: string): FlatElement[] {
  const { errors, tree } = evaluateApp(html);
  assert.deepEqual(errors, [],
    `the application threw while being evaluated, so the browser would too: ${errors.join(" | ")}`);
  return tree;
}