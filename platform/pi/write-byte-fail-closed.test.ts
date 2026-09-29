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
import type { VaultWiring } from "./vault-tools.ts";
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

/**
 * 6. The cap counts UTF-8 BYTES, not string length.
 *
 * `docs/POLICY_PORT.md` specifies `maxBytesPerWrite` as "UTF-8 bytes of the write
 * payload", and `payloadBytes` implements that with `Buffer.byteLength(text,
 * "utf8")`. Tests 1-5 all use single-byte filler, so for every one of them UTF-8
 * byte length and `.length` are the same number: a regression that swapped
 * `Buffer.byteLength(text, "utf8")` for `text.length` would pass all five and
 * silently under-bill every non-ASCII payload.
 *
 * The euro sign is 1 UTF-16 code unit but 3 UTF-8 bytes, so the payload below is
 * 200 code units and 600 bytes. The assertion that the code-unit length is under
 * CAP is what makes this test discriminating rather than decorative: it proves
 * the denial came from byte accounting and could not have come from length
 * accounting.
 */
test("6. the cap counts UTF-8 bytes, not string length", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root);

  // U+20AC: one UTF-16 code unit, three UTF-8 bytes.
  const euro = String.fromCharCode(0x20ac);
  const text = euro.repeat(200);
  const utf8Bytes = Buffer.byteLength(text, "utf8");
  const codeUnits = text.length;

  assert.equal(utf8Bytes, 600, "the fixture must be 600 UTF-8 bytes");
  assert.ok(codeUnits < CAP, "the fixture must be under the cap in code units, or it would not discriminate");

  // Per D-023 the path is billed too, so the expected total is content + path.
  // It is computed rather than hardcoded because the sandbox root length varies.
  const target = path.join(root, "euro.md");
  const expected = utf8Bytes + Buffer.byteLength(target, "utf8");

  const { decision } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: target, content: text },
    undefined,
    "utf8-bytes",
  );

  assert.equal(decision.decision, "DENY", "600 UTF-8 bytes of content must exceed the 512-byte cap");
  assert.match(
    reason(decision),
    new RegExp(`maxBytesPerWrite exceeded \\(${expected} > ${CAP}\\)`),
    "the billed total must be the UTF-8 byte count, path included",
  );
});

/**
 * 7. The budget still binds a vault attached through the PRODUCTION FUNNEL.
 *
 * Test 4 proves the budget binds the vault, but it hand-registers the descriptor
 * (`adapter.registerTools([vault])`). Production does not do that. The real path
 * is `KernelAdapter.registerTools`, which appends `this.vaultDescriptors()`, and
 * `setVault`, which does the same; the funnel yields the descriptor only when
 * `vaultToolsEnabled` sees `config.enabled === true`. That is a separate code
 * path with its own gate, and this test is the only thing covering it.
 *
 * The failure this guards against is specific: if a future change to the funnel
 * or to `descriptor()` in vault-tools.ts produced a descriptor that was not
 * WRITE-tier — CONTROLLED, say — then a CONTROLLED tool never reaches the size
 * check, the vault would stop being billed in production, and test 4 would still
 * pass because it never goes through the funnel. The same descriptor going
 * through two different registration paths is exactly the kind of thing that
 * drifts apart silently.
 *
 * The wiring below is the shape `vault-boundary.test.ts` already uses: enabled,
 * with a path resolved inside the sandbox so the suite stays hermetic.
 */
test("7. a vault attached through the setVault funnel is still billed", async () => {
  const root = await sandbox();
  await mkdir(path.join(root, "vault"), { recursive: true });

  const policyConfig: PolicyConfig = parsePolicyConfig({ ...TEST_RULES }, "test-policy.json");
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy(CONFIG, root, policyConfig));
  for (const name of TOOL_NAMES) {
    adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
  }

  // Production entry point: the funnel, not a hand-picked descriptor.
  const wiring: VaultWiring = {
    config: { enabled: true, path: path.join(root, "vault", "vault-data.json"), retrieveMode: "redacted" },
  };
  adapter.setVault(wiring);
  await adapter.beginTask("do the work", "do the work");

  const { decision } = await adapter.precheckToolCall(
    "vault_store",
    "execute",
    { name: "entry", shape: "opaque", value: "x".repeat(CAP + 1) },
    undefined,
    "vault-funnel-big",
  );

  assert.equal(
    decision.decision,
    "DENY",
    "a funnel-attached vault_store is still WRITE-tier, so the budget still binds it",
  );
  assert.match(reason(decision), /maxBytesPerWrite exceeded/);
});
