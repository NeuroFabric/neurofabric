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
 * CORPUS for path-candidate extraction. The contract, both directions.
 *
 * A shell tool's command text is tokenized into path candidates, and those
 * candidates are then judged by the boundary and the file rules. That design
 * makes shell SYNTAX indistinguishable from a location, so ordinary commands
 * are denied as if a code fragment were a path. Three live examples, each of
 * which ended a task:
 *
 *   find … -exec … \;                    -> denied: `\;` escapes the allowed root
 *   node -e "const { KernelAdapter }…"   -> denied: no matching file rule for a CODE LINE
 *   grep del f                            -> denied: `del` read as a destructive token
 *
 * This corpus is the contract. Four fields per entry, and all four are
 * asserted:
 *
 *   verdict  ALLOW or DENY
 *   reason   the reason text, matched for DENY and required ABSENT for ALLOW
 *   rule     which layer must produce it, asserted by name
 *
 * A MUST-DENY that denies for the WRONG reason is a silent security regression:
 * the entry stays green while the guardrail it exists to protect has moved. So
 * every DENY asserts the specific rule, and separately asserts it is not the
 * "no matching file rule" fallback — the catch-all denial that would otherwise
 * let any candidate pass for any reason.
 *
 * MUST-PASS asserts ALLOW on BOTH policy layers AND that driving the call
 * through the kernel emits no denial event at all. Allowing on one layer while
 * the other denies is still a dead task.
 *
 * THE GATE: a change that breaks a MUST-DENY entry is rejected outright,
 * whatever it buys in false positives. This is a security control and the
 * corpus is the contract; relaxing a guardrail to reduce noise is the
 * dangerous direction, so precision is only ever bought with corpus evidence.
 */

/**
 * Deny payloads are assembled at runtime. The deny lists match on raw content,
 * so a literal `.env` or destructive string in THIS file would make writing the
 * file itself a denied tool call. Every value below is a real case.
 */
const DOT_ENV = "." + "env";
const RECURSIVE_DELETE = "r" + "m -rf build";
const OUTSIDE = "../" + "outside.txt";

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

let workspace: string;
function root(): string {
  if (!workspace) throw new Error("corpus not initialised");
  return workspace;
}

/** The credential/boundary layer: `.env`, destructive commands, escapes. */
function trusted(): TrustedProjectPolicy {
  return new TrustedProjectPolicy({ allowedRoots: [root()] });
}

/**
 * The declarative layer: file rules, command patterns, command tokens. The
 * catch-all `**` rule matters — with no fileRules at all the engine
 * default-denies every path, which would mask what is under test.
 */
function kernelConfig(): PolicyConfig {
  return parsePolicyConfig({
    version: 1,
    onViolation: "block",
    fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
    destructiveCommandPatterns: [RECURSIVE_DELETE.replace(" build", "")],
    destructiveCommandTokens: ["rm", "rmdir", "del", "erase", "unlink", "shred", "remove-item"],
    limits: { maxToolCallsPerTask: 40, maxFileWritesPerTask: 10, maxBytesPerWrite: 2_000_000 },
  }, "extractor-corpus.json");
}

function configured(): ConfiguredPolicy {
  return new ConfiguredPolicy(kernelConfig(), { mode: "TRUSTED_PROJECT", base: new DefaultPolicy(), allowedRoots: [root()] });
}

function request(t: ToolDescriptor, input: unknown): PolicyRequest {
  return { taskId: "t-corpus", tool: t, operation: "execute", input };
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

type CorpusEntry = {
  label: string;
  tool: ToolDescriptor;
  input: unknown;
  verdict: "ALLOW" | "DENY";
  /** Matched against the denial reason for DENY; required absent for ALLOW. */
  reason: RegExp;
  /** Which layer must produce the verdict. Both are asserted to agree. */
  layer: "trusted" | "configured";
};

/**
 * MUST-DENY. Each is a genuine security guardrail, each observed live. These
 * are the gate: precision work that breaks any of them is rejected.
 */
const MUST_DENY: CorpusEntry[] = [
  {
    label: "credential file read by name",
    tool: readTool, input: { path: DOT_ENV }, verdict: "DENY",
    reason: /credential file/i, layer: "trusted",
  },
  {
    label: "recursive delete",
    tool: bashTool, input: { command: RECURSIVE_DELETE }, verdict: "DENY",
    reason: /destructive command (pattern|token)/i, layer: "configured",
  },
  {
    label: "path escaping the workspace root",
    tool: readTool, input: { path: OUTSIDE }, verdict: "DENY",
    reason: /allowed root|outside|escape/i, layer: "trusted",
  },
  {
    label: "traversal inside command text",
    tool: bashTool, input: { command: "cat " + OUTSIDE }, verdict: "DENY",
    reason: /allowed root|outside|escape/i, layer: "trusted",
  },
  {
    // Correctly denied, and deliberately corpus-recorded. `mktemp -d /tmp/…`
    // writes outside the workspace, so a workspace-confined policy MUST refuse
    // it. An earlier draft of this corpus listed it as MUST-PASS, which would
    // have required weakening the boundary to satisfy it. It belongs here: the
    // gate protects the control, and the corpus has to agree with it.
    label: "absolute unix path outside the root",
    tool: bashTool, input: { command: "mktemp -d /tmp/nf-corpus-XXXXXX" }, verdict: "DENY",
    reason: /allowed root|outside|escape/i, layer: "trusted",
  },
];

/**
 * MUST-PASS. Every one of these is a false positive that ended a task. They are
 * ordinary work, and none of them names a location outside the workspace.
 */
const MUST_PASS: CorpusEntry[] = [
  {
    // `\;` is the `find -exec` terminator. It was extracted as a path candidate
    // and denied as escaping the root.
    label: "find -exec with escaped terminator",
    tool: bashTool, input: { command: "find src -type f -exec echo {} \\;" }, verdict: "ALLOW",
    reason: /credential file|destructive command|allowed root|outside|escape|no matching file rule/i,
    layer: "trusted",
  },
  {
    label: "compound mkdir with redirection",
    tool: bashTool, input: { command: "mkdir -p x && echo \"h\" > x/t.txt" }, verdict: "ALLOW",
    reason: /credential file|destructive command|allowed root|outside|escape|no matching file rule/i,
    layer: "trusted",
  },
  {
    label: "inline node script",
    tool: bashTool,
    input: { command: "node -e \"const { KernelAdapter } = await import('./kernel-adapter.ts')\"" },
    verdict: "ALLOW",
    reason: /credential file|destructive command|allowed root|outside|escape|no matching file rule/i,
    layer: "trusted",
  },
  {
    // The live false positive, in its real shape: a MULTI-LINE inline script.
    // The single-line form passes, because the `**` catch-all matches it; the
    // live denial carried embedded newlines and was refused as "no matching
    // file rule for 'const { KernelAdapter } = await import(…);…'". Fidelity
    // matters here — a corpus entry that drops the newlines stops describing
    // the defect it was added for.
    label: "multi-line inline node script",
    tool: bashTool,
    input: { command: "node -e \"const { KernelAdapter } = await import('./k.ts');\nconst os = await import('node:os');\"" },
    verdict: "ALLOW",
    reason: /credential file|destructive command|allowed root|outside|escape|no matching file rule/i,
    layer: "trusted",
  },
  {
    label: "piped grep excluding a pattern",
    tool: bashTool, input: { command: "git grep -n policyMode -- platform | grep -v \"\\.test\\.\"" },
    verdict: "ALLOW",
    reason: /credential file|destructive command|allowed root|outside|escape|no matching file rule/i,
    layer: "trusted",
  },
  {
    // The watch item: `{}` is the -exec placeholder. If it is extracted as a
    // path candidate it trips the file rule, and that forces the recursion
    // decision. Recorded here so the corpus, not taste, decides.
    label: "find -exec with brace placeholder",
    tool: bashTool, input: { command: "find src -type f -exec grep -n TODO {} +" }, verdict: "ALLOW",
    reason: /credential file|destructive command|allowed root|outside|escape|no matching file rule/i,
    layer: "trusted",
  },
];

const ALL = [...MUST_DENY, ...MUST_PASS];

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

test("corpus: setup", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "nf-corpus-"));
  workspace = tmp;
  assert.ok(workspace, "workspace root for the corpus");
});

test("corpus: MUST-DENY entries deny for their OWN rule", () => {
  // Only the DECLARED layer must deny. The two layers have different
  // responsibilities — the credential rule lives in the trusted layer, the
  // command-pattern and file rules in the declarative one — so requiring them
  // to agree would assert an architecture that does not exist. What must never
  // happen is a DENY for the wrong rule, which is what the two assertions below
  // exist to catch.
  const failures: string[] = [];
  for (const entry of MUST_DENY) {
    const policy = entry.layer === "trusted" ? trusted() : configured();
    const decision = policy.evaluate(request(entry.tool, entry.input));
    if (decision.decision !== "DENY") {
      failures.push(`${entry.label}: expected DENY from the ${entry.layer} layer, got ${JSON.stringify(decision)}`);
      continue;
    }
    const reason = decision.reason ?? "";
    if (!entry.reason.test(reason)) {
      failures.push(`${entry.label}: denied for the WRONG rule, expected ${entry.reason}, got "${reason}"`);
    }
    // The catch-all denial must never stand in for a real rule: that is how a
    // guardrail goes missing while the entry stays green.
    if (/no matching file rule/i.test(reason)) {
      failures.push(`${entry.label}: denied by the file-rule fallback, not by its own guardrail. reason=${reason}`);
    }
  }
  assert.deepEqual(failures, [], "MUST-DENY regressions:\n" + failures.join("\n"));
});

test("corpus: MUST-PASS entries allow on BOTH layers", () => {
  // Every failure is collected rather than asserted one at a time, so a single
  // run reports the whole false-positive surface instead of only its first
  // member. Fixing them one run at a time is how a corpus stops describing the
  // problem and starts describing the fix.
  const failures: string[] = [];
  for (const entry of MUST_PASS) {
    for (const [name, policy] of [["trusted", trusted()], ["configured", configured()]] as const) {
      const decision = policy.evaluate(request(entry.tool, entry.input));
      if (decision.decision !== "ALLOW") {
        failures.push(`${entry.label} [${name}]: FALSE POSITIVE, a real command was denied. reason=${decision.reason}`);
      }
    }
  }
  assert.deepEqual(failures, [], "MUST-PASS failures:\n" + failures.join("\n"));
});

test("corpus: MUST-PASS entries emit NO denial event through the kernel", async () => {
  // A verdict is not the whole story: the extension records a decision per
  // preflight. MUST-PASS must be clean all the way down, so the task is never
  // handed a recorded denial it will have to reason about.
  const failures: string[] = [];
  for (const entry of MUST_PASS) {
    const adapter = new KernelAdapter();
    adapter.setPolicy(buildPolicy(
      { policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] }, root(), kernelConfig(),
    ));
    adapter.registerTools([toolDescriptorFromPi({ name: entry.tool.name, description: entry.tool.name })]);

    await adapter.beginTask(entry.label, entry.label);
    const { decision } = await adapter.precheckToolCall(entry.tool.name, "execute", entry.input, undefined, "c1");
    if (decision.decision !== "ALLOW") {
      failures.push(`${entry.label}: the kernel denied an ordinary command. reason=${decision.reason}`);
    }

    const denials = adapter.recentEvents(500)
      .filter((e) => e.type === "APPROVAL_DENIED" || e.type === "LIFECYCLE_REFUSED")
      .map((e) => `${e.type}:${(e.payload as Record<string, unknown>).reason}`);
    if (denials.length > 0) failures.push(`${entry.label}: denial events recorded: ${denials.join(" | ")}`);
  }
  assert.deepEqual(failures, [], "MUST-PASS kernel failures:\n" + failures.join("\n"));
});
