import { isPatternPosition, newSegment, tokenizeShell } from "./tool-paths.ts";
import { MAX_SECURITY_SCAN_DEPTH } from "./workspace.ts";

/**
 * COMMAND POSITION, for the destructive-token guard.
 *
 * §2.2 of the ledger. `destructiveCommandTokens` are matched as whole tokens
 * ANYWHERE in command text, so `grep del f` is denied: `del` is the pattern being
 * searched for, not a program being run. The queue's stated fix -- match at word
 * boundaries in "command position" -- was refused by measurement, because it
 * would ALLOW `bash -c "rm -rf /"`, `find . | xargs rm`, `find . -exec rm {} \;`
 * and `nohup rm f`. Every one of those is a real deletion.
 *
 * So this module PARSES instead of narrowing. What it is allowed to conclude is
 * deliberately tiny, and the size of the carve-out is the whole safety argument:
 *
 *   A destructive token is excused in EXACTLY ONE situation -- it sits in a
 *   PATTERN position of a recognised pattern command. Everything else keeps
 *   today's behaviour.
 *
 * Not "in command position". A token in an ordinary operand slot (`echo rm`) stays
 * DENIED, because the policy's own scope note says content arriving inside command
 * text is caught on purpose. Widening past pattern positions would un-break that
 * committed decision, which is the same objection that refused the head-only rule.
 *
 * FAIL-CLOSED RESIDUE. `classified: false` means the parser does not understand the
 * input -- an unbalanced quote, a wrapper it does not know, a truncated command, or
 * nesting past the depth cap. The caller then falls back to today's whole-text
 * rule, which is strictly MORE aggressive. The parser can therefore never turn a
 * DENY into an ALLOW by being wrong about something it did not understand; it can
 * only fail into the behaviour that already shipped.
 *
 * Bounded recursion. Wrappers nest (`timeout 5 xargs rm`), and each `-c` payload
 * and `-exec` body is a command line in its own right. The cap is
 * `MAX_SECURITY_SCAN_DEPTH` -- 12, IMPORTED, not re-declared. It is D-027's bound
 * for the other bounded scanners here, and `workspace.ts` argues at length why a
 * second literal would be how those three thresholds drifted apart in the first
 * place. Exceeding it is unclassifiable, so it denies.
 *
 * MEASUREMENT HOST: MSYS2/MinGW64, bash 5.3.15 -- NOT Linux. `sudo`, `setsid` and
 * `watch` are absent here or resolve to a Windows binary, so their option grammar
 * could not be measured and they are deliberately NOT in the table. An
 * unrecognised wrapper is unclassifiable, which denies, so the gap fails closed.
 */

/** What one measured wrapper does with the tokens before its command operand. */
interface WrapperSpec {
  /** Options that swallow the following token as their value. */
  optionsWithValue: ReadonlySet<string>;
  /** Options that consume nothing. */
  flags: ReadonlySet<string>;
  /**
   * Bare (non-option) operands consumed before the command. `timeout` eats a
   * DURATION: measured `timeout printf ...` fails with "invalid time interval",
   * which is what proves the duration is consumed rather than passed through.
   */
  bareOperands: number;
  /** `env` consumes NAME=VALUE pairs (measured: `env -i FOO=bar ...`). */
  consumesAssignments?: boolean;
}

/**
 * COMMAND_WRAPPERS. Ten entries. Every one measured on the host named above, and
 * the measured behaviour is recorded beside each rather than assumed.
 *
 * NOT in the table, and the reason each is absent matters as much as the rows
 * that are present:
 *
 *   sudo      resolves to a WINDOWS binary here, not GNU sudo. Not measurable,
 *             therefore not measured, therefore not assumed.
 *   setsid    absent from this host.
 *   watch     absent from this host.
 *
 * None of the three is guessed at. Each is unclassifiable, and unclassifiable
 * denies, so the cost of the gap is a false positive on a host where the tool is
 * not installed rather than a hole on one where it is.
 *
 * `sh -c`, `bash -c` and the `find` exec family are handled structurally rather
 * than through this table, because for them the command operand is a nested
 * command LINE (a payload, or a body up to a terminator), not an operand slot.
 */
function spec(
  optionsWithValue: readonly string[],
  flags: readonly string[],
  bareOperands = 0,
  consumesAssignments = false,
): WrapperSpec {
  return { optionsWithValue: new Set(optionsWithValue), flags: new Set(flags), bareOperands, consumesAssignments };
}

const COMMAND_WRAPPERS: ReadonlyMap<string, WrapperSpec> = new Map<string, WrapperSpec>([
  // -n -L -P -d -a -E -I each take a value; -0 -t -- take none. Measured: the
  // default with no command is `echo`, so a missing command is not an error
  // here and the operand position is still the first bare token.
  ["xargs", spec(["-n", "-L", "-P", "-d", "-a", "-E", "-I"], ["-0", "-t", "--"])],
  // `env -i` CLEARS the environment -- measured, because `env -i FOO=bar printf`
  // then fails to find printf. That is the proof the option was consumed rather
  // than passed to the child.
  ["env", spec(["-u", "-C", "-S", "--chdir", "--unset"], ["-i", "--ignore-environment"], 0, true)],
  ["nohup", spec([], ["--help", "--version"])],
  ["nice", spec(["-n"], ["--help", "--version"])],
  // stdbuf REQUIRES a mode option: measured, `stdbuf` with none exits with "you
  // must specify a buffering mode option".
  ["stdbuf", spec(["-o", "-i", "-e"], ["--help", "--version"])],
  ["timeout", spec(["-k", "-s", "--kill-after", "--signal"], ["--preserve-status", "--foreground", "--help", "--version"], 1)],
  // `-v` and `-V` consume their operand as a NAME TO QUERY, not a command to
  // run: measured, `command -v printf` prints `printf`.
  ["command", spec(["-v", "-V"], ["-p", "--help"])],
  ["exec", spec([], ["-a", "-c", "-l"])],
]);

/** Heads whose operands item 1's tables classify. Imported semantics, own list. */
const PATTERN_COMMAND_HEADS: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep", "rg", "sed", "awk", "tr"]);

/** `sh`/`bash` become nested command lines through `-c`. */
const PAYLOAD_WRAPPERS: ReadonlySet<string> = new Set(["sh", "bash"]);

/** The `find` options whose body is a nested command line. */
const FIND_EXEC_OPTIONS: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok"]);

/** `find -ok` accepts ONLY the `;` terminator; measured, `+` is an error. */
const FIND_TERMINATORS: ReadonlySet<string> = new Set([";", "+"]);

export interface CommandPositionResult {
  /**
   * Tokens that sit in a pattern position. ONLY these are exempt from the
   * destructive-token rule. Every other token keeps today's behaviour.
   */
  readonly patternTokens: ReadonlySet<string>;
  /** False when the parser cannot understand the input. The caller must fall
   *  back to today's whole-text rule. Never means "allow". */
  readonly classified: boolean;
  /** Present when `classified` is false, for the denial reason. */
  readonly reason?: string;
}

type Unclassified = { classified: false; reason: string };

/** Split on the operators that separate one command from the next. */
function splitSegments(text: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote !== "") {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if (char === "\\") {
      current += char;
      if (i + 1 < text.length) current += text[i + 1];
      i += 1;
      continue;
    }
    if (char === "|" || char === ";") {
      segments.push(current);
      current = "";
      if (char === "|" && text[i + 1] === "|") i += 1;
      continue;
    }
    if (char === "&") {
      segments.push(current);
      current = "";
      if (text[i + 1] === "&") i += 1;
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.filter((segment) => segment.trim() !== "");
}

/** An unclosed quote makes everything after it unknowable. */
function hasUnbalancedQuote(text: string): boolean {
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote !== "") {
      if (char === "\\" && quote === '"') { i += 1; continue; }
      if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') quote = char;
  }
  return quote !== "";
}

/**
 * The operands of a plain command, classified with item 1's tables.
 *
 * `newSegment` and `isPatternPosition` are IMPORTED from `tool-paths.ts` rather
 * than reimplemented, so the two layers cannot drift on what a pattern position
 * is. Item 1 pinned that logic against `path-extraction-corpus.test.ts`; this
 * corpus pins that the token guard agrees with it.
 */
function patternPositionsOf(tokens: readonly string[], headIndex: number): Set<string> {
  const pattern = new Set<string>();
  const segment = newSegment();
  segment.head = tokens[headIndex];
  for (let i = headIndex + 1; i < tokens.length; i += 1) {
    const text = tokens[i];
    if (segment.takeNextAsPattern) {
      segment.takeNextAsPattern = false;
      pattern.add(text);
      continue;
    }
    if (text.startsWith("-")) {
      if (text === "-f" || text === "--file") segment.patternFromFile = true;
      if (text === "-e" || text === "--regexp") {
        segment.expressionOption = true;
        if (segment.head !== null && GREP_FAMILY_HOLDER.has(segment.head)) segment.takeNextAsPattern = true;
      }
      continue;
    }
    if (isPatternPosition(segment, text)) {
      segment.positionalSeen = true;
      pattern.add(text);
    }
  }
  return pattern;
}

/** The grep family takes its pattern after `-e`; `sed`/`awk` do not. */
const GREP_FAMILY_HOLDER: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep", "rg"]);

/** Consume a wrapper's options and fixed operands; return the command index. */
function commandOperandIndex(
  tokens: readonly string[],
  wrapper: WrapperSpec,
  start: number,
): { index: number } | Unclassified {
  let index = start;
  let bare = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "{}") { index += 1; continue; }
    if (token.startsWith("-")) {
      // Attached values are real: measured `stdbuf -o0`, `stdbuf -oL`, and
      // `nice -10` all run the command rather than treating the value as one.
      const attached = [...wrapper.optionsWithValue]
        .find((option) => token.length > option.length && token.startsWith(option));
      if (attached !== undefined) { index += 1; continue; }
      if (wrapper.optionsWithValue.has(token)) {
        if (index + 1 >= tokens.length) return { classified: false, reason: `option '${token}' has no value` };
        index += 2;
        continue;
      }
      if (wrapper.flags.has(token)) { index += 1; continue; }
      // An option this table never measured is not an option it understands.
      return { classified: false, reason: `unmeasured option '${token}'` };
    }
    if (wrapper.consumesAssignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { index += 1; continue; }
    if (bare < wrapper.bareOperands) { bare += 1; index += 1; continue; }
    break;
  }
  return { index };
}

function parseTokens(
  tokens: readonly string[],
  depth: number,
  patternTokens: Set<string>,
): CommandPositionResult | Unclassified {
  if (depth > MAX_SECURITY_SCAN_DEPTH) {
    return { classified: false, reason: `command nesting exceeds the depth cap of ${MAX_SECURITY_SCAN_DEPTH}` };
  }
  if (tokens.length === 0) return { classified: false, reason: "empty command segment" };

  const head = tokens[0];

  // `sh -c` / `bash -c`: the payload is a command line in its own right.
  if (PAYLOAD_WRAPPERS.has(head)) {
    const cIndex = tokens.indexOf("-c", 1);
    if (cIndex === -1) {
      // `sh` with no `-c` reads a script from stdin, which is not knowable here.
      return { classified: false, reason: `'${head}' invoked without -c` };
    }
    const payload = tokens[cIndex + 1];
    if (payload === undefined) return { classified: false, reason: `-c carries no payload` };
    return parseCommandLine(payload, depth + 1, patternTokens);
  }

  // `find`'s exec options carry a nested command line as their body.
  if (head === "find") {
    for (let i = 1; i < tokens.length; i += 1) {
      if (!FIND_EXEC_OPTIONS.has(tokens[i])) continue;
      const body: string[] = [];
      let cursor = i + 1;
      for (; cursor < tokens.length; cursor += 1) {
        // `tokenizeShell` PRESERVES the backslash, so an escaped terminator
        // arrives as the two characters `\;` and never matches a plain `;`.
        // Measured: both `find . -exec ... \;` and the unescaped form are valid,
        // and `\;` is what an agent actually types.
        if (FIND_TERMINATORS.has(tokens[cursor].replace(/^\\/, ""))) break;
        if (tokens[cursor] !== "{}") body.push(tokens[cursor]);
      }
      if (cursor >= tokens.length) {
        // Measured: find reports "missing argument to '-exec'" in this shape.
        return { classified: false, reason: `'${tokens[i]}' has no terminator` };
      }
      const nested = parseTokens(body, depth + 1, patternTokens);
      if (!nested.classified) return nested;
    }
    return { patternTokens, classified: true };
  }

  const wrapper = COMMAND_WRAPPERS.get(head);
  let index = 0;
  if (wrapper !== undefined) {
    const consumed = commandOperandIndex(tokens, wrapper, 1);
    if ("classified" in consumed) return consumed;
    index = consumed.index;
  }

  const command = tokens[index];
  if (command === undefined) return { classified: false, reason: `'${head}' names no command operand` };

  // A wrapper's command operand may itself be a wrapper: `timeout 5 xargs rm`.
  if (COMMAND_WRAPPERS.has(command) || PAYLOAD_WRAPPERS.has(command) || command === "find") {
    return parseTokens(tokens.slice(index), depth + 1, patternTokens);
  }

  for (const token of patternPositionsOf(tokens, index)) patternTokens.add(token);

  // An unmeasured program head is not a claim that it is safe.
  if (!COMMAND_WRAPPERS.has(command) && !PATTERN_COMMAND_HEADS.has(command)) {
    return { classified: false, reason: `'${command}' is not a measured command or wrapper` };
  }
  return { patternTokens, classified: true };
}

/** Parse one command line, recursing through payloads and `-exec` bodies. */
export function parseCommandLine(
  text: string,
  depth = 0,
  patternTokens: Set<string> = new Set(),
): CommandPositionResult {
  if (hasUnbalancedQuote(text)) {
    return { patternTokens, classified: false, reason: "unbalanced quote" };
  }
  for (const segment of splitSegments(text)) {
    const tokens = tokenizeShell(segment).map((token) => token.text.trim()).filter((token) => token !== "");
    const parsed = parseTokens(tokens, depth, patternTokens);
    if (!parsed.classified) {
      return { patternTokens, classified: false, reason: parsed.reason };
    }
  }
  return { patternTokens, classified: true };
}