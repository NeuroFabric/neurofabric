/**
 * D-009: a limit declared on CoreLimits is a limit that is enforced.
 *
 * F-006 removed `maxStepRetries` for advertising a bound that did not exist,
 * and recorded that eight more limits were in the same state. D-009 removed six
 * of them and enforced the three that had a natural choke point. D-016b removed
 * a seventh — `maxContextTokens`, whose only consumer still had no production
 * caller. These tests pin each enforced cap, and pin the removal of the rest,
 * so a future edit that reintroduces a paper limit fails here rather than in
 * production.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DEFAULT_LIMITS, validateLimits, type CoreLimits } from "./limits.ts";
import { selectContext } from "./context-memory.ts";
import { createArtifact } from "./artifact.ts";
import type { ContextSource, ToolDescriptor } from "./types.ts";

const REMOVED = [
  "maxTaskDurationMs",
  "maxStepDurationMs",
  "maxToolDurationMs",
  "maxParallelTasks",
  "maxParallelTools",
  "maxOutputBytes",
  // D-016b: removed because `selectContext` — its only consumer — had no
  // production caller and no producer for `estimatedTokens`, so the field
  // advertised a bound that could not occur.
  "maxContextTokens",
] as const;

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "d009-limits-"));
}

const write = (name: string, riskLevel: ToolDescriptor["riskLevel"] = "WRITE"): ToolDescriptor => ({
  name: "write",
  description: "test tool",
  sideEffect: "SIDE_EFFECTING",
  riskLevel,
  idempotency: "IDEMPOTENT",
  input: {},
} as ToolDescriptor);

// --- 1. the interface is exactly the enforced set ---------------------------

test("D009.1 CoreLimits declares exactly the five enforced limits", () => {
  assert.deepEqual(Object.keys(DEFAULT_LIMITS).sort(), [
    "maxArtifactBytes",
    "maxExecutionTimeMs",
    "maxRecoveryDepth",
    "maxReplans",
    "maxToolRetries",
  ]);
});

test("D009.1b the seven removed limits are gone from the surface and the validator", () => {
  for (const limit of REMOVED) {
    assert.equal(limit in DEFAULT_LIMITS, false, `${limit} must not be declared`);
    // validateLimits merges over DEFAULT_LIMITS, so a removed field would also
    // have to disappear from the validated shape rather than being inherited.
    const validated = validateLimits({});
    assert.equal(limit in validated, false, `${limit} must not survive validation`);
  }
});

test("D009.1c validateLimits still rejects a non-positive limit", () => {
  assert.throws(() => validateLimits({ maxToolRetries: 0 }), /Invalid core limit/);
  assert.throws(() => validateLimits({ maxArtifactBytes: -1 }), /Invalid core limit/);
});

test("D009.1d validateLimits rejects an unknown key instead of merging it through", () => {
  const forged = { maxParallelTools: 4 } as unknown as Partial<CoreLimits>;
  // RESOLVED (Task B). `validateLimits` used to merge the caller's object over
  // DEFAULT_LIMITS with a spread and only range-check the merged entries, so a
  // key that is not on `CoreLimits` was neither rejected nor dropped: it rode
  // through into the returned object, and the range check even applied to it.
  // Removal of a limit from the interface was therefore not enforced at the
  // validation boundary, and a caller could construct a "limits" object
  // carrying a field the platform no longer claims to honour.
  //
  // Unknown keys are now rejected by name, matching the fail-loudly contract
  // `parsePolicyConfig` already applies to an unknown policy field. The
  // supported contract is unchanged: a well-typed caller can only pass keys
  // that are on the interface, and a partial of declared keys still merges
  // over the defaults exactly as before.
  assert.throws(() => validateLimits(forged), /Unknown core limit: maxParallelTools/);
});

test("D009.1e a rejected unknown key is not merged, and declared keys still merge", () => {
  // The rejection happens before the merge, so nothing partially applies.
  assert.throws(
    () => validateLimits({ maxToolRetries: 5, bogusLimit: 1 } as unknown as Partial<CoreLimits>),
    /Unknown core limit: bogusLimit/,
  );

  // A partial of REAL keys is still accepted and still fills from the defaults.
  const partial = validateLimits({ maxToolRetries: 5 });
  assert.equal(partial.maxToolRetries, 5, "a declared key is applied");
  assert.equal(partial.maxReplans, DEFAULT_LIMITS.maxReplans, "an undeclared key keeps its default");
  assert.equal(partial.maxArtifactBytes, DEFAULT_LIMITS.maxArtifactBytes);

  // An empty object is still valid, which is what D009.1b already pinned.
  assert.doesNotThrow(() => validateLimits({}));

  // Every key the result carries is a key the interface declares, so a
  // validated object can never contain a phantom field.
  for (const key of Object.keys(validateLimits({}))) {
    assert.ok(
      (DEFAULT_LIMITS as Record<string, unknown>)[key] !== undefined,
      `validated limits must not carry a field outside the interface: ${key}`,
    );
  }
});

// --- 2. selectContext honours the budget it is given -----------------------

test("D009.2 selectContext admits exactly the budget and drops one token past it", () => {
  const source = (id: string, estimatedTokens: number): ContextSource =>
    ({ id, content: id, scope: "TASK", estimatedTokens, priority: 1, required: false }) as ContextSource;

  // D-016b: the budget is a required argument again, because the declared
  // default it used to carry was removed with `maxContextTokens`. The boundary
  // property that made the cap real is unchanged: a budget that exactly covers
  // the sources admits them, and one token less drops the last.
  const two = [source("a", 60), source("b", 40)];

  assert.equal(selectContext(two, 100).length, 2, "a budget equal to the total must admit both");
  assert.equal(selectContext(two, 99).length, 1, "one token short of the total must drop a source");
  assert.equal(selectContext(two, 99)[0].id, "a", "the dropped source is the one that no longer fits");
});

test("D009.2b an explicit budget still wins, and a larger one admits both", () => {
  const source = (id: string, estimatedTokens: number): ContextSource =>
    ({ id, content: id, scope: "TASK", estimatedTokens, priority: 1, required: false }) as ContextSource;

  const two = [source("a", 60), source("b", 60)];
  assert.equal(selectContext(two, 100).length, 1, "a budget below the total must drop a source");
  assert.equal(selectContext(two, 200).length, 2, "a budget above the total must admit both");
});

test("D009.2c a required source is dropped by the budget when it does not fit", () => {
  // DEFECT, PINNED AS-IS — Task C. The test name states what the code does,
  // which is the opposite of what the name previously claimed.
  //
  // `selectContext` guards each source twice:
  //
  //   if (used + source.estimatedTokens > maxTokens && !source.required) continue;
  //   if (used + source.estimatedTokens > maxTokens) continue;
  //
  // The first guard exempts a required source. The second has no exemption, so
  // it catches the same source one line later and the exemption is dead. A
  // required source is therefore dropped exactly like an optional one, and a
  // budget below its estimated size yields an empty selection — a required
  // source, by definition something the caller must not run without, silently
  // disappears.
  //
  // D-009 wired `maxContextTokens` to this function. Wiring a cap is what
  // makes the cap real, and this is what enforcing it revealed.
  //
  // D-016b removed `maxContextTokens`, which ends this defect's status as a
  // CoreLimits requirement: the operator ruled that Task C is not part of the
  // removal and that the existing behaviour may stand. The pin therefore now
  // documents a known `selectContext` defect rather than outstanding CoreLimits
  // work. It is deliberately left RED relative to the intuitive behaviour — a
  // required source that does not fit should arguably survive — so that if a
  // future task does decide the required-source policy, the change is a
  // deliberate one with a failing test to turn green, not a silent edit. The
  // budget this test supplies is now passed explicitly, because the declared
  // default it used to rely on no longer exists.
  const required = { id: "r", content: "r", scope: "TASK", estimatedTokens: 10_000, priority: 1, required: true } as ContextSource;
  const optional = { id: "o", content: "o", scope: "TASK", estimatedTokens: 10_000, priority: 1, required: false } as ContextSource;

  assert.deepEqual(selectContext([optional, required], 100), []);

  // A required source that does fit the budget is still admitted, so the
  // defect is confined to the over-budget case and not to `required` itself.
  const small = { ...required, estimatedTokens: 40 };
  assert.deepEqual(selectContext([small], 100).map((s) => s.id), ["r"]);
});

// --- 3. maxArtifactBytes is enforced ----------------------------------------

test("D009.3 createArtifact accepts a file within the artifact budget", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "small.bin");
    writeFileSync(file, Buffer.alloc(1024));
    const artifact = createArtifact({ reference: file, descriptor: write(), taskId: "t1", stepId: "s1", executionId: "e1" });
    assert.equal(artifact.reference, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D009.3b createArtifact rejects a file over the artifact budget", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "big.bin");
    writeFileSync(file, Buffer.alloc(DEFAULT_LIMITS.maxArtifactBytes + 1));
    assert.throws(
      () => createArtifact({ reference: file, descriptor: write(), taskId: "t1", stepId: "s1", executionId: "e1" }),
      /exceeds maxArtifactBytes/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D009.3c a file exactly at the budget is accepted, one byte over is not", () => {
  const dir = tempDir();
  try {
    const atLimit = path.join(dir, "at.bin");
    writeFileSync(atLimit, Buffer.alloc(DEFAULT_LIMITS.maxArtifactBytes));
    assert.doesNotThrow(() => createArtifact({ reference: atLimit, descriptor: write(), taskId: "t1", stepId: "s1", executionId: "e1" }));

    const overLimit = path.join(dir, "over.bin");
    writeFileSync(overLimit, Buffer.alloc(DEFAULT_LIMITS.maxArtifactBytes + 1));
    assert.throws(() => createArtifact({ reference: overLimit, descriptor: write(), taskId: "t1", stepId: "s1", executionId: "e1" }), /exceeds maxArtifactBytes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D009.3d a reference that does not exist yet is left to verification", () => {
  const dir = tempDir();
  try {
    const missing = path.join(dir, "not-written-yet.bin");
    assert.doesNotThrow(() => createArtifact({ reference: missing, descriptor: write(), taskId: "t1", stepId: "s1", executionId: "e1" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D009.3e a directory reference is not measured as a single artifact", () => {
  const dir = tempDir();
  try {
    assert.doesNotThrow(() => createArtifact({ reference: dir, descriptor: write("dir", "WRITE"), taskId: "t1", stepId: "s1", executionId: "e1" }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
