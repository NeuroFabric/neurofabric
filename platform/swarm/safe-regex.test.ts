import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_EVALUATION_BUDGET_MS,
  MAX_PROGRAM_INSTRUCTIONS,
  MAX_REPETITION,
  SafePattern,
  SafePatternError,
} from "./safe-regex.ts";

/**
 * THE NFA ENGINE, PROVEN AGAINST V8.
 *
 * === WHY THE DIFFERENTIAL TEST IS THE CENTRE OF THIS FILE ===
 *
 * A backtracking engine that can hang is a serious problem. A linear engine that
 * is subtly WRONG is a worse one, because it produces confident wrong verdicts and
 * there is no hang to notice. So the primary evidence here is not a timing
 * measurement; it is an exhaustive comparison against V8's own `RegExp` over every
 * supported construct crossed with a subject corpus chosen to hit the boundaries:
 * empty strings, one character either side of a quantifier's minimum, class edges,
 * anchors at both ends, and multi-line subjects.
 *
 * If the two ever disagree, this file fails. That is the property that makes the
 * engine trustworthy, and it is the reason the corpus below is written out in full
 * rather than generated -- a generated corpus tests the generator.
 *
 * === WHAT IS DELIBERATELY NOT CLAIMED ===
 *
 * The engine supports a SUBSET. Lookaround, backreferences, named groups, lazy and
 * possessive quantifiers, non-ASCII literals and empty alternatives are refused,
 * each with its own reason, and the tests below pin those refusals. A bounded
 * subset that cannot hang is worth more here than a complete one that can, because
 * the author sees the refusal at authoring time and can write a different pattern.
 */

/** Patterns that BOTH engines are expected to accept. */
const SUPPORTED: readonly string[] = [
  // literals
  "abc", "col_15", "a.b",
  // anchors
  "^abc", "abc$", "^abc$", "^$", "^\\s*$", "^\\w+:",
  // quantifiers
  "a*b", "a+b", "a?b", "ab?c", "a{3}", "a{2,}", "a{2,4}", "a{0,2}b", "(ab){2,3}",
  // groups and alternation
  "(ab)+", "(a|b)c", "(?:foo|bar)", "x(y|z)w", "(a|ab)(c|bcd)", "(a|b)*c",
  // character classes
  "[a-z]+", "[^a-z]+", "[A-Za-z0-9_]{3,}", "[abc-]+", "[-abc]+", "[0-9]{1,3}.[0-9]{1,3}",
  // shorthands, including their negations
  "\\d+", "\\w+", "\\s+", "\\D", "\\W", "\\S", "[^\\d]+", "\\B",
  // dot
  "a.c", ".",
  // word boundaries
  "\\bword\\b",
  // escapes
  "\\.log$", "err(or)?\\b",
  // THE REJECTED SHAPES FROM D-040.2, now permitted because they cannot backtrack
  "(a+)+", "(a*)*b", "([a-z]+)+", "(x{1,3})?y",
];

/**
 * Subjects chosen to sit ON the boundaries rather than comfortably inside them:
 * empty, single characters, one either side of every quantifier's minimum and
 * maximum, class edges, both anchor positions, and a multi-line subject.
 */
const SUBJECTS: readonly string[] = [
  "", "a", "b", "ab", "abc", "abcd", "abcde", "aaa", "aaaa", "aaaaa", "x", "xx", "xxx",
  "b", "bb", "a\nb", " x ", "xyz", "ABC", "Word", "sword", "wordy", "123", "12.34",
  "foo", "bar", "foobar", "col_15", "aXbc", "abbbc", "ababcd", "app.log", "error:",
  "ababababab", "aaaaaaaaaaaaaaaaaaaaaaaaX", "-", "_", "0", "9",
];

test("EVERY SUPPORTED PATTERN AGREES WITH V8 ON EVERY SUBJECT", () => {
  // The single most important assertion in this file.
  const disagreements: string[] = [];
  let compared = 0;

  for (const pattern of SUPPORTED) {
    const mine = SafePattern.compile(pattern);
    for (const subject of SUBJECTS) {
      const theirs = new RegExp(pattern).test(subject);
      const ours = mine.test(subject);
      compared += 1;
      if (ours !== theirs) {
        disagreements.push(`${pattern} against ${JSON.stringify(subject)}: engine ${ours}, V8 ${theirs}`);
      }
    }
  }

  assert.ok(compared > 1000, `the corpus should be large, compared only ${compared}`);
  assert.deepEqual(disagreements, [], `${disagreements.length} disagreement(s)`);
});

test("A SEEDED GENERATIVE SWEEP AGREES WITH V8 ACROSS THOUSANDS OF RANDOM PATTERNS", () => {
  // The corpus above is written, so it is only as good as what I thought to write.
  // Every bug found while building this engine was in WIRING -- an exit that went
  // nowhere, a branch that matched nothing, a closing brace the parser forgot to
  // consume -- and wiring bugs hide in COMBINATIONS no hand-written list contains.
  // So this builds patterns from the grammar itself and checks all of them.
  //
  // SEEDED, deliberately: a generative differential test that fails intermittently
  // is worse than none, because it gets rerun until it passes.
  let seed = 0x2f6e2b1;
  const random = () => {
    // mulberry32: small, fast, and reproducible from the seed above.
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

  const ATOMS = ["a", "b", "c", "x", ".", "[ab]", "[^a]", "[a-c]", "\\d", "\\w", "\\s", "\\S"];
  const QUANTS = ["", "", "*", "+", "?", "{2}", "{1,2}", "{0,2}", "{2,}"];

  const build = (depth: number): string => {
    const roll = random();
    if (depth <= 0 || roll < 0.45) return `${pick(ATOMS)}${pick(QUANTS)}`;
    if (roll < 0.65) return `(?:${build(depth - 1)}|${build(depth - 1)})`;
    if (roll < 0.80) return `(${build(depth - 1)})${pick(QUANTS)}`;
    if (roll < 0.90) return `${build(depth - 1)}${build(depth - 1)}`;
    return `^${build(depth - 1)}${build(depth - 1)}$`;
  };

  const ALPHABET = ["a", "b", "c", "x", "1", " ", "\n"];
  const subject = () => {
    const length = Math.floor(random() * 9);
    let out = "";
    for (let i = 0; i < length; i += 1) out += pick(ALPHABET);
    return out;
  };

  const disagreements: string[] = [];
  let patterns = 0;
  let comparisons = 0;
  let refused = 0;

  for (let round = 0; round < 1200; round += 1) {
    const pattern = build(3);
    let mine;
    try {
      mine = SafePattern.compile(pattern);
    } catch {
      // A refusal is a legitimate outcome of a random pattern, not a disagreement.
      refused += 1;
      continue;
    }
    patterns += 1;
    for (let i = 0; i < 8; i += 1) {
      const text = subject();
      comparisons += 1;
      if (mine.test(text) !== new RegExp(pattern).test(text)) {
        disagreements.push(`${pattern} against ${JSON.stringify(text)}`);
      }
    }
  }

  assert.ok(patterns > 800, `too few patterns compiled: ${patterns} (${refused} refused)`);
  assert.ok(comparisons > 5000, `too few comparisons: ${comparisons}`);
  assert.deepEqual(disagreements.slice(0, 10), [], `${disagreements.length} disagreement(s) of ${comparisons}`);
});

test("THE CASE-INSENSITIVE FLAG AGREES WITH V8", () => {
  const patterns = ["abc", "[a-z]+", "urgent", "a.c", "(foo|bar)"];
  const subjects = ["ABC", "AbC", "abc", "URGENT", "a.c", "FOO", "bar"];

  for (const pattern of patterns) {
    const mine = SafePattern.compile(pattern, { flags: "i" });
    for (const subject of subjects) {
      assert.equal(mine.test(subject), new RegExp(pattern, "i").test(subject), `${pattern} /i against ${subject}`);
    }
  }
});

test("THE MULTILINE FLAG AGREES WITH V8", () => {
  const patterns = ["^b", "b$", "^\\w+$", "\\s*$"];
  const subjects = ["a\nb", "b\na", "a\nb\nc", "x\ny\n"];

  for (const pattern of patterns) {
    const mine = SafePattern.compile(pattern, { flags: "m" });
    for (const subject of subjects) {
      assert.equal(mine.test(subject), new RegExp(pattern, "m").test(subject), `${pattern} /m against ${JSON.stringify(subject)}`);
    }
  }
});

test("A NESTED-QUANTIFIER PATTERN IS NOW PERMITTED, BECAUSE IT CANNOT BACKTRACK", () => {
  // The inversion of D-040.2.2: `(a+)+` was refused because V8's engine runs it in
  // time exponential in the subject. It is no longer refused because it is no
  // longer V8's engine, and refusing a pattern that is provably linear would be
  // refusing it for a reason that no longer exists.
  const pattern = SafePattern.compile("(a+)+");

  assert.equal(pattern.test("aaaaaaaaaaaaaaaaaaaaaaa"), true);
  assert.equal(pattern.test("aaaaXaaaa"), true, "the linear engine finds a match after failing the tail");
  assert.equal(pattern.test("aaaaX"), true);
});

test("A CATASTROPHIC PATTERN AGAINST A LONG SUBJECT IS FAST, NOT SLOW", () => {
  // V8 runs `(a+)+b` against 40 non-matching characters in roughly the square of
  // the subject length; against 4000 it does not return at all. Here it is a
  // single pass over the subject, so the same work is a rounding error.
  const pattern = SafePattern.compile("(a+)+b");
  const subject = `${"a".repeat(4000)}c`;

  const began = Date.now();
  const matched = pattern.test(subject);
  const elapsed = Date.now() - began;

  assert.equal(matched, false);
  assert.ok(elapsed < 500, `a linear engine took ${elapsed}ms on 4001 characters`);
});

test("MANY CATASTROPHIC PATTERTS ON A LONG SUBJECT REMAIN FAST TOGETHER", () => {
  // One fast measurement can be luck. This is the shape a platform actually
  // faces: many customer patterns, each against a large subject, on one event loop.
  const patterns = ["(a+)+b", "(a*)*c", "([a-z]+)+d", "(x+x+)+y", "(a|aa)+b", "(.*a){20}z"];
  const subject = `${"a".repeat(2000)}c`;

  const began = Date.now();
  for (const source of patterns) SafePattern.compile(source).test(subject);
  const elapsed = Date.now() - began;

  assert.ok(elapsed < 2000, `six pathological patterns took ${elapsed}ms`);
});

/* ------------------------------------------------------------------ */
/* WHAT IS SUPPORTED, STATED DIRECTLY                                  */
/* ------------------------------------------------------------------ */

test("LITERALS, CLASSES AND GROUPS BEHAVE AS A CUSTOMER WOULD EXPECT", () => {
  assert.equal(SafePattern.compile("urgent wire").test("URGENT WIRE"), false, "case matters without the flag");
  assert.equal(SafePattern.compile("urgent wire", { flags: "i" }).test("URGENT WIRE"), true);
  assert.equal(SafePattern.compile("col_[0-9]+").test("col_15"), true);
  assert.equal(SafePattern.compile("col_[0-9]+").test("col_x"), false);
  assert.equal(SafePattern.compile("(slow|timeout) ").test("request timeout after 30s"), true);
  assert.equal(SafePattern.compile("^\\d{3}-\\d{4}$").test("555-1234"), true);
  assert.equal(SafePattern.compile("^\\d{3}-\\d{4}$").test("5551234"), false, "the anchors are honoured");
});

test("A REPETITION COUNTS EXACTLY, WHICH IS THE BUG THAT STARTED THIS FILE", () => {
  // An earlier compiler let a fragment exit at its trailing match, which patch
  // cannot repoint, so a{3} compiled to a. This asserts the count is real.
  assert.equal(SafePattern.compile("a{3}").test("aa"), false);
  assert.equal(SafePattern.compile("a{3}").test("aaa"), true);
  assert.equal(SafePattern.compile("a{3}").test("aaaa"), true, "unanchored: the first three match");
  assert.equal(SafePattern.compile("^a{3}$").test("aaaa"), false, "anchored: exactly three");
  assert.equal(SafePattern.compile("^a{3}$").test("aaa"), true);
  assert.equal(SafePattern.compile("^a{2,4}$").test("a"), false);
  assert.equal(SafePattern.compile("^a{2,4}$").test("aaaaa"), false);
  assert.equal(SafePattern.compile("^a{2,}$").test("aaaaa"), true);
});

test("AN OPTIONAL RUN HAS AN EXIT, WHICH IS THE SECOND BUG THIS FILE EXISTS FOR", () => {
  // The last optional copy of a{0,2}b was wired to the outermost split, which is
  // itself unwired, so the whole pattern matched nothing. Every branch must reach
  // the continuation.
  for (const subject of ["b", "ab", "aab"]) {
    assert.equal(SafePattern.compile("^a{0,2}b$").test(subject), true, `failed on ${JSON.stringify(subject)}`);
  }
  assert.equal(SafePattern.compile("^a{0,2}b$").test("aaab"), false);
  assert.equal(SafePattern.compile("^a{0,2}c$").test("c"), true, "zero copies must still reach the exit");
});

test("AN UNANCHORED PATTERN MATCHES ANYWHERE, IN ONE PASS", () => {
  // The start thread is re-injected at every position, so an unanchored search
  // costs the same as an anchored one rather than restarting the machine per index.
  assert.equal(SafePattern.compile("bcd").test("abcde"), true);
  assert.equal(SafePattern.compile("bcd").test("xxabcdexx"), true);
  assert.equal(SafePattern.compile("xyz").test("abcde"), false);
});

test("A CARET INSIDE A CLASS IS A LITERAL, AS IN EVERY OTHER ENGINE", () => {
  assert.equal(SafePattern.compile("[^a]").test("b"), true);
  assert.equal(SafePattern.compile("[a^]").test("^"), true);
});

/* ------------------------------------------------------------------ */
/* WHAT IS REFUSED, AND WHY                                            */
/* ------------------------------------------------------------------ */

test("EVERY UNSUPPORTED CONSTRUCT IS REFUSED WITH ITS OWN REASON", () => {
  const cases: readonly (readonly [string, RegExp])[] = [
    ["a(?=b)", /lookahead/],
    ["a(?!b)", /lookahead/],
    ["(?<=a)b", /lookbehind/],
    ["(?<!a)b", /lookbehind/],
    ["(?<name>a)", /named capture/],
    ["(a)\\1", /backreference/],
    ["a*?", /lazy/],
    ["a*+", /possessive/],
    ["a{2000}", /exceeds/],
    ["a{1,2000}", /exceeds/],
    ["caf\\u00e9", /unknown escape|non-ASCII/],
    ["(|a)b", /empty alternative/],
    ["*abc", /nothing to repeat/],
    ["a**", /nothing to repeat|unsupported/],
    ["^abc$", /^$/, ],
  ];

  for (const [pattern, expected] of cases) {
    if (expected.source === "^$") continue; // anchor sanity case, handled below
    assert.throws(
      () => SafePattern.compile(pattern),
      (error: unknown) => {
        assert.ok(error instanceof SafePatternError, `${pattern} should be a SafePatternError`);
        assert.match(error.message, expected, `reason for ${pattern}`);
        return true;
      },
      `${pattern} should have been refused`,
    );
  }
});

test("A PATTERN THAT IS ONLY ANCHORS IS FINE", () => {
  // Explicit, because the refusal table above lists it and a reader deserves to
  // know which way it falls.
  assert.doesNotThrow(() => SafePattern.compile("^abc$"));
});

test("AN UNBALANCED PATTERN IS REFUSED, NOT HALF-COMPILED", () => {
  assert.throws(() => SafePattern.compile("a[b"), /character class/);
  assert.throws(() => SafePattern.compile("(ab"), /group/);
  assert.throws(() => SafePattern.compile("abc)"), /unexpected/);
  assert.throws(() => SafePattern.compile("a{2,1}"), /ends before it begins/);
  assert.throws(() => SafePattern.compile(""), /non-empty/);
});

test("A REPEATED ANCHOR IS REFUSED, BECAUSE V8 WOULD MEAN SOMETHING ELSE BY IT", () => {
  assert.throws(() => SafePattern.compile("^*"), /cannot be repeated/);
  assert.throws(() => SafePattern.compile("$+"), /cannot be repeated/);
});

test("A PATTERN THAT NEEDS MORE THAN THE PROGRAM CEILING IS REFUSED", () => {
  // The ceiling is what makes an unrolled repetition safe to accept at all.
  assert.throws(
    () => SafePattern.compile(`(a{${MAX_REPETITION}}){${MAX_REPETITION}}`),
    /instructions|simplify it/,
  );
  assert.ok(MAX_PROGRAM_INSTRUCTIONS > 0);
});

test("ONLY i AND m ARE PERMITTED, AND THE REASON FOR REFUSING g IS SPECIFIC", () => {
  assert.throws(() => SafePattern.compile("a", { flags: "g" }), /stateless/);
  assert.throws(() => SafePattern.compile("a", { flags: "s" }), /not permitted/);
  assert.doesNotThrow(() => SafePattern.compile("a", { flags: "i" }));
  assert.doesNotThrow(() => SafePattern.compile("a", { flags: "im" }));
  assert.ok(MAX_REPETITION > 0);
});

/* ------------------------------------------------------------------ */
/* THE TRIPWIRE                                                        */
/* ------------------------------------------------------------------ */

test("THE TRIPWIRE FIRES, DISABLES THE PATTERN, AND IS COUNTED", () => {
  // With a linear engine this should be unreachable, which is why it is the alarm
  // and not the door. It is tested with an injected clock so that it CAN be
  // exercised: a safety control that has never been observed firing is a control
  // nobody knows works.
  let fake = 0;
  const pattern = SafePattern.compile("a+b", {
    now: () => { fake += 1_000; return fake; },
  });

  const hit = pattern.test("aaab");

  assert.equal(hit, false);
  assert.equal(pattern.isDisabled, true);
  assert.equal(pattern.stats().timeouts, 1);
  // Once disabled the pattern short-circuits, so a rule that would burn the event
  // loop stops costing anything rather than merely being reported.
  assert.equal(pattern.test("aaab"), false);
  assert.equal(pattern.stats().tests, 1);
});

test("THE DEFAULT BUDGET IS THE ONE THE DIRECTIVE ASKED FOR", () => {
  assert.equal(DEFAULT_EVALUATION_BUDGET_MS, 50);
  const pattern = SafePattern.compile("a+b", { budgetMs: 1 });
  assert.equal(typeof pattern.stats().longestMs, "number");
});

test("STATISTICS TELL A WORKING RULE FROM AN INERT ONE", () => {
  // A customer who can see that their rule matched four thousand times can tell a
  // working rule from one that never fires, and a rule that silently never fires
  // is the single worst failure this product has.
  const pattern = SafePattern.compile("urgent");
  for (const subject of ["urgent now", "later", "urgent again", "nothing"]) pattern.test(subject);

  const stats = pattern.stats();
  assert.equal(stats.tests, 4);
  assert.equal(stats.matches, 2);
  assert.equal(stats.timeouts, 0);
  assert.equal(stats.disabled, false);
  assert.ok(stats.programSize > 0, "and the program is inspectable, which is what makes its cost knowable");
});
