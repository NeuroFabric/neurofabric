import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CoreError } from "./errors.ts";
import { CredentialVault, parseVaultConfig, type VaultConfig } from "./vault.ts";

/**
 * The vault's own contract: configuration parsing and the five operations,
 * against a real filesystem in a temporary directory.
 *
 * Every value here is synthetic and obviously non-functional. Nothing in this
 * file is a credential, and nothing is at rest outside the sandbox.
 */

const SOURCE = "synthetic-policy.json";

function sandbox(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "nf-vault-"));
}

function vaultAt(root: string, overrides: Partial<VaultConfig> = {}): VaultConfig {
  return { enabled: true, path: path.join(root, "vault", "secrets.json"), retrieveMode: "redacted", ...overrides };
}

/** A clock that hands out the given stamps in order, so rotation is assertable. */
function clock(...stamps: string[]): () => string {
  let index = 0;
  return () => stamps[Math.min(index++, stamps.length - 1)]!;
}

/**
 * `assert.throws` proves a throw happened but hands back nothing to inspect, and
 * this suite asserts on the category and the message. These two helpers run the
 * call and return the error, failing loudly if it did not throw at all.
 */
function caught(call: () => unknown): CoreError {
  try {
    call();
  } catch (error) {
    return error as CoreError;
  }
  throw new Error("expected the call to throw");
}

/** The same for a rejected promise, which is how every operation here fails. */
async function rejection(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (error) {
    return error as CoreError;
  }
  throw new Error("expected the call to reject");
}

const VALID = { enabled: true, path: "/tmp/vault.json", retrieveMode: "redacted" } as const;

test("a valid vault block parses, and retrieveMode is carried as written", () => {
  const redacted = parseVaultConfig(VALID, SOURCE);
  assert.deepEqual(redacted, { enabled: true, path: "/tmp/vault.json", retrieveMode: "redacted" });
  const optin = parseVaultConfig({ ...VALID, retrieveMode: "unredacted-optin" }, SOURCE);
  assert.equal(optin?.retrieveMode, "unredacted-optin");
});

test("an absent vault block is inert rather than disabled", () => {
  assert.equal(parseVaultConfig(undefined, SOURCE), undefined);
});

test("an unknown field inside a present block throws, naming the file and the field", () => {
  // The whole point of failing loud: a key the operator believes is in force but
  // which is silently dropped is the usability bug this prevents.
  const error = caught(() => parseVaultConfig({ ...VALID, requireApprovalForUnredacted: true }, SOURCE));
  assert.equal(error.category, "CONFIGURATION_ERROR");
  assert.match(error.message, /synthetic-policy\.json/);
  assert.match(error.message, /vault\.requireApprovalForUnredacted/);
  assert.match(error.message, /enabled, path, retrieveMode/);
});

test("field types are enforced, and each failure names its field", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...VALID, enabled: "yes" }, /vault\.enabled must be a boolean/],
    [{ ...VALID, path: "" }, /vault\.path must be a non-empty string/],
    [{ ...VALID, path: 7 }, /vault\.path must be a non-empty string/],
    [{ ...VALID, retrieveMode: "raw" }, /vault\.retrieveMode must be "redacted" or "unredacted-optin"/],
    [{ ...VALID, retrieveMode: undefined }, /vault\.retrieveMode must be "redacted" or "unredacted-optin"/],
  ];
  for (const [input, expected] of cases) {
    const error = caught(() => parseVaultConfig(input, SOURCE));
    assert.match(error.message, expected, `for ${JSON.stringify(input)}`);
  }
});

test("a vault block that is not an object throws", () => {
  for (const input of [[], "yes", 3, null]) {
    const error = caught(() => parseVaultConfig(input, SOURCE));
    assert.match(error.message, /vault must be an object/);
  }
});

test("loading a vault that does not exist yields an empty vault, not an error", async () => {
  const root = await sandbox();
  try {
    const vault = new CredentialVault(vaultAt(root), { persist: () => {} });
    const file = await vault.load();
    assert.deepEqual(file, { version: 1, entries: {} });
    assert.deepEqual(await vault.list(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a store, list, retrieve and delete round-trip through a real file", async () => {
  const root = await sandbox();
  try {
    const vault = new CredentialVault(vaultAt(root), { persist: () => {}, now: clock("2026-01-01T00:00:00.000Z") });

    const stored = await vault.store("reporting-endpoint", "opaque-string", "fixture-value-0001");
    assert.deepEqual(stored, { shape: "opaque-string", value: "fixture-value-0001", rotatedAt: "2026-01-01T00:00:00.000Z" });

    // The file on disk is the sanctioned store and holds the value verbatim.
    const onDisk = JSON.parse(await readFile(vaultAt(root).path, "utf8"));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.entries["reporting-endpoint"].value, "fixture-value-0001");

    const reloaded = new CredentialVault(vaultAt(root), { persist: () => {} });
    assert.deepEqual(await reloaded.list(), [
      { name: "reporting-endpoint", shape: "opaque-string", rotatedAt: "2026-01-01T00:00:00.000Z" },
    ]);

    const preview = await reloaded.retrieve("reporting-endpoint");
    assert.equal(preview.unredacted, false);
    assert.equal(preview.preview, "fixture-value-0001");
    assert.equal(preview.shape, "opaque-string");

    assert.equal(await reloaded.delete("reporting-endpoint"), true);
    assert.equal(await reloaded.delete("reporting-endpoint"), false);
    assert.deepEqual(await reloaded.list(), []);
    await assert.rejects(() => reloaded.retrieve("reporting-endpoint"), /no vault entry named/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a first store creates the vault directory, so the file is never orphaned", async () => {
  const root = await sandbox();
  try {
    const config = vaultAt(root);
    const vault = new CredentialVault(config, { persist: () => {} });
    assert.deepEqual(await vault.load(), { version: 1, entries: {} });
    await vault.store("first", "opaque-string", "fixture-value-0002");
    const onDisk = JSON.parse(await readFile(config.path, "utf8"));
    assert.equal(Object.keys(onDisk.entries).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Permission bits exist only on POSIX. Windows has no equivalent, and Node
 * accepts `mode` there without effect, so these assertions are skipped rather
 * than weakened into something that passes everywhere and means nowhere.
 */
const POSIX_MODES = process.platform !== "win32";
const SKIP_WINDOWS = POSIX_MODES ? false : "POSIX permission bits are not meaningful on Windows";

test("a stored vault is not readable by group or other", { skip: SKIP_WINDOWS }, async () => {
  const root = await sandbox();
  try {
    const config = vaultAt(root);
    const vault = new CredentialVault(config, { persist: () => {} });
    await vault.store("secret-entry", "opaque-string", "fixture-value-perms-0001");

    const file = await stat(config.path);
    assert.equal(
      file.mode & 0o077,
      0,
      `vault file must not be group/other readable, got ${(file.mode & 0o777).toString(8)}`,
    );

    const dir = await stat(path.dirname(config.path));
    assert.equal(
      dir.mode & 0o077,
      0,
      `vault directory must not be group/other accessible, got ${(dir.mode & 0o777).toString(8)}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * `writeFile`'s `mode` applies only when the file is CREATED, so requesting
 * 0600 is not enough on its own: a vault written by an earlier version keeps
 * whatever mode it already had. This drives that case directly, because a fix
 * that only sets the mode at creation would pass the test above and leave every
 * existing deployment world-readable.
 */
test("a vault file left world-readable by an earlier version is tightened on its next write", { skip: SKIP_WINDOWS }, async () => {
  const root = await sandbox();
  try {
    const config = vaultAt(root);
    await mkdir(path.dirname(config.path), { recursive: true });
    await writeFile(config.path, `${JSON.stringify({ version: 1, entries: {} })}\n`, { encoding: "utf8", mode: 0o644 });
    // Set explicitly so the fixture is world-readable whatever the umask is.
    await chmod(config.path, 0o644);
    const before = await stat(config.path);
    assert.equal(before.mode & 0o004, 0o004, "the fixture must start world-readable or this test proves nothing");

    const vault = new CredentialVault(config, { persist: () => {} });
    await vault.store("later-entry", "opaque-string", "fixture-value-perms-0002");

    const after = await stat(config.path);
    assert.equal(
      after.mode & 0o077,
      0,
      `the write must tighten a pre-existing vault file, still ${(after.mode & 0o777).toString(8)}`,
    );
    assert.equal(after.mode & 0o777, 0o600, "and it must land on exactly owner-only");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("storing an existing name overwrites it and updates rotatedAt", async () => {
  const root = await sandbox();
  try {
    // There is no rotate op: an overwrite IS the rotation, and the event record
    // is the audit of when it happened (OQ-2).
    const vault = new CredentialVault(vaultAt(root), {
      persist: () => {},
      now: clock("2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"),
    });

    await vault.store("rotating", "opaque-string", "fixture-value-0003");
    const second = await vault.store("rotating", "opaque-string", "fixture-value-0004");

    assert.equal(second.value, "fixture-value-0004");
    assert.equal(second.rotatedAt, "2026-03-01T00:00:00.000Z");
    const entries = await vault.list();
    assert.equal(entries.length, 1, "an overwrite must not create a second entry");
    assert.equal(entries[0]!.rotatedAt, "2026-03-01T00:00:00.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the audit trail distinguishes a rotation from a first store", async () => {
  const root = await sandbox();
  try {
    // A rotation is the security-relevant event: something that was already
    // there has been replaced. Two identical store/ok lines cannot show that,
    // so the replacement is recorded explicitly.
    const recorded: Record<string, unknown>[] = [];
    const vault = new CredentialVault(vaultAt(root), {
      persist: (entry) => { recorded.push(entry as Record<string, unknown>); },
      now: clock("2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"),
    });

    await vault.store("tracked", "opaque-string", "fixture-value-0010");
    const stores = () => recorded.filter((entry) => entry.op === "store");

    assert.equal(stores().length, 1);
    assert.equal(stores()[0]!.replaced, undefined, "a first store is not a replacement");

    await vault.store("tracked", "opaque-string", "fixture-value-0011");
    assert.equal(stores().length, 2);
    assert.equal(stores()[1]!.replaced, true, "a rotation must be recorded as a replacement");
    assert.equal(stores()[1]!.name, "tracked");
    assert.equal(stores()[1]!.shape, "opaque-string");

    // The audit trail is redacted by construction, like every vault event.
    const serialised = JSON.stringify(recorded);
    assert.ok(!serialised.includes("fixture-value-0010"), "the replaced value must not reach the audit trail");
    assert.ok(!serialised.includes("fixture-value-0011"), "the new value must not reach the audit trail");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unredacted read is refused outright when the mode does not opt in", async () => {
  const root = await sandbox();
  try {
    const vault = new CredentialVault(vaultAt(root, { retrieveMode: "redacted" }), { persist: () => {} });
    await vault.store("gated", "opaque-string", "fixture-value-0005");

    // No approval of any single call reaches past this. The mode is the
    // operator's standing instruction and is checked before the entry is read.
    // The per-call approval lives at the precheck, on a separate tool, and is
    // deliberately not re-decided here.
    const error = await rejection(vault.retrieve("gated", { unredacted: true }));
    assert.match(error.message, /retrieveMode is "redacted"/);

    // The ordinary read is unaffected.
    const preview = await vault.retrieve("gated");
    assert.equal(preview.unredacted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an opted-in mode returns the value, and the mode gate is the only gate here", async () => {
  const root = await sandbox();
  try {
    const vault = new CredentialVault(vaultAt(root, { retrieveMode: "unredacted-optin" }), { persist: () => {} });
    await vault.store("gated", "opaque-string", "fixture-value-0006");

    // Reached only through an approved precheck. The module cannot verify that
    // and does not need to: an execution binds only on an ALLOW decision.
    const revealed = await vault.retrieve("gated", { unredacted: true });
    assert.equal(revealed.unredacted, true);
    assert.equal(revealed.unredacted === true ? revealed.value : undefined, "fixture-value-0006");

    // The same entry read the ordinary way is still a preview.
    const preview = await vault.retrieve("gated");
    assert.equal(preview.unredacted, false);
    assert.equal(preview.preview, "fixture-value-0006");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store rejects an empty name, an empty shape, or a non-string value", async () => {
  const root = await sandbox();
  try {
    const vault = new CredentialVault(vaultAt(root), { persist: () => {} });
    const error = await rejection(vault.store("", "opaque-string", "x"));
    assert.match(error.message, /non-empty name/);
    await assert.rejects(() => vault.store("named", "", "x"), /non-empty shape/);
    await assert.rejects(() => vault.store("named", "opaque-string", 7 as unknown as string), /string value/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a vault file that is not the expected layout is an error, not an empty vault", async () => {
  const root = await sandbox();
  try {
    const config = vaultAt(root);
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(path.dirname(config.path), { recursive: true });

    const vault = new CredentialVault(config, { persist: () => {} });
    const cases: Array<[string, RegExp]> = [
      ["not json at all", /not valid JSON/],
      ["[]", /must be a JSON object/],
      [JSON.stringify({ version: 2, entries: {} }), /version 2 is not supported/],
      [JSON.stringify({ version: 1, entries: [] }), /entries must be an object/],
      [JSON.stringify({ version: 1, entries: { a: { shape: "s" } } }), /must have a shape, a string value and a rotatedAt/],
    ];
    for (const [content, expected] of cases) {
      await writeFile(config.path, content, "utf8");
      await assert.rejects(() => vault.load(), expected, `for ${content}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
