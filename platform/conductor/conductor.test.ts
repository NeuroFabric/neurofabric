import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, realpath, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Conductor } from "./conductor.ts";

/**
 * THE CONTRACT `DESIGN.md` NAMES, for the arm the type system exposed.
 *
 * `conductor.ts`'s `callTool` used to branch on `decision.decision !== "ALLOW"`
 * and then read `decision.tier ?? "SOFT_REFUSE"`. TypeScript caught it: the
 * `REQUIRE_APPROVAL` arm of `PolicyDecision` carries no `violation` and no
 * `tier`, so both reads were errors. Narrowing it properly revealed that the
 * `??` fallback was not cosmetic -- it FABRICATED a refusal tier for an
 * approval gate, reporting a question about authority as a scope refusal.
 *
 * That matters because the two are counted and stored differently. Under
 * RULING 1 a refusal is a counted, typed event; an approval gate that never
 * became one cannot be laundered into the refusal ledger.
 *
 * The distinction this file protects:
 *   - `REQUIRE_APPROVAL` unresolved authorises NOTHING. The tool must not run.
 *   - But it is NOT a policy violation, so it must not be reported as one.
 */

const CSV = `region,units,revenue
North,120,4800
South,95,3325
East,140,5600`;

/**
 * `realpath` is not cosmetic here. `os.tmpdir()` returns the 8.3 SHORT form on
 * this host (`RISHAB~1`) while the kernel reports the resolved LONG form, so a
 * path built locally and a path reported back by the conductor are different
 * strings pointing at one file. Without this, "the artifact exists" fails
 * spuriously AND "the artifact does not exist" passes vacuously -- which is the
 * worse of the two, because it would pass if the file were written.
 */
async function workspace(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "nf-conductor-")));
  await writeFile(path.join(dir, "sales.csv"), CSV, "utf8");
  return dir;
}

const exists = async (p: string) => {
  try { await stat(p); return true; } catch { return false; }
};

const eventTypes = (result: { kernelEvents: { type: string }[] }) => result.kernelEvents.map((e) => e.type);

// === 1. The control: the loop works when the policy allows it =============

test("C0 in TRUSTED_PROJECT mode the conductor delivers a dashboard", async () => {
  const cwd = await workspace();
  const conductor = new Conductor({ cwd, projectConfig: { policyMode: "TRUSTED_PROJECT", allowedRoots: [cwd] } });
  const out = path.join(cwd, "d.html");
  const result = await conductor.run("make me a dashboard from sales.csv", { output: out });
  assert.equal(result.status, "DELIVERED", `status=${result.status} failure=${JSON.stringify(result.failure)}`);
  assert.equal(result.failure, undefined, "a delivered run carries no failure");
  assert.equal(await exists(out), true,
    `expected ${out}; artifacts=${JSON.stringify(result.artifacts)}; dir=${JSON.stringify(await readdir(cwd))}`);
});

// === 2. The arm under test ===============================================

test("C1 an unresolved REQUIRE_APPROVAL surfaces as APPROVAL_REQUIRED", async () => {
  const cwd = await workspace();
  const conductor = new Conductor({ cwd, projectConfig: { policyMode: "APPROVAL", allowedRoots: [cwd] } });
  const result = await conductor.run("make me a dashboard from sales.csv", { output: path.join(cwd, "d.html") });

  assert.equal(result.status, "FAILED", "an approval gate that never resolved must not deliver");
  assert.equal(result.failure?.code, "APPROVAL_REQUIRED",
    "the gate is its own outcome, and the conductor must not rename it");
});

test("C1b it is never reported as a fabricated SOFT_REFUSE", async () => {
  const cwd = await workspace();
  const conductor = new Conductor({ cwd, projectConfig: { policyMode: "APPROVAL", allowedRoots: [cwd] } });
  const result = await conductor.run("make me a dashboard from sales.csv", { output: path.join(cwd, "d.html") });

  assert.notEqual(result.failure?.code, "POLICY_SOFT_REFUSE",
    "the exact defect: a missing tier was backfilled with SOFT_REFUSE, inventing a refusal the policy never made");
  assert.ok(!(result.failure?.reason ?? "").includes("POLICY_SOFT_REFUSE"),
    "and it must not leak into the reason either");
});

test("C1c the tool does not run when its approval never resolved", async () => {
  const cwd = await workspace();
  const conductor = new Conductor({ cwd, projectConfig: { policyMode: "APPROVAL", allowedRoots: [cwd] } });
  const result = await conductor.run("make me a dashboard from sales.csv", { output: path.join(cwd, "d.html") });
  assert.equal(await exists(path.join(cwd, "d.html")), false,
    "an unresolved approval gate authorises nothing, so nothing may be written");
});

test("C1d the policy's own reason travels to the caller", async () => {
  const cwd = await workspace();
  const conductor = new Conductor({ cwd, projectConfig: { policyMode: "APPROVAL", allowedRoots: [cwd] } });
  const result = await conductor.run("make me a dashboard from sales.csv", { output: path.join(cwd, "d.html") });
  assert.ok((result.failure?.reason ?? "").length > 0,
    "a structured failure with no words in it is a mystery, not a report");
});

/**
 * The read half ran and the write half was gated, so the run really did reach
 * the gate. Without this, C1 would also pass if the CSV had simply never been
 * found -- a different failure wearing the same coat.
 */
test("C1e the read succeeded before the write was gated", async () => {
  const cwd = await workspace();
  const conductor = new Conductor({ cwd, projectConfig: { policyMode: "APPROVAL", allowedRoots: [cwd] } });
  const result = await conductor.run("make me a dashboard from sales.csv", { output: path.join(cwd, "d.html") });
  const progress = result.progress.map((p) => `${p.state}${p.detail ? `:${p.detail}` : ""}`);
  assert.ok(progress.some((p) => p.startsWith("EXECUTE") && p.includes("csv_read")),
    `expected the read to have run, saw ${progress.join(" | ")}`);
  assert.ok(progress.some((p) => p.startsWith("EXECUTE") && p.includes("render_page")),
    "and the write to have been attempted and gated");
});

test("C1f the kernel is not asked to treat this as a violation", async () => {
  const cwd = await workspace();
  const conductor = new Conductor({ cwd, projectConfig: { policyMode: "APPROVAL", allowedRoots: [cwd] } });
  const result = await conductor.run("make me a dashboard from sales.csv", { output: path.join(cwd, "d.html") });
  // An approval gate is not a hazard, so it must not produce the tier's
  // terminal certificate naming one.
  const failed = result.kernelEvents.filter((e) => e.type === "TASK_FAILED");
  assert.equal(failed.length, 0,
    `an approval gate must not be escalated to a hazard certificate: ${JSON.stringify(failed)}`);
  assert.ok(eventTypes(result).length > 0, "the run still produced a trace, so the failure is visible");
});