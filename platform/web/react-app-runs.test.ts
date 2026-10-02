import test from "node:test";
import assert from "node:assert/strict";

import { toReactDashboard, DASHBOARD_DATA_ID, DASHBOARD_MOUNT_ID } from "./react-report.ts";
import { buildAnalysis } from "./react-report.test-support.ts";

const DATA_ID = DASHBOARD_DATA_ID;

/**
 * THE DASHBOARD MUST ACTUALLY RUN, NOT MERELY PARSE.
 *
 * A `ReferenceError: h is not defined` took the whole dashboard down -- blank
 * page, no charts, no chat -- and every one of the 1,075 tests in this
 * repository passed. The reason is the most important thing in this file.
 *
 * EVERY EXISTING TEST HOLDS THE DOCUMENT AS A STRING. The parse test checks the
 * emitted source does not terminate its own script element. The report tests
 * check that a column name, a role or a number appears in the payload. Those
 * are real assertions and they all held, and none of them can see a name that
 * is undefined until a JavaScript engine tries to read it. A parse test proves
 * the text is well-formed; it says nothing about whether the page runs.
 *
 * So this file EVALUATES the emitted application. The stubs below are the bare
 * minimum of the browser the code expects; anything the app touches that is not
 * here throws, which is the point -- an unstubbed global must fail loudly rather
 * than quietly pass.
 *
 * The assertion is deliberately not "no errors thrown". It is that the render
 * call HAPPENED, because a page that threw before rendering and a page that
 * rendered nothing are both "no console output" to a lazier check.
 */

const analysis = await buildAnalysis();

/** The application source, extracted the way a browser's tokenizer sees it. */
function appSourceOf(html: string): string {
  const open = '<script type="text/babel"';
  const start = html.indexOf(open);
  assert.ok(start > 0, "the page must carry its application as a babel script");
  const from = html.indexOf(">", start) + 1;
  return html.slice(from, html.indexOf("</script>", from));
}

interface EvaluateResult {
  rendered: boolean;
  errors: string[];
}

function evaluateApp(html: string): EvaluateResult {
  const src = appSourceOf(html);
  const errors: string[] = [];

  // The data block, exactly as the page embeds it.
  const openData = html.indexOf(`id="${DATA_ID}"`);
  assert.ok(openData > 0, "the page must embed its data block");
  const dataFrom = html.indexOf(">", openData) + 1;
  const payload = html.slice(dataFrom, html.indexOf("</script>", dataFrom));

  // Every stub FAILS LOUDLY on a property it does not know, so a global the
  // app uses that nobody stubbed shows up as a test failure rather than as an
  // undefined that quietly happens to be falsy.
  const strictElement = (name: string, text: string) => new Proxy({} as Record<string, unknown>, {
    get(_t, prop) {
      if (prop === "textContent") return text;
      if (prop === "addEventListener") return () => undefined;
      if (prop === "scrollTop") return 0;
      if (prop === Symbol.toPrimitive) return () => name;
      throw new Error(`un-stubbed property ${String(prop)} on ${name}`);
    },
  });

  // The REAL embedded payload, not a hand-written stand-in. An earlier version
  // returned a fixed JSON literal and the app threw reading `greeting.text`,
  // which says nothing about the app -- a page under test should be handed the
  // data that page actually carries.
  const documentStub = {
    getElementById: (id: string) => strictElement(id, id === DATA_ID ? payload : "{}"),
    createElement: () => strictElement("created", "{}"),
  };

  let rendered = false;

  /**
   * A createElement that RECORDS rather than returns a placeholder, and a
   * render that actually INVOKES the component functions.
   *
   * The first version of this file stubbed createElement to return an empty
   * object and had render() do nothing but set a flag. It passed with the `h`
   * declaration deleted -- because a component function is only DEFINED at
   * module scope, and nothing ever CALLED it, so not one of the 97 `h(...)`
   * sites was reached. A test that evaluates code without running the code is
   * the exact failure this file exists to prevent, and it committed it.
   */
  const elementStub = (type: unknown, props: unknown, ...children: unknown[]) =>
    ({ __element: true, type, props, children });

  const renderTree = (node: unknown, depth = 0): void => {
    if (depth > 40) throw new Error("the element tree did not terminate");
    if (typeof node === "function") { renderTree((node as () => unknown)(), depth + 1); return; }
    if (Array.isArray(node)) { for (const child of node) renderTree(child, depth + 1); return; }
    if (node !== null && typeof node === "object" && (node as { __element?: boolean }).__element === true) {
      const e = node as { type: unknown; props: unknown; children: unknown[] };
      // A hook-using component must render as a function, which is what makes
      // the `h` inside it actually execute.
      if (typeof e.type === "function") {
        renderTree((e.type as (p: unknown) => unknown)(e.props), depth + 1);
        return;
      }
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
    createRoot: () => ({
      render: (node: unknown) => { renderTree(node); rendered = true; },
    }),
  };

  const sandbox = {
    document: documentStub,
    React: reactStub,
    ReactDOM: reactDomStub,
    window: {},
    console: { log: () => undefined, error: (...a: unknown[]) => { errors.push(String(a[0])); } },
    JSON,
    Math,
    String,
    Number,
    Object,
    Array,
    Set,
    Map,
    Date,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    fetch: () => Promise.reject(new Error("no network in this test")),
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  };
  // `var` declarations in the source land on the sandbox object, so an
  // undefined `h` throws HERE rather than inside a browser we do not have.
  const names = Object.keys(sandbox);
  const values = names.map((n) => sandbox[n as keyof typeof sandbox]);
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(...names, `"use strict";\n${src}\n`);
    fn(...values);
  } catch (error) {
    errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
  return { rendered, errors };
}

test("the emitted application RUNS, so the dashboard is not a blank page", () => {
  const html = toReactDashboard(analysis, {});
  const { rendered, errors } = evaluateApp(html);
  assert.deepEqual(errors, [],
    `the application threw while being evaluated, so the browser would too: ${errors.join(" | ")}`);
  assert.equal(rendered, true, "and it must reach the mount call, not merely run without throwing");
});

test("the LIVE page runs too, with the chat source spliced in", () => {
  const html = toReactDashboard(analysis, { live: { path: "operations.csv" } });
  const { rendered, errors } = evaluateApp(html);
  assert.deepEqual(errors, [], `the live application threw: ${errors.join(" | ")}`);
  assert.equal(rendered, true);
});

test("the element alias is declared BEFORE anything uses it", () => {
  // The narrow assertion that names this bug directly. Ordering matters as much
  // as existence: a declaration that appears after the first call site still
  // throws, and that is not a mistake anyone makes deliberately.
  const src = appSourceOf(toReactDashboard(analysis, {}));

  const declAt = /(^|[\s;{])var\s+h\s*=\s*React\.createElement\s*;/.exec(src);
  assert.ok(declAt !== null,
    "the alias must be DECLARED, or every render call throws a ReferenceError at runtime");

  const firstCall = /(^|[^A-Za-z0-9_$.])h\s*\(/.exec(src);
  assert.ok(firstCall !== null, "the app should render through the alias at all");
  assert.ok(declAt.index < firstCall.index,
    `the alias is declared at ${declAt.index} but first used at ${firstCall.index}; ` +
    "a declaration after the first call still throws");

  // And the call sites must be many enough for this to be worth asserting.
  const calls = [...src.matchAll(/(^|[^A-Za-z0-9_$.])h\s*\(/g)];
  assert.ok(calls.length > 20,
    `expected the alias to be load-bearing across the app, found ${calls.length} call sites`);
  void DASHBOARD_MOUNT_ID;
});
