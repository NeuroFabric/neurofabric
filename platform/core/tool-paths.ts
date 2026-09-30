import { scanPathCandidates, MAX_SECURITY_SCAN_DEPTH, newScanState, type CandidateScan, type ScanState, type StringScan } from "./workspace.ts";
import type { ToolDescriptor } from "./types.ts";

/**
 * Which strings in a tool input are actually filesystem paths.
 *
 * This module answers that question, and nothing else. Deciding whether a
 * genuine path may be touched is the job of `WorkspaceBoundary`; this file
 * only decides what counts as a path in the first place.
 *
 * The distinction matters. A tool call payload mixes genuine paths with
 * document content, search patterns, regular expressions, URLs and shell
 * syntax. Treating every one of them as a path made the boundary deny
 * ordinary work, because a slash in prose is not a path.
 *
 * Two rules, and only two:
 *
 *   1. A structured tool has a schema. Path operands come from arguments whose
 *      names say they carry a path. A content or pattern argument is data and
 *      is never a path source, however much it looks like one.
 *   2. A shell tool's payload is a command line. Operands come from a
 *      quote-aware tokenizer, so flags, assignments, URLs and non-path words
 *      are not mistaken for locations.
 *
 * A tool with no usable schema falls back to the older conservative scan. That
 * fallback is deliberate: an unclassifiable tool must still be protected.
 */

/** Tools whose input is a command line rather than a structured payload. */
const SHELL_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "powershell",
  "pwsh",
  "cmd",
  "run",
  "exec",
  "terminal",
]);

/** Argument names that carry an actual filesystem path. */
const PATH_PARAM_NAMES: ReadonlySet<string> = new Set([
  "path",
  "filePath",
  "file_path",
  "filename",
  "fileName",
  "dir",
  "directory",
  "cwd",
  "output",
  "outputPath",
  "outDir",
  "outputDir",
  "target",
  "destination",
  "dest",
  "baseDir",
  "root",
  "from",
  "to",
  "source",
  "sources",
  "paths",
  "files",
]);

/**
 * Argument names whose value is a command line.
 *
 * Only these are scanned for destructive and credential patterns on a
 * structured tool. A file's content is data: writing text is not running it.
 */
export const COMMAND_PARAM_NAMES: ReadonlySet<string> = new Set([
  "command",
  "cmd",
  "script",
  "shell",
  "shellCommand",
  "args",
  "argv",
]);

/**
 * Device nodes, which are not workspace paths.
 *
 * These are skipped only when they are the target of a redirection, because
 * that is the one position where the path names a device rather than a file.
 * As an ordinary argument they are still real paths and are still checked.
 */
const DEVICE_PATHS: ReadonlySet<string> = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/stdin",
  "/dev/tty",
  "NUL",
  "nul",
  "CON",
  "con",
  "PRN",
  "AUX",
  "COM1",
  "LPT1",
]);

const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;
const VARIABLE_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PERCENT_ENCODED = /%[0-9A-Fa-f]{2}/;

/**
 * Commands whose leading arguments are patterns or scripts rather than paths.
 *
 * `grep PATTERN FILE` does take file operands, so a blanket "skip everything
 * after a pattern-taking command" rule would be fail-open. Only the positions
 * below are pattern positions; every other operand of the same command is
 * still checked, so `grep pattern /etc/passwd` remains a violation.
 */
const PATTERN_COMMANDS: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep", "rg", "sed", "awk", "tr"]);

/** The grep family takes its pattern after `-e`; `sed`/`awk` do not. */
const GREP_FAMILY: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep", "rg"]);

/** What is known about the command segment currently being classified. */
interface PatternSegment {
  /** The pattern-taking command of this segment, once one has been seen. */
  head: string | null;
  /** True once `-f` was seen: the pattern is a file, so every operand is one. */
  patternFromFile: boolean;
  /** True once `-e` was seen: the pattern or script is already supplied. */
  expressionOption: boolean;
  /** True while the next token is the value of a `-e`/`--regexp` option. */
  takeNextAsPattern: boolean;
  /** True once this command's first positional has been classified. */
  positionalSeen: boolean;
}

function newSegment(): PatternSegment {
  return {
    head: null,
    patternFromFile: false,
    expressionOption: false,
    takeNextAsPattern: false,
    positionalSeen: false,
  };
}

/**
 * Whether `token` sits in a pattern position of `segment` and must therefore
 * never be treated as a path operand. A pattern is a string, whatever it
 * contains, so this is decided by position and never by token shape.
 */
function isPatternPosition(segment: PatternSegment, token: string): boolean {
  if (segment.head === null) return false;
  /** `tr` has no file operand: every non-option token is a character set. */
  if (segment.head === "tr") return true;
  /** With `-f` the pattern is a file, so every positional is a file. */
  if (segment.patternFromFile) return false;
  /** With `-e` the pattern is already supplied, so positionals are files. */
  if (segment.expressionOption) return false;
  /** Only the FIRST positional is a pattern; the rest are files. */
  if (segment.positionalSeen) return false;
  return true;
}

/** How an operand was discovered. Useful in traces and in operator-facing errors. */
export type PathOperandKind = "schema" | "shell";

export interface PathOperand {
  value: string;
  /** The argument or field the operand came from. */
  origin: string;
  kind: PathOperandKind;
}

export function isShellTool(tool: Pick<ToolDescriptor, "name">): boolean {
  return SHELL_TOOLS.has(tool.name.toLowerCase());
}

/** True for device nodes such as the null device and the file-descriptor tree. */
export function isDevicePath(value: string): boolean {
  if (DEVICE_PATHS.has(value)) return true;
  return value.startsWith("/dev/fd/");
}

/**
 * Whether a token names a filesystem location.
 *
 * This is intentionally permissive for shell operands, because a shell operand
 * really is an argument rather than prose: `deploy/prod.env` is a path even
 * though it is also a plausible word. The containment check downstream is what
 * decides whether resolving it is safe.
 */
function looksLikePath(token: string): boolean {
  if (token === "") return false;
  if (token.includes("://")) return false;
  if (token.startsWith("/") || token.startsWith("~")) return true;
  if (WINDOWS_DRIVE.test(token)) return true;
  if (token.startsWith("./") || token.startsWith("../")) return true;
  if (token.startsWith(".\\") || token.startsWith("..\\")) return true;
  return token.includes("/") || token.includes("\\");
}

interface ShellToken {
  text: string;
  /** True when this token is the target of a redirection, for example after `>`. */
  redirectTarget: boolean;
}

function isOperatorChar(char: string): boolean {
  return char === "|" || char === "&" || char === ";" || char === "<" || char === ">" || char === "(" || char === ")";
}

/**
 * Split a command line into tokens, tracking quoting, escaping and
 * redirection targets.
 *
 * This is not a shell. It does not expand variables, globs, aliases or
 * functions, and it does not try to. It models just enough grammar to tell an
 * argument from syntax, which is all the boundary needs; the limits are
 * documented as residual limitations rather than papered over.
 *
 * Backslashes are preserved rather than consumed, so a Windows path such as
 * `C:\Users\dev` survives tokenisation intact. Inside double quotes a
 * backslash still escapes the characters where a shell would.
 */
export function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
  let started = false;
  let quote = "";
  let pendingRedirect = false;

  const push = (): void => {
    if (!started) return;
    tokens.push({ text: current, redirectTarget: pendingRedirect });
    pendingRedirect = false;
    current = "";
    started = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (quote !== "") {
      if (char === "\\" && quote === '"') {
        const next = index + 1 < command.length ? command[index + 1] : "";
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          current += next;
          started = true;
          index += 1;
          continue;
        }
        current += char;
        started = true;
        continue;
      }
      if (char === quote) {
        quote = "";
        continue;
      }
      current += char;
      started = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }

    if (char === "\\") {
      current += char;
      started = true;
      if (index + 1 < command.length) {
        current += command[index + 1];
        index += 1;
      }
      continue;
    }

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      push();
      continue;
    }

    if (isOperatorChar(char)) {
      push();
      pendingRedirect = char === "<" || char === ">";
      continue;
    }

    if (char === "$" && command[index + 1] === "(") {
      /** Command substitution: the inner text is itself a command line, so it
       * is scanned as one rather than discarded. */
      started = true;
      continue;
    }

    current += char;
    started = true;
  }

  push();
  return tokens;
}

function decodeOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * A token made only of shell meaning can never be a location.
 *
 * Two shapes reach here and neither is a path:
 *
 *   `\;`  The tokenizer's backslash branch (below) consumes the escape and the
 *         character after it as ONE token, so an escaped terminator arrives as
 *         the two characters `\;` and never meets `isOperatorChar`, which is
 *         what classifies a bare `;`. It then reaches `looksLikePath` and is
 *         judged as a location.
 *
 *   a quoted multi-line blob. Inside quotes the tokenizer accumulates
 *         everything, newlines included, so an inline script becomes a single
 *         token — and a single token containing several lines of code is not a
 *         filesystem path on any platform.
 *
 * This rule only ever REMOVES candidates, so it cannot introduce a new
 * permission; it can only stop denying commands that never named a location.
 * The MUST-DENY corpus in `platform/pi/path-extraction-corpus.test.ts` is the
 * net: a token that genuinely escapes the root does not match either pattern,
 * because a real path contains ordinary path characters.
 *
 * A redirection target is not exempted here and does not need to be: `out.txt`
 * is not made of syntax characters, so it never matches. Only tokens that are
 * ENTIRELY syntax — `\;`, `&&`, `{}`, `|` — are dropped.
 */
const SHELL_SYNTAX_TOKEN = /^[\s\\;|&\/<>(){}[\]]+$/;
const CONTAINS_LINE_BREAK = /[\n\r]/;

function isShellSyntaxToken(text: string): boolean {
  return SHELL_SYNTAX_TOKEN.test(text) || CONTAINS_LINE_BREAK.test(text);
}

function extractFromCommand(command: string, origin: string, into: Map<string, PathOperand>): void {
  /** How the command segment being read is classified. */
  let segment = newSegment();

  for (const token of tokenizeShell(command)) {
    const text = token.text.trim();
    if (text === "") continue;
    if (VARIABLE_ASSIGNMENT.test(text)) continue;
    if (text.includes("://")) continue;
    if (isShellSyntaxToken(text)) continue;
    if (token.redirectTarget && isDevicePath(text)) continue;

    /** The value of `-e`/`--regexp` is a pattern, never a location. */
    if (segment.takeNextAsPattern) {
      segment.takeNextAsPattern = false;
      continue;
    }

    if (text.startsWith("-")) {
      if (text === "-f" || text === "--file") segment.patternFromFile = true;
      if (text === "-e" || text === "--regexp") {
        segment.expressionOption = true;
        if (segment.head !== null && GREP_FAMILY.has(segment.head)) segment.takeNextAsPattern = true;
      }
      continue;
    }

    /** `tokenizeShell` emits no token for `|`, `;` or `&&`, so a following
     * command is recognised by name: a pattern-taking command appearing after
     * the current one has taken its positional begins the next segment. */
    if (PATTERN_COMMANDS.has(text) && (segment.head === null || segment.positionalSeen)) {
      segment = newSegment();
      segment.head = text;
      /** The command's own name is not one of its operands. */
      continue;
    }

    /** A redirection target is an operand of the shell, not of the command,
     * so it is never a pattern position and is always checked. */
    if (!token.redirectTarget && isPatternPosition(segment, text)) {
      segment.positionalSeen = true;
      continue;
    }
    if (looksLikePath(text)) {
      into.set(text, { value: text, origin, kind: "shell" });
      continue;
    }

    /** A token such as %2e%2e%2fsecret.txt hides a traversal. Decoding it
     * can only ever add a candidate, never remove one, so this fails closed. */
    const decoded = PERCENT_ENCODED.test(text) ? decodeOnce(text) : text;
    if (decoded !== text && looksLikePath(decoded)) {
      into.set(decoded, { value: decoded, origin, kind: "shell" });
    }
  }
}

/**
 * Inspect the items of an array argument.
 *
 * An array can carry a path in three different ways, and all three are
 * inspected here:
 *
 *   1. directly, as strings, when the array itself is a path-bearing name
 *      (`{ paths: ["a", "b"] }`);
 *   2. inside the objects it contains, however deeply nested
 *      (`{ targets: [{ path: "a" }] }`);
 *   3. through further arrays (`{ paths: [["a"]] }`).
 *
 * Case 2 is the one that was previously invisible. `collectFromObject` recursed
 * into a nested object but returned early on an array, so the same logical
 * structure was inspectable or invisible depending only on whether it was
 * wrapped in brackets. Objects inside an array are now walked on exactly the
 * same terms as an object outside one.
 *
 * Only strings sitting under a path-bearing name are taken directly. An array
 * under some other name contributes its objects, and leaves that are not under
 * a path-bearing name are not paths.
 */
/** The outcome of a bounded path scan: what was found, and whether it finished. */
export type PathScan = CandidateScan;

function collectFromArray(
  items: readonly unknown[],
  key: string,
  origin: string,
  depth: number,
  into: Map<string, PathOperand>,
  state: ScanState,
): void {
  if (depth > MAX_SECURITY_SCAN_DEPTH) {
    state.truncated = true;
    return;
  }
  const direct = PATH_PARAM_NAMES.has(key);

  for (const item of items) {
    if (typeof item === "string") {
      if (direct && item.trim() !== "") {
        into.set(item, { value: item, origin, kind: "schema" });
      }
      continue;
    }
    if (item === null || typeof item !== "object") continue;
    if (Array.isArray(item)) {
      // A further array keeps the enclosing name, so `paths: [[x]]` still
      // yields `x` rather than dropping it.
      collectFromArray(item, key, origin, depth + 1, into, state);
      continue;
    }
    collectFromObject(item, origin, depth + 1, into, state);
  }
}

/** Pull path operands out of a structured payload, by argument name. */
function collectFromObject(value: unknown, origin: string, depth: number, into: Map<string, PathOperand>, state: ScanState): void {
  if (depth > MAX_SECURITY_SCAN_DEPTH) {
    // Truncation is recorded, not swallowed. A caller that ignored this flag
    // would read the empty result as "no paths here" and allow the call.
    state.truncated = true;
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (typeof nested === "string") {
      if (PATH_PARAM_NAMES.has(key) && nested.trim() !== "") {
        into.set(nested, { value: nested, origin, kind: "schema" });
        continue;
      }
      if (COMMAND_PARAM_NAMES.has(key)) {
        extractFromCommand(nested, key, into);
      }
      continue;
    }

    if (Array.isArray(nested)) {
      collectFromArray(nested, key, origin, depth, into, state);
      continue;
    }

    collectFromObject(nested, origin, depth + 1, into, state);
  }
}

/** Add the decoded form of any percent-encoded operand, for checking as well. */
function expandEncoded(candidates: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const candidate of candidates) {
    expanded.add(candidate);
    if (!PERCENT_ENCODED.test(candidate)) continue;
    const decoded = decodeOnce(candidate);
    if (decoded !== candidate) expanded.add(decoded);
  }
  return [...expanded];
}

/**
 * The path operands of a tool call, and nothing else.
 *
 * Containment of these operands is decided by the caller through
 * `WorkspaceBoundary.checkCandidates`.
 */
export function scanToolPathCandidates(
  tool: Pick<ToolDescriptor, "name" | "inputSchema">,
  input: unknown,
): PathScan {
  const found = new Map<string, PathOperand>();
  const state: ScanState = newScanState();

  if (isShellTool(tool)) {
    if (input !== null && typeof input === "object") {
      for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (typeof value !== "string") continue;
        if (key === "cwd" || key === "description") continue;
        if (PATH_PARAM_NAMES.has(key)) {
          if (value.trim() !== "") found.set(value, { value, origin: key, kind: "schema" });
          continue;
        }
        extractFromCommand(value, key, found);
      }
    }
    return { candidates: expandEncoded([...found.keys()]), truncated: state.truncated };
  }

  const schema = tool.inputSchema === null || typeof tool.inputSchema !== "object" ? undefined : tool.inputSchema;
  const properties = schema === undefined ? undefined : (schema as Record<string, unknown>).properties;

  if (properties !== null && typeof properties === "object") {
    collectFromObject(input, "schema", 0, found, state);
    return { candidates: expandEncoded([...found.keys()]), truncated: state.truncated };
  }

  /** No schema to reason from: keep the old conservative behaviour rather
   * than silently deciding that a tool has no paths at all.
   *
   * The name-based pass runs first so that a well-formed `path` argument is
   * kept WHOLE. Without it, the tokenizer below splits every string on
   * whitespace, which corrupts a legitimate path containing a space into a
   * truncated prefix (`C:\Users\Jane Doe\x` -> `C:\Users\Jane`) and that bogus
   * candidate is then denied as a boundary escape. The tokenizer still runs
   * over everything it did not consume, so the fallback stays fail-closed. */
  collectFromObject(input, "heuristic", 0, found, state);
  const consumed = new Set([...found.values()].map((operand) => operand.value));
  const fallback = scanPathCandidates(scrubConsumed(input, consumed, state));
  if (fallback.truncated) state.truncated = true;
  for (const candidate of fallback.candidates) {
    found.set(candidate, { value: candidate, origin: "scan", kind: "shell" });
  }
  return { candidates: expandEncoded([...found.keys()]), truncated: state.truncated };
}

/**
 * The path operands of a tool call.
 *
 * Retained for callers that only need the operands. A SECURITY decision must
 * use `scanToolPathCandidates` instead: this function cannot distinguish "no
 * path operands" from "the walk stopped early", and that distinction is the
 * whole point of the fail-closed contract.
 */
export function extractToolPathCandidates(
  tool: Pick<ToolDescriptor, "name" | "inputSchema">,
  input: unknown,
): string[] {
  return scanToolPathCandidates(tool, input).candidates;
}

/**
 * Replace every string equal to an already-consumed path operand with an empty
 * string, so the tokenizing fallback cannot re-derive a truncated form of it.
 * Recursive to match `collectFromObject`, and bounded in depth for the same
 * reason.
 */
function scrubConsumed(value: unknown, consumed: ReadonlySet<string>, state: ScanState, depth = 0): unknown {
  if (depth > MAX_SECURITY_SCAN_DEPTH) {
    state.truncated = true;
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrubConsumed(item, consumed, state, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (typeof nested === "string") {
      out[key] = consumed.has(nested) ? "" : nested;
      continue;
    }
    out[key] = scrubConsumed(nested, consumed, state, depth + 1);
  }
  return out;
}

/**
 * The text that destructive and credential patterns are matched against.
 *
 * For a shell tool the whole payload is command text. For a structured tool
 * only command-like arguments are. File content is deliberately excluded:
 * quoting a dangerous command in a document is not running it.
 */
export function extractCommandText(tool: Pick<ToolDescriptor, "name">, input: unknown): unknown {
  if (input === null || typeof input !== "object") return {};
  if (isShellTool(tool)) return input;

  const scoped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (COMMAND_PARAM_NAMES.has(key)) scoped[key] = value;
  }
  return scoped;
}

/**
 * True when a command-bearing argument sits below the top level of a
 * structured payload.
 *
 * `extractCommandText` scopes a structured tool's command text to TOP-LEVEL
 * keys, so a command argument nested one level down is not command text as far
 * as the pattern scan is concerned -- the scan sees `{}` and matches nothing.
 * An empty result there is indistinguishable from "no command was present",
 * which is the same fail-open shape this change exists to remove: a security
 * scan that inspected nothing reported it as a clean bill of health.
 *
 * Bounded by the same depth limit as every other walk, and iterative in its
 * recursion depth for the same reason the others are.
 */
function commandKeyNestedBelowTopLevel(value: unknown, state: ScanState, depth = 1): void {
  if (depth > MAX_SECURITY_SCAN_DEPTH) {
    state.truncated = true;
    return;
  }
  if (value === null || typeof value !== "object") return;
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index): [string, unknown] => [String(index), item])
    : Object.entries(value as Record<string, unknown>);

  for (const [key, nested] of entries) {
    if (COMMAND_PARAM_NAMES.has(key)) {
      // Found, and out of reach of the top-level scope. Not inspected.
      state.truncated = true;
      return;
    }
    commandKeyNestedBelowTopLevel(nested, state, depth + 1);
  }
}

/**
 * The command text of a tool call, together with whether the whole payload was
 * actually reachable through it.
 *
 * A caller making a security decision must use this rather than
 * `extractCommandText`, for the same reason a path decision must use
 * `scanToolPathCandidates`: the unscoped form cannot tell "there is no command
 * here" from "the command was somewhere the scan could not reach".
 */
export function scanCommandText(tool: Pick<ToolDescriptor, "name">, input: unknown): { text: unknown; truncated: boolean } {
  const state: ScanState = newScanState();
  if (input !== null && typeof input === "object" && !isShellTool(tool)) {
    commandKeyNestedBelowTopLevel(input, state);
  }
  return { text: extractCommandText(tool, input), truncated: state.truncated };
}
