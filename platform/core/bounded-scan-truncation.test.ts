/**
 * Bounded security-scan truncation must fail CLOSED.
 *
 * A depth bound on a security scanner is a *safety* limit, not an allow
 * condition. When a scan is truncated because the payload exceeds that bound,
 * the operation has NOT been shown to be safe -- it has been left uninspected.
 * Reading "not scanned" as "safe" is a fail-open.
 *
 * This suite pins the security DECISION, not the extractor's return value. A
 * scanner that returns `[]` is ambiguous: it can mean "no path operands here"
 * (fine) or "I stopped walking" (unsafe). The tests below drive the real
 * production engines -- `TrustedProjectPolicy.evaluate` and
 * `ConfiguredPolicy.evaluate` -- so the assertion is on ALLOW/DENY, which is
 * the thing that actually gates the tool call.
 */
import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConfiguredPolicy } from "./configured-policy.ts";
import { parsePolicyConfig } from "./policy-config.ts";
import { DefaultPolicy, TrustedProjectPolicy } from "./policy.ts";
import type { PolicyRequest, RiskLevel, ToolDescriptor } from "./types.ts";

let root = "";
let workspace = "";
/** An absolute path that exists nowhere but is unmistakably outside the root. */
let outside = "";

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nf-bounded-scan-"));
  workspace = path.join(root, "app");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  outside = path.join(root, "outside", "escape.txt");
});

after(() => {
  // Nothing to clean: the sandbox lives in the OS temp directory.
});

function tool(name: string, riskLevel: RiskLevel, extra: Record<string, unknown> = {}): ToolDescriptor {
  return {
    name,
    version: "1.0.0",
    description: `synthetic ${name}`,
    inputSchema: { type: "object", properties: { path: { type: "string" }, ...extra } },
    outputSchema: {},
    capabilities: [],
    permissions: [],
    riskLevel,
    timeoutMs: 1000,
    retryPolicy: { maxAttempts: 1 },
    idempotency: "IDEMPOTENT",
    sideEffect: riskLevel === "WRITE" ? "SIDE_EFFECTING" : "READ_ONLY",
  };
}

const readTool = tool("read", "READ_ONLY");
const writeTool = tool("write", "WRITE");

/** Wrap `value` in `levels` anonymous objects, so the value's depth is exact. */
function nest(value: unknown, levels: number): unknown {
  let out: unknown = value;
  for (let i = 0; i < levels; i += 1) out = { [`level${i}`]: out };
  return out;
}

/** A structured payload whose `path` operand sits at nesting depth `levels`. */
function nestedPath(levels: number): unknown {
  return nest({ path: outside }, levels);
}

function request(t: ToolDescriptor, input: unknown): PolicyRequest {
  return { taskId: "t-scan", tool: t, operation: t.name, input };
}

function trusted(): TrustedProjectPolicy {
  return new TrustedProjectPolicy({ allowedRoots: [workspace] });
}

function configured(): ConfiguredPolicy {
  // The catch-all rule matters: with no fileRules at all the engine default-denies
  // every path ("no matching file rule"), which would mask what is under test.
  const config = parsePolicyConfig(
    { version: 1, onViolation: "block", fileRules: [{ pattern: "**", read: "allow", write: "allow" }] },
    "bounded-scan-test.json",
  );
  return new ConfiguredPolicy(config, { mode: "TRUSTED_PROJECT", base: new DefaultPolicy(), allowedRoots: [workspace] });
}

const TRUNCATION = /incomplete|too deep|truncat|exceed/i;

test("1. TrustedProjectPolicy: an outside-root path is DENIED at every nesting depth", () => {
  const policy = trusted();
  // Within the old bound the boundary catches it; beyond the old bound the
  // candidate was never collected and the call was ALLOWed. The invariant under
  // test is that no nesting depth is ever a way to get an ALLOW.
  for (let levels = 0; levels <= 12; levels += 1) {
    const decision = policy.evaluate(request(readTool, nestedPath(levels)));
    assert.equal(
      decision.decision,
      "DENY",
      `READ_ONLY at nesting ${levels} must be DENY, got ${decision.decision} (${decision.reason ?? "-"})`,
    );
  }
});

test("2. ConfiguredPolicy: an outside-root path is DENIED at every nesting depth", () => {
  const policy = configured();
  for (let levels = 0; levels <= 12; levels += 1) {
    const decision = policy.evaluate(request(readTool, nestedPath(levels)));
    assert.equal(
      decision.decision,
      "DENY",
      `READ_ONLY at nesting ${levels} must be DENY, got ${decision.decision} (${decision.reason ?? "-"})`,
    );
  }
});

test("3. truncation is reported as truncation, not inferred from an empty result", async () => {
  // Imported here rather than at module scope so that the behavioural tests
  // above are the ones that go red first: a missing export is a build error,
  // not evidence about the security decision.
  const { scanToolPathCandidates } = await import("./tool-paths.ts");
  const shallow = scanToolPathCandidates(readTool, { path: "src/a.ts" });
  assert.equal(shallow.truncated, false, "a shallow payload is fully scanned");
  assert.deepEqual(shallow.candidates, ["src/a.ts"], "the path operand is collected");

  const deep = scanToolPathCandidates(readTool, nestedPath(400));
  assert.equal(deep.truncated, true, "a 400-deep payload is explicitly truncated");
  // The distinction the policy needs: empty AND complete is a different fact
  // from empty AND incomplete. Collapsing them is the defect.
  const noPaths = scanToolPathCandidates(readTool, { unrelated: { a: 1 } });
  assert.deepEqual(noPaths.candidates, [], "no path operands here");
  assert.equal(noPaths.truncated, false, "and that is not truncation");
});

test("4. a very deep payload is DENIED and the traversal stays bounded", () => {
  for (const policy of [trusted(), configured()]) {
    const decision = policy.evaluate(request(readTool, nestedPath(5000)));
    assert.equal(decision.decision, "DENY", "a 5000-deep payload must not be ALLOWed");
    assert.ok(
      decision.reason !== undefined && TRUNCATION.test(decision.reason),
      `the reason must name the incomplete scan, got: ${decision.reason ?? "-"}`,
    );
  }
});

test("5. a shallow, in-root payload is still ALLOWed (no false positive)", () => {
  const inside = path.join("src", "a.ts");
  for (const policy of [trusted(), configured()]) {
    assert.equal(policy.evaluate(request(readTool, { path: inside })).decision, "ALLOW", "top level in-root");
    assert.equal(policy.evaluate(request(readTool, { a: { b: { path: inside } } })).decision, "ALLOW", "nested in-root");
  }
});

test("6. the D-027 WRITE depth denial is unchanged and still fires first", () => {
  // D-027 lives in the configured engine, so that is the engine whose write
  // behaviour must be preserved. The reason text is asserted because the read
  // side must not silently take over a case D-027 already rules on.
  const decision = configured().evaluate(request(writeTool, nestedPath(20)));
  assert.equal(decision.decision, "DENY", "a deep WRITE must be DENY");
  assert.match(
    decision.reason ?? "",
    /nesting depth/i,
    `D-027's own reason must be preserved, got: ${decision.reason ?? "-"}`,
  );
});

test("7. destructive-command scanning is not skipped by depth either", () => {
  // A structured tool carrying a `command` argument: the same bounded
  // string-walk that hides a path also hid a destructive command.
  const cmdTool = tool("batch", "READ_ONLY", { command: { type: "string" } });
  const payload = nest({ command: "rm -rf /" }, 10);
  for (const policy of [trusted(), configured()]) {
    const decision = policy.evaluate(request(cmdTool, payload));
    assert.equal(decision.decision, "DENY", "a deeply nested destructive command must be DENY");
  }
  // And the shallow form is still caught by the pattern itself, unchanged.
  const shallow = configured().evaluate(request(cmdTool, { command: "rm -rf /" }));
  assert.equal(shallow.decision, "DENY", "shallow destructive command still denied");
});

test("8. secret-pattern scanning is not skipped by depth either", () => {
  // The pattern walk had its own, lower bound, so it hid credential access
  // independently of the path walk. Verified separately, not assumed to share
  // an implementation: `printenv` is in SECRET_ACCESS_PATTERNS, and past the
  // old bound the walk simply never saw it.
  const cmdTool = tool("batch", "READ_ONLY", { command: { type: "string" } });
  for (const levels of [10, 20]) {
    const payload = nest({ command: "printenv" }, levels);
    for (const policy of [trusted(), configured()]) {
      const decision = policy.evaluate(request(cmdTool, payload));
      assert.equal(decision.decision, "DENY", `secret at nesting ${levels} must be DENY`);
    }
  }
  // Shallow form unchanged: caught by the pattern itself.
  assert.equal(
    trusted().evaluate(request(cmdTool, { command: "printenv" })).decision,
    "DENY",
    "shallow credential access still denied",
  );
});
