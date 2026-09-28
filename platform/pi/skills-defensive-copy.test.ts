import test from "node:test";
import assert from "node:assert/strict";
import { KernelAdapter } from "./kernel-adapter.ts";
import { discoverSkills } from "../skill-registry.mjs";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import type { SkillDescriptor } from "../core/types.ts";

/**
 * The `KernelAdapter.skills` accessor must hand back a DEFENSIVE COPY.
 *
 * The accessor is written as `get skills() { return [...this.skillList]; }`,
 * which exists for one reason: a caller must not be able to reach into the
 * kernel's installed skill state by mutating the array it was given. `setSkills`
 * is the validated entry point for changing that state, and a getter that
 * leaked the live reference would let any caller bypass it.
 *
 * This suite is the executable proof of that contract. It was written BEFORE
 * the fix and is expected to fail against the pre-fix code, where a
 * `private readonly skills` field shadowed the accessor with an own property and
 * the defensive copy never ran.
 */

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");

/** A syntactically valid descriptor; the point is the array reference, not the shape. */
function descriptor(name: string): SkillDescriptor {
  return {
    name,
    version: "1.0.0",
    description: `injected ${name}`,
    capabilities: [],
    requiredTools: [],
    optionalTools: [],
    dependencies: [],
    constraints: [],
    examples: [],
    riskLevel: "READ_ONLY",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object" },
  } as unknown as SkillDescriptor;
}

test("1. the accessor is present and starts empty on a fresh adapter", async () => {
  const adapter = new KernelAdapter();
  const returned = adapter.skills;
  assert.ok(Array.isArray(returned), "skills must be an array, not undefined");
  assert.equal(returned.length, 0, "a fresh adapter has no skills");
});

test("2. mutating the returned array must NOT reach kernel state", async () => {
  const adapter = new KernelAdapter();

  const returned = adapter.skills;
  returned.push(descriptor("injected-by-caller"));

  // The whole point of the defensive copy. A second read must not see it.
  assert.equal(
    adapter.skills.length,
    0,
    "a caller must not be able to install a skill by mutating the returned array",
  );
  assert.equal(
    adapter.skills.some((skill) => skill.name === "injected-by-caller"),
    false,
    "the injected descriptor must not be visible through the accessor",
  );
});

test("3. mutating the returned array must not affect a later validated read", async () => {
  const adapter = new KernelAdapter();

  const returned = adapter.skills;
  returned.push(descriptor("sneaky"));
  returned.length = 99;

  // Whatever the caller did to their reference, the kernel's own view is
  // unchanged and a real `setSkills` call is still authoritative.
  adapter.setSkills([descriptor("legit-one")]);
  const names = adapter.skills.map((skill) => skill.name);
  assert.deepEqual(names, ["legit-one"], "setSkills must remain the authoritative entry point");
});

test("4. setSkills and the accessor agree for a real catalog", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-skills-"));
  try {
    const skills = await discoverSkills(path.join(PROJECT_ROOT, "skills"), {
      knownTools: ["read", "bash", "write", "edit", "grep", "find", "ls"],
    });
    assert.ok(skills.length > 0, "the project catalog must not be empty");

    const adapter = new KernelAdapter();
    adapter.setSkills(skills);

    const first = adapter.skills;
    first.pop();
    assert.equal(
      adapter.skills.length,
      skills.length,
      "truncating the returned array must not shrink the kernel's installed skills",
    );
  } finally {
    // Nothing to clean: the adapter holds state in memory only.
    void root;
  }
});

test("5. two successive reads are independent references", async () => {
  const adapter = new KernelAdapter();
  adapter.setSkills([descriptor("only-one")]);

  const a = adapter.skills;
  const b = adapter.skills;
  assert.notEqual(a, b, "each read must return its own array, not one shared reference");
});
