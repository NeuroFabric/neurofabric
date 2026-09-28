import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ConfiguredPolicy,
  CoreError,
  DefaultPolicy,
  WorkspaceBoundary,
  parsePolicyConfig,
  type PolicyConfig,
} from "../core/index.ts";
import { KernelAdapter } from "./kernel-adapter.ts";
import { createVaultHandlers, vaultToolDescriptors } from "./vault-tools.ts";
import type { VaultWiring } from "./vault-tools.ts";
import { REDACTED, type VaultEvent } from "../core/redaction.ts";

/**
 * The vault tools at the kernel boundary: declared, registered, prechecked.
 *
 * This suite uses its OWN synthetic policy, never the committed one and never
 * the legacy-rules fixture (A3). The pattern family below is invented for this
 * file and is obviously fake, so what is pinned is the MECHANISM — where the
 * approval gate falls, and what the configured engine does and does not reach
 * — not any particular operator's rules.
 *
 * Three measurements from the pre-flight are pinned here deliberately, because
 * each is easy to regress by accident:
 *
 *   - P-1: the configured engine's write scan reaches a fixed set of
 *     content-bearing argument names, and `value` is not among them. A store
 *     payload is outside channel 2 BY DESIGN, so the synthetic pattern below
 *     is configured and still does not deny a store.
 *   - P-2: the wiring is a config channel on the adapter; the four (now five)
 *     descriptors attach through one funnel.
 *   - P-3: approval is derived from the tool's tier, not from a flag. WRITE and
 *     CONTROLLED always require it; a pure READ_ONLY tool never does.
 */

const SYNTHETIC_SOURCE = "synthetic-vault-policy.json";
/** Invented for this file. It is not a real pattern and matches no credential. */
const SYNTHETIC_PATTERN = "fixture-blocked-marker:";
const TRIPPING_VALUE = "fixture-blocked-marker: PLACEHOLDER";
const CLEAN_VALUE = "fixture-value-0009";

const VAULT_BLOCK = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  path: path.join("workspace", "vault", "vault-data.json"),
  retrieveMode: "redacted",
  ...overrides,
});

/** A policy of our own making: the vault block under test, and one fake pattern. */
function syntheticPolicy(vault?: Record<string, unknown>): PolicyConfig {
  return parsePolicyConfig(
    {
      version: 1,
      secretWritePatterns: [SYNTHETIC_PATTERN],
      onViolation: "block",
      ...(vault === undefined ? {} : { vault }),
    },
    SYNTHETIC_SOURCE,
  );
}

interface Harness {
  adapter: KernelAdapter;
  config: PolicyConfig;
  root: string;
  vaultPath: string;
  wiring?: VaultWiring;
}

/**
 * Wire the adapter the way the extension wires it: policy first, then the vault
 * configuration, then registration, then a task.
 */
async function harness(root: string, vault?: Record<string, unknown>): Promise<Harness> {
  const config = syntheticPolicy(vault);
  const adapter = new KernelAdapter({ boundary: new WorkspaceBoundary([root]) });
  adapter.setPolicy(
    new ConfiguredPolicy(config, { mode: "APPROVAL", base: new DefaultPolicy(), allowedRoots: [root] }),
  );
  // A relative configured path is resolved against the project root, which is
  // what an operator means by it. Resolving it here is also what keeps the
  // suite hermetic: an unresolved relative path would write the vault file into
  // whatever directory the runner happened to be in.
  const wiring = config.vault === undefined ? undefined : { config: { ...config.vault, path: path.join(root, config.vault.path) } };
  if (wiring) adapter.setVault(wiring);
  adapter.registerTools([]);
  await adapter.beginTask("exercise the vault tools", "exercise the vault tools");
  return {
    adapter,
    config,
    root,
    vaultPath: config.vault === undefined ? "" : path.join(root, config.vault.path),
    ...(wiring === undefined ? {} : { wiring }),
  };
}

async function sandbox(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "nf-vault-boundary-"));
}

/** The call shape the extension uses: a decision, or a throw for an unknown tool. */
async function precheck(h: Harness, tool: string, input: unknown, id: string, approve = false) {
  return h.adapter.precheckToolCall(
    tool,
    "execute",
    input,
    approve ? { requestApproval: async () => true } : undefined,
    id,
  );
}

/** Run a handler and hand back the error it raised, which `rejects` does not. */
async function rejection(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (error) {
    return error as CoreError;
  }
  throw new Error("expected the handler to reject");
}

test("an absent vault block registers no tools at all", async () => {
  const root = await sandbox();
  try {
    assert.equal(syntheticPolicy().vault, undefined, "no block means inert, not disabled");
    const h = await harness(root);
    assert.equal(h.wiring, undefined);
    await assert.rejects(() => precheck(h, "vault_list", {}, "c1"), /Unknown tool: vault_list/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a disabled vault block registers no tools either", async () => {
  const root = await sandbox();
  try {
    const h = await harness(root, VAULT_BLOCK({ enabled: false }));
    assert.equal(h.config.vault?.enabled, false);
    // The block IS present and validated; only the flag withholds the tools.
    assert.equal(h.config.vault?.retrieveMode, "redacted");
    for (const tool of ["vault_list", "vault_store", "vault_reveal"]) {
      await assert.rejects(() => precheck(h, tool, { name: "a" }, `c-${tool}`), new RegExp(`Unknown tool: ${tool}`));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an enabled block registers all five, each at the tier its name implies", async () => {
  const root = await sandbox();
  try {
    const h = await harness(root, VAULT_BLOCK());
    assert.equal(h.config.vault?.enabled, true);
    // Free reads are ALLOW; the three gated tools ask. That both proves each
    // tool is registered and pins P-3's measured table.
    const expected: Array<[string, unknown, string]> = [
      ["vault_list", {}, "ALLOW"],
      ["vault_retrieve", { name: "entry" }, "ALLOW"],
      ["vault_store", { name: "entry", shape: "opaque-string", value: CLEAN_VALUE }, "REQUIRE_APPROVAL"],
      ["vault_delete", { name: "entry" }, "REQUIRE_APPROVAL"],
      ["vault_reveal", { name: "entry" }, "REQUIRE_APPROVAL"],
    ];
    for (const [tool, input, decision] of expected) {
      const outcome = await precheck(h, tool, input, `reg-${tool}`);
      assert.equal(outcome.decision.decision, decision, `${tool} must be reachable and precheck to ${decision}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the five descriptors declare only the three sanctioned access strings", async () => {
  const descriptors = vaultToolDescriptors();
  assert.deepEqual(
    descriptors.map((d) => d.name),
    ["vault_store", "vault_retrieve", "vault_reveal", "vault_list", "vault_delete"],
  );
  const access = new Map<string, string>([
    ["vault_store", "credential.store"],
    ["vault_retrieve", "credential.read"],
    // A reveal reads; it is gated by its TIER, not by a second access string.
    ["vault_reveal", "credential.read"],
    ["vault_list", "credential.read"],
    ["vault_delete", "credential.delete"],
  ]);
  for (const descriptor of descriptors) {
    const expected = access.get(descriptor.name)!;
    assert.deepEqual(descriptor.capabilities, [expected]);
    assert.deepEqual(descriptor.permissions, [expected]);
    // M2: a descriptor is a declaration. It carries no handler.
    assert.equal("handler" in descriptor, false);
  }
  // The tier split is the whole of the gate, so it is pinned here.
  const tiers = new Map(descriptors.map((d) => [d.name, d.riskLevel]));
  assert.equal(tiers.get("vault_reveal"), "CONTROLLED");
  assert.equal(tiers.get("vault_retrieve"), "READ_ONLY");
  assert.equal(tiers.get("vault_store"), "WRITE");
});

test("approval is per call: the same gated call asks again and is refused again without a provider", async () => {
  const root = await sandbox();
  try {
    const h = await harness(root, VAULT_BLOCK());
    const input = { name: "entry", shape: "opaque-string", value: CLEAN_VALUE };
    // Nothing is remembered between calls, so a refusal is not a standing state
    // and a grant is not a session grant.
    assert.equal((await precheck(h, "vault_store", input, "a1")).decision.decision, "REQUIRE_APPROVAL");
    assert.equal((await precheck(h, "vault_store", input, "a2")).decision.decision, "REQUIRE_APPROVAL");
    assert.equal((await precheck(h, "vault_store", input, "a3", true)).decision.decision, "ALLOW");
    assert.equal((await precheck(h, "vault_store", input, "a4")).decision.decision, "REQUIRE_APPROVAL");

    // A redacted read never asks at all — metadata is free.
    assert.equal((await precheck(h, "vault_retrieve", { name: "entry" }, "r1")).decision.decision, "ALLOW");
    assert.equal((await precheck(h, "vault_list", {}, "r2")).decision.decision, "ALLOW");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a delete is a tool operation with an approval gate, not a shell concern", async () => {
  const root = await sandbox();
  try {
    const h = await harness(root, VAULT_BLOCK());
    const handlers = createVaultHandlers(h.wiring!, { persist: () => {} });
    assert.equal((await handlers.vault_delete({ name: "absent" })).removed, false);
    assert.equal((await precheck(h, "vault_delete", { name: "absent" }, "del-1")).decision.decision, "REQUIRE_APPROVAL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("R-1 / P-1: a configured write pattern does not deny a store, and no local scan exists", async () => {
  const root = await sandbox();
  try {
    const h = await harness(root, VAULT_BLOCK());
    // The pattern IS configured, and the input DOES contain it. It is still not
    // a denial: `value` is outside the engine's content-bearing arguments by
    // design, so channel 2 never sees a store payload.
    assert.deepEqual(h.config.secretWritePatterns, [SYNTHETIC_PATTERN]);
    const input = { name: "entry", shape: "opaque-string", value: TRIPPING_VALUE };
    assert.ok(input.value.includes(SYNTHETIC_PATTERN), "the fixture must actually trip the pattern");

    const asked = await precheck(h, "vault_store", input, "a7-1");
    assert.equal(asked.decision.decision, "REQUIRE_APPROVAL");
    assert.notEqual(asked.decision.decision, "DENY");

    // With the operator's approval the store runs. The approval IS the sanction:
    // a vault-local deny-scan could only have fired here, overriding it.
    assert.equal((await precheck(h, "vault_store", input, "a7-2", true)).decision.decision, "ALLOW");

    const events: unknown[] = [];
    const handlers = createVaultHandlers(h.wiring!, { persist: (entry) => events.push(entry) });
    const stored = await handlers.vault_store(input);
    assert.equal(stored.name, "entry");
    // It is stored verbatim, and the event still carries no value.
    const onDisk = await readFile(h.vaultPath, "utf8");
    assert.ok(onDisk.includes(TRIPPING_VALUE));
    const record = events.at(-1) as VaultEvent;
    assert.equal(record.op, "store");
    assert.equal("value" in record, false);
    assert.equal(JSON.stringify(events).includes(TRIPPING_VALUE), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("R-2: a redacted read refuses the unredacted key and names the tool that can serve it", async () => {
  const root = await sandbox();
  try {
    const h = await harness(root, VAULT_BLOCK());
    const handlers = createVaultHandlers(h.wiring!, { persist: () => {} });
    await handlers.vault_store({ name: "entry", shape: "opaque-string", value: CLEAN_VALUE });

    // The split is structural, so the older shape is refused rather than
    // ignored — including when the caller explicitly asks for false.
    for (const key of [true, false]) {
      const error = await rejection(handlers.vault_retrieve({ name: "entry", unredacted: key }));
      assert.equal(error.category, "TOOL_ERROR");
      assert.match(error.message, /vault_reveal/);
    }
    await rejection(handlers.vault_reveal({ name: "entry", unredacted: true }));

    // And the plain read works, returning a preview and the shape, never a value.
    const preview = await handlers.vault_retrieve({ name: "entry" });
    assert.equal(preview.unredacted, false);
    assert.equal(preview.preview, CLEAN_VALUE);
    assert.equal(preview.shape, "opaque-string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("R-2: a reveal is gated at precheck, and its event records the approval and never the value", async () => {
  const root = await sandbox();
  try {
    const h = await harness(root, VAULT_BLOCK({ retrieveMode: "unredacted-optin" }));
    const events: unknown[] = [];
    const handlers = createVaultHandlers(h.wiring!, { persist: (entry) => events.push(entry) });
    await handlers.vault_store({ name: "entry", shape: "opaque-string", value: CLEAN_VALUE });

    // No provider: the reveal is not authorised, and it acquires no execution.
    const asked = await precheck(h, "vault_reveal", { name: "entry" }, "rv-1");
    assert.equal(asked.decision.decision, "REQUIRE_APPROVAL");
    // With one: the same call is authorised. Per call, and only this call.
    const granted = await precheck(h, "vault_reveal", { name: "entry" }, "rv-2", true);
    assert.equal(granted.decision.decision, "ALLOW");
    assert.equal((await precheck(h, "vault_reveal", { name: "entry" }, "rv-3")).decision.decision, "REQUIRE_APPROVAL");

    // The handler returns the value; the event records that a reveal happened.
    const revealed = await handlers.vault_reveal({ name: "entry" });
    assert.equal(revealed.unredacted, true);
    assert.equal(revealed.unredacted === true ? revealed.value : undefined, CLEAN_VALUE);

    const record = events.at(-1) as VaultEvent;
    assert.equal(record.op, "retrieve");
    assert.equal(record.approval, true, "the approval fact is the audit record");
    assert.equal(record.shape, "opaque-string");
    assert.equal("value" in record, false);
    assert.equal(JSON.stringify(events).includes(CLEAN_VALUE), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("R-2: the default mode refuses a reveal outright, whatever the approval", async () => {
  const root = await sandbox();
  try {
    const h = await harness(root, VAULT_BLOCK({ retrieveMode: "redacted" }));
    const events: unknown[] = [];
    const handlers = createVaultHandlers(h.wiring!, { persist: (entry) => events.push(entry) });
    await handlers.vault_store({ name: "entry", shape: "opaque-string", value: CLEAN_VALUE });

    // The precheck authorises it — the tier gate is satisfied — and the vault
    // still refuses. The operator's standing instruction outranks one approval.
    assert.equal((await precheck(h, "vault_reveal", { name: "entry" }, "m-1", true)).decision.decision, "ALLOW");
    const error = await rejection(handlers.vault_reveal({ name: "entry" }));
    assert.equal(error.category, "POLICY_ERROR");
    assert.match(error.message, /retrieveMode is "redacted"/);

    const last = events.at(-1) as VaultEvent;
    assert.equal(last.outcome, "refused");
    assert.equal(last.approval, undefined, "a refused reveal approved nothing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the redaction marker is what a redacted read of a guard-tripping value shows", async () => {
  const root = await sandbox();
  try {
    const h = await harness(root, VAULT_BLOCK());
    const handlers = createVaultHandlers(h.wiring!, { persist: () => {} });
    const value = ["bea", "rer ", "PLACEHOLDER-NOT-FUNCTIONAL-0002"].join("");
    await handlers.vault_store({ name: "entry", shape: "opaque-string", value });

    const preview = await handlers.vault_retrieve({ name: "entry" });
    assert.equal(preview.unredacted, false);
    assert.ok(preview.preview.includes(REDACTED));
    assert.equal(preview.preview.includes("PLACEHOLDER-NOT-FUNCTIONAL-0002"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
