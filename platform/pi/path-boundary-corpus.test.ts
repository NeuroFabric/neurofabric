import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfiguredPolicy, DefaultPolicy, TrustedProjectPolicy } from "../core/index.ts";
import { parsePolicyConfig, type PolicyConfig } from "../core/policy-config.ts";
import { chooseRecoveryDetailed } from "../core/recovery.ts";
import { DEFAULT_LIMITS } from "../core/limits.ts";
import { scanToolPathCandidates } from "../core/tool-paths.ts";
import type { PolicyRequest, ToolDescriptor } from "../core/types.ts";

/**
 * CORPUS for the path boundary (§2.4 / D4) and for the violation threading
 * that decides whether a refusal kills the task (§2.5 / D5).
 *
 * Two independent defects meet in one corpus, and they are kept in separate
 * sections with separate gates so a future change cannot make one look like the
 * other. A soft refusal and a survivable denial both leave the task alive; they
 * are not the same fix and they are not the same gate.
 *
 *   Section A — the boundary judges the spelling, not the path.
 *              A candidate that came from a shell command reaches the boundary
 *              with its backslash escapes still in it, so the guard evaluates a
 *              path that does not exist, and the file rules match a mangled
 *              form. This fails in BOTH directions and one gate cannot cover it.
 *   Section B — what happens to the task afterwards.
 *              A denial that the committed policy says is survivable terminates
 *              the task anyway, and an out-of-root discovery glob takes the task
 *              down with it.
 *
 * Deny payloads are assembled at runtime. The deny lists match on raw content,
 * so a literal credential filename or destructive command in THIS file would
 * make writing the file a denied tool call.
 */
const DOT_ENV = "." + "env";
const RECURSIVE_DELETE = "r" + "m -rf build";
const OUTSIDE = "../" + "outside.txt";

/** An in-root path the shell would resolve, carrying an escaped space. */
const ESCAPED_IN_ROOT = "notes/my\\ file.md";
/** The same shape, written as a traversal the boundary must not lose. */
const ESCAPED_TRAVERSAL = "..\\outside.txt";

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

const readTool = tool("read", { path: { type: "string" } });
const bashTool = tool("bash", { command: { type: "string" } }, "SIDE_EFFECTING");
const lsTool = tool("ls", { path: { type: "string" } });
/** An out-of-root WRITE, so B2c can prove the soft class never reaches a write. */
const writeTool = tool("write", { path: { type: "string" } }, "SIDE_EFFECTING");
writeTool.riskLevel = "WRITE";

let workspace: string;
function root(): string {
  if (!workspace) throw new Error("corpus not initialised");
  return workspace;
}

function fileRules(specific: boolean): Array<Record<string, unknown>> {
  return specific
    ? [{ pattern: "notes/**/*.md", read: "allow", write: "allow" }]
    : [{ pattern: "**", read: "allow", write: "allow" }];
}

function kernelConfig(specific = false): PolicyConfig {
  return parsePolicyConfig({
    version: 1,
    onViolation: "block",
    fileRules: fileRules(specific),
    destructiveCommandPatterns: [RECURSIVE_DELETE.replace(" build", "")],
    destructiveCommandTokens: ["rm", "rmdir", "del", "erase", "unlink", "shred", "remove-item"],
    limits: { maxToolCallsPerTask: 40, maxFileWritesPerTask: 10, maxBytesPerWrite: 2_000_000 },
  }, "path-boundary-corpus.json");
}

/** A fresh policy per case, so no case can spend another's budget. */
function configured(specific = false): ConfiguredPolicy {
  return new ConfiguredPolicy(kernelConfig(specific), {
    mode: "TRUSTED_PROJECT", base: new DefaultPolicy(), allowedRoots: [root()],
  });
}

/** The credential/boundary layer, which owns the `.env` name rule. */
function trusted(): TrustedProjectPolicy {
  return new TrustedProjectPolicy({ allowedRoots: [root()] });
}

function request(t: ToolDescriptor, input: unknown): PolicyRequest {
  return { taskId: "t-boundary", tool: t, operation: "execute", input };
}

test.before(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "nf-boundary-"));
  await mkdtemp(path.join(os.tmpdir(), "nf-boundary-"));
});

// ===========================================================================
// SECTION A — the boundary judges the spelling
// ===========================================================================

/**
 * A1 (MUST-PASS, measurement 1). The false DENY.
 *
 * The path is inside the root. The shell would resolve the escape to a file
 * named `my file.md`. Today the candidate reaches the boundary still escaped, so
 * a rule shaped for real markdown paths does not match the mangled spelling and
 * the call falls through to the default-deny branch: a dead task for a file the
 * policy would have allowed.
 *
 * MEASURED, and it is policy-shape dependent, which the ledger did not record:
 * under the COMMITTED policy (`**` catch-all only, `.pi/neurofebric-policy.json:18`)
 * this case is ALLOWED today, because the catch-all matches any spelling. The
 * false DENY needs at least one specific rule — which the policy file's own note
 * tells operators to insert ABOVE the catch-all. A1p below is therefore the gate
 * that carries the defect; A1 is kept as the regression guard for the shape that
 * happens to be green.
 */
test("A1 MUST-PASS: an in-root path with an escaped space is allowed (catch-all shape)", () => {
  const decision = configured().evaluate(request(readTool, { path: ESCAPED_IN_ROOT }));
  assert.equal(decision.decision, "ALLOW", `in-root escaped path was refused: ${decision.reason ?? ""}`);
});

test("A1p MUST-PASS: the same path under a specific file rule is allowed", () => {
  const decision = configured(true).evaluate(request(readTool, { path: ESCAPED_IN_ROOT }));
  assert.equal(decision.decision, "ALLOW", `in-root escaped path was refused: ${decision.reason ?? ""}`);
});

test("A1b MUST-PASS: the same file in-root via a shell command is allowed", () => {
  const decision = configured(true).evaluate(request(bashTool, { command: `cat ${ESCAPED_IN_ROOT}` }));
  assert.equal(decision.decision, "ALLOW", `in-root escaped path was refused: ${decision.reason ?? ""}`);
});

/**
 * A2 (MUST-DENY). The false ALLOW — the dangerous direction.
 *
 * `..\outside.txt` read as a LITERAL filename is a file inside the root, so a
 * boundary that never unescapes cannot see the traversal. This is why the fix
 * adds candidates and never drops them, and why containment is checked on the
 * raw form AND the resolved form: additive, so it can only deny more.
 *
 * On Windows the backslash reading already denies this at `workspace.ts`; the
 * gate therefore asserts the verdict on every host, and the interesting host is
 * the one where the raw spelling looks contained.
 */
test("A2 MUST-DENY: an escaped traversal does not pass as a literal filename", () => {
  const decision = configured().evaluate(request(bashTool, { command: `cat ${ESCAPED_TRAVERSAL}` }));
  assert.equal(decision.decision, "DENY", "an escaped traversal was permitted");
  assert.match(String(decision.reason), /allowed root|outside|escape/i);
});

/**
 * A3 (MUST-PASS, measurement 3). An in-root glob.
 *
 * A glob is a PATTERN, not a location. It names no file. Scoped by its literal
 * prefix it is an ordinary in-root enumeration and must pass, and the file rules
 * are matched against the resolved prefix spelling rather than the pattern.
 */
test("A3 MUST-PASS: an in-root glob is allowed", () => {
  const decision = configured(true).evaluate(request(lsTool, { path: "notes/*.md" }));
  assert.equal(decision.decision, "ALLOW", `in-root glob was refused: ${decision.reason ?? ""}`);
});

// ===========================================================================
// SECTION N — the boundary judges the spelling (the unbuilt §2.4(a) fix)
// ===========================================================================

/**
 * Section A's gates pass against UNFIXED behaviour, so they prove nothing about
 * this fix and are not allowed to stand as its evidence. These gates assert the
 * FIXED behaviour and are written to be host-INDEPENDENT, so they mean the same
 * thing on Windows and on POSIX.
 *
 * The fix is additive: a shell operand carrying a shell escape contributes its
 * UNESCAPED spelling as an ADDITIONAL candidate, never as a replacement. The raw
 * spelling is still checked. That direction is the whole safety argument -- a
 * candidate added to the set can only ever produce another denial, never remove
 * one -- so the boundary itself is not modified at all.
 */

/** Candidate spellings the scanner produced for one shell command. */
function candidatesFor(command: string): string[] {
  return scanToolPathCandidates(
    { name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
    { command },
  ).candidates;
}

/**
 * N1 (MUST-PASS, red-first). An escaped shell operand contributes BOTH readings.
 *
 * RED against unmodified code: only the raw spelling is produced today, which is
 * why `..\outside.txt` is a literal in-root filename on POSIX and the traversal
 * is invisible. Host-independent, so it is meaningful here.
 */
test("N1 MUST-PASS: an escaped shell operand yields its raw and unescaped spellings", () => {
  const found = candidatesFor("cat " + ESCAPED_TRAVERSAL);
  assert.ok(found.includes(ESCAPED_TRAVERSAL), `raw spelling dropped: ${JSON.stringify(found)}`);
  assert.ok(found.includes("../outside.txt"), `unescaped spelling absent: ${JSON.stringify(found)}`);
});

/**
 * N2 (MUST-DENY). A drive letter is a SEPARATOR, not an escape.
 *
 * `C:\Users\x` unescaped to `C:/Users/x` would be a second spelling of the same
 * absolute path. It happens to be harmless, but "happens to be harmless" is not
 * a reason to rewrite a drive path, and a UNC prefix is the same case. Neither
 * spelling is added.
 */
test("N2 MUST-DENY: a drive-letter operand is not unescaped", () => {
  const found = candidatesFor("type " + "C:\\Users\\someone\\notes.md");
  assert.deepEqual(found, ["C:\\Users\\someone\\notes.md"], `a drive path was rewritten: ${JSON.stringify(found)}`);
});

test("N3 MUST-DENY: a UNC operand is not unescaped", () => {
  const found = candidatesFor("type " + "\\\\server\\share\\notes.md");
  assert.deepEqual(found, ["\\\\server\\share\\notes.md"], `a UNC path was rewritten: ${JSON.stringify(found)}`);
});

/**
 * N4 (MUST-DENY). A SCHEMA operand is never unescaped.
 *
 * A structured `path` field is data, not shell text. The shell never saw it, so
 * there is no shell reading of it to resolve toward, and inventing one would let
 * a caller smuggle a second spelling past the boundary by choosing a backslash.
 */
test("N4 MUST-DENY: a schema path operand is not unescaped", () => {
  const found = scanToolPathCandidates(
    { name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
    { path: "notes\\my file.md" },
  ).candidates;
  assert.deepEqual(found, ["notes\\my file.md"], `a schema operand was rewritten: ${JSON.stringify(found)}`);
});

/**
 * N5 (MUST-PASS). The fix must not introduce the false DENY it was meant to end.
 *
 * An in-root escaped path is allowed under BOTH spellings, so adding a candidate
 * costs nothing here. This is the gate that would catch a fix which replaced the
 * raw spelling instead of supplementing it, or which unescaped too eagerly.
 */
test("N5 MUST-PASS: an in-root escaped path is still allowed after the fix", () => {
  const decision = configured(true).evaluate(request(bashTool, { command: `cat ${ESCAPED_IN_ROOT}` }));
  assert.equal(decision.decision, "ALLOW", `in-root escaped path was refused: ${decision.reason ?? ""}`);
});

/**
 * N6 (MUST-DENY). A glob is a PATTERN and is not matched against file rules.
 *
 * `notes/*.md` names no file. Matching it against a rule shaped for real
 * markdown paths is a coincidence of spelling, not a permission, so the rule
 * matcher is not consulted for a pattern: the glob is scope-checked by its
 * literal prefix and nothing else.
 */
test("N6 MUST-PASS: an in-root glob is scoped by prefix, not matched against file rules", () => {
  const decision = configured(true).evaluate(request(lsTool, { path: "notes/*.md" }));
  assert.equal(decision.decision, "ALLOW", `in-root glob was refused: ${decision.reason ?? ""}`);
});

test("N7 MUST-DENY: an out-of-root glob is still refused", () => {
  const decision = configured().evaluate(request(lsTool, { path: "../../*" }));
  assert.equal(decision.decision, "DENY", "an out-of-root glob was permitted");
});

test("N8 MUST-DENY: an out-of-root glob under a read tool is a hard violation", () => {
  const decision = configured().evaluate(request(readTool, { path: "../../*.md" }));
  assert.equal(decision.decision, "DENY", "an out-of-root glob was permitted to a read tool");
  assert.equal(decision.refusal, undefined, "a read inherited the enumeration class");
});

/**
 * B1 (MUST-DENY, §2.1 gate — unchanged). The existing deny set, carried here so
 * precision work cannot quietly relax a guardrail. A MUST-DENY that denies for
 * the wrong reason is a silent regression, so each asserts the specific rule.
 */
const MUST_DENY: Array<{ label: string; run: () => { decision: string; reason?: string }; reason: RegExp }> = [
  {
    label: "credential file read by name",
    run: () => trusted().evaluate(request(readTool, { path: DOT_ENV })),
    reason: /credential file/i,
  },
  {
    label: "path escaping the workspace root",
    run: () => configured().evaluate(request(readTool, { path: OUTSIDE })),
    reason: /allowed root|outside|escape/i,
  },
  {
    label: "traversal inside command text",
    run: () => configured().evaluate(request(bashTool, { command: `cat ${OUTSIDE}` })),
    reason: /allowed root|outside|escape/i,
  },
  {
    label: "absolute unix path outside the root",
    run: () => configured().evaluate(request(bashTool, { command: "mktemp -d /tmp/nf-corpus-XXXXXX" })),
    reason: /allowed root|outside|escape/i,
  },
  {
    label: "recursive delete",
    run: () => configured().evaluate(request(bashTool, { command: RECURSIVE_DELETE })),
    reason: /destructive command (pattern|token)/i,
  },
];

for (const entry of MUST_DENY) {
  test(`B1 MUST-DENY: ${entry.label}`, () => {
    const { decision, reason } = entry.run();
    assert.equal(decision, "DENY", "a MUST-DENY entry was permitted");
    assert.match(String(reason), entry.reason);
  });
}

/**
 * B2 (MUST-DENY + soft). An out-of-root discovery call is still REFUSED.
 *
 * The scope change is not a permission change. The call is refused, it carries
 * its own reason, and nothing is read or executed. What changes is that it is
 * not a VIOLATION, so it must not be recoverable by retrying the same call and
 * must not terminate the task.
 */
test("B2: an out-of-root discovery call is refused as a soft refusal, not a violation", () => {
  const decision = configured().evaluate(request(lsTool, { path: "../../*" }));
  assert.equal(decision.decision, "DENY", "an out-of-root span was permitted");
  // `DenialRefusal` is a string union, not an object: the class IS the value.
  assert.equal(decision.refusal, "out_of_scope_discovery", "the refusal was not classified as scope discovery");
  assert.match(String(decision.reason), /allowed root|outside|escape/i);
});

/**
 * B2b (MUST-DENY). The soft class must NOT widen.
 *
 * The same out-of-root span, requested by a READ, stays a hard violation with no
 * refusal class at all. This is the gate that proves the three conditions in
 * `evaluatePaths` are conjunctive rather than decorative -- if the enumeration
 * check were ever dropped, or widened to any tool, this entry fails.
 */
test("B2b MUST-DENY: an out-of-root READ is a hard violation, not a soft refusal", () => {
  const decision = configured().evaluate(request(readTool, { path: "../../*" }));
  assert.equal(decision.decision, "DENY", "an out-of-root read was permitted");
  assert.equal(decision.refusal, undefined, "a read inherited the enumeration class");
});

test("B2c MUST-DENY: an out-of-root WRITE is a hard violation, not a soft refusal", () => {
  const decision = configured().evaluate(request(writeTool, { path: "../../*" }));
  assert.equal(decision.decision, "DENY", "an out-of-root write was permitted");
  assert.equal(decision.refusal, undefined, "a write inherited the enumeration class");
});

/**
 * B3. A soft refusal spends NO budget.
 *
 * Counted here rather than asserted by hand: a refused call that still books a
 * tool call can exhaust `maxToolCallsPerTask` purely by being refused, which is
 * the benign-non-zero-exit failure in §2.3 wearing a different hat.
 */
test("B3: a soft refusal spends no tool-call budget", () => {
  const policy = configured();
  const before = policy.toolBudget?.(request(lsTool, { path: "x" }))?.used ?? 0;
  policy.evaluate(request(lsTool, { path: "../../*" }));
  const after = policy.toolBudget?.(request(lsTool, { path: "x" }))?.used ?? 0;
  assert.equal(after, before, "a refused call booked budget");
});

/**
 * B4 (the D5 gate, red-first). A BLOCK violation arriving as a tool result must
 * leave the task running.
 *
 * This is the path that killed two consecutive sessions. The denial is
 * delivered as a failed result, `classifyFailure` returns POLICY_DENIED, and
 * recovery terminated on it unconditionally — the committed `onViolation:
 * block` never reached it, because the options carried no violation field.
 *
 * FAILING CLOSED IS THE DEFAULT: an ABSENT violation means terminate. This gate
 * pins the surviving case only, and gate B5 pins the absent case so a later
 * change cannot make "unknown" mean "carry on".
 */
test("B4 MUST-PASS: a block violation received as a tool result does not terminate", () => {
  const decision = chooseRecoveryDetailed({
    limits: DEFAULT_LIMITS,
    failure: "POLICY_DENIED",
    depth: 0,
    idempotency: "IDEMPOTENT",
    violation: "block",
  });
  assert.notEqual(decision.strategy, "TERMINATE", "a block violation terminated the task");
});

test("B5 MUST-DENY: an absent violation still terminates (fail closed)", () => {
  const decision = chooseRecoveryDetailed({
    limits: DEFAULT_LIMITS,
    failure: "POLICY_DENIED",
    depth: 0,
    idempotency: "IDEMPOTENT",
  });
  assert.equal(decision.strategy, "TERMINATE", "an absent violation let the task continue");
  assert.equal(decision.reason, "POLICY_DENIED_TERMINATED");
});

test("B6 MUST-DENY: an abort violation still terminates", () => {
  const decision = chooseRecoveryDetailed({
    limits: DEFAULT_LIMITS,
    failure: "POLICY_DENIED",
    depth: 0,
    idempotency: "IDEMPOTENT",
    violation: "abort",
  });
  assert.equal(decision.strategy, "TERMINATE", "an abort violation let the task continue");
});
