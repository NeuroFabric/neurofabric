import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { globToRegExp, loadPolicyConfig, parsePolicyConfig, POLICY_CONFIG_FILE } from "./policy-config.ts";

async function projectWith(document: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-policy-config-"));
  await mkdir(path.join(root, ".pi"), { recursive: true });
  await writeFile(path.join(root, ".pi", POLICY_CONFIG_FILE), JSON.stringify(document), "utf8");
  return root;
}

test("a valid policy is loaded and normalised", async () => {
  const root = await projectWith({
    version: 1,
    deniedTools: ["bash"],
    allowedTools: ["read", "bash"],
    fileRules: [{ pattern: "**", read: "allow", write: "deny" }],
    destructiveCommandPatterns: ["rm -rf"],
    secretWritePatterns: ["api_key"],
    limits: { maxToolCallsPerTask: 40, maxFileWritesPerTask: 10, maxBytesPerWrite: 2_000_000 },
    onViolation: "abort",
  });

  const config = await loadPolicyConfig(root);

  assert.ok(config);
  assert.deepEqual(config.deniedTools, ["bash"]);
  assert.deepEqual(config.allowedTools, ["read", "bash"]);
  assert.deepEqual(config.fileRules, [{ pattern: "**", read: "allow", write: "deny" }]);
  assert.deepEqual(config.destructiveCommandPatterns, ["rm -rf"]);
  assert.deepEqual(config.secretWritePatterns, ["api_key"]);
  assert.equal(config.onViolation, "abort");
  assert.equal(config.limits.maxBytesPerWrite, 2_000_000);
  assert.ok(config.source.endsWith(POLICY_CONFIG_FILE), "the source path is kept for decision messages");
});

test("an absent policy file is not an error", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-policy-config-"));
  assert.equal(await loadPolicyConfig(root), undefined);
});

test("a malformed policy file fails loudly rather than degrading to no rules", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-policy-config-"));
  await mkdir(path.join(root, ".pi"), { recursive: true });
  await writeFile(path.join(root, ".pi", POLICY_CONFIG_FILE), "{ not json", "utf8");

  await assert.rejects(
    () => loadPolicyConfig(root),
    // Narrowed with `instanceof` rather than an unannotated parameter: the
    // assertion itself is unchanged, but a non-Error rejection now fails the
    // test instead of throwing a TypeError from inside the validator.
    (error: unknown) => error instanceof Error
      && error.message.includes("not valid JSON")
      && error.message.includes(POLICY_CONFIG_FILE),
  );
});

test("every invalid field is reported with the file and the field name", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ version: 2 }, /version 2 is not supported/],
    [{ onViolation: "explode" }, /onViolation must be "block" or "abort"/],
    [{ deniedTools: "bash" }, /deniedTools must be an array/],
    [{ deniedTools: ["bash", "bash"] }, /duplicate entry 'bash' in deniedTools/],
    [{ deniedTools: [""] }, /deniedTools must contain non-empty strings/],
    [{ deniedContentPatterns: ["rm -rf"] }, /deniedContentPatterns is no longer supported/],
    [{ secretWritePatterns: "api_key" }, /secretWritePatterns must be an array/],
    [{ destructiveCommandPatterns: [""] }, /destructiveCommandPatterns must contain non-empty strings/],
    [{ secretWritePatterns: ["a", "a"] }, /duplicate entry 'a' in secretWritePatterns/],
    [{ fileRules: [] }, /fileRules must be a non-empty array/],
    [{ fileRules: [{ pattern: "**", read: "yes", write: "allow" }] }, /fileRules\[0\]\.read must be "allow" or "deny"/],
    [{ fileRules: [{ read: "allow", write: "allow" }] }, /fileRules\[0\]\.pattern must be a non-empty glob/],
    [{ limits: { maxToolCallsPerTask: 0 } }, /limits\.maxToolCallsPerTask must be a positive integer/],
    [{ limits: { maxBytesPerWrite: -1 } }, /limits\.maxBytesPerWrite must be a positive integer/],
    [{ limits: { maxFileWritesPerTask: 1.5 } }, /limits\.maxFileWritesPerTask must be a positive integer/],
    [[], /must be a JSON object/],
  ];

  for (const [document, expected] of cases) {
    assert.throws(
      () => parsePolicyConfig(document, "test-policy.json"),
      (error: Error) => {
        assert.match(error.message, expected);
        assert.ok(error.message.includes("test-policy.json"), "the message must name the file");
        return true;
      },
    );
  }
});

test("globs behave like the legacy fnmatch patterns for the shapes policies use", () => {
  const cases: [string, string, boolean][] = [
    ["**", "anything/at/all.txt", true],
    ["**", "top.txt", true],
    ["workspace/**", "workspace/a.txt", true],
    ["workspace/**", "elsewhere/a.txt", false],
    ["*.env", ".env", true],
    ["*.env", "config/.env", false],
    ["config/*.env", "config/.env", true],
    ["config/*.env", "config/sub/.env", false],
    ["reports/**", "reports/2024/incident.md", true],
    ["reports/**", "reports", false],
    ["?.txt", "a.txt", true],
    ["?.txt", "ab.txt", false],
  ];

  for (const [pattern, value, expected] of cases) {
    assert.equal(globToRegExp(pattern).test(value), expected, `${pattern} vs ${value}`);
  }
});
