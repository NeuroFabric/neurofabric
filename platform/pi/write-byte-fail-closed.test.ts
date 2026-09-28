/**
 * Write-size accounting is FAIL-CLOSED.
 *
 * Origin: found while closing D-022. `payloadBytes` and the secret scan shared
 * one collector, so splitting the secret scan to be fail-closed exposed that the
 * SIZE limit was still reading a closed allowlist of content field names. Large
 * content carried in the harness's camelCase `newText` / `oldText` measured as
 * zero bytes and so bypassed `maxBytesPerWrite` entirely — the same bypass class
 * as the deny-scan, in a different control.
 *
 * `docs/POLICY_PORT.md` specifies the limit as "UTF-8 bytes of the write
 * payload". A `newText` value is part of that payload, so this is a divergence
 * between the written spec and the implementation, not a change of intent.
 *
 * Unlike the deny-scan there is NO tool exemption: a budget applies to the vault
 * too. Approval sanctions the write, it does not waive the budget.
 *
 * The marker is assembled at runtime so this source file is not itself a refused
 * write payload. `precheckToolCall` only decides; nothing is written to disk.
 *
 * See D-023.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { vaultToolDescriptors } from "./vault-tools.ts";
import { buildPolicy } from "./project-config.ts";
import { parsePolicyConfig, type PolicyConfig } from "../core/policy-config.ts";
import type { NeurofebricProjectConfig } from "./project-config.ts";

/** Assembled at runtime so the literal never appears whole in this file. */
const MARK = ["zz", "byte", "scan", "zz"].join("");

const TOOL_NAMES = ["read", "bash", "write", "edit", "grep", "find", "ls"];

const CONFIG: NeurofebricProjectConfig = { policyMode: "APPROVAL", allowedRoots: ["."] };

/**
 * A cap comfortably above a real temp path (the sandbox root alone runs to
 * ~75 bytes) but small enough for a test payload to cross it. The path fields
 * are billed too, so a cap smaller than a path would make every write exceed it.
 */
const CAP = 512;

const TEST_RULES = {
  version: 1,
  deniedTools: [],
  allowedTools: [],
  fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
  destructiveCommandPatterns: [],
  destructiveCommandTokens: [],
  secretWritePatterns: [MARK],
  limits: { maxToolCallsPerTask: 120, maxFileWritesPerTask: 30, maxBytesPerWrite: CAP },
  onViolation: "block",
} as const;

async function sandbox(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "nf-write-bytes-"));
}

async function configuredAdapter(root: string, tools = TOOL_NAMES) {
  await mkdir(path.join(root, "reports"), { recursive: true });
  const policyConfig: PolicyConfig = parsePolicyConfig({ ...TEST_RULES }, "test-policy.json");
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy(CONFIG, root, policyConfig));
  for (const name of tools) {
    adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
  }
  // The real vault descriptor, which is WRITE-tier. `toolDescriptorFromPi`
  // would classify `vault_store` as CONTROLLED because it is not in its
  // risk table, and a CONTROLLED tool never reaches the size check.
  const vault = vaultToolDescriptors().find((d) => d.name === "vault_store");
  if (vault) adapter.registerTools([vault]);
  await adapter.beginTask("do the work", "do the work");
  return adapter;
}

const reason = (decision: { reason?: string }): string => String(decision.reason ?? "");

/** 1. The size limit must see content carried in a camelCase edit field. */
test("1. a payload over the cap in newText is denied", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root);

  const { decision } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "a.md"), newText: "x".repeat(CAP + 1) },
    undefined,
    "big-newText",
  );
  assert.equal(decision.decision, "DENY", "newText counts toward maxBytesPerWrite");
  assert.match(reason(decision), /maxBytesPerWrite exceeded/);
});

/** 2. And in oldText, and nested, and under a name nothing has heard of. */
test("2. every string in the payload counts toward the cap", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root);

  const oversized = [
    { path: path.join(root, "a.md"), oldText: "x".repeat(CAP + 1) },
    { path: path.join(root, "b.md"), edits: { body: "x".repeat(CAP + 1) } },
    { path: path.join(root, "c.md"), someFutureField: "x".repeat(CAP + 1) },
    { path: path.join(root, "d.md"), edits: ["x".repeat(CAP + 1)] },
  ];

  for (const input of oversized) {
    const { decision } = await adapter.precheckToolCall("write", "execute", input, undefined, "big");
    assert.equal(decision.decision, "DENY", `must be denied: ${Object.keys(input).join(",")}`);
    assert.match(reason(decision), /maxBytesPerWrite exceeded/);
  }
});

/** 3. Locator fields count too. The cap is on the call, not only on the body. */
test("3. a path field counts toward the cap", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root);

  const longName = "y".repeat(CAP + 1);
  const { decision } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, `${longName}.md`), content: "small" },
    undefined,
    "big-path",
  );
  assert.equal(decision.decision, "DENY", "the cap is on the whole call, not only on the body");
  assert.match(reason(decision), /maxBytesPerWrite exceeded/);
});

/** 4. No tool exemption: a budget binds the vault exactly as it binds any write. */
test("4. the budget applies to the vault too", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root, TOOL_NAMES);

  const { decision } = await adapter.precheckToolCall(
    "vault_store",
    "execute",
    { name: "entry", shape: "opaque", value: "x".repeat(CAP + 1) },
    undefined,
    "vault-big",
  );
  assert.equal(decision.decision, "DENY", "approval sanctions the write; it does not waive the budget");
  assert.match(reason(decision), /maxBytesPerWrite exceeded/);
});

/** 5. A small payload is still admitted, so the cap is a cap and not a refusal. */
test("5. a payload within the cap is admitted", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root);

  const { decision } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "a.md"), content: "small" },
    undefined,
    "small",
  );
  assert.notEqual(decision.decision, "DENY", "a small clean write must still be allowed");
});
