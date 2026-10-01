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

/**
 * Commands that EXECUTE their payload, across shell families.
 *
 * R7. Distinct from `PAYLOAD_WRAPPERS`, which is the two wrappers this module
 * already recursed through structurally. This set is what an UNMEASURED wrapper
 * delegates to, and delegating to one of these means the payload is not inert
 * text: something will run it.
 */
const SHELL_EXECUTING: ReadonlySet<string> = new Set([
  "sh", "bash", "dash", "zsh", "ksh", "ash", "busybox",
  "cmd", "powershell", "pwsh",
]);

/**
 * The flags each family takes its payload after. Matched case-sensitively for
 * `-Command`, because PowerShell accepts both spellings and they are not the
 * same token on a case-insensitive filesystem.
 *
 * Combined forms (`sh -lc "..."`) are NOT read: `-lc` is neither flag, so its
 * payload is not recognised and the token inside it is not seen as command
 * position. That is a gap, recorded here rather than left to be discovered, and
 * it fails toward SOFT rather than toward HARD.
 */
const SHELL_PAYLOAD_FLAGS: ReadonlySet<string> = new Set([
  "-c", "/c", "-command", "-Command",
]);

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
  /**
   * Tokens that ARE the operation being run -- the command operand at some
   * nesting level, after wrappers are consumed and payloads recursed into.
   *
   * This is what the tiering reads. A token in this set is a deletion; the same
   * token anywhere else is data. Recorded even when `classified` is false,
   * because `rm notes.txt` is unclassified by design (the module's job is to
   * find PATTERN positions, not to bless commands) and is still a deletion.
   *
   * Collected across EVERY segment of a compound command, which is what makes
   * the floor hold when a later segment sits behind an unclassifiable earlier
   * one.
   */
  readonly commandTokens: ReadonlySet<string>;
  /**
   * Tokens that would be DELEGATED TO by an unmeasured wrapper -- that wrapper's
   * first bare operand, with option values skipped.
   *
   * This is R6's whole content, and it is deliberately narrower than "any token
   * under an unmeasured program". An unmeasured program might be a wrapper that
   * runs its first operand, or a leaf command that merely prints it; nothing
   * measurable here says which. The ruling fails closed, but only for the
   * operand a wrapper would actually hand control to. Widening it to every
   * operand would make a commit message hard and undo payload tiering, because
   * a VCS wrapper's operands include the message text.
   */
  readonly delegatedTokens: ReadonlySet<string>;
  /**
   * Per-segment exemptions. A compound command is several command lines joined
   * by `;`, `|` or `&&`, and each is judged on its own: a segment that could
   * not be understood forfeits only its OWN exemptions, never a sibling's.
   */
  readonly segments: readonly SegmentExemption[];
  /** False when ANY segment could not be understood. Never means "allow". */
  readonly classified: boolean;
  /** Present when `classified` is false, for the denial reason. */
  readonly reason?: string;
}

/** One compound-command segment and the exemptions it has earned. */
export interface SegmentExemption {
  /** The segment text, exactly as `splitSegments` produced it. */
  readonly text: string;
  /**
   * Tokens this segment may not be denied for. EMPTY when the segment could not
   * be understood -- fail closed for that segment alone.
   */
  readonly exempt: ReadonlySet<string>;
}

type Unclassified = { classified: false; reason: string; commandTokens: ReadonlySet<string> };

/**
 * What one segment's parse produces. `segments` belongs to the whole command
 * line, so it is built once in `parseCommandLine` and is deliberately absent
 * from every recursive step below it.
 */
type SegmentParse = { patternTokens: Set<string>; commandTokens: Set<string>; classified: true };

/**
 * The first bare operand after an unmeasured head: the program such a wrapper
 * would delegate to.
 *
 * Option values are skipped on the POSIX convention that `-X` consumes the next
 * token. That convention is NOT measured for an unmeasured program -- nothing
 * about it can be from this host -- so this is an approximation. It fails in the
 * safe direction in the case that matters: a wrapper given `-u root` skips the
 * value and still reaches its command. It UNDER-detects in the opposite case,
 * where an option genuinely takes no value and one operand too many is skipped.
 * That gap is recorded rather than papered over; closing it properly needs the
 * measurement host to move to Linux, which is Task 2.
 */
function delegatedOperand(tokens: readonly string[], start: number): string | undefined {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") return tokens[index + 1];
    if (token.startsWith("-")) {
      // An attached value (`-u=root`) has nothing after it to skip.
      if (token.includes("=")) { index += 1; continue; }
      index += 2;
      continue;
    }
    return token;
  }
  return undefined;
}

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
): { index: number } | { reason: string } {
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
        if (index + 1 >= tokens.length) return { reason: `option '${token}' has no value` };
        index += 2;
        continue;
      }
      if (wrapper.flags.has(token)) { index += 1; continue; }
      // An option this table never measured is not an option it understands.
      return { reason: `unmeasured option '${token}'` };
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
  commandTokens: Set<string>,
  delegatedTokens: Set<string>,
): SegmentParse | Unclassified {
  if (depth > MAX_SECURITY_SCAN_DEPTH) {
    return { classified: false, reason: `command nesting exceeds the depth cap of ${MAX_SECURITY_SCAN_DEPTH}`, commandTokens };
  }
  if (tokens.length === 0) return { classified: false, reason: "empty command segment", commandTokens };

  const head = tokens[0];

  // `sh -c` / `bash -c`: the payload is a command line in its own right.
  if (PAYLOAD_WRAPPERS.has(head)) {
    const cIndex = tokens.indexOf("-c", 1);
    if (cIndex === -1) {
      // `sh` with no `-c` reads a script from stdin, which is not knowable here.
      return { classified: false, reason: `'${head}' invoked without -c`, commandTokens };
    }
    const payload = tokens[cIndex + 1];
    if (payload === undefined) return { classified: false, reason: `-c carries no payload`, commandTokens };
    // The payload's own segments are not surfaced here: only the shared union
    // accumulators matter to this step, and the top-level `parseCommandLine`
    // owns the per-segment view.
    const nested = parseCommandLine(payload, depth + 1, patternTokens, commandTokens, delegatedTokens);
    if (!nested.classified) return { classified: false, reason: nested.reason ?? "unclassified payload", commandTokens };
    return { patternTokens, commandTokens, classified: true };
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
        return { classified: false, reason: `'${tokens[i]}' has no terminator`, commandTokens };
      }
      const nested = parseTokens(body, depth + 1, patternTokens, commandTokens, delegatedTokens);
      if (!nested.classified) return nested;
    }
    return { patternTokens, commandTokens, classified: true };
  }

  const wrapper = COMMAND_WRAPPERS.get(head);
  let index = 0;
  if (wrapper !== undefined) {
    const consumed = commandOperandIndex(tokens, wrapper, 1);
    if (!("index" in consumed)) return { classified: false, reason: consumed.reason, commandTokens };
    index = consumed.index;
  }

  const command = tokens[index];
  if (command === undefined) return { classified: false, reason: `'${head}' names no command operand`, commandTokens };

  // Recorded BEFORE both returns below, and before the measured-command check.
  // `rm notes.txt` is unclassified on purpose -- this module's job is to find
  // PATTERN positions, not to bless commands -- and the tiering still has to see
  // that the token is the operation. Recursion continues to carry the same set,
  // so a command found inside a wrapper or a payload lands here too.
  commandTokens.add(command);

  // A wrapper's command operand may itself be a wrapper: `timeout 5 xargs rm`.
  if (COMMAND_WRAPPERS.has(command) || PAYLOAD_WRAPPERS.has(command) || command === "find") {
    return parseTokens(tokens.slice(index), depth + 1, patternTokens, commandTokens, delegatedTokens);
  }

  for (const token of patternPositionsOf(tokens, index)) patternTokens.add(token);

  // An unmeasured program head is not a claim that it is safe.
  if (!COMMAND_WRAPPERS.has(command) && !PATTERN_COMMAND_HEADS.has(command)) {
    // R6. Nothing measurable here says whether this program is a wrapper that
    // runs its first operand or a leaf command that merely prints it, so the
    // operand it would delegate to is recorded and the matcher fails it closed.
    // Only the DELEGATED operand, never the rest: a VCS wrapper's operands
    // include its commit message, and claiming those would undo tiering.
    const delegated = delegatedOperand(tokens, index + 1);
    if (delegated !== undefined) delegatedTokens.add(delegated);
    // R7: delegating to a shell-executing command means the payload behind it
    // will RUN, so it is command position and has to be parsed as one. Without
    // this the token inside `sudo sh -c "..."` is reached by no rule at all --
    // not by delegation (which names the shell) and not by the parse (which
    // stopped here).
    if (delegated !== undefined && SHELL_EXECUTING.has(delegated)) {
      const flagIndex = tokens.findIndex(
        (t, i) => i > index && SHELL_PAYLOAD_FLAGS.has(t),
      );
      if (flagIndex !== -1 && tokens[flagIndex + 1] !== undefined) {
        parseCommandLine(tokens[flagIndex + 1], depth + 1, patternTokens, commandTokens, delegatedTokens);
      }
    }
    return { classified: false, reason: `'${command}' is not a measured command or wrapper`, commandTokens };
  }
  return { patternTokens, commandTokens, classified: true };
}

/**
 * Parse one command line, recursing through payloads and `-exec` bodies.
 *
 * PER SEGMENT, and never short-circuiting. An earlier version returned at the
 * first segment it could not classify, which cost two things at once: the
 * exemptions already earned by earlier segments were discarded, so one unrelated
 * `echo` voided a legitimate grep exemption in the same line; and every LATER
 * segment went unparsed, so a deletion behind an unclassifiable segment was
 * never identified as an operation and was softened to the survivable tier.
 *
 * Now every segment is parsed, `commandTokens` accumulates across all of them so
 * the floor holds wherever the deletion sits, and each segment carries its own
 * exemptions -- empty when that segment alone could not be understood.
 */
export function parseCommandLine(
  text: string,
  depth = 0,
  patternTokens: Set<string> = new Set(),
  commandTokens: Set<string> = new Set(),
  delegatedTokens: Set<string> = new Set(),
): CommandPositionResult {
  if (hasUnbalancedQuote(text)) {
    // No segment can be trusted, so none is offered. The caller falls back to
    // scanning the whole text, which is strictly MORE aggressive.
    return { patternTokens, commandTokens, delegatedTokens, segments: [], classified: false, reason: "unbalanced quote" };
  }
  const segments: SegmentExemption[] = [];
  let firstReason: string | undefined;
  for (const segment of splitSegments(text)) {
    // Snapshot first: whatever the parser adds for THIS segment, including via a
    // nested payload, is what this segment may be exempt for.
    const before = new Set(patternTokens);
    const tokens = tokenizeShell(segment).map((token) => token.text.trim()).filter((token) => token !== "");
    const parsed = parseTokens(tokens, depth, patternTokens, commandTokens, delegatedTokens);
    const earned = [...patternTokens].filter((token) => !before.has(token));
    segments.push({
      text: segment,
      exempt: parsed.classified ? new Set(earned) : new Set<string>(),
    });
    if (!parsed.classified && firstReason === undefined) firstReason = parsed.reason;
  }
  return {
    patternTokens,
    commandTokens,
    delegatedTokens,
    segments,
    classified: firstReason === undefined,
    reason: firstReason,
  };
}