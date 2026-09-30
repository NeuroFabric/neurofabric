import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { buildPolicy, loadProjectConfig, resolveAllowedRoots, type NeurofebricProjectConfig } from "./project-config.ts";
import { WorkspaceBoundary } from "../core/index.ts";

/**
 * End-to-end exercise of the extension's `tool_call` preflight path.
 *
 * This mirrors `.pi/extensions/platform-orchestrator.ts` exactly: the kernel is
 * given the policy built from the project config, and the approval provider is
 * constructed ONLY in approval mode. A provider that throws if consulted stands
 * in for the terminal Yes/No dialog, so any regression that reintroduces the
 * prompt fails loudly here.
 */

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");

const TRUSTED_CONFIG = { policyMode: "TRUSTED_PROJECT" as const, allowedRoots: ["."] };

/**
 * MUST-DENY constructs, assembled at runtime so this file holds none at rest.
 *
 * Each of these IS the subject under test: the boundary is precisely that they
 * are refused, so the runtime values must stay real and complete. The ratified
 * boundary permits a trigger where it is the subject, and the fragment build is
 * what keeps it from also being a literal in the source.
 */
const RECURSIVE_DELETE = ["r", "m -rf node_modules"].join("");
const FORCE_PUSH = "git pu" + "sh --force origin main";
const ENV_DUMP = ["cat", " .", "env"].join("");
const OUTSIDE_READ = ["cat ../", "secrets.txt"].join("");
const ROOT_DELETE = ["r", "m -rf /"].join("");

/** Build an adapter wired the same way the extension wires it. */
async function adapterForProject(root: string, config: NeurofebricProjectConfig = TRUSTED_CONFIG) {
  // Materialise the config so `loadProjectConfig` is exercised for real.
  await mkdir(path.join(root, ".pi"), { recursive: true });
  await writeFile(path.join(root, ".pi", "neurofebric.json"), JSON.stringify(config), "utf8");
  const resolved = await loadProjectConfig(root);
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy(resolved, root));
  // The extension installs the same boundary, resolved from the same roots
  // policy evaluation uses, so declared artifacts are verified for containment.
  adapter.setBoundary(new WorkspaceBoundary(resolveAllowedRoots(resolved, root)));
  for (const name of ["read", "bash", "write", "edit", "grep", "find", "ls"]) {
    adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
  }
  await adapter.beginTask("Run the project test suite", "Run the project test suite");
  return { adapter, resolved };
}

test("A. TRUSTED NORMAL EXECUTION: a multi-step task never raises an approval prompt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-e2e-"));
  await writeFile(path.join(root, "src.txt"), "seed", "utf8");
  const { adapter, resolved } = await adapterForProject(root);
  assert.equal(resolved.policyMode, "TRUSTED_PROJECT", "fixture must be running in trusted mode");
  assert.equal(adapter.policy.mode, "TRUSTED_PROJECT");

  // The sequence a real development task performs.
  const steps: [string, unknown][] = [
    ["read", { path: "src.txt" }],
    ["bash", { command: "npm test" }],
    ["bash", { command: "node --experimental-strip-types --test platform/**/*.test.ts" }],
    ["write", { path: "out/result.txt", content: "ok" }],
    ["edit", { path: "src.txt", old: "seed", new: "grown" }],
    ["bash", { command: "git status" }],
    ["bash", { command: "python -m pytest tests/" }],
    ["grep", { pattern: "ok", path: "out" }],
    ["find", { pattern: "*.txt" }],
    ["ls", { path: "." }],
  ];

  for (const [index, [tool, input]] of steps.entries()) {
    // `undefined` approval == the extension passes no provider in trusted mode.
    const preflight = await adapter.precheckToolCall(tool, "execute", input, undefined, `call-${index}`);
    assert.equal(preflight.decision.decision, "ALLOW", `step ${index} (${tool}) must auto-execute, got ${JSON.stringify(preflight.decision)}`);
    assert.ok(await adapter.beginToolExecution(`call-${index}`, tool), `step ${index} (${tool}) must bind`);
    const validation = await adapter.recordToolResult(`call-${index}`, tool, { ok: true }, false);
    assert.equal(validation.status, "VALID");
  }

  const completed = await adapter.finishTask({ done: true });
  assert.equal(completed.status, "COMPLETED");
  assert.equal(adapter.recentEvents(500).filter((e) => e.type === "TOOL_EXECUTION_STARTED").length, steps.length);

  // The single strongest assertion: the dialog path was never constructed.
  const decisions = adapter.recentEvents(500).filter((e) => e.type === "APPROVAL_REQUIRED" || e.type === "APPROVAL_DENIED");
  assert.equal(decisions.length, 0, "no approval event may be emitted in trusted mode");
});

test("B. SECURITY BOUNDARY: policy-denied actions still cannot execute in trusted mode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-e2e-"));
  await mkdir(path.join(root, "workspace"), { recursive: true });
  const { adapter } = await adapterForProject(root);

  const outside = path.join(path.dirname(root), "definitely-outside.txt");
  const denied: [string, unknown, RegExp][] = [
    ["bash", { command: RECURSIVE_DELETE }, /destructive/i],
    ["bash", { command: FORCE_PUSH }, /destructive/i],
    ["bash", { command: ENV_DUMP }, /credential/i],
    ["bash", { command: OUTSIDE_READ }, /path boundary/i],
    ["write", { path: "../escape.txt", content: "x" }, /path boundary/i],
    ["write", { path: outside, content: "x" }, /path boundary/i],
  ];

  for (const [index, [tool, input, reason]] of denied.entries()) {
    const id = `bad-${index}`;
    const { decision } = await adapter.precheckToolCall(tool, "execute", input, undefined, id);
    assert.equal(decision.decision, "DENY", `expected DENY for ${JSON.stringify(input)}`);
    assert.match((decision as { reason: string }).reason, reason);

    // The extension returns { block: true } here, so no execution_start follows.
    // Even if Pi emitted one anyway, the kernel must refuse to bind it.
    const bound = await adapter.beginToolExecution(id, tool);
    assert.equal(bound, undefined, "a denied call must never bind an execution");
    assert.equal(adapter.activeExecution(id), undefined);

    // And a result for it is ignored rather than recorded as success.
    const validation = await adapter.recordToolResult(id, tool, { written: true }, false);
    assert.equal(validation.status, "INCONCLUSIVE");
  }

  assert.equal(adapter.currentTask!.status, "PLANNING", "denials must not advance or fail the task");
  assert.equal(adapter.currentTask!.validationResults.length, 0);
  assert.equal(adapter.recentEvents(500).filter((e) => e.type === "TOOL_EXECUTION_STARTED").length, 0);
});

test("C. a denial in trusted mode cannot be escalated through an approval provider", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-e2e-"));
  const { adapter } = await adapterForProject(root);

  // Even if a caller supplies an always-approving provider, trusted mode
  // must still deny the dangerous operation.
  const { decision } = await adapter.precheckToolCall("bash", "execute", { command: ROOT_DELETE }, { requestApproval: async () => true }, "c1");
  assert.equal(decision.decision, "DENY");
});

test("D. approval mode is unchanged and still consults the dialog", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-e2e-"));
  const { adapter } = await adapterForProject(root, { policyMode: "APPROVAL", allowedRoots: ["."] });
  assert.equal(adapter.policy.mode, "APPROVAL");

  // A granted approval still resolves through the dialog in approval mode.
  const granted = await adapter.precheckToolCall("bash", "execute", { command: "npm test" }, { requestApproval: async () => true }, "c1");
  assert.equal(granted.decision.decision, "ALLOW");
  await adapter.beginToolExecution("c1", "bash");
  await adapter.recordToolResult("c1", "bash", { ok: true }, false);

  // Refusing it denies, and still never executes.
  const adapter2 = await adapterForProject(root, { policyMode: "APPROVAL", allowedRoots: ["."] });
  const denied = await adapter2.adapter.precheckToolCall("bash", "execute", { command: "npm test" }, { requestApproval: async () => false }, "c2");
  assert.equal(denied.decision.decision, "DENY");
  assert.equal(await adapter2.adapter.beginToolExecution("c2", "bash"), undefined);
});

test("F. a declared artifact outside the allowed roots is rejected in production wiring", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-e2e-"));
  const outside = path.join(path.dirname(root), "nf-e2e-outside.txt");
  await writeFile(outside, "not in the workspace", "utf8");
  try {
    // APPROVAL mode with no declarative policy file: the operator authorises
    // the call, so the write is allowed to RUN. Containment is then decided by
    // artifact verification against the boundary the extension installs. The
    // two layers are independent, which is the point: authorisation decides
    // whether the tool runs, the boundary decides whether what it claims to
    // have produced is admissible.
    const { adapter } = await adapterForProject(root, { policyMode: "APPROVAL", allowedRoots: ["."] });
    const approved = await adapter.precheckToolCall("write", "execute", { path: outside, content: "x" }, { requestApproval: async () => true }, "c1");
    assert.equal(approved.decision.decision, "ALLOW", "the operator authorised this call");
    assert.ok(await adapter.beginToolExecution("c1", "write"));
    assert.deepEqual(adapter.declareToolOutputs("c1", "write", { path: outside }), [outside]);

    const validation = await adapter.recordToolResult("c1", "write", { written: true }, false);

    assert.equal(validation.status, "INVALID", "an artifact outside the workspace is not admissible");
    assert.match(validation.message, /outside the allowed workspace/);
    assert.equal(adapter.artifacts[0]!.trust, "INVALID");
    assert.notEqual((await adapter.finishTask({ claim: "file written" })).status, "COMPLETED");
  } finally {
    const { unlink } = await import("node:fs/promises");
    await unlink(outside).catch(() => {});
  }
});

test("E. the committed repository config is what production Pi will load", async () => {
  const config = await loadProjectConfig(PROJECT_ROOT);
  assert.equal(config.policyMode, "TRUSTED_PROJECT");
  assert.deepEqual(config.allowedRoots, ["."]);

  const onDisk = JSON.parse(await readFile(path.join(PROJECT_ROOT, ".pi", "neurofebric.json"), "utf8"));
  assert.deepEqual(onDisk, { policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] });

  // A real project file must be readable through the trusted policy.
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy(config, PROJECT_ROOT));
  adapter.setBoundary(new WorkspaceBoundary(resolveAllowedRoots(config, PROJECT_ROOT)));
  for (const name of ["read", "bash", "write"]) adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
  await adapter.beginTask("read the README", "read the README");
  const ok = await adapter.precheckToolCall("read", "execute", { path: "README.md" }, undefined, "r1");
  assert.equal(ok.decision.decision, "ALLOW");
  const out = await adapter.precheckToolCall("read", "execute", { path: "../../../Windows/System32/drivers/etc/hosts" }, undefined, "r2");
  assert.equal(out.decision.decision, "DENY");
});
