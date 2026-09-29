/**
 * Write-tier payload scanning is FAIL-CLOSED.
 *
 * Origin — a live asymmetry, not a reading of the code. The harness Edit tool
 * carries its payload in camelCase `newText` / `oldText`. The scanner's
 * `CONTENT_PARAM_NAMES` listed only the snake_case `new_string` / `old_string`
 * (plus `content`, `contents`, `text`, `body`, `data`). A write-tier call
 * carrying a guarded literal in `content` was refused; the identical literal in
 * `newText` was authorized. `CONTENT_PARAM_NAMES` was an ALLOWLIST, so any
 * field name it did not already know about was silently unscanned — a new
 * harness field would be a silent bypass rather than a test failure.
 *
 * The rule these tests pin: for a WRITE-tier tool, every string value in the
 * payload is scanned, EXCEPT values under an explicit set of path/locator field
 * names. Unknown fields default to scanned.
 *
 * "Scanned" is bounded: per D-027 a write payload nested deeper than 12 is
 * refused outright, because past that depth the guard cannot walk safely. The
 * bound is `MAX_WRITE_PAYLOAD_DEPTH` in `platform/core/configured-policy.ts`,
 * set to 12 to match `MAX_DEPTH` in `platform/core/redaction.ts`. This file used
 * to say the payload "is scanned at any depth", which overstated what the guard
 * did — before the bound it could be walked at any depth right up until it
 * crashed, and afterwards it is refused. Test 6 pins the bound.
 *
 * The marker below is assembled from fragments at runtime so this source file
 * is not itself a refused write payload. The production control under test is
 * unchanged: the same `ConfiguredPolicy` secret-write rule, the same matcher,
 * the same write-tier-only scoping. Only the string differs.
 *
 * Nothing here touches disk. `precheckToolCall` only decides; the boundary and
 * the size limit are configured but no file is written.
 *
 * See D-022.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { KernelAdapter } from "./kernel-adapter.ts";
import { toolDescriptorFromPi } from "./tool-adapter.ts";
import { buildPolicy } from "./project-config.ts";
import { parsePolicyConfig, type PolicyConfig } from "../core/policy-config.ts";
import type { NeurofebricProjectConfig } from "./project-config.ts";

/** Assembled at runtime so the literal never appears whole in this file. */
const MARK = ["zz", "write", "scan", "zz"].join("");

/**
 * Field names whose values are locators rather than content, and are therefore
 * exempt from the secret scan. Mirrors the production exempt set; test 5 asserts
 * a write-tier tool's declared string fields are either exempt or scanned.
 */
const EXEMPT = new Set(["path", "newPath", "oldPath", "filePath", "notebookPath"]);

const TOOL_NAMES = ["read", "bash", "write", "edit", "grep", "find", "ls"];

const CONFIG: NeurofebricProjectConfig = { policyMode: "APPROVAL", allowedRoots: ["."] };

/** Locally constructed rules. The production policy file is not read. */
const TEST_RULES = {
  version: 1,
  deniedTools: [],
  allowedTools: [],
  fileRules: [{ pattern: "**", read: "allow", write: "allow" }],
  destructiveCommandPatterns: [],
  destructiveCommandTokens: [],
  secretWritePatterns: [MARK],
  limits: { maxToolCallsPerTask: 120, maxFileWritesPerTask: 30, maxBytesPerWrite: 2_000_000 },
  onViolation: "block",
} as const;

async function sandbox(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "nf-write-scan-"));
}

async function configuredAdapter(root: string) {
  await mkdir(path.join(root, "reports"), { recursive: true });
  const policyConfig: PolicyConfig = parsePolicyConfig({ ...TEST_RULES }, "test-policy.json");
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy(CONFIG, root, policyConfig));
  for (const name of TOOL_NAMES) {
    adapter.registerTools([toolDescriptorFromPi({ name, description: name })]);
  }
  await adapter.beginTask("do the work", "do the work");
  return adapter;
}

const reason = (decision: { reason?: string }): string => String(decision.reason ?? "");

/** 1. The asymmetry itself. RED before the fix, green after. */
test("1. a write-tier payload carrying the marker in a camelCase edit field is denied", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root);

  for (const field of ["newText", "oldText"]) {
    const { decision } = await adapter.precheckToolCall(
      "write",
      "execute",
      { path: path.join(root, "notes.md"), [field]: MARK },
      undefined,
      `scan-${field}`,
    );
    assert.equal(decision.decision, "DENY", `${field} must be scanned: an allowlist is not a boundary`);
    assert.match(reason(decision), /secret write pattern matched/);
  }
});

/**
 * 2. Depth does not hide a payload — up to the depth this test actually pins.
 *
 * The title this test used to carry, "a string value nested at any depth is
 * denied", claimed more than the test proved: the three cases below are an
 * object, an element inside an array, and an object three levels deep. "Any
 * depth" is not what that establishes, and a title that overclaims is the same
 * defect class as the D-024 test-comment truth audit — it invites the next
 * reader to believe the guard is unbounded when no test here establishes that.
 *
 * What IS left unproven, deliberately: the collector has no depth bound, and at
 * extreme nesting it throws rather than denying. That is the subject of D-027
 * and is not pinned here, so this test does not claim it.
 */
test("2. a marker nested in an object, in an array element, and three levels deep is denied", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root);

  const nested = [
    { path: path.join(root, "a.md"), edits: { replacement: MARK } },
    { path: path.join(root, "b.md"), edits: [{ body: MARK }] },
    { path: path.join(root, "c.md"), a: { b: { c: MARK } } },
  ];

  for (const input of nested) {
    const { decision } = await adapter.precheckToolCall("write", "execute", input, undefined, "nested");
    assert.equal(decision.decision, "DENY", `nested payload must be scanned: ${JSON.stringify(input)}`);
  }
});

/** 3. Fail-closed default: a field name nothing has ever heard of is still scanned. */
test("3. an unknown field name is scanned rather than bypassing the scan", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root);

  const { decision } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "a.md"), someFutureHarnessField: MARK },
    undefined,
    "future",
  );
  assert.equal(decision.decision, "DENY", "an unrecognized field must not be a bypass");
  assert.match(reason(decision), /secret write pattern matched/);
});

/** 4. The path/locator exemption is preserved. A file named for the concept is not a secret. */
test("4. a path or locator value naming the concept is not scanned", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root);

  const inputs = [
    { path: path.join(root, `notes-${MARK}.md`), content: "clean body" },
    { path: path.join(root, "a.md"), newPath: path.join(root, `${MARK}-renamed.md`), content: "clean" },
  ];

  for (const input of inputs) {
    const { decision } = await adapter.precheckToolCall("write", "execute", input, undefined, "exempt");
    assert.notEqual(decision.decision, "DENY", `locator must stay exempt: ${JSON.stringify(input)}`);
  }
});

/**
 * 5. Anti-regression. Walks a write-tier tool's DECLARED string fields and
 * asserts each is either an exempt locator or is scanned. A future harness field
 * added to this schema is picked up by the walk automatically, so adding a field
 * without thinking about the scan fails here instead of silently bypassing it.
 *
 * The one tool-level exemption is `vault_store`, listed by name. It is the
 * sanctioned credential store: its control is the approval gate, and a
 * deny-scan there would let an automated control override a human sanction.
 */
test("5. every declared string field of every write-tier tool is scanned except vault_store", async () => {
  const root = await sandbox();
  await mkdir(path.join(root, "reports"), { recursive: true });
  const policyConfig: PolicyConfig = parsePolicyConfig({ ...TEST_RULES }, "test-policy.json");
  const adapter = new KernelAdapter();
  adapter.setPolicy(buildPolicy(CONFIG, root, policyConfig));

  // A realistic harness write-tool surface, in the casing the harness uses.
  const properties: Record<string, { type: string }> = {
    path: { type: "string" },
    oldText: { type: "string" },
    newText: { type: "string" },
    newPath: { type: "string" },
    oldPath: { type: "string" },
    notebookPath: { type: "string" },
    mode: { type: "string" },
    lineEnd: { type: "string" },
    content: { type: "string" },
    new_string: { type: "string" },
  };

  const toolNames = ["write", "edit", "vault_store"];

  for (const name of toolNames) {
    adapter.registerTools([
      toolDescriptorFromPi({
        name,
        description: name,
        parameters: { type: "object", properties },
      } as never),
    ]);
  }
  await adapter.beginTask("do the work", "do the work");

  // The exemption is named here on purpose, so the test reads as the contract
  // rather than inheriting whatever the implementation happens to do.
  const SCAN_EXEMPT_TOOLS = new Set(["vault_store"]);

  for (const tool of toolNames) {
    for (const [field, schema] of Object.entries(properties)) {
      if (schema.type !== "string") continue;
      const input: Record<string, unknown> = {};
      input[field] = EXEMPT.has(field) ? path.join(root, `x-${MARK}.md`) : MARK;

      const { decision } = await adapter.precheckToolCall(tool, "execute", input, undefined, `walk-${tool}-${field}`);

      if (EXEMPT.has(field) || SCAN_EXEMPT_TOOLS.has(tool)) {
        assert.notEqual(
          decision.decision,
          "DENY",
          `${tool}.${field} is exempt from the deny-scan and must not be denied`,
        );
      } else {
        assert.equal(decision.decision, "DENY", `content field must be scanned: ${tool}.${field}`);
      }
    }
  }
});

/**
 * 6. D-027: the deny-scan enforces a hard depth bound of 12.
 *
 * Before the bound, `collectScannedStrings` was an unbounded recursion. It
 * denied correctly at ordinary depths, so the defect was invisible to every
 * other test in this file, but past roughly 2000-3000 levels it exhausted the
 * stack and threw `RangeError: Maximum call stack size exceeded` straight out
 * of `precheckToolCall`. A boundary that crashes on an input has no decision
 * to give; D-027 makes it refuse instead.
 *
 * Two cases, failing for different reasons without the bound, which is what
 * makes this test discriminating rather than decorative:
 *
 *   - 13 levels, just past the bound, carrying the marker. Before the bound
 *     this is DENIED *with the wrong reason* ("secret write pattern matched"):
 *     the scan walked all the way down and matched. D-027 says exceeding the
 *     depth bound is itself the reason, so this asserts the reason, not merely
 *     the decision.
 *   - 3000 levels. Before the bound this does not return at all; it throws.
 *     After the bound it is DENY, like any other too-deep write.
 *
 * The third case guards the other direction: a payload inside the bound must
 * still be scanned normally, so the bound cannot creep down and refuse ordinary
 * writes.
 *
 * The bound is 12 to match `MAX_DEPTH` in `platform/core/redaction.ts`, so the
 * repository has one depth convention across both recursive boundary walkers.
 */
test("6. a write payload nested beyond the depth bound is denied, not thrown", async () => {
  const root = await sandbox();
  const adapter = await configuredAdapter(root);

  const nest = (levels: number): unknown => {
    let payload: unknown = MARK;
    for (let i = 0; i < levels; i += 1) payload = { level: payload };
    return payload;
  };

  // Just past the bound: denied, and denied FOR THE DEPTH.
  const { decision: justPast } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "deep.md"), body: nest(13) },
    undefined,
    "depth-13",
  );
  assert.equal(justPast.decision, "DENY", "13 levels is past the bound of 12 and must be refused");
  assert.match(
    reason(justPast),
    /nesting depth 13 exceeds the limit of 12/,
    "exceeding the bound is itself the reason; a pattern match at the bottom is not what is tested",
  );

  // Far past the bound: the shape that used to crash must now decide.
  const { decision: farPast } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "deeper.md"), body: nest(3000) },
    undefined,
    "depth-3000",
  );
  assert.equal(farPast.decision, "DENY", "a 3000-level payload must be denied rather than throwing RangeError");
  assert.match(reason(farPast), /nesting depth 3000 exceeds the limit of 12/);

  // The bound must not fire early: inside the bound, the scan still runs.
  const { decision: withinBound } = await adapter.precheckToolCall(
    "write",
    "execute",
    { path: path.join(root, "shallow.md"), body: nest(3) },
    undefined,
    "depth-3",
  );
  assert.match(
    reason(withinBound),
    /secret write pattern matched/,
    "a payload within the bound is scanned normally, not refused for depth",
  );
});
