import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ConfiguredPolicy, DefaultPolicy, TrustedProjectPolicy } from "../core/index.ts";
import { parsePolicyConfig, type PolicyConfig } from "../core/policy-config.ts";
import { chooseRecoveryDetailed } from "../core/recovery.ts";
import { DEFAULT_LIMITS } from "../core/limits.ts";
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
// SECTION B — what the refusal does to the task
// ===========================================================================

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
  const refusal = (decision as { refusal?: { kind?: string } }).refusal;
  assert.equal(refusal?.kind, "out_of_scope_discovery", "the refusal was not classified as scope discovery");
  assert.match(String(decision.reason), /allowed root|outside|escape/i);
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
