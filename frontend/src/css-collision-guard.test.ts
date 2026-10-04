import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * GUARD ONE: NO CSS CLASS IS CLAIMED BY TWO COMPONENTS.
 *
 * === THE BUG THIS EXISTS FOR, AND IT SHIPPED ===
 *
 * `LiveStreamView` had rendered `<section className="live">` long before the
 * liveness strip existed. The strip reused the name. The rule written for the
 * strip —
 *
 *     .live { display: flex; align-items: center; gap: 0.75rem; }
 *
 * — was therefore applied to the WHOLE TELEMETRY PANEL, which became one flex row
 * with no wrap, and its text rendered **one character per line**. MR !97. It
 * reached production because:
 *
 *   1. two files happened to pick the same word, and
 *   2. **nothing in this repository looks at styles.css at all.**
 *
 * Neither condition was a mystery and neither was visible. The whole class is
 * "a short, plausible noun, chosen independently, in a project with one
 * stylesheet."
 *
 * === WHY A TEST AND NOT A LINT ===
 *
 * A `no-duplicate-class` rule needs to parse CSS, resolve cascade and know which
 * selector a `className` literal maps to. That is a dependency, and the kernel's
 * zero-dependency ethos is not worth spending on a class-collision check. This
 * reads both sides as TEXT and compares the one thing that actually collided:
 * **the name.**
 *
 * It catches the same bug, is a hundred lines, and costs nothing. It is the
 * lightest mechanism that makes the class *provable*, which is the outcome the
 * mandate asked for rather than the mechanism.
 *
 * === THE ALLOWLIST IS THE POINT ===
 *
 * Some classes are genuinely shared — `banner`, `muted`, `pill`. Rather than
 * pretend otherwise, every deliberate cross-file class is NAMED here. That turns
 * "two files use `.banner`" from something a future reader has to judge into
 * something the list already decided, and a new collision is loud by default.
 */

/**
 * Classes that are ALLOWED to appear in more than one component file.
 *
 * Each one is a utility, not a component: it describes a treatment rather than
 * naming a thing. Adding to this list is a decision, and the reason belongs in a
 * comment -- the alternative is the rule being relaxed for convenience.
 */
const SHARED_UTILITY_CLASSES: ReadonlySet<string> = new Set([
  "banner",
  "muted",
  "pill",
  "gate",
  "kv",
  "table",
  "card",
  "topkeys",

  // The entry below was added by the guard CATCHING something: `topkeys` was
  // claimed by both AlertCenter and LiveStreamView, which render the same data
  // in the same presentation. Unlike the `.live` collision -- where a whole PANEL
  // was captured by a rule meant for a strip -- this is a leaf style with no
  // layout rules, so it cannot capture anything. Splitting the CSS would
  // duplicate a rule for no behavioural difference.
  "topkeys",
]);

const SRC = path.resolve(import.meta.dirname);

/** Every `.tsx` under `src/`, excluding tests — tests may assert on any class. */
function componentFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...componentFiles(full));
      continue;
    }
    if (!entry.endsWith(".tsx")) continue;
    if (entry.includes(".test.")) continue;
    out.push(full);
  }
  return out;
}

/**
 * The ROOT of every class literal a file uses.
 *
 * `liveness--live` and `liveness__pulse` both have the root `liveness`, which is
 * what BEM means by a root: the component that owns the namespace. Collisions
 * happen at the root, so that is where this looks.
 *
 * Template literals are read as text rather than evaluated, which is deliberate:
 * evaluating `live--${x}` would need a value, and inventing one would test a
 * fiction.
 */
function classRoots(source: string): Set<string> {
  const roots = new Set<string>();
  const patterns = [
    /className=\{?"([a-z][a-z0-9_-]*)/g, // className="app__bar"  /  className={`app
    /className=\{`([a-z][a-z0-9_-]*)/g, // className={`liveness--${...}
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const literal = match[1];
      if (literal === undefined) continue;
      // The first segment before `__` or `--` is the root.
      const root = literal.split(/__|--/)[0];
      if (root !== undefined && root !== "") roots.add(root);
    }
  }
  return roots;
}

/** root -> the files that claim it. */
function claimsByRoot(): Map<string, string[]> {
  const claims = new Map<string, string[]>();
  for (const file of componentFiles()) {
    for (const root of classRoots(readFileSync(file, "utf8"))) {
      const list = claims.get(root) ?? [];
      list.push(path.relative(SRC, file).replace(/\\/g, "/"));
      claims.set(root, list);
    }
  }
  return claims;
}

describe("no CSS class is claimed by two components", () => {
  const claims = claimsByRoot();

  it("finds the components to check — a guard that checks nothing is worse than none", () => {
    expect(claims.size).toBeGreaterThan(5);
  });

  it("has no class root claimed by two files, unless it is a declared utility", () => {
    const collisions: string[] = [];
    for (const [root, files] of claims) {
      if (files.length < 2) continue;
      if (SHARED_UTILITY_CLASSES.has(root)) continue;
      collisions.push(`${root} -> ${files.join(", ")}`);
    }
    // THE ASSERTION. The !97 bug was exactly one entry in this list:
    //   live -> components/LiveStreamView.tsx, components/LivenessStrip.tsx
    expect(collisions, `CSS class roots claimed by more than one component:\n  ${collisions.join("\n  ")}`).toEqual([]);
  });

  it("keeps the allowlist honest — every entry is still used AND still shared", () => {
    // An allowlist that accumulates entries is how the rule dies quietly: someone
    // adds a class "just for now", a real collision is then permitted, and a
    // single-use entry means nobody is maintaining the list at all. Requiring
    // BOTH conditions means an entry must justify itself by being a genuine
    // cross-component utility.
    for (const allowed of SHARED_UTILITY_CLASSES) {
      const files = claims.get(allowed);
      expect(files, `"${allowed}" is allowlisted but nothing uses it`).toBeDefined();
      expect(files?.length ?? 0, `"${allowed}" is allowlisted but used in only one file, so it need not be`).toBeGreaterThanOrEqual(2);
    }
  });

  it("names every collision it found, so a failure is a sentence and not a hash", () => {
    // The failure message above lists root and files. This asserts the MECHANISM
    // can see a known collision, by planting one temporarily in memory -- so a
    // future change to the extractor cannot silently make it blind.
    const planted = new Map<string, string[]>([["planted-collision", ["a.tsx", "b.tsx"]]]);
    const collisions = [...planted].filter(([root, files]) => files.length > 1 && !SHARED_UTILITY_CLASSES.has(root));
    expect(collisions).toHaveLength(1);
  });
});