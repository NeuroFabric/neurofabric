# Finding F-007: Quoted backslash-leading grep pattern misclassified as rooted path; the denial terminates the task

- **ID:** F-007
- **Status:** Resolved 2026-09-26 (fix commits a4b6353, 37c2f2e; residuals recorded below).
- **Component:** Path-boundary precheck (path-escape guard), policy violation handling (see F-003), denial message diagnostics

## Description
This shell command was denied in precheck without executing (Took 0.0s):

    find . -type f -name "*.jsonl" -o -name "*.log" | grep -v "node_modules" | grep -v "\.git"

    policy neurofebric-policy.json: path boundary violation: \.git: path escapes the allowed root (C:\Users\Rishabh Sharma\.pi\agent)

The guard extracted `\.git` — a grep EXCLUSION PATTERN, not a path operand —
from the quoted pattern. A backslash-leading token resolves as a rooted path;
drive-relative resolution places it outside any allowed root, so the whole
command is denied. The committed suite already tests that grep patterns are not
path operands; this shape (quoted, backslash-leading) defeats that heuristic.

## Secondary issues
1. **The denial killed the task (F-003 reproduced live):** immediately after
   this single denial, every tool call returned "Task is FAILED; no further
   tool calls are accepted". A false-positive boundary violation terminated an
   otherwise healthy session — exactly the behavior F-003 predicts.
2. **Denial message diagnostics:** the message shows only the policy file
   basename and one allowed root — not the full root list, the raw token's
   origin, or the extraction rule that produced it. The false positive cannot
   be diagnosed from the message alone. (Feeds P3a structured violations.)

## Expected behavior
- Path extraction must not treat quoted grep/sed pattern arguments as path
  operands; extend the existing grep-pattern test with this shape.
- Per F-003, a boundary violation should deny the call, not terminate the task.
- Violation messages should carry the full allowed-roots list, the raw token,
  and the rule that produced it.

## Update 2026-09-26 (third instance — non-terminal)


## Update 2026-09-26 (fourth instance — deliberate reproduction during recon, terminal)
During read-only recon of the extractor, the agent ran grep commands with backslash-leading tokens while investigating this finding — deliberately reproducing the denial despite the standing rule. Multiple denials were followed immediately by the terminal "Task is FAILED" state. Two upgrades:

Mechanism now confirmed from source, not inference: platform/core/workspace.ts, extractPathCandidates splits scanned strings on /[\s"'()<>]+/ — quotation marks are delimiters, not protection — so a quoted pattern like '.git' yields a bare backslash-leading token that is classified as a path candidate and resolved drive-relative outside the allowed root.
Codified rules (docs/handoff.md, a614b74) did not prevent the violation. New standing rule: denial reproduction belongs in unit tests, never in live shells.
Open question (unresolved): PolicyDecision carries ViolationAction block vs abort; which violation classes map to abort, and whether a denial counter exists, is under investigation (explains why one denial was terminal, another was survived by 20+ calls).

## Resolution 2026-09-26 (fixed from the code side)

Fix commits: a4b6353 (red tests banked first), 37c2f2e (fix). Suite 194 pass / 0 fail.

Mechanism (source-confirmed): the live extraction layer for shell tools is
extractFromCommand in platform/core/tool-paths.ts
(extractToolPathCandidates → extractFromCommand → tokenizeShell +
looksLikePath). extractPathCandidates in workspace.ts is unreachable for
shell tools — its only consumer inside tool-paths.ts is the schema-less
fallback. tokenizeShell treats quotation marks as delimiters, not protection,
so a quoted pattern like '\.git' yielded a bare backslash-leading token that
was classified as a path candidate and resolved drive-relative outside the
allowed root.

Fix shape: positional, confined to extractFromCommand — pattern arguments in
pattern positions are no longer classified as path candidates. A
pattern-taking command head (PATTERN_COMMANDS) is never counted as one of
its own operands, and once a positional operand has been seen, a later
pattern-command token opens a new segment rather than being read as an
operand of the current one:

```typescript
const PATTERN_COMMANDS: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep", "rg", "sed", "awk", "tr"]);

/** The grep family takes its pattern after `-e`; `sed`/`awk` do not. */
const GREP_FAMILY: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep", "rg"]);

function extractFromCommand(command: string, origin: string, into: Map<string, PathOperand>): void {
  /** How the command segment being read is classified. */
  let segment = newSegment();

  for (const token of tokenizeShell(command)) {
    const text = token.text.trim();
    if (text === "") continue;
    if (VARIABLE_ASSIGNMENT.test(text)) continue;
    if (text.includes("://")) continue;
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
```

looksLikePath and extractPathCandidates (workspace.ts) are untouched; the
schema-less fallback is unchanged.

Residuals (accepted; backlog):
1. Slash-bearing script arguments are still read as path candidates —
   sed -e "s/a/b/" survives the fix; pattern positions are skipped, script
   payloads are not parsed.
2. The schema-less fallback in workspace.ts still runs extractPathCandidates
   for tools without schemas.
3. Head detection is name-based: tokenizeShell emits no separator token, so
   a file operand literally named grep/sed/awk/tr can be misread as a
   command head.
