import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { REDACTED } from "./redaction.ts";
import { CredentialVault, type VaultConfig, type VaultEvent } from "./vault.ts";

/**
 * The two-sinks invariant (A6, ruling 5).
 *
 * The vault file is the ONE sanctioned unredacted store. Everything else — the
 * event, and anything downstream of it — goes out redacted. This suite pins
 * both halves of that, and pins the failure mode that would silently break it:
 * redaction applied at WRITE time, which would destroy the material the vault
 * exists to hold. That is the M3 regression, and it is the reason the store
 * path and the event path are separate code.
 *
 * Every value is synthetic. The value that must redact is assembled in-suite
 * from fragments, so no credential-shaped literal is ever at rest in the
 * repository, and the assembled string is obviously non-functional.
 */

const BENIGN_VALUE = "fixture-value-0007";
const REDACTING_VALUE = ["bea", "rer ", "PLACEHOLDER-NOT-FUNCTIONAL-0001"].join("");

function sandbox(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "nf-vault-redact-"));
}

function configAt(root: string, overrides: Partial<VaultConfig> = {}): VaultConfig {
  return { enabled: true, path: path.join(root, "vault", "secrets.json"), retrieveMode: "redacted", ...overrides };
}

function collector(): { records: unknown[]; persist: (entry: unknown) => void } {
  const records: unknown[] = [];
  return { records, persist: (entry) => records.push(entry) };
}

test("a guard-passing value survives the round trip while the event carries no value", async () => {
  const root = await sandbox();
  try {
    const config = configAt(root);
    const { records, persist } = collector();
    const vault = new CredentialVault(config, { persist });

    const stored = await vault.store("plain-entry", "opaque-string", BENIGN_VALUE);
    await vault.retrieve("plain-entry");
    await vault.list();

    // The stored entry is intact. Redacting at write time would have replaced
    // this with a marker and the vault would no longer hold anything.
    const reloaded = new CredentialVault(config, { persist: () => {} });
    const entry = (await reloaded.load()).entries["plain-entry"]!;
    assert.equal(entry.value, BENIGN_VALUE);
    assert.equal(entry.shape, "opaque-string");
    assert.equal(stored.value, BENIGN_VALUE);
    const onDisk = await readFile(config.path, "utf8");
    assert.ok(onDisk.includes(BENIGN_VALUE), "the sanctioned store holds the value verbatim");

    // And the events, which are the only other surface the vault touches, hold
    // nothing of the sort.
    assert.equal(records.length, 3, "one event per operation, and no more");
    for (const record of records) {
      const event = record as VaultEvent;
      assert.ok(event.op, "each record names its operation");
      assert.ok(event.outcome, "each record names its outcome");
      assert.equal("value" in event, false, "an event must carry no value field at all");
    }
    assert.equal(JSON.stringify(records).includes(BENIGN_VALUE), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a value the guard would redact is still stored intact, and only its preview is redacted", async () => {
  const root = await sandbox();
  try {
    const config = configAt(root);
    const { records, persist } = collector();
    const vault = new CredentialVault(config, { persist });

    await vault.store("redacting-entry", "opaque-string", REDACTING_VALUE);

    // Store path: untouched. The vault is the one place the value is allowed to
    // exist, so writing it verbatim is the correct behaviour, not a leak.
    const stored = (await vault.load()).entries["redacting-entry"]!;
    assert.equal(stored.value, REDACTING_VALUE);

    // Read path: redacted by default, whatever the operator's mode.
    const preview = await vault.retrieve("redacting-entry");
    assert.equal(preview.unredacted, false);
    assert.notEqual(preview.preview, REDACTING_VALUE, "the preview must not be the value");
    assert.ok(preview.preview.includes(REDACTED), "the preview carries the redaction marker");
    assert.equal(preview.preview.includes("PLACEHOLDER-NOT-FUNCTIONAL-0001"), false);

    // Event path: redacted too, and the value is absent from it entirely.
    assert.equal(JSON.stringify(records).includes("PLACEHOLDER-NOT-FUNCTIONAL-0001"), false);
    for (const record of records) {
      assert.equal("value" in (record as VaultEvent), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a deletion and an absent retrieval are recorded as outcomes, never as values", async () => {
  const root = await sandbox();
  try {
    const { records, persist } = collector();
    const vault = new CredentialVault(configAt(root), { persist });
    await vault.store("temp-entry", "opaque-string", BENIGN_VALUE);
    assert.equal(await vault.delete("temp-entry"), true);
    assert.equal(await vault.delete("temp-entry"), false);
    await assert.rejects(() => vault.retrieve("temp-entry"), /no vault entry named/);

    const outcomes = (records as VaultEvent[]).map((event) => `${event.op}:${event.outcome}`);
    assert.deepEqual(outcomes, [
      "store:ok",
      "delete:ok",
      "delete:absent",
      "retrieve:absent",
    ]);
    assert.equal(JSON.stringify(records).includes(BENIGN_VALUE), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a reveal records the approval fact and never the value, and a refusal records no approval", async () => {
  const root = await sandbox();
  try {
    // Opted in, so the reveal path is the one exercised: under the final split a
    // reveal is gated at the precheck, and what survives here is the fact that
    // one was approved — never the value it produced.
    const revealed = collector();
    const optedIn = new CredentialVault(configAt(root, { retrieveMode: "unredacted-optin" }), revealed);
    await optedIn.store("gated-entry", "opaque-string", REDACTING_VALUE);

    const result = await optedIn.retrieve("gated-entry", { unredacted: true });
    assert.equal(result.unredacted, true);
    assert.equal(result.unredacted === true ? result.value : undefined, REDACTING_VALUE);

    const revealEvent = (revealed.records as VaultEvent[]).at(-1)!;
    assert.equal(revealEvent.op, "retrieve");
    assert.equal(revealEvent.outcome, "ok");
    assert.equal(revealEvent.approval, true, "the approval fact is the audit record of a reveal");
    assert.equal(revealEvent.name, "gated-entry");
    assert.equal("value" in revealEvent, false);
    assert.equal(JSON.stringify(revealed.records).includes("PLACEHOLDER-NOT-FUNCTIONAL-0001"), false);

    // The same call against a vault the operator left in the default mode is
    // refused outright, and the refusal is recorded without the value too.
    const strictEvents = collector();
    const strict = new CredentialVault(configAt(root), strictEvents);
    await strict.store("gated-entry", "opaque-string", REDACTING_VALUE);
    await assert.rejects(() => strict.retrieve("gated-entry", { unredacted: true }), /retrieveMode is "redacted"/);

    const refusal = (strictEvents.records as VaultEvent[]).at(-1)!;
    assert.equal(refusal.outcome, "refused");
    assert.equal(refusal.approval, undefined, "a refused read approved nothing");
    assert.equal(JSON.stringify(strictEvents.records).includes("PLACEHOLDER-NOT-FUNCTIONAL-0001"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
