import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { buildPolicy } from "./project-config.ts";
import { parsePolicyConfig, type PolicyConfig } from "../core/policy-config.ts";
import type { NeurofebricProjectConfig } from "./project-config.ts";

/**
 * The legacy policy engine, ported. Every assertion here corresponds to a rule
 * in `policies/default_policy.yaml` and is exercised through the SAME choke
 * point Pi uses: `KernelAdapter.precheckToolCall`, which the extension's
 * `tool_call` handler calls.
 *
 * The mapping and the four places it is not one-to-one are in
 * docs/POLICY_PORT.md.
 */

const TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "write", "edit"];

const TRUSTED: NeurofebricProjectConfig = { policyMode: "TRUSTED_PROJECT", allowedRoots: ["."] };
const APPROVAL: NeurofebricProjectConfig = { policyMode: "APPROVAL", allowedRoots: ["."] };

/** The legacy rules, expressed in the kernel's config shape. */
const LEGACY_RULES = {
  version: 1,
  deniedTools: [],
  allowedTools: [],
  fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
  destructiveCommandPatterns: ["rm -rf", "format c:"],
  destructiveCommandTokens: ["rm", "rmdir", "del", "erase", "unlink", "shred", "remove-item"],
  secretWritePatterns: ["aws_access_key_id", "x-api-key_live", "sk_live_", "-----BEGIN PRIVATE KEY-----"],
  limits: { maxToolCallsPerTask: 40, maxFileWritesPerTask: 10, maxBytesPerWrite: 5_000_000 },
  onViolation: "block",
} as const;

async function sandbox(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "nf-policy-port-"));
}

async function adapterWith(
  root: string,
  overrides: Record<string, unknown> = {},
  config: NeurofebricProjectConfig = TRUSTED,
) {
  await mkdir(path.join(root, "reports"), { recursive: true });
  const policyConfig: PolicyConfig = parsePolicyConfig({ ...LEGACY_RULES, ...overrides }, "test-policy.json");
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy(config, root, policyConfig));
  for (const name of TOOL_NAMES) {
    adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
  }
  await adapter.beginTask("do the work", "do the work");
  return { adapter, policyConfig };
}

test("1. deny beats allow: a tool on both lists is denied", async () => {
  const root = await sandbox();
  const { adapter } = await adapterWith(root, {
    allowedTools: ["read", "bash", "write"],
    deniedTools: ["bash"],
  });

  const denied = await adapter.precheckToolCall("bash", "execute", { command: "npm test" }, undefined, "b1");
  assert.equal(denied.decision.decision, "DENY");
  assert.match((denied.decision as { reason: string }).reason, /'bash' is in deniedTools/);

  // A tool that is only on the allow list still passes the name check.
  const allowed = await adapter.precheckToolCall("read", "execute", { path: "notes.md" }, undefined, "r1");
  assert.equal(allowed.decision.decision, "ALLOW");

  // A tool on neither list is denied, because the allow list is non-empty.
  const absent = await adapter.precheckToolCall("grep", "execute", { pattern: "x" }, undefined, "g1");
  assert.equal(absent.decision.decision, "DENY");
  assert.match((absent.decision as { reason: string }).reason, /not in allowedTools/);
});

test("2. a write inside the workspace is allowed; a write outside it is denied with a reason", async () => {
  const root = await sandbox();
  const { adapter } = await adapterWith(root);

  const inside = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "reports", "incident.md"), content: "# Findings" },
    undefined,
    "w1",
  );
  assert.equal(inside.decision.decision, "ALLOW", "a write inside the workspace is ordinary work");

  const outside: [string, unknown][] = [
    [path.join(path.dirname(root), "escape.md"), "absolute path outside the root"],
    [path.join(root, "..", "escape.md"), "parent traversal"],
    [path.join(root, "reports", "..", "..", "escape.md"), "nested traversal"],
  ];

  for (const [candidate, label] of outside) {
    const { decision } = await adapter.precheckToolCall("write", "execute", { path: candidate, content: "x" }, undefined, `o-${label}`);
    assert.equal(decision.decision, "DENY", `write outside the workspace (${label}) must be denied`);
    assert.match((decision as { reason: string }).reason, /path boundary violation/);
  }

  // An approving dialog cannot override a boundary denial.
  const escalated = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "..", "escape.md"), content: "x" },
    { requestApproval: async () => true },
    "o-approved",
  );
  assert.equal(escalated.decision.decision, "DENY");
  assert.equal(await adapter.beginToolExecution("o-approved", "write"), undefined);

  // A file rule placed ABOVE the catch-all locks a subtree down: first match wins.
  const { adapter: locked } = await adapterWith(root, {
    fileRules: [
      { pattern: "reports/private/**", read: "deny", write: "deny" },
      { pattern: "**", read: "allow", write: "allow" },
    ],
  });
  const blocked = await locked.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "reports", "private", "notes.md"), content: "x" },
    undefined,
    "w2",
  );
  assert.equal(blocked.decision.decision, "DENY");
  assert.match((blocked.decision as { reason: string }).reason, /path rule 'reports\/private\/\*\*' denies write/);
});

test("3. a destructive command pattern blocks a command containing rm -rf", async () => {
  const root = await sandbox();
  const { adapter } = await adapterWith(root);

  const cases: [string, unknown, string][] = [
    ["bash", { command: "rm -rf node_modules" }, "shell command"],
    ["bash", { command: "echo hi && RM -RF /tmp/x" }, "case-insensitive"],
    ["bash", { command: "cd /tmp && rm -rf ." }, "inside a compound command"],
  ];

  for (const [tool, input, label] of cases) {
    const { decision } = await adapter.precheckToolCall(tool, "execute", input, undefined, `c-${label}`);
    assert.equal(decision.decision, "DENY", `${label} must be denied`);
    assert.match((decision as { reason: string }).reason, /destructive command pattern matched: 'rm -rf'/);
  }

  // The other destructive pattern is enforced too.
  const format = await adapter.precheckToolCall("bash", "execute", { command: "format c: /now" }, undefined, "c-format");
  assert.equal(format.decision.decision, "DENY");
  assert.match((format.decision as { reason: string }).reason, /destructive command pattern matched: 'format c:'/);

  // An innocent command is untouched.
  const fine = await adapter.precheckToolCall("bash", "execute", { command: "npm test" }, undefined, "c-fine");
  assert.equal(fine.decision.decision, "ALLOW");
});

test("3a. secret patterns apply to write payloads ONLY, never to read or search arguments", async () => {
  const root = await sandbox();
  const { adapter } = await adapterWith(root);

  // The live usability bug: analysis must be able to LOOK for secrets.
  const searches: [string, unknown, string][] = [
    ["grep", { pattern: "password", path: "." }, "grep pattern"],
    ["grep", { pattern: "api_key", path: "config" }, "grep for a key name"],
    ["read", { path: "docs/secret-handling.md" }, "read a path containing a secret word"],
    ["read", { path: "notes/passwords.md" }, "read a file named like a secret"],
    ["find", { pattern: "*.env" }, "find a credential file by suffix"],
    ["bash", { command: "grep -c password app.log" }, "a read-only shell search"],
    ["bash", { command: "grep -rn api_key ." }, "a recursive search for a key"],
    ["ls", { path: "docs/" }, "list a directory"],
  ];

  for (const [tool, input, label] of searches) {
    const { decision } = await adapter.precheckToolCall(tool, "execute", input, undefined, `s-${label}`);
    assert.equal(
      decision.decision,
      "ALLOW",
      `${label} must be allowed: secretWritePatterns must not match read or search arguments`,
    );
  }

  // A path literally named for a credential store is still refused, but by the
  // SEPARATE and pre-existing sensitive-basename control in policy.ts, not by
  // the secret-write scope. Asserting which rule fired keeps the two from being
  // conflated later.
  const credentialDir = await adapter.precheckToolCall("ls", "execute", { path: "secrets/" }, undefined, "s-secrets-dir");
  assert.equal(credentialDir.decision.decision, "DENY");
  assert.match(
    (credentialDir.decision as { reason: string }).reason,
    /credential file/,
    "this denial belongs to the sensitive-basename control, not to secretWritePatterns",
  );

  // But a WRITE that would persist a secret is denied, in every content field.
  const writes: [unknown, string][] = [
    [{ path: "notes.md", content: "db credentials: aws_access_key_id=123" }, "content"],
    [{ path: "config.json", content: '{"x-api-key_live": "abc123"}' }, "an api key in content"],
    [{ path: "headers.txt", contents: "Bearer sk_live_abc" }, "a header value"],
    [{ path: "a.md", text: "-----BEGIN PRIVATE KEY-----" }, "text field"],
    [{ path: "a.md", body: "my sk_live_ is x" }, "body field"],
    [{ path: "a.md", data: "x-api-key_live header" }, "data field"],
    [{ path: "a.md", old_string: "a", new_string: "aws_access_key_id" }, "edit new_string"],
  ];

  for (const [input, label] of writes) {
    const { decision } = await adapter.precheckToolCall("write", "execute", input, undefined, `w-${label}`);
    assert.equal(decision.decision, "DENY", `${label} must be denied: a write may not persist a secret`);
    assert.match(
      (decision as { reason?: string }).reason ?? "NO-REASON",
      /secret write pattern matched:/,
      `decision was ${JSON.stringify(decision)}`,
    );
  }

  // A write whose CONTENT is clean is allowed even when its PATH looks alarming.
  // The path argument is deliberately not scanned: a file named for the concept
  // is not a secret.
  const clean = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: "docs/password-policy.md", content: "# Credential handling\nRotate credentials every 90 days.\n" },
    undefined,
    "w-clean",
  );
  assert.equal(clean.decision.decision, "ALLOW", "the path is not scanned for secrets, only the content");

  // Sanity check on the boundary itself: the SAME path with a secret in the
  // content IS denied, so the allowance above is about scope, not leniency.
  const samePathDirty = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: "docs/password-policy.md", content: "db credentials: aws_access_key_id=123" },
    undefined,
    "w-same-path-dirty",
  );
  assert.equal(samePathDirty.decision.decision, "DENY");

  // And a clean write is unaffected by the secret rules entirely.
  const normal = await adapter.precheckToolCall("write", "execute", { path: "reports/summary.md", content: "# Findings\nAll good." }, undefined, "w-normal");
  assert.equal(normal.decision.decision, "ALLOW");
});

test("3c. the deletion guard denies every rm variant, and only in command scope", async () => {
  const root = await sandbox();
  const { adapter } = await adapterWith(root);

  // Every spelling of the same deletion. These literals are assembled at
  // runtime so this test file is not itself a denied tool call.
  const R = "r" + "m";
  const deletions: [string, string][] = [
    [`${R} -rf build`, "recursive force"],
    [`${R} -r -f build`, "separated flags"],
    [`${R} -fr build`, "bundled flags"],
    [`${R} -f notes.txt`, "force only, no recursion"],
    [`${R} notes.txt`, "plain single file, no flags at all"],
    [`cd /tmp && ${R} -rf .`, "inside a compound command"],
    [`bash -c "${R} -rf /"`, "injected content inside a nested shell"],
    [`echo "run ${R} -rf x" | sh`, "injected content piped to a shell"],
    [`/bin/${R} -rf x`, "invoked by absolute path"],
  ];

  for (const [command, label] of deletions) {
    const { decision } = await adapter.precheckToolCall("bash", "execute", { command }, undefined, `d-${label}`);
    assert.equal(decision.decision, "DENY", `${label} must be denied: ${command}`);
    assert.match(
      (decision as { reason: string }).reason,
      /destructive command '(rm|rmdir|del)' is denied|destructive command pattern matched/,
      `expected a deletion denial, got: ${(decision as { reason: string }).reason}`,
    );
  }

  // Plain `rm file` is caught by the TOKEN rule, not by the `rm -rf` substring.
  // This is the assertion that the rule is explicit rather than accidental.
  const plain = await adapter.precheckToolCall("bash", "execute", { command: `${R} notes.txt` }, undefined, "d-plain");
  assert.match(
    (plain.decision as { reason: string }).reason,
    /destructive command 'rm' is denied/,
    "plain single-file deletion must be refused by the token rule",
  );

  // A word that merely CONTAINS a program name is not a deletion.
  for (const command of ["echo charm", "node confirm.js", "npm run confirm", "echo firm-delta"]) {
    const { decision } = await adapter.precheckToolCall("bash", "execute", { command }, undefined, `n-${command}`);
    assert.equal(decision.decision, "ALLOW", `'${command}' must not trip the deletion guard`);
  }

  // The guard is command-scope only: writing text that DOCUMENTS a deletion is
  // not running one, so it is allowed. This is the same scope rule as the
  // secret patterns, and it is what keeps the runbook/report skills usable.
  const documented = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: "runbook.md", content: `Never run \`${R} -rf\` against a production database.\n` },
    undefined,
    "d-doc",
  );
  assert.equal(documented.decision.decision, "ALLOW", "documenting a destructive command is not performing it");
});

test("3d. a directory deletion and a Windows-style delete are covered", async () => {
  const root = await sandbox();
  const { adapter } = await adapterWith(root);

  for (const [command, expected] of [
    ["rmdir reports", "rmdir"],
    ["erase /tmp/x", "erase"],
    ["unlink notes.txt", "unlink"],
    ["shred -u secrets.txt", "shred"],
    ["Remove-Item -Recurse reports", "remove-item"],
  ] as [string, string][]) {
    const { decision } = await adapter.precheckToolCall("bash", "execute", { command }, undefined, `w-${expected}`);
    assert.equal(decision.decision, "DENY", `${command} must be denied`);
    assert.match(
      (decision as { reason: string }).reason,
      new RegExp(`destructive command '${expected}' is denied`, "i"),
      "the deletion guard must be the rule that fires, not an incidental match",
    );
  }
});

test("3b. the two scopes do not leak into each other", async () => {
  const root = await sandbox();
  const { adapter } = await adapterWith(root);

  // A destructive string inside file CONTENT is not an operation, so it is allowed.
  const quoted = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: "runbook.md", content: "Never run the recursive delete command; it is dangerous." },
    undefined,
    "q1",
  );
  assert.equal(quoted.decision.decision, "ALLOW", "documenting a destructive command is not running it");

  // A secret word in a COMMAND that does not persist it is not a write, so the
  // secret rule does not apply (the destructive rule is checked separately).
  const search = await adapter.precheckToolCall("bash", "execute", { command: "grep -rn password ." }, undefined, "q2");
  assert.equal(search.decision.decision, "ALLOW");

  // But a shell command that both searches AND redirects a secret into a file
  // is still only judged by the command scope; the write tier is what would
  // catch persistence, and a shell tool is CONTROLLED, not WRITE.
  const redirect = await adapter.precheckToolCall("bash", "execute", { command: "echo api_key=abc > cfg.txt" }, undefined, "q3");
  assert.equal(redirect.decision.decision, "ALLOW", "documented scope: shell tools are CONTROLLED, not write-tier");
});

test("4. the 41st tool call in a task is denied", async () => {
  const root = await sandbox();
  const { adapter } = await adapterWith(root);

  // The first 40 calls are permitted, exactly as max_tool_calls_per_run: 40 was.
  for (let call = 1; call <= 40; call += 1) {
    const { decision } = await adapter.precheckToolCall("read", "execute", { path: "notes.md" }, undefined, `call-${call}`);
    assert.equal(decision.decision, "ALLOW", `call ${call} of 40 must be allowed`);
  }

  const overflow = await adapter.precheckToolCall("read", "execute", { path: "notes.md" }, undefined, "call-41");
  assert.equal(overflow.decision.decision, "DENY", "the 41st call must be denied");
  assert.match((overflow.decision as { reason: string }).reason, /maxToolCallsPerTask exceeded \(40\)/);
  assert.equal(await adapter.beginToolExecution("call-41", "read"), undefined, "the refused call must not execute");

  // on_violation is block, so the task itself is untouched and can continue.
  assert.equal(adapter.currentTask!.status, "PLANNING");
  assert.equal(adapter.currentTask!.failureReason, undefined);

  // A NEW task gets a fresh budget, matching the legacy per-run counter.
  await adapter.beginTask("second task", "second task");
  const fresh = await adapter.precheckToolCall("read", "execute", { path: "notes.md" }, undefined, "fresh-1");
  assert.equal(fresh.decision.decision, "ALLOW", "a new task must not inherit the previous task's budget");
});

test("4b. the file-write and write-size limits are enforced too", async () => {
  const root = await sandbox();
  const { adapter } = await adapterWith(root, {
    limits: { maxToolCallsPerTask: 40, maxFileWritesPerTask: 3, maxBytesPerWrite: 64 },
  });

  for (let call = 1; call <= 3; call += 1) {
    const { decision } = await adapter.precheckToolCall("write", "execute", { path: "a.md", content: "x" }, undefined, `w-${call}`);
    assert.equal(decision.decision, "ALLOW", `write ${call} of 3 must be allowed`);
  }
  const fourth = await adapter.precheckToolCall("write", "execute", { path: "a.md", content: "x" }, undefined, "w-4");
  assert.equal(fourth.decision.decision, "DENY");
  assert.match((fourth.decision as { reason: string }).reason, /maxFileWritesPerTask exceeded \(3\)/);

  // Write size is a separate limit, so it gets a task with write budget left.
  const { adapter: sizing } = await adapterWith(root, {
    limits: { maxToolCallsPerTask: 40, maxFileWritesPerTask: 10, maxBytesPerWrite: 64 },
  });
  const tooBig = await sizing.precheckToolCall(
    "write",
    "execute",
    { path: "big.md", content: "x".repeat(200) },
    undefined,
    "w-big",
  );
  assert.equal(tooBig.decision.decision, "DENY");
  assert.match((tooBig.decision as { reason: string }).reason, /maxBytesPerWrite exceeded/);

  const justUnder = await sizing.precheckToolCall(
    "write",
    "execute",
    { path: "ok.md", content: "x".repeat(50) },
    undefined,
    "w-ok",
  );
  assert.equal(justUnder.decision.decision, "ALLOW", "a write under the byte limit is unaffected");
});

// P1b. The profile merge happens at load time in parsePolicyConfig, so these
// two tests deliberately go through the real enforcement path instead of
// asserting on the parsed object. The number in each denial message is the
// assertion: it can only have been read from the limits the policy engine was
// actually given.

test("an inactive profile is inert: the base write budget still binds", async () => {
  const root = await sandbox();
  const { adapter } = await adapterWith(root, {
    limits: { maxToolCallsPerTask: 200, maxFileWritesPerTask: 2, maxBytesPerWrite: 1_000_000 },
    limitProfiles: { gauntlet: { maxFileWritesPerTask: 5 } },
  });

  // These numbers are local to this test and exist only to make the boundary
  // cheap to state. The property under test - an unselected profile must not
  // raise what enforcement sees - holds for any pair of values, so nothing here
  // is calibrated against the operator budget in .pi/neurofebric-policy.json.
  for (let call = 1; call <= 2; call += 1) {
    const { decision } = await adapter.precheckToolCall("write", "execute", { path: "a.md", content: "x" }, undefined, `w-${call}`);
    assert.equal(decision.decision, "ALLOW", `write ${call} of 2 must be allowed`);
  }

  // The profile is defined but not selected, so the base budget of 2 is what
  // enforcement sees: the 3rd write is denied AT 2, not at 5.
  const third = await adapter.precheckToolCall("write", "execute", { path: "a.md", content: "x" }, undefined, "w-3");
  assert.equal(third.decision.decision, "DENY");
  assert.match((third.decision as { reason: string }).reason, /maxFileWritesPerTask exceeded \(2\)/);
});

test("an active profile raises the budget the enforcement actually sees", async () => {
  const root = await sandbox();
  const { adapter } = await adapterWith(root, {
    limits: { maxToolCallsPerTask: 200, maxFileWritesPerTask: 10, maxBytesPerWrite: 1_000_000 },
    limitProfiles: { gauntlet: { maxFileWritesPerTask: 50 } },
    activeLimitProfile: "gauntlet",
  });

  // This shares the base write budget of 10 with the sizing fixture above, but
  // not with the inactive-profile test, which uses its own local pair. Under
  // this profile the 51st write is allowed, and that allowance can only have
  // come from the profile being merged in.
  for (let call = 1; call <= 50; call += 1) {
    const { decision } = await adapter.precheckToolCall("write", "execute", { path: "a.md", content: "x" }, undefined, `w-${call}`);
    assert.equal(decision.decision, "ALLOW", `write ${call} of 50 must be allowed`);
  }

  // 51 is refused at 50: the interpolated value is the merged one, which is
  // the only way this test could fail if the merge were not reaching the kernel.
  const fiftyFirst = await adapter.precheckToolCall("write", "execute", { path: "a.md", content: "x" }, undefined, "w-51");
  assert.equal(fiftyFirst.decision.decision, "DENY");
  assert.match((fiftyFirst.decision as { reason: string }).reason, /maxFileWritesPerTask exceeded \(50\)/);
});

test("5. on_violation: abort terminates the task and the trace shows why", async () => {
  const root = await sandbox();
  const { adapter } = await adapterWith(root, { onViolation: "abort" });

  // An innocent call still works before the violation.
  assert.equal((await adapter.precheckToolCall("read", "execute", { path: "notes.md" }, undefined, "a1")).decision.decision, "ALLOW");

  const violation = await adapter.precheckToolCall("bash", "execute", { command: "rm -rf node_modules" }, undefined, "a2");
  assert.equal(violation.decision.decision, "DENY");
  assert.equal((violation.decision as { violation?: string }).violation, "abort");

  // The task is terminated, not merely blocked.
  assert.equal(adapter.currentTask!.status, "FAILED");
  assert.match(adapter.currentTask!.failureReason!, /rm -rf/);

  // The termination is visible in the trace, with the rule and the reason.
  const events = adapter.recentEvents(200);
  const violationEvent = events.find((entry) => entry.type === "POLICY_VIOLATION");
  assert.ok(violationEvent, "a POLICY_VIOLATION event must be recorded");
  assert.equal(violationEvent!.payload.tool, "bash");
  assert.equal(violationEvent!.payload.onViolation, "abort");
  assert.match(String(violationEvent!.payload.reason), /rm -rf/);
  assert.ok(events.some((entry) => entry.type === "POLICY_ABORTED"), "the abort itself must be recorded");
  const failed = events.find((entry) => entry.type === "TASK_FAILED");
  assert.ok(failed, "the task failure must be recorded");
  assert.match(String(failed!.payload.reason), /Policy abort/);

  // Further calls are refused, however innocent they are, and cannot resurrect it.
  const after = await adapter.precheckToolCall("read", "execute", { path: "notes.md" }, undefined, "a3");
  assert.equal(after.decision.decision, "DENY");
  assert.match((after.decision as { reason: string }).reason, /Task is FAILED/);
  assert.equal(await adapter.beginToolExecution("a3", "read"), undefined);
  assert.equal(adapter.currentTask!.status, "FAILED");

  // Finalising an aborted task reports it as-is rather than completing or throwing.
  const finished = await adapter.finishTask({ done: true });
  assert.equal(finished.status, "FAILED");
});

test("6. the declarative rules can only remove a permission, never add one", async () => {
  const root = await sandbox();

  // A maximally permissive config still cannot turn a write into an automatic
  // approval: in APPROVAL mode the tier policy underneath still escalates.
  const permissive: PolicyConfig = parsePolicyConfig({
    ...LEGACY_RULES,
    deniedTools: [],
    allowedTools: [],
    fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
  }, "test-policy.json");
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy({ policyMode: "APPROVAL", allowedRoots: ["."] }, root, permissive));
  for (const name of TOOL_NAMES) adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
  await adapter.beginTask("write a report", "write a report");

  const { decision } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "reports", "a.md"), content: "x" },
    undefined,
    "p1",
  );
  assert.equal(decision.decision, "REQUIRE_APPROVAL", "the tier policy still owns approval");

  // And in trusted mode the same config leaves the workspace boundary intact.
  const trusted = new KernelAdapter();
  trusted.setPolicy(buildPolicy({ ...TRUSTED, allowedRoots: [root] }, root, permissive));
  for (const name of TOOL_NAMES) trusted.registerTools([toolDescriptorFromPi({ name, description: name })]);
  await trusted.beginTask("write a report", "write a report");
  const escape = await trusted.precheckToolCall(
    "write",
    "execute",
    { path: path.join(path.dirname(root), "escape.md"), content: "x" },
    undefined,
    "p2",
  );
  assert.equal(escape.decision.decision, "DENY");
});

test("7. the committed project policy file is valid and loadable", async () => {
  const projectRoot = path.resolve(import.meta.dirname, "../..");
  const { loadPolicyConfig } = await import("../core/policy-config.ts");
  const config = await loadPolicyConfig(projectRoot);

  assert.ok(config, ".pi/neurofebric-policy.json must exist and parse");
  assert.equal(config!.version, 1);
  assert.equal(config!.limits.maxToolCallsPerTask, 1000, "the operator-raised harness budget");
  assert.equal(config!.limits.maxFileWritesPerTask, 500);
  assert.equal(config!.limits.maxBytesPerWrite, 5_000_000);
  assert.deepEqual(config!.destructiveCommandPatterns, ["rm -rf", "format c:"]);
  assert.deepEqual(
    config!.destructiveCommandTokens,
    ["rm", "rmdir", "del", "erase", "unlink", "shred", "remove-item"],
    "the shipped config must carry the deletion guard explicitly",
  );
  assert.deepEqual(config!.secretWritePatterns, ["aws_access_key_id", "x-api-key_live", "sk_live_", "-----BEGIN PRIVATE KEY-----"]);
  assert.equal(config!.onViolation, "block");
});