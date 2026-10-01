import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfiguredPolicy, DefaultPolicy, TrustedProjectPolicy } from "../core/index.ts";
import { parsePolicyConfig, type PolicyConfig } from "../core/policy-config.ts";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { buildPolicy } from "./project-config.ts";
import type { PolicyRequest, ToolDescriptor } from "../core/types.ts";

/**
 * CORPUS for command-position scoping of the destructive-token guard.
 *
 * THE DEFECT. `destructiveCommandTokens` (`rm`, `rmdir`, `del`, `erase`,
 * `unlink`, `shred`, `remove-item`) are matched as whole tokens ANYWHERE in
 * command text. So `grep del f` is denied, because `del` is the *pattern being
 * searched for* rather than a command being run. §2.2 of the ledger.
 *
 * WHY THE OBVIOUS FIX WAS REFUSED. The queue item said bare tokens must match in
 * "command position". Measured against the real rules, that rule would ALLOW all
 * of these, every one of which is a real deletion:
 *
 *     bash -c "rm -rf /"            the token is quoted, not a head
 *     find . | xargs rm             `rm` is an operand of `xargs`
 *     find . -exec rm {} \;         `rm` is inside the `-exec` body
 *     nohup rm f / timeout 5 rm f   same shape
 *
 * So the guard cannot be narrowed to the segment head. It has to be PARSED, and
 * that parse is only safe under one invariant: **anything the parser cannot
 * classify keeps today's behaviour and is DENIED.** The residue gates at the
 * bottom of this file are the enforcement of that invariant, and they are the
 * reason this relaxation is narrower than it first looks.
 *
 * WHAT IS AND IS NOT RELAXED. A destructive token is excused in exactly ONE
 * situation: it sits in a PATTERN position of a recognised pattern command
 * (`PATTERN_COMMANDS` / `GREP_FAMILY`, already shipped in `tool-paths.ts` and
 * pinned by item 1). Nothing else is excused. In particular a token that is a
 * plain operand of a plain command -- `echo rm` -- is STILL DENIED, because the
 * policy's own scope note says injected content arriving inside command text is
 * caught on purpose, and widening past pattern positions would un-break that
 * committed decision. See MUST_DENY_KNOWN, which records that deliberately.
 *
 * TRIGGER LITERALS. This file is the subject under test, so it is the one place
 * they are permitted. It lives in its own file, separately from
 * `path-extraction-corpus.test.ts`, for the reason item 1 established: a gate and
 * the edit that relaxes it must never be the same edit.
 */

const TOKENS = ["rm", "rmdir", "del", "erase", "unlink", "shred", "remove-item"];

function tool(
  name: string,
  properties: Record<string, unknown>,
  sideEffect: "PURE" | "SIDE_EFFECTING" = "PURE",
): ToolDescriptor {
  return {
    name, version: "1", description: name,
    inputSchema: { type: "object", properties },
    outputSchema: { type: "object" },
    capabilities: [], permissions: [],
    riskLevel: "READ_ONLY", timeoutMs: 1000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
    idempotency: "IDEMPOTENT", sideEffect,
  };
}

const bashTool = tool("bash", { command: { type: "string" } }, "SIDE_EFFECTING");

let workspace: string;
function root(): string {
  if (!workspace) throw new Error("corpus not initialised");
  return workspace;
}

/** The token guard lives on the DECLARATIVE layer; see §2.1's A4 mirror rule. */
function configured(): ConfiguredPolicy {
  return new ConfiguredPolicy(
    parsePolicyConfig({
      version: 1,
      deniedTools: [],
      allowedTools: [],
      fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
      destructiveCommandPatterns: ["rm -rf", "format c:"],
      destructiveCommandTokens: TOKENS,
      limits: { maxToolCallsPerTask: 40, maxFileWritesPerTask: 10, maxBytesPerWrite: 2_000_000 },
      onViolation: "block",
    }, "command-position-corpus.json"),
    { mode: "TRUSTED_PROJECT", base: new DefaultPolicy(), allowedRoots: [root()] },
  );
}

/** Also constructed, because a MUST-PASS must allow on BOTH layers or it is still a dead task. */
function trusted(): TrustedProjectPolicy {
  return new TrustedProjectPolicy({ allowedRoots: [root()] });
}

function request(input: unknown): PolicyRequest {
  return { taskId: "t-cmdpos", tool: bashTool, operation: "execute", input };
}

function cmd(text: string): unknown {
  return { command: text };
}

// ---------------------------------------------------------------------------
// MUST-PASS -- red today. Every one is a false positive that ends a task.
// ---------------------------------------------------------------------------

const MUST_PASS: { label: string; command: string }[] = [
  // The plain case from §2.2: `del` is grep's pattern operand.
  { label: "grep pattern is the string being searched for", command: "grep del f" },
  { label: "grep-family pattern, egrep", command: "egrep del f" },
  { label: "grep-family pattern, rg", command: "rg del f" },
  // The option carries the pattern; the operand after it is a file.
  { label: "grep pattern supplied through -e", command: "grep -e del f" },
  // The other destructive tokens are equally innocent as patterns.
  { label: "grep searching for rm", command: "grep rm f" },
  { label: "grep searching for shred", command: "grep shred f" },
  { label: "grep searching for remove-item", command: "grep remove-item f" },
  // `tr` has no file operand: every non-option token is a character set.
  { label: "tr character set, not a command", command: "tr del x" },
  // THE COMPOSITION. `grep` sits in a command position reached through a
  // wrapper, so `del` is still its pattern. One recursion, both verdicts right.
  { label: "xargs wrapping grep, pattern still a pattern", command: "xargs grep del f" },
  { label: "timeout consuming its duration, then grep", command: "timeout 5 grep del f" },
  { label: "nohup wrapping grep", command: "nohup grep del f" },
  { label: "env consuming an assignment, then grep", command: "env FOO=1 grep del f" },
  { label: "nice consuming its adjustment, then grep", command: "nice -n 5 grep del f" },
  { label: "stdbuf consuming its mode, then grep", command: "stdbuf -o0 grep del f" },
  // A `-c` payload is re-parsed as a command line in its own right.
  { label: "sh -c payload re-parsed", command: 'sh -c "grep del f"' },
  { label: "bash -c payload re-parsed", command: 'bash -c "grep del f"' },
  // A `-exec` body is a nested command line.
  { label: "find -exec body re-parsed", command: "find src -type f -exec grep del {} \\;" },
  // Two wrappers deep, still inside the cap.
  { label: "two wrappers deep", command: "timeout 5 xargs grep del f" },
];

// ---------------------------------------------------------------------------
// MUST-DENY -- green today, and these five are the GATE. A change that lets any
// of them through is rejected whatever it buys in precision.
// ---------------------------------------------------------------------------

const MUST_DENY: { label: string; command: string }[] = [
  { label: "destructive command inside a -c payload", command: 'bash -c "rm -rf /"' },
  { label: "destructive command piped into xargs", command: "find . | xargs rm" },
  { label: "destructive command in a find -exec body", command: "find . -exec rm {} \\;" },
  { label: "destructive command after nohup", command: "nohup rm f" },
  { label: "destructive command after timeout", command: "timeout 5 rm f" },
];

/**
 * MUST-DENY, hardened. Each of the five forms above plus a shape that reaches the
 * same command through a DIFFERENT route, so a parser cannot satisfy the gate by
 * recognising exactly five spellings.
 */
const MUST_DENY_COMPOSED: { label: string; command: string }[] = [
  { label: "xargs deletion with the + terminator style argument list", command: "find . | xargs rm -f" },
  { label: "find -execdir body", command: "find . -execdir rm {} \\;" },
  { label: "find -ok body", command: "find . -ok rm {} \\;" },
  { label: "env passing through to a deletion", command: "env FOO=1 rm f" },
  { label: "stdbuf passing through to a deletion", command: "stdbuf -o0 rm f" },
  { label: "command executing a deletion", command: "command rm f" },
  { label: "exec replacing the shell with a deletion", command: "exec rm f" },
  { label: "sh -c payload running a deletion", command: 'sh -c "rm f"' },
  { label: "three wrappers deep", command: "timeout 5 xargs nohup rm f" },
  { label: "deletion in the SECOND segment after a separator", command: "echo hi && rm f" },
  { label: "deletion in a segment after a pipe", command: "echo hi | rm f" },
];

/**
 * RESIDUE. The fail-closed invariant, made executable.
 *
 * Every entry is something the parser cannot classify, and every entry CARRIES A
 * DESTRUCTIVE TOKEN, because a gate that asserts "this unparseable input is
 * denied" is only meaningful if the guard would otherwise have had something to
 * deny. Without a token in the text there is nothing to refuse, today or later,
 * so such an entry would be asserting an unrelated control.
 *
 * Each is denied today and MUST STILL be denied after the parse. That is the
 * whole licence for the relaxation: if any of these turns green, the parser has
 * learned to claim it understands input it does not understand.
 */
const MUST_DENY_RESIDUE: { label: string; command: string }[] = [
  // Unbalanced quote: the tokenizer cannot know where the payload ends.
  { label: "unbalanced quote", command: 'grep "del f' },
  // An unknown wrapper. `parallel`, `eval`, `time` and `source` all run their
  // operands as commands and are NOT in COMMAND_WRAPPERS, so they are
  // unclassifiable rather than safe. None of them is on this host to measure,
  // and none is guessed at.
  { label: "unknown wrapper (eval)", command: 'eval "rm f"' },
  { label: "unknown wrapper (parallel)", command: "parallel rm {} ::: a" },
  { label: "unknown wrapper (source)", command: "source rm" },
  // A truncated command. Measured: find reports "missing argument to -exec"
  // when the terminator is absent, so this input never reaches a command.
  { label: "truncated find -exec with no terminator", command: "find . -exec rm {}" },
  { label: "truncated xargs with no command", command: "find . | xargs -n rm" },
  // Recursion past the depth cap. The cap is MAX_SECURITY_SCAN_DEPTH (12), the
  // same bound D-027 fixed for the other bounded scanners, imported rather than
  // re-declared. Exceeding it is unclassifiable, and unclassifiable is DENY.
  { label: "nesting past the depth cap", command: "timeout 5 ".repeat(13) + "rm f" },
];

/**
 * Deliberately still DENIED, and recorded rather than quietly relaxed.
 *
 * This is the session's own first-party reproduction: an `echo` whose LABEL
 * contained a bare destructive token was refused by the live guard, killing the
 * measurement that produced it. It is ordinary work and it is annoying.
 *
 * It is nonetheless NOT in MUST_PASS, and the reason is the policy's own scope
 * note: content arriving inside command text is caught on purpose, because
 * injected content arrives exactly that way. Excusing a plain operand would
 * un-break that committed decision, which is the same objection that refused the
 * head-only fix. Listed here so the cost is visible and deliberate rather than
 * discovered later as an oversight.
 */
const MUST_DENY_KNOWN: { label: string; command: string }[] = [
  { label: "echo whose label quotes a destructive token", command: 'echo "destructive command rm is denied"' },
  { label: "a plain operand that happens to be a destructive token", command: "echo rm" },
];

// ---------------------------------------------------------------------------

test("command-position corpus: harness", async (t) => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "nf-cmdpos-"));
  await t.test("MUST-PASS allow on BOTH layers", () => {
    const failures: string[] = [];
    for (const entry of MUST_PASS) {
      for (const [name, policy] of [["configured", configured()], ["trusted", trusted()]] as const) {
        const decision = policy.evaluate(request(cmd(entry.command)));
        if (decision.decision !== "ALLOW") {
          failures.push(`${entry.label} [${name}]: FALSE POSITIVE. reason=${decision.reason}`);
        }
      }
    }
    assert.deepEqual(failures, [], "MUST-PASS failures:\n" + failures.join("\n"));
  });

  await t.test("MUST-DENY still deny, by the token or pattern rule", () => {
    const failures: string[] = [];
    for (const group of [MUST_DENY, MUST_DENY_COMPOSED, MUST_DENY_KNOWN]) {
      for (const entry of group) {
        const decision = configured().evaluate(request(cmd(entry.command)));
        if (decision.decision !== "DENY") {
          failures.push(`${entry.label}: EXPECTED DENY, got ${JSON.stringify(decision)}`);
          continue;
        }
        const reason = decision.reason ?? "";
        // Matched loosely on purpose. The guard's own wording is
        // "destructive command '<token>' is denied" for the token rule and
        // "destructive command pattern matched" for the pattern rule; requiring
        // both spellings would pin prose rather than the decision.
        if (!/destructive command/i.test(reason)) {
          failures.push(`${entry.label}: denied for the WRONG rule. got "${reason}"`);
        }
      }
    }
    assert.deepEqual(failures, [], "MUST-DENY regressions:\n" + failures.join("\n"));
  });

  await t.test("RESIDUE denies -- the fail-closed invariant", () => {
    const failures: string[] = [];
    for (const entry of MUST_DENY_RESIDUE) {
      const decision = configured().evaluate(request(cmd(entry.command)));
      if (decision.decision !== "DENY") {
        failures.push(`${entry.label}: UNCLASSIFIABLE INPUT WAS ALLOWED -- the invariant is broken. got ${JSON.stringify(decision)}`);
      }
    }
    assert.deepEqual(failures, [], "RESIDUE failures:\n" + failures.join("\n"));
  });

  await t.test("MUST-PASS emit NO denial event through the kernel", async () => {
    const failures: string[] = [];
    for (const entry of MUST_PASS) {
      const adapter = new KernelAdapter();
      adapter.setPolicy(buildPolicy(
        { policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] }, root(),
        parsePolicyConfig({
          version: 1,
          deniedTools: [], allowedTools: [],
          fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
          destructiveCommandPatterns: ["rm -rf", "format c:"],
          destructiveCommandTokens: TOKENS,
          limits: { maxToolCallsPerTask: 40, maxFileWritesPerTask: 10, maxBytesPerWrite: 2_000_000 },
          onViolation: "block",
        }, "command-position-corpus.json"),
      ));
      adapter.registerTools([toolDescriptorFromPi({ name: "bash", description: "bash" })]);
      await adapter.beginTask(entry.label, entry.label);
      const { decision } = await adapter.precheckToolCall("bash", "execute", cmd(entry.command), undefined, "c1");
      if (decision.decision !== "ALLOW") {
        failures.push(`${entry.label}: the kernel denied an ordinary command. reason=${decision.reason}`);
      }
      const denials = adapter.recentEvents(500)
        .filter((e) => e.type === "APPROVAL_DENIED" || e.type === "LIFECYCLE_REFUSED");
      if (denials.length > 0) failures.push(`${entry.label}: ${denials.length} denial event(s) recorded`);
    }
    assert.deepEqual(failures, [], "MUST-PASS kernel failures:\n" + failures.join("\n"));
  });
});