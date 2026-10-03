/**
 * SAFE PATTERNS. A linear-time matcher for customer-supplied regexes.
 *
 * === WHY THIS EXISTS, IN ONE PARAGRAPH ===
 *
 * D-040.2 recorded the limitation honestly: schema regexes were run by V8, whose
 * backtracking engine runs in time exponential in the subject length for patterns
 * like `(a+)+`, and the mitigation then was a heuristic that rejects the common
 * nested-quantifier shapes. A heuristic is a guess about a shape. This removes the
 * guess: schema patterns are no longer run by V8's backtracking engine at all, they
 * are run by the Thompson NFA below, which cannot backtrack because it never
 * backtracks.
 *
 * === WHY AN ENGINE RATHER THAN A TIMEOUT ===
 *
 * The obvious fix is a 50ms timeout around the match, and it does not work. A
 * JavaScript regex call is SYNCHRONOUS: there is no way to interrupt one, no
 * `AbortSignal` that reaches it, and no way to run it on another thread without
 * paying a structured-clone round trip per event. A "timeout" around a synchronous
 * call can only be measured AFTER the call returns, which is after the event loop
 * has already been blocked for however long the pattern wanted. So the abort the
 * directive asks for cannot be a timer, and pretending otherwise would be the one
 * thing that makes this platform look safe while being exactly as vulnerable.
 *
 * === WHAT AN NFA COSTS AND WHAT IT BUYS ===
 *
 * A Thompson NFA tracks every position a match could be in at once, so it runs in
 * O(subject x program) with no worst case to speak of. A backtracking engine is
 * faster on patterns that match immediately, and slower by an exponential factor
 * on patterns that do not. For a platform whose schemas are written by strangers
 * and applied to attacker-shaped data, the predictable one is not a trade.
 *
 * The price is a smaller language. Lookaround, backreferences and named groups are
 * REFUSED with a specific reason each, rather than silently mis-executed or
 * silently accepted-then-slow. A bounded subset that cannot hang is worth more than
 * a complete one that can, and the refusals happen at authoring time where a
 * customer can read them.
 *
 * === THE TRIPWIRE IS STILL HERE, AND IT IS NOT THE DEFENCE ===
 *
 * `SafePattern.test` measures itself and a pattern that somehow exceeds its budget
 * is disabled and reported. With an NFA that should never happen, and the header
 * says so rather than letting the reader believe the budget is what makes this
 * safe. It is the alarm, not the door.
 */

/** Hard ceiling on program size. A pattern that would exceed it is refused. */
export const MAX_PROGRAM_INSTRUCTIONS = 20_000;
/** Hard ceiling on `{n,m}`, so a repetition cannot blow the program up. */
export const MAX_REPETITION = 1000;
/** Default evaluation budget, in milliseconds. The tripwire, not the defence. */
export const DEFAULT_EVALUATION_BUDGET_MS = 50;

export interface CharSet {
  /** Membership for code units below 128. */
  readonly ascii: Uint8Array;
  /** Membership above 127, or undefined when the set is ASCII-only. */
  readonly wide?: (code: number) => boolean;
  /** True when the set is an exclusion rather than an inclusion. */
  readonly negated: boolean;
}

export class SafePatternError extends Error {
  /** Where in the pattern the problem is, so a customer is pointed at it. */
  readonly at: number;

  constructor(message: string, at: number) {
    super(`${message} (at offset ${at})`);
    this.name = "SafePatternError";
    this.at = at;
  }
}

/* ==================================================================== */
/* CHAR SETS                                                            */
/* ==================================================================== */

function emptySet(negated = false): CharSet {
  return { ascii: new Uint8Array(128), negated };
}

function addChar(set: CharSet, code: number): void {
  if (code < 128) set.ascii[code] = 1;
  // Above 127 the ASCII table cannot hold it, so such a literal is simply not
  // matchable by an ASCII-only set. Recorded rather than silently wrong: a pattern
  // with a non-ASCII literal is refused at parse time (see the literal path).
}

function addRange(set: CharSet, from: number, to: number): void {
  const start = Math.max(0, from);
  const end = Math.min(127, to);
  for (let code = start; code <= end; code += 1) set.ascii[code] = 1;
}

function matches(set: CharSet, code: number): boolean {
  const hit = code < 128 ? set.ascii[code] === 1 : false;
  return set.negated ? !hit : hit;
}

/** Case folding, done once at compile time rather than per character. */
function foldCase(set: CharSet): CharSet {
  if (set.negated) {
    // Folding an exclusion is folding its complement, so build the complement,
    // fold it, and invert. Doing it the other way round gets this subtly wrong.
    const folded = new Uint8Array(128);
    for (let code = 0; code < 128; code += 1) {
      folded[code] = set.ascii[code] === 1 ? 0 : 1;
      const other = swapCase(code);
      if (other >= 0) folded[other] = set.ascii[other] === 1 ? 0 : 1;
    }
    return { ascii: folded, negated: true };
  }
  const ascii = Uint8Array.from(set.ascii);
  for (let code = 0; code < 128; code += 1) {
    if (ascii[code] !== 1) continue;
    const other = swapCase(code);
    if (other >= 0) ascii[other] = 1;
  }
  return { ascii, ...(set.wide === undefined ? {} : { wide: set.wide }), negated: false };
}

function swapCase(code: number): number {
  if (code >= 65 && code <= 90) return code + 32;
  if (code >= 97 && code <= 122) return code - 32;
  return -1;
}

/* ==================================================================== */
/* PARSING                                                              */
/* ==================================================================== */

type Node =
  | { readonly kind: "empty" }
  | { readonly kind: "seq"; readonly parts: readonly Node[] }
  | { readonly kind: "alt"; readonly options: readonly Node[] }
  | { readonly kind: "repeat"; readonly body: Node; readonly min: number; readonly max: number }
  | { readonly kind: "char"; readonly set: CharSet }
  | { readonly kind: "assert"; readonly boundary: "^" | "$" | "b" | "B" };

/** The class shorthands, as predicates over the ASCII table. */
const CLASS_SHORTHANDS: Record<string, (code: number) => boolean> = {
  d: (code) => code >= 48 && code <= 57,
  w: (code) => (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95,
  s: (code) => code === 32 || (code >= 9 && code <= 13),
};

const LITERAL_ESCAPES: Record<string, number> = {
  n: 10, r: 13, t: 9, f: 12, v: 11, "0": 0,
};

class Parser {
  private pos = 0;
  private readonly source: string;

  // Not a parameter property: Node's strip-only type erasure cannot erase one.
  constructor(source: string) {
    this.source = source;
  }

  parse(): Node {
    const node = this.alternation();
    if (this.pos !== this.source.length) {
      throw new SafePatternError(`unexpected "${this.source[this.pos]}"`, this.pos);
    }
    return node;
  }

  private peek(): string | undefined {
    return this.source[this.pos];
  }

  private alternation(): Node {
    const options: Node[] = [this.concat()];
    while (this.peek() === "|") {
      this.pos += 1;
      options.push(this.concat());
    }
    return options.length === 1 ? options[0]! : { kind: "alt", options };
  }

  private concat(): Node {
    const parts: Node[] = [];
    while (this.pos < this.source.length) {
      const next = this.source[this.pos]!;
      if (next === "|" || next === ")") break;
      parts.push(this.quantified());
    }
    if (parts.length === 0) return { kind: "empty" };
    return parts.length === 1 ? parts[0]! : { kind: "seq", parts };
  }

  private quantified(): Node {
    const start = this.pos;
    const atom = this.atom();

    // THE QUANTIFIER TEST COMES FIRST, and the order is the whole bug this replaced.
    // Checking "is this atom an anchor?" before checking "is a quantifier next?"
    // rejects every pattern beginning with a caret, because the character after a
    // leading `^` is a literal and not a quantifier -- and a leading `^` is the
    // most ordinary thing a customer writes.
    const quantifier = this.peek();
    if (quantifier !== "*" && quantifier !== "+" && quantifier !== "?" && quantifier !== "{") {
      return atom;
    }

    if (atom.kind === "assert") {
      // `^*` is not "zero or more anchors"; it is a mistake, and V8 accepts it as
      // the latter. Refusing is kinder than silently disagreeing with the engine a
      // customer's pattern was written against.
      throw new SafePatternError("an anchor or word boundary cannot be repeated", start);
    }
    if (atom.kind === "empty") {
      throw new SafePatternError("a repetition has nothing to repeat", start);
    }

    let min: number;
    let max: number;
    if (quantifier === "*") { min = 0; max = -1; this.pos += 1; }
    else if (quantifier === "+") { min = 1; max = -1; this.pos += 1; }
    else if (quantifier === "?") { min = 0; max = 1; this.pos += 1; }
    else { ({ min, max } = this.bounded()); }

    if (this.peek() === "?") {
      throw new SafePatternError("lazy repetition is not supported; remove the trailing ?", this.pos);
    }
    if (this.peek() === "+") {
      throw new SafePatternError("possessive repetition is not supported; remove the trailing +", this.pos);
    }
    if (max !== -1 && max > MAX_REPETITION) {
      throw new SafePatternError(`a repetition of at most ${max} exceeds the ${MAX_REPETITION} limit`, start);
    }
    if (min > MAX_REPETITION) {
      throw new SafePatternError(`a repetition of at least ${min} exceeds the ${MAX_REPETITION} limit`, start);
    }
    return { kind: "repeat", body: atom, min, max };
  }

  private bounded(): { min: number; max: number } {
    const start = this.pos;
    this.pos += 1; // consume {
    const minText = this.digits();
    if (minText === "") throw new SafePatternError("expected a repetition count after {", start);
    const min = Number.parseInt(minText, 10);
    if (this.peek() === "}") {
      this.pos += 1;
      return { min, max: min };
    }
    if (this.peek() !== ",") throw new SafePatternError("expected , or } in a repetition", this.pos);
    this.pos += 1;
    const maxText = this.digits();
    if (maxText === "") {
      // The closing brace MUST be consumed here. Returning without it leaves a
      // stray `}` in the source, and the enclosing sequence then parses that brace
      // as a literal -- so `a{2,}` silently becomes `a{2,}` followed by a
      // required `}`, and the pattern stops matching anything that does not end in
      // a brace. A parser bug that adds a character to the pattern is invisible
      // from the outside, which is why it is written down here.
      if (this.peek() !== "}") throw new SafePatternError("expected } to close a repetition", this.pos);
      this.pos += 1;
      return { min, max: -1 };
    }
    const max = Number.parseInt(maxText, 10);
    if (this.peek() !== "}") throw new SafePatternError("expected } to close a repetition", this.pos);
    this.pos += 1;
    if (max < min) throw new SafePatternError(`repetition {${min},${max}} ends before it begins`, start);
    return { min, max };
  }

  private digits(): string {
    let out = "";
    while (this.pos < this.source.length && this.source[this.pos]! >= "0" && this.source[this.pos]! <= "9") {
      out += this.source[this.pos];
      this.pos += 1;
    }
    return out;
  }

  private atom(): Node {
    const start = this.pos;
    const char = this.source[this.pos]!;
    this.pos += 1;

    if (char === "(") return this.group();
    if (char === "[") return { kind: "char", set: this.charClass() };
    if (char === ".") {
      // Any character but a newline. `\n` is excluded deliberately: a rule that
      // matches across lines will fire on any field containing one.
      const set = emptySet();
      set.ascii.fill(1);
      set.ascii[10] = 0;
      return { kind: "char", set };
    }
    if (char === "^") return { kind: "assert", boundary: "^" };
    if (char === "$") return { kind: "assert", boundary: "$" };
    if (char === "\\") return this.escape();
    if (char === ")" || char === "*" || char === "+" || char === "?") {
      throw new SafePatternError(`"${char}" has nothing to repeat`, start);
    }
    return { kind: "char", set: this.literal(char, start) };
  }

  private group(): Node {
    const start = this.pos - 1;
    if (this.source.startsWith("?", this.pos)) {
      const next = this.source[this.pos + 1];
      if (next === "=" || next === "!") {
        throw new SafePatternError("lookahead is not supported", start);
      }
      if (next === "<" && (this.source[this.pos + 2] === "=" || this.source[this.pos + 2] === "!")) {
        throw new SafePatternError("lookbehind is not supported", start);
      }
      if (this.source.startsWith("?<", this.pos)) {
        throw new SafePatternError("named capture groups are not supported; a plain ( ) captures nothing here", start);
      }
      if (next === ":") {
        this.pos += 2;
      } else {
        // A bare `(?` is not a construct this engine implements. Refusing beats
        // guessing which one the author meant.
        throw new SafePatternError("unsupported group construct; use ( ) or (?: )", start);
      }
    }
    const inner = this.alternation();
    if (this.peek() !== ")") throw new SafePatternError("expected ) to close a group", this.pos);
    this.pos += 1;
    return inner;
  }

  private escape(): Node {
    const start = this.pos - 1;
    const char = this.source[this.pos];
    if (char === undefined) throw new SafePatternError("a pattern may not end with a backslash", start);
    this.pos += 1;

    if (char >= "1" && char <= "9") {
      throw new SafePatternError("backreferences are not supported", start);
    }
    if (char === "b") return { kind: "assert", boundary: "b" };
    if (char === "B") return { kind: "assert", boundary: "B" };

    const shorthand = CLASS_SHORTHANDS[char];
    if (shorthand !== undefined) return { kind: "char", set: this.fromPredicate(shorthand, false) };
    const negatedShorthand = CLASS_SHORTHANDS[char.toLowerCase()];
    if (char === char.toUpperCase() && negatedShorthand !== undefined && /[dws]/i.test(char)) {
      return { kind: "char", set: this.fromPredicate(negatedShorthand, true) };
    }
    return { kind: "char", set: this.literalCode(this.escapedChar(char, start), start) };
  }

  private charClass(): CharSet {
    const start = this.pos - 1;
    let negated = false;
    if (this.peek() === "^") { negated = true; this.pos += 1; }

    const set = emptySet(negated);
    let first = true;
    while (this.pos < this.source.length) {
      const char = this.source[this.pos]!;
      if (char === "]" && !first) { this.pos += 1; return set; }
      first = false;
      this.pos += 1;

      const low = char === "\\"
        ? this.classEscape(set, start)
        : this.checkLiteral(char, start);

      if (this.peek() === "-" && this.source[this.pos + 1] !== "]" && this.pos + 1 < this.source.length) {
        this.pos += 1;
        const next = this.source[this.pos]!;
        this.pos += 1;
        const high = next === "\\" ? this.classEscape(set, start) : this.checkLiteral(next, start);
        if (high < low) throw new SafePatternError("a character range ends before it begins", start);
        addRange(set, low, high);
        continue;
      }
      addChar(set, low);
    }
    throw new SafePatternError("expected ] to close a character class", start);
  }

  /** An escape INSIDE a class: adds a shorthand set, or returns one literal code. */
  private classEscape(set: CharSet, start: number): number {
    const char = this.source[this.pos];
    if (char === undefined) throw new SafePatternError("a pattern may not end with a backslash", start);
    this.pos += 1;
    if (char === "b") return 8; // backspace inside a class, per the usual reading
    const shorthand = CLASS_SHORTHANDS[char];
    if (shorthand !== undefined) {
      for (let code = 0; code < 128; code += 1) if (shorthand(code)) set.ascii[code] = 1;
      return -1;
    }
    return this.escapedChar(char, start);
  }

  private escapedChar(char: string, start: number): number {
    const literal = LITERAL_ESCAPES[char];
    if (literal !== undefined) return literal;
    const code = char.charCodeAt(0);
    if (code > 127) {
      // Refused rather than matched against an ASCII-only table, which would
      // silently never match and give a customer a rule that never fires.
      throw new SafePatternError("non-ASCII literals are not supported", start);
    }
    if (/[A-Za-z0-9]/.test(char)) {
      throw new SafePatternError(`unknown escape "\\${char}"`, start);
    }
    return code;
  }

  private checkLiteral(char: string, start: number): number {
    if (char.charCodeAt(0) > 127) throw new SafePatternError("non-ASCII literals are not supported", start);
    return char.charCodeAt(0);
  }

  private literal(char: string, start: number): CharSet {
    return this.literalCode(this.checkLiteral(char, start), start);
  }

  /** A single-code literal, from either a bare character or an escape. */
  private literalCode(code: number, start: number): CharSet {
    if (code > 127) throw new SafePatternError("non-ASCII literals are not supported", start);
    const set = emptySet();
    set.ascii[code] = 1;
    return set;
  }

  private fromPredicate(predicate: (code: number) => boolean, negated: boolean): CharSet {
    const set = emptySet(negated);
    for (let code = 0; code < 128; code += 1) if (predicate(code)) set.ascii[code] = 1;
    return set;
  }
}

/**
 * THE PROGRAM.
 *
 * Four opcodes and no others. `split` carries BOTH branches rather than the usual
 * two split instructions, because one instruction per branch keeps the program half
 * the size and `patch` needs a single repointable site.
 *
 * A char or assert's successor is the NEXT INSTRUCTION IN THE ARRAY. That is
 * implicit, and the simulator depends on it; see the layout invariant below.
 */
type Instruction =
  | { readonly op: "char"; readonly set: CharSet }
  | { readonly op: "split"; readonly a: number; readonly b: number }
  | { readonly op: "assert"; readonly boundary: "^" | "$" | "b" | "B" }
  | { readonly op: "match" };

/* ==================================================================== */
/* COMPILATION TO AN NFA                                                */
/* ==================================================================== */

/**
 * COMPILE TO AN NFA.
 *
 * === THE LAYOUT INVARIANT, WHICH IS THE WHOLE OF THE CORRECTNESS ARGUMENT ===
 *
 * Three rules, and every bug this class is prone to comes from breaking one:
 *
 *  1. A char or assert instruction's successor is the NEXT INSTRUCTION IN THE
 *     ARRAY. It is implicit, not stored, and the simulator relies on it: the
 *     closure never "follows" a char, it consumes one and lands on the next index.
 *
 *  2. Every fragment's EXIT is a split, because only a split can be repointed. An
 *     earlier version made a char fragment exit at its trailing match, which
 *     patch() cannot touch -- so a{3} silently became a, matching after one
 *     character instead of three. That is the whole lesson: a fragment exit that
 *     is not repointable is a fragment whose repetition count is a suggestion.
 *
 *  3. Compilation never emits match except in finish(). A program under
 *     construction has no way to succeed, so a half-built program can never be
 *     mistaken for a finished one.
 */
interface Fragment {
  /** Where a match can begin in this fragment. */
  readonly start: number;
  /** The patchable exit. */
  readonly out: number;
}

class Compiler {
  readonly program: Instruction[] = [];

  /**
   * Compile a node, or undefined when it matches only the empty string.
   *
   * `undefined` rather than a node, because an empty fragment that exists as a
   * node has to be WIRED to something, and the obvious wiring -- giving it a start
   * and an exit that are the same instruction -- makes that instruction point at
   * its own continuation. The result is a loop that matches nothing, which is how
   * a pattern like `(|a)b` silently stopped matching.
   */
  compile(node: Node): Fragment | undefined {
    switch (node.kind) {
      case "empty":
        return undefined;
      case "char": {
        const at = this.emit({ op: "char", set: node.set });
        const out = this.pass();
        return { start: at, out };
      }
      case "assert": {
        const at = this.emit({ op: "assert", boundary: node.boundary });
        const out = this.pass();
        return { start: at, out };
      }
      case "seq": {
        const parts: Fragment[] = [];
        for (const part of node.parts) {
          const fragment = this.compile(part);
          if (fragment !== undefined) parts.push(fragment);
        }
        if (parts.length === 0) return undefined;
        for (let i = 0; i < parts.length - 1; i += 1) this.patch(parts[i]!.out, parts[i + 1]!.start);
        return { start: parts[0]!.start, out: parts[parts.length - 1]!.out };
      }
      case "alt":
        return this.alternation(node.options);
      case "repeat":
        return this.repeat(node);
    }
  }

  /**
   * Alternation as a chain of splits.
   *
   * Built back to front so each option's exit points at the split that follows it,
   * and the caller patches only the outermost one.
   */
  private alternation(options: readonly Node[]): Fragment {
    const starts: number[] = [];
    const outs: number[] = [];
    for (const option of options) {
      const fragment = this.compile(option);
      if (fragment === undefined) {
        // An empty option is a branch to nowhere in particular, which is not a
        // branch a Thompson machine can express without a cycle. Refused, with a
        // reason, rather than compiled into something that matches nothing.
        throw new SafePatternError("an empty alternative is not supported; remove the empty branch", 0);
      }
      starts.push(fragment.start);
      outs.push(fragment.out);
    }
    // === THE CONSTRUCTION, AND WHY IT IS THIS SHAPE ===
    //
    // Every option's exit goes to the SHARED EXIT. That is the part that is easy to
    // get backwards: in a backtracking engine the code after an alternation is
    // reached by falling out of whichever branch matched, and it is tempting to
    // chain option i's exit into option i+1. In an NFA all branches run at once,
    // so option i+1 is already being explored from the same position -- chaining
    // the exits means a successful option re-enters the next one, and
    // `(a|ab)` then fails to match the string "a" because its own success path
    // walks into a branch that needs another character.
    //
    // The chain from option i to option i+1 is therefore the FAILURE path only:
    // it is how the machine gives up on one option and tries the next. The last
    // option gets NO split, so the chain ends rather than escaping -- wiring that
    // last branch to the exit would let the whole alternation match the empty
    // string, and an anchored pattern would succeed without consuming anything.
    const exit = this.pass();
    let chain = -1;
    for (let i = outs.length - 1; i >= 1; i -= 1) {
      chain = this.emit({ op: "split", a: starts[i]!, b: chain });
    }
    const entry = this.emit({ op: "split", a: starts[0]!, b: chain });
    for (const out of outs) this.patch(out, exit);
    return { start: entry, out: exit };
  }

  /**
   * A counted repetition, by UNROLLING.
   *
   * Unrolled rather than looped because an NFA for a counted repetition is
   * inherently a copy, and because an unrolled program is inspectable: its length
   * IS the pattern's cost, which is what the program ceiling bounds.
   *
   * Every branch of every optional copy escapes to ONE shared exit node rather
   * than to the outermost split. Pointing the last copy's exit at the outermost
   * split -- which is what an earlier version did -- leaves it pointing at a node
   * that is itself unpatched, so `a{0,2}b` matched nothing at all. Every path out
   * of a repetition must reach the same place, and that place must be a node whose
   * destination the CALLER supplies.
   */
  private repeat(node: Node & { kind: "repeat" }): Fragment | undefined {
    const { min, max, body } = node;

    const mandatoryStarts: number[] = [];
    const mandatoryOuts: number[] = [];
    for (let i = 0; i < min; i += 1) {
      const fragment = this.compile(body);
      if (fragment === undefined) return undefined;
      mandatoryStarts.push(fragment.start);
      mandatoryOuts.push(fragment.out);
      if (i > 0) this.patch(mandatoryOuts[i - 1]!, fragment.start);
    }

    if (max === -1) {
      const loopBody = this.compile(body);
      if (loopBody === undefined) return undefined;
      // One looping copy: take another, or escape. Its body returns to the loop.
      const loop = this.emit({ op: "split", a: loopBody.start, b: -1 });
      this.patch(loopBody.out, loop);
      if (mandatoryOuts.length > 0) this.patch(mandatoryOuts[mandatoryOuts.length - 1]!, loop);
      const exit = this.pass();
      // The SECOND branch, not the first. This loop node already has its first
      // branch (take another copy), and a single-branch patcher reports it as
      // "already wired" and does nothing -- leaving the loop with no way out, so
      // a-plus matched exactly one character.
      this.patchSecond(loop, exit);
      return { start: mandatoryStarts.length > 0 ? mandatoryStarts[0]! : loop, out: exit };
    }

    const optionalStarts: number[] = [];
    const optionalOuts: number[] = [];
    for (let i = min; i < max; i += 1) {
      const fragment = this.compile(body);
      if (fragment === undefined) return undefined;
      optionalStarts.push(fragment.start);
      optionalOuts.push(fragment.out);
    }
    if (optionalStarts.length === 0) {
      if (mandatoryOuts.length === 0) return undefined;
      return { start: mandatoryStarts[0]!, out: mandatoryOuts[mandatoryOuts.length - 1]! };
    }

    const exit = this.pass();
    let escape = exit;
    for (let i = optionalOuts.length - 1; i >= 0; i -= 1) {
      const entry = this.emit({ op: "split", a: optionalStarts[i]!, b: escape });
      this.patch(optionalOuts[i]!, escape);
      escape = entry;
    }
    if (mandatoryOuts.length > 0) {
      this.patch(mandatoryOuts[mandatoryOuts.length - 1]!, escape);
      return { start: mandatoryStarts[0]!, out: exit };
    }
    return { start: escape, out: exit };
  }

  private emit(instruction: Instruction): number {
    this.guard();
    this.program.push(instruction);
    return this.program.length - 1;
  }

  /** A split whose branches are filled in later. */
  private pass(): number {
    return this.emit({ op: "split", a: -1, b: -1 });
  }

  private guard(): void {
    if (this.program.length >= MAX_PROGRAM_INSTRUCTIONS) {
      throw new SafePatternError(
        `the pattern needs more than ${MAX_PROGRAM_INSTRUCTIONS} instructions; simplify it`,
        0,
      );
    }
  }

  /** Repoint a split's FIRST branch. The only patchable thing, by construction. */
  private patch(at: number, target: number): void {
    const instruction = this.program[at];
    if (instruction === undefined || instruction.op !== "split") return;
    if (instruction.a !== -1) return; // already wired
    this.program[at] = { op: "split", a: target, b: instruction.b };
  }

  /**
   * Repoint a split's SECOND branch.
   *
   * A node emitted as `split(a, -1)` has its escape deliberately left open, and it
   * is a real bug if `patch` cannot fill it: `patch` treats a node whose first
   * branch is already set as finished, which for a loop entry it always is.
   */
  private patchSecond(at: number, target: number): void {
    const instruction = this.program[at];
    if (instruction === undefined || instruction.op !== "split") return;
    if (instruction.b !== -1) return;
    this.program[at] = { op: "split", a: instruction.a, b: target };
  }

  /**
   * CLOSE THE PROGRAM: wire the exit to a trailing match and stop.
   *
   * A method rather than two calls from outside, because the entry and the
   * terminator are a matched pair, and letting a caller wire only one of them is
   * how a program ends with nowhere to go.
   */
  finish(fragment: Fragment | undefined): { program: readonly Instruction[]; start: number } {
    if (fragment === undefined) {
      // The whole pattern matches only the empty string, so the program is a
      // single match instruction and every position succeeds.
      this.emit({ op: "match" });
      return { program: this.program, start: 0 };
    }
    this.patch(fragment.out, this.program.length);
    this.emit({ op: "match" });
    return { program: this.program, start: fragment.start };
  }
}

/* ==================================================================== */
/* SIMULATION                                                           */
/* ==================================================================== */

const WORD = (code: number): boolean =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;

/** Word-ness for a boundary test. -1 means "no character", which is not a word. */
const isWord = (code: number): boolean => code >= 0 && WORD(code);


/**
 * ONE MATCH.
 *
 * Single pass, O(subject x program), and the reason is that the state list holds
 * EVERY position a match could be in at once rather than guessing one and
 * backtracking when it fails. A backtracking engine is faster when the pattern
 * matches immediately and exponentially slower when it does not; for patterns
 * written by strangers and applied to attacker-shaped data, predictable is not a
 * trade.
 *
 * === WHY THE START IS RE-INJECTED AT EVERY POSITION ===
 *
 * `test` means "does this pattern match anywhere", so a match may begin at any
 * index. Rather than restarting the machine at each position -- which would make
 * the worst case quadratic in the subject -- the start thread is added back into
 * the live set as the scan passes each index. One pass, and the cost is identical
 * to an anchored search. This is why a leading caret costs nothing to honour: the
 * caret assertion simply fails at every index after zero.
 */
function simulate(
  program: readonly Instruction[],
  subject: string,
  startIndex: number,
  multiline: boolean,
  now: () => number,
  budgetMs: number,
): { matched: boolean; timedOut: boolean } {
  const size = program.length;
  const length = subject.length;

  let current = new Uint8Array(size);
  let upcoming = new Uint8Array(size);
  const stack: number[] = [];
  const seeds: number[] = [];

  /**
   * Follow epsilon transitions into `list`.
   *
   * An explicit stack rather than recursion, twice over: the closure can be deep,
   * and recursion depth over a program a customer controls is how a stack overflow
   * gets found. The budget is checked here rather than per character, because a
   * check per character would cost more than the work it guards.
   */
  const close = (list: Uint8Array, from: number[], prev: number, at: number): boolean => {
    stack.length = 0;
    for (const state of from) {
      if (list[state] === 1) continue;
      list[state] = 1;
      stack.push(state);
    }
    while (stack.length > 0) {
      if (now() - scanStartedAt > budgetMs) return false;
      const here = stack.pop()!;
      const instruction = program[here]!;
      if (instruction.op === "split") {
        if (instruction.a >= 0 && list[instruction.a] !== 1) { list[instruction.a] = 1; stack.push(instruction.a); }
        if (instruction.b >= 0 && list[instruction.b] !== 1) { list[instruction.b] = 1; stack.push(instruction.b); }
        continue;
      }
      if (instruction.op === "assert") {
        if (!holds(instruction.boundary, prev, subject, at, multiline)) continue;
        // The successor is implicit: the next instruction in the array.
        const next = here + 1;
        if (next < size && list[next] !== 1) { list[next] = 1; stack.push(next); }
      }
      // char and match are terminals for this step. A char waits to consume, and a
      // match is found by the scan below.
    }
    return true;
  };

  const scanStartedAt = now();
  const scanStart = scanStartedAt;

  if (!close(current, [startIndex], -1, 0)) return { matched: false, timedOut: true };

  for (let index = 0; index <= length; index += 1) {
    if (index > 0) {
      // Re-inject the start thread so a match may begin here. One pass, any index.
      if (!close(current, [startIndex], subject.charCodeAt(index - 1), index)) {
        return { matched: false, timedOut: true };
      }
    }
    for (let state = 0; state < size; state += 1) {
      if (current[state] === 1 && program[state]!.op === "match") return { matched: true, timedOut: false };
    }
    if (index === length) break;

    const code = subject.charCodeAt(index);
    seeds.length = 0;
    for (let state = 0; state < size; state += 1) {
      if (current[state] !== 1) continue;
      const instruction = program[state]!;
      if (instruction.op !== "char") continue;
      if (!matches(instruction.set, code)) continue;
      // Land on the implicit successor, which is what a consumed char leads to.
      const next = state + 1;
      if (next < size) seeds.push(next);
    }

    upcoming.fill(0);
    if (!close(upcoming, seeds, code, index + 1)) return { matched: false, timedOut: true };

    const swap = current;
    current = upcoming;
    upcoming = swap;
  }

  return { matched: false, timedOut: now() - scanStart > budgetMs };
}

function holds(
  boundary: "^" | "$" | "b" | "B",
  prev: number,
  subject: string,
  at: number,
  multiline: boolean,
): boolean {
  const next = at < subject.length ? subject.charCodeAt(at) : -1;
  switch (boundary) {
    case "^":
      return multiline ? prev === 10 || prev === -1 : prev === -1;
    case "$":
      return multiline ? next === 10 || next === -1 : next === -1;
    case "b":
      return isWord(prev) !== isWord(next);
    case "B":
      return isWord(prev) === isWord(next);
  }
}


/* ==================================================================== */
/* THE PUBLIC SURFACE                                                   */
/* ==================================================================== */

export interface SafePatternOptions {
  /** "i" folds case at compile time; "m" makes ^ and $ match at line ends. */
  readonly flags?: string;
  readonly budgetMs?: number;
  readonly now?: () => number;
}

export interface SafePatternStats {
  readonly tests: number;
  readonly matches: number;
  /** Evaluations that exceeded the budget. Should be zero: see the header. */
  readonly timeouts: number;
  /** True once the tripwire fired; further tests short-circuit to false. */
  readonly disabled: boolean;
  readonly longestMs: number;
  readonly programSize: number;
}

/**
 * A COMPILED, CUSTOMER-SUPPLIED PATTERN.
 *
 * State is three counters and a clock, and the counters exist for the portal: a
 * customer who can see that one of their rules matched four thousand times can
 * tell a working rule from an inert one, and a rule that silently never fires is
 * the single worst failure this product has.
 */
export class SafePattern {
  readonly source: string;
  private readonly program: readonly Instruction[];
  private readonly start: number;
  private readonly multiline: boolean;
  private readonly budgetMs: number;
  private readonly now: () => number;
  private tests = 0;
  private matches = 0;
  private timeouts = 0;
  private longestMs = 0;
  private disabled = false;

  // Explicit fields rather than parameter properties: Node's strip-only type
  // erasure cannot erase the latter, and this repository has been reminded of that
  // more times than it should have needed to be.
  private constructor(
    source: string,
    program: readonly Instruction[],
    start: number,
    options: SafePatternOptions,
  ) {
    this.source = source;
    this.program = program;
    this.start = start;
    this.multiline = (options.flags ?? "").includes("m");
    this.budgetMs = options.budgetMs ?? DEFAULT_EVALUATION_BUDGET_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Compile a pattern, or throw a `SafePatternError` explaining precisely why not. */
  static compile(pattern: string, options: SafePatternOptions = {}): SafePattern {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new SafePatternError("a pattern must be a non-empty string", 0);
    }
    const flags = options.flags ?? "";
    for (const flag of flags) {
      if (flag !== "i" && flag !== "m") {
        throw new SafePatternError(
          `flag "${flag}" is not permitted; use i or m. Matching is stateless, so g has no meaning`,
          0,
        );
      }
    }
    const node = new Parser(pattern).parse();
    if (flags.includes("i")) foldNode(node);

    const compiler = new Compiler();
    const { program, start } = compiler.finish(compiler.compile(node));
    return new SafePattern(pattern, program, start, options);
  }

  /** Does this subject contain a match? One pass, bounded, no backtracking. */
  test(subject: string): boolean {
    if (this.disabled) return false;
    this.tests += 1;
    const began = this.now();
    const outcome = simulate(this.program, subject, this.start, this.multiline, this.now, this.budgetMs);
    const elapsed = this.now() - began;
    if (elapsed > this.longestMs) this.longestMs = elapsed;
    if (outcome.timedOut) {
      // The alarm, not the door. With an NFA this should be unreachable; if it ever
      // fires, the pattern is DISABLED rather than merely reported, because a rule
      // that burns the event loop is worse than a rule that does not run.
      this.timeouts += 1;
      this.disabled = true;
      return false;
    }
    if (outcome.matched) this.matches += 1;
    return outcome.matched;
  }

  stats(): SafePatternStats {
    return {
      tests: this.tests,
      matches: this.matches,
      timeouts: this.timeouts,
      disabled: this.disabled,
      longestMs: this.longestMs,
      programSize: this.program.length,
    };
  }

  get isDisabled(): boolean {
    return this.disabled;
  }
}

/** Case-fold an AST in place, once, at compile time. */
function foldNode(node: Node): void {
  switch (node.kind) {
    case "char":
      (node as { set: CharSet }).set = foldCase(node.set);
      return;
    case "seq":
      for (const part of node.parts) foldNode(part);
      return;
    case "alt":
      for (const option of node.options) foldNode(option);
      return;
    case "repeat":
      foldNode(node.body);
      return;
    case "empty":
    case "assert":
      return;
  }
}
