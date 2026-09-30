/**
 * F-006 §2.3: telling an ANSWER from a FAULT.
 *
 * A command that exits non-zero for an ordinary, successful reason — `grep`
 * with no match exits 1, and so do `diff`, `comm` and `cmp` in common cases — is
 * not a failure, and recovery must not spend a replan on it. Two of those
 * replans killed a task whose only sin was looking for something that was not
 * there. See `docs/F006_LEDGER.md` §2.3 for both certificates.
 *
 * WHY THIS IS A TABLE AND NOT A RULE. The obvious fix — "a non-zero exit that
 * the command reports as a normal outcome" — is unimplementable without knowing
 * which command ran, because the exit code alone does not discriminate.
 * Measured, not assumed: `node -e "process.exit(1)"` is a genuine failure and
 * exits 1, and so does a `cp` of a missing file. Nor does "non-zero with empty
 * output" work: that same `node` measurement produced NO output at all. The
 * signal that separates the two is the command, so the rule is enumerated as
 * (command, exit-code) pairs and a command absent from the table is an ordinary
 * failure.
 *
 * THE TABLE IS DELIBERATELY NARROW, and narrow is the safe direction here. Each
 * entry is a command whose author defined a specific meaning for a specific
 * non-zero code. `find` is absent on purpose: it exits 1 on ERROR, not on
 * "nothing found". A false negative costs the old behaviour — the failure is
 * classified as it always was. A false positive would swallow a real failure, so
 * the asymmetry is deliberate and the table grows only by measurement.
 *
 * EVERY FUNCTION HERE FAILS CLOSED. Absent, unrecognised, or unparseable input
 * yields `undefined`, which the classifier treats as "no exit information" and
 * which leaves the previous behaviour bit for bit. The worst case for a wrong
 * read of an untyped payload is that this fix is inert — never that it
 * misclassifies a genuine failure.
 */

/**
 * Commands whose author assigned a defined meaning to a non-zero exit, mapped
 * to the codes that mean "ran correctly, the answer is the answer".
 *
 * In every row below the code that means ERROR is 2 and is deliberately absent:
 * a command that could not do its job is a failure, and the table is per
 * (command, code) precisely so that `grep` finding nothing and `grep` unable to
 * read its input stay different outcomes.
 */
const BENIGN_NONZERO_EXITS: ReadonlyMap<string, ReadonlySet<number>> = new Map([
  // Search tools: 0 = at least one match, 1 = no match, 2 = error.
  ["grep", new Set([1])],
  ["egrep", new Set([1])],
  ["fgrep", new Set([1])],
  ["rg", new Set([1])],
  // Comparison tools: 0 = same, 1 = different, 2 = trouble.
  ["diff", new Set([1])],
  ["comm", new Set([1])],
  ["cmp", new Set([1])],
]);

/**
 * A conservative program-name shape: letters, digits, underscore, dot, hyphen.
 *
 * Anything else — an empty first token, a path, a variable, a quoted
 * expression — yields `undefined` rather than a guess. A program name is never a
 * filesystem path, so a first token containing a separator is not a program name
 * and is not resolved into one.
 */
const PROGRAM_NAME = /^[A-Za-z0-9_.-]+$/;

/** How far into a payload the exit status is looked for, and how many strings are read. */
const MAX_WALK_DEPTH = 3;
const MAX_WALK_STRINGS = 20;

/**
 * The exit status Pi appends to a failed command's result, as measured
 * first-party from inside the consuming process.
 *
 * ANCHORED AT THE END, deliberately. Output that merely quotes these words
 * mid-body is not an exit status, and a command that was asked to print them
 * must not be able to manufacture a benign classification. Combined with the
 * command table — `echo` is not in it — the two guards are independent.
 */
const TRAILING_EXIT_STATUS = /Command exited with code (\d+)\s*$/;

/**
 * The program name a call will run, taken from the command's first token.
 *
 * ONLY the name is kept, never the command text. A command line can carry
 * credentials and paths that must not ride along on an error object, and the
 * classifier needs nothing more than which program this is. The command itself
 * is not retained, so there is nothing here to redact later.
 *
 * `undefined` when the input is not a tool call carrying a `command` string, or
 * when the first token is not a plain program name.
 */
export function commandNameFrom(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== "string") return undefined;
  const first = command.trim().split(/\s+/, 1)[0];
  if (first === undefined || !PROGRAM_NAME.test(first)) return undefined;
  return first;
}

/**
 * The exit status carried by a tool result, or `undefined` when the result
 * carries none this can read.
 *
 * A structured field is preferred over text, so a runtime that supplies a real
 * field is honoured without relying on the annotation at all. The text walk is
 * BOUNDED in both depth and count, for the same reason the path and
 * destructive-command scans elsewhere in this codebase are bounded: an
 * unbounded walk of an untrusted payload is its own defect.
 */
export function exitStatusFrom(payload: unknown): number | undefined {
  const structured = structuredExitStatus(payload);
  if (structured !== undefined) return structured;
  return annotatedExitStatus(payload, 0, { seen: 0 });
}

/** A numeric `exitCode`-style field, when the payload has one. */
function structuredExitStatus(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isInteger(value)) continue;
    if (/^(exit_?code|exitstatus|exit_?status|status)$/i.test(key)) return value;
  }
  return undefined;
}

/** The trailing annotation, if any string in the payload ends with one. */
function annotatedExitStatus(value: unknown, depth: number, budget: { seen: number }): number | undefined {
  if (budget.seen >= MAX_WALK_STRINGS) return undefined;
  if (typeof value === "string") {
    budget.seen += 1;
    const match = TRAILING_EXIT_STATUS.exec(value.trimEnd());
    return match === null ? undefined : Number(match[1]);
  }
  if (depth >= MAX_WALK_DEPTH) return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = annotatedExitStatus(entry, depth + 1, budget);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      const found = annotatedExitStatus(entry, depth + 1, budget);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Whether this outcome is an answer rather than a fault.
 *
 * True only when BOTH a known program name and one of that program's defined
 * non-zero codes are present. Either one missing is `false`, which is the
 * ordinary-failure path.
 */
export function isBenignNonZeroExit(commandName: string | undefined, exitStatus: number | undefined): boolean {
  if (commandName === undefined || exitStatus === undefined) return false;
  return BENIGN_NONZERO_EXITS.get(commandName)?.has(exitStatus) === true;
}
