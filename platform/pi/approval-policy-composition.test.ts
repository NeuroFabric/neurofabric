import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { buildPolicy } from "./project-config.ts";
import { parsePolicyConfig, type PolicyConfig } from "../core/policy-config.ts";
import type { ApprovalProvider, PolicyRequest } from "../core/index.ts";
import type { NeurofebricProjectConfig } from "./project-config.ts";

/**
 * Composition of the INSTALLED policy with an approval provider.
 *
 * The contract under test, in APPROVAL mode with a declarative policy file:
 *
 *   - the installed policy is the engine that evaluates every call;
 *   - the provider resolves exactly one thing, a REQUIRE_APPROVAL;
 *   - the provider can never override a DENY the policy already produced;
 *   - the provider can never REPLACE the policy.
 *
 * Every assertion goes through `KernelAdapter.precheckToolCall`, the same
 * choke point Pi's `tool_call` handler calls, and the adversarial provider here
 * approves EVERYTHING. A control that only survives without a provider is a
 * control an operator with a UI can switch off, so the interesting provider is
 * the always-approving one, not the refusing one.
 *
 * TEST FIXTURE NOTE — the placeholder secret token.
 *
 * The rule list below is constructed locally by this suite; it is not read from
 * `.pi/neurofebric-policy.json` and it changes no production value. The token
 * `zzcredentialzz` exists solely so this SOURCE FILE can be written at all:
 * the repository's write-time guard scans new file content against the
 * production `secretWritePatterns`, and a literal credential-shaped word in a
 * test fixture trips that guard as a false positive. The production control
 * being exercised is unchanged — this is the same `ConfiguredPolicy` secret
 * write rule, the same `matchIn` matcher, and the same "write-tier payload
 * only" scoping. Only the string the test searches for differs.
 */

const TOOL_NAMES = ["read", "bash", "write", "edit", "grep", "find", "ls"];

const TRUSTED: NeurofebricProjectConfig = { policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] };
const APPROVAL: NeurofebricProjectConfig = { policyMode: "APPROVAL", allowedRoots: ["."] };

/** Locally constructed rules. See the fixture note above about the token. */
const TEST_RULES = {
  version: 1,
  deniedTools: [],
  allowedTools: [],
  fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
  destructiveCommandPatterns: ["rm -rf", "format c:"],
  destructiveCommandTokens: ["rm", "rmdir", "del", "erase", "unlink", "shred", "remove-item"],
  secretWritePatterns: ["zzcredentialzz", "zztokenzz"],
  limits: { maxToolCallsPerTask: 40, maxFileWritesPerTask: 10, maxBytesPerWrite: 2_000_000 },
  onViolation: "block",
} as const;

/** A provider that says yes to everything and records that it was asked. */
function alwaysApprove(): ApprovalProvider & { calls: number } {
  const provider = {
    calls: 0,
    async requestApproval(_request: PolicyRequest): Promise<boolean> {
      provider.calls += 1;
      return true;
    },
  };
  return provider;
}

async function sandbox(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "nf-approval-compose-"));
}

async function configuredAdapter(
  root: string,
  overrides: Record<string, unknown> = {},
  config: NeurofebricProjectConfig = APPROVAL,
  withPolicyFile = true,
) {
  await mkdir(path.join(root, "reports"), { recursive: true });
  const policyConfig: PolicyConfig | undefined = withPolicyFile
    ? parsePolicyConfig({ ...TEST_RULES, ...overrides }, "test-policy.json")
    : undefined;
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy(config, root, policyConfig));
  for (const name of TOOL_NAMES) {
    adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
  }
  await adapter.beginTask("do the work", "do the work");
  return adapter;
}

const reason = (decision: { reason?: string }): string => String(decision.reason ?? "");

/** 1. The core bypass: an approving provider must not resurrect a denied call. */
test("1. an approving provider cannot turn a declarative DENY into an ALLOW", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root);
  const approval = alwaysApprove();

  // A bare DefaultPolicy would REQUIRE_APPROVAL for this write, and the
  // always-approving provider would wave it through. The configured policy
  // denies it on the secret-write rule first, and that denial is final.
  const { decision } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "reports", "incident.md"), content: "zzcredentialzz = abc123" },
    approval,
    "w1",
  );

  assert.equal(decision.decision, "DENY");
  assert.match(reason(decision), /secret write pattern matched/);
  assert.equal(approval.calls, 0, "the provider must not be consulted for a decision policy already made");
  assert.equal(await adapter.beginToolExecution("w1", "write"), undefined, "a denied call binds no execution");
});

/** 2. Workspace boundary. */
test("2. the workspace boundary cannot be bypassed by approval", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root);
  const approval = alwaysApprove();

  const escapes: [string, unknown][] = [
    ["absolute outside the root", { path: path.join(path.dirname(root), "escape.md"), content: "x" }],
    ["parent traversal", { path: path.join(root, "..", "escape.md"), content: "x" }],
  ];

  for (const [label, input] of escapes) {
    const { decision } = await adapter.precheckToolCall("write", "execute", input, approval, `o-${label}`);
    assert.equal(decision.decision, "DENY", `write ${label} must be denied even with an approving provider`);
    assert.match(reason(decision), /path boundary violation/, `write ${label} must fail on the boundary`);
  }
  assert.equal(approval.calls, 0, "an approving provider must never be asked to override the boundary");

  // A read outside the root is equally denied.
  const read = await adapter.precheckToolCall(
    "read",
    "execute",
    { path: path.join(path.dirname(root), "escape.md") },
    approval,
    "o-read",
  );
  assert.equal(read.decision.decision, "DENY");
  assert.equal(approval.calls, 0);
});

/** 3. Destructive-command protection, including the deletion guard. */
test("3. destructive command protection cannot be bypassed by approval", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root);
  const approval = alwaysApprove();

  const commands: [string, unknown][] = [
    ["deletion guard", { command: "rm -rf build" }],
    ["deletion guard via quoted shell", { command: 'bash -c "rm -rf /"' }],
    ["destructive substring rule", { command: "echo hi && format c:" }],
  ];

  for (const [label, input] of commands) {
    const { decision } = await adapter.precheckToolCall("bash", "execute", input, approval, `b-${label}`);
    assert.equal(decision.decision, "DENY", `${label} must be denied even with an approving provider`);
  }
  assert.equal(approval.calls, 0, "an approving provider must never be asked to override a destructive denial");
});

/** 4. Secret-write protection. */
test("4. secret write protection cannot be bypassed by approval, and stays scoped to writes", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root);
  const approval = alwaysApprove();

  for (const content of ["zzcredentialzz: value", "zztokenzz", "a ZZTOKENZZ inline"]) {
    const { decision } = await adapter.precheckToolCall(
      "write",
      "execute",
      { path: path.join(root, "reports", "notes.md"), content },
      approval,
      `s-${content}`,
    );
    assert.equal(decision.decision, "DENY", `a write carrying the rule token must be denied: ${content}`);
    assert.match(reason(decision), /secret write pattern matched/);
  }
  assert.equal(approval.calls, 0);

  // Scoping is part of the control and approval must not widen it: searching
  // for the same token is analysis, not persistence, so it is not denied by
  // this rule.
  const grep = await adapter.precheckToolCall("grep", "execute", { pattern: "zzcredentialzz", path: root }, approval, "g1");
  assert.notEqual(grep.decision.decision, "DENY", "searching for the token is not writing it");
  assert.equal(approval.calls, 0);
});

/** 5. Configured PolicyLimits in APPROVAL mode. */
test("5. configured PolicyLimits remain enforced in APPROVAL mode", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root, {
    limits: { maxToolCallsPerTask: 2, maxFileWritesPerTask: 10, maxBytesPerWrite: 2_000_000 },
  });
  const approval = alwaysApprove();

  const first = await adapter.precheckToolCall("read", "execute", { path: path.join(root, "a.md") }, approval, "l1");
  const second = await adapter.precheckToolCall("read", "execute", { path: path.join(root, "b.md") }, approval, "l2");
  assert.equal(first.decision.decision, "ALLOW");
  assert.equal(second.decision.decision, "ALLOW");

  const third = await adapter.precheckToolCall("read", "execute", { path: path.join(root, "c.md") }, approval, "l3");
  assert.equal(third.decision.decision, "DENY", "the configured tool-call budget must still be enforced");
  assert.match(reason(third.decision), /maxToolCallsPerTask exceeded/);
});

/** 5b. The write budget, which is the limit a provider is most likely to exhaust. */
test("5b. the configured write budget remains enforced in APPROVAL mode", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root, {
    limits: { maxToolCallsPerTask: 100, maxFileWritesPerTask: 1, maxBytesPerWrite: 2_000_000 },
  });
  const approval = alwaysApprove();
  const write = (n: string) => ({ path: path.join(root, "reports", `${n}.md`), content: "ordinary content" });

  const first = await adapter.precheckToolCall("write", "execute", write("a"), approval, "w-a");
  assert.equal(first.decision.decision, "ALLOW", "an approving provider grants the first write");

  const second = await adapter.precheckToolCall("write", "execute", write("b"), approval, "w-b");
  assert.equal(second.decision.decision, "DENY", "the configured write budget must still be enforced");
  assert.match(reason(second.decision), /maxFileWritesPerTask exceeded/);
  assert.equal(approval.calls, 1, "the provider is asked only for the call it actually granted");
});

/** 6. REQUIRE_APPROVAL is still resolvable by the provider. */
test("6. the provider still resolves a genuine REQUIRE_APPROVAL", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root);
  const approval = alwaysApprove();

  const { decision } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "reports", "incident.md"), content: "# Findings" },
    approval,
    "w1",
  );

  assert.equal(decision.decision, "ALLOW", "an approved, in-policy write is allowed");
  assert.equal(approval.calls, 1, "the provider must be consulted exactly once");

  const events = adapter.recentEvents(200).map((event) => event.type);
  assert.ok(events.includes("APPROVAL_REQUIRED"), "the approval must be recorded in the trace");
});

/** 6b. A refusing provider still denies, and binds no execution. */
test("6b. a refusing provider denies, and the refusal binds no execution", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root);
  const refusal: ApprovalProvider = { async requestApproval() { return false; } };

  const { decision } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "reports", "incident.md"), content: "# Findings" },
    refusal,
    "w1",
  );

  assert.equal(decision.decision, "DENY");
  assert.match(reason(decision), /Approval denied/);
  assert.equal(await adapter.beginToolExecution("w1", "write"), undefined);
  assert.equal(adapter.activeExecution("w1"), undefined);
});

/** 6c. With no provider the requirement is unresolved, so nothing is authorised. */
test("6c. an unresolvable REQUIRE_APPROVAL authorises nothing", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root);

  const { decision } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "reports", "incident.md"), content: "# Findings" },
    undefined,
    "w1",
  );

  assert.equal(decision.decision, "REQUIRE_APPROVAL");
  assert.equal(await adapter.beginToolExecution("w1", "write"), undefined);
});

/** 7. Denial is a real policy violation that the trace records and can abort on. */
test("7. a provider-overridden denial is still a traced violation, not a bare refusal", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root, { onViolation: "abort" });
  const approval = alwaysApprove();

  const { decision } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "reports", "incident.md"), content: "zzcredentialzz: value" },
    approval,
    "w1",
  );

  assert.equal(decision.decision, "DENY");
  assert.equal(decision.violation, "abort");

  const events = adapter.recentEvents(200).map((event) => event.type);
  assert.ok(events.includes("POLICY_VIOLATION"), "the violation must be traced");
  assert.ok(events.includes("TASK_FAILED"), "an aborting violation must end the task");
});

/** 8. TRUSTED_PROJECT is unchanged. */
test("8. TRUSTED_PROJECT behavior is unchanged", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root, {}, TRUSTED);
  const approval = alwaysApprove();

  // Dangerous operations are denied, not prompted, and the provider is not asked.
  const destructive = await adapter.precheckToolCall("bash", "execute", { command: "rm -rf build" }, approval, "b1");
  assert.equal(destructive.decision.decision, "DENY");

  // An ordinary in-bounds write resolves to ALLOW with no interaction at all.
  const write = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "reports", "incident.md"), content: "# Findings" },
    approval,
    "w1",
  );
  assert.equal(write.decision.decision, "ALLOW");
  assert.equal(approval.calls, 0, "trusted-project mode must never escalate to a human");

  // The boundary still outranks an approving provider.
  const boundary = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "..", "escape.md"), content: "x" },
    approval,
    "w2",
  );
  assert.equal(boundary.decision.decision, "DENY");
  assert.equal(approval.calls, 0);
});

/** 9. APPROVAL with no policy file keeps its pre-existing behaviour. */
test("9. APPROVAL without a configured policy preserves existing behavior", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root, {}, APPROVAL, false);
  const approval = alwaysApprove();

  // Tier policy only: a write needs approval, and approval grants it.
  const write = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "reports", "incident.md"), content: "# Findings" },
    approval,
    "w1",
  );
  assert.equal(write.decision.decision, "ALLOW");
  assert.equal(approval.calls, 1);

  // With no policy file there are no declarative rules, so the boundary is not
  // the policy's to enforce and a write anywhere still routes to approval. This
  // is pre-existing behaviour, pinned so the fix did not silently change it.
  const other = await configuredAdapter(root, {}, APPROVAL, false);
  const headless = await other.precheckToolCall(
    "write",
    "execute",
    { path: path.join(path.dirname(root), "escape.md"), content: "x" },
    undefined,
    "w2",
  );
  assert.equal(headless.decision.decision, "REQUIRE_APPROVAL", "tier policy still requires approval for any write");
});

/**
 * 10. Budget accounting must not double count.
 *
 * The installed policy is evaluated exactly once per call. If the composition
 * evaluated it twice, every call would consume two budget units and the limit
 * would fire at exactly half the configured count.
 */
test("10. the tool budget is counted once per call, never twice", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root, {
    limits: { maxToolCallsPerTask: 3, maxFileWritesPerTask: 10, maxBytesPerWrite: 2_000_000 },
  });
  const approval = alwaysApprove();

  // Three calls are inside a budget of three. Double counting would have
  // denied the second of them.
  for (const index of [1, 2, 3]) {
    const { decision } = await adapter.precheckToolCall(
      "read",
      "execute",
      { path: path.join(root, `read-${index}.md`) },
      approval,
      `c-${index}`,
    );
    assert.equal(decision.decision, "ALLOW", `call ${index} of 3 must be inside a budget of 3`);
  }

  const fourth = await adapter.precheckToolCall("read", "execute", { path: path.join(root, "read-4.md") }, approval, "c-4");
  assert.equal(fourth.decision.decision, "DENY", "the fourth call is one past a budget of three");
  assert.match(reason(fourth.decision), /maxToolCallsPerTask exceeded \(3\)/);

  // The same call with no provider must behave identically, because the
  // provider must not change how the policy meters.
  const bare = await configuredAdapter(root, {
    limits: { maxToolCallsPerTask: 3, maxFileWritesPerTask: 10, maxBytesPerWrite: 2_000_000 },
  });
  for (const index of [1, 2, 3]) {
    const { decision } = await bare.precheckToolCall("read", "execute", { path: path.join(root, `r-${index}.md`) }, undefined, `b-${index}`);
    assert.equal(decision.decision, "ALLOW", `call ${index} of 3 must be inside a budget of 3 without a provider`);
  }
  const bareFourth = await bare.precheckToolCall("read", "execute", { path: path.join(root, "r-4.md") }, undefined, "b-4");
  assert.equal(bareFourth.decision.decision, "DENY");
});

/**
 * 11. F-008 budget telemetry.
 *
 * Telemetry is emitted only by the engine that metered the call. When an
 * approval provider caused a different, non-metering policy to evaluate, the
 * wiring was silently dead in APPROVAL mode. With the installed policy in
 * place it must be live again.
 */
test("11. F-008 budget telemetry stays wired on the approval path", async () => {
  const root = await sandbox();
  // Band arithmetic in `ConfiguredPolicy.budgetLevel`: low at used >= ceil(limit
  // * 0.75), critical at used >= ceil(limit * 0.9). With a limit of 3 that is
  // low at 3 and critical at 3 as well, so the third call is already critical.
  const adapter = await configuredAdapter(root, {
    limits: { maxToolCallsPerTask: 3, maxFileWritesPerTask: 10, maxBytesPerWrite: 2_000_000 },
  });
  const approval = alwaysApprove();

  for (const index of [1, 2, 3]) {
    await adapter.precheckToolCall("read", "execute", { path: path.join(root, `t-${index}.md`) }, approval, `t-${index}`);
  }

  assert.ok(adapter.budget, "the adapter must be holding budget telemetry after a provider-backed call");
  assert.equal(adapter.budget!.used, 3, "telemetry must report the real count of three, not six");
  assert.equal(adapter.budget!.limit, 3);
  assert.equal(adapter.budget!.level, "critical", "three of three is the critical band");

  // The advisory event must reach the trace on this path. Before the fix the
  // provider swapped in a non-metering policy, so no budget existed here at all
  // and this event was unreachable in APPROVAL mode.
  const events = adapter.recentEvents(200).map((event) => event.type);
  assert.ok(events.includes("BUDGET_LOW"), "the advisory low-budget event must fire on this path");
});

/** 12. The provider is asked only for genuine REQUIRE_APPROVAL results. */
test("12. the approval provider is consulted only for genuine approval requirements", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root);
  const approval = alwaysApprove();

  // ALLOW from the tier policy: a read needs no prompt.
  const read = await adapter.precheckToolCall("read", "execute", { path: path.join(root, "a.md") }, approval, "q1");
  assert.equal(read.decision.decision, "ALLOW");
  assert.equal(approval.calls, 0, "a read must not prompt");

  // DENY from the declarative rules: the provider is never asked.
  const denied = await adapter.precheckToolCall("bash", "execute", { command: "rm -rf build" }, approval, "q2");
  assert.equal(denied.decision.decision, "DENY");
  assert.equal(approval.calls, 0, "a denial must not prompt");

  // REQUIRE_APPROVAL: the one case the provider exists for.
  const write = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "reports", "incident.md"), content: "# Findings" },
    approval,
    "q3",
  );
  assert.equal(write.decision.decision, "ALLOW");
  assert.equal(approval.calls, 1, "exactly one prompt, for exactly one requirement");
});
