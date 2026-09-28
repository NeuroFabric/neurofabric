import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TrustedProjectPolicy, extractToolPathCandidates } from "./index.ts";
import type { PolicyRequest, ToolDescriptor } from "./types.ts";

/**
 * Nested path extraction: a path-bearing structure must be discoverable
 * wherever it sits in the payload.
 *
 * `collectFromObject` recursed into a nested OBJECT but stopped at an ARRAY,
 * so the same logical structure was inspectable or invisible depending only on
 * whether it was wrapped in brackets:
 *
 *   { batch: { path: X } }      -> recursed, X became a candidate
 *   { batch: [ { path: X } ] }  -> array returned early, X was never a candidate
 *
 * The escape is `path.join(root, "outside.txt")`, which is outside the allowed
 * root on every platform. Each case is asserted twice: that the candidate is
 * EXTRACTED, and that it actually reaches the existing boundary check and is
 * denied. Extraction alone would prove nothing if the boundary ignored it.
 */

const PARENT = "../";
const ABSOLUTE = "/";

function tool(name: string, properties: Record<string, unknown>, sideEffect: "PURE" | "SIDE_EFFECTING" = "PURE"): ToolDescriptor {
  return {
    name,
    version: "1",
    description: name,
    inputSchema: { type: "object", properties },
    outputSchema: { type: "object" },
    capabilities: [],
    permissions: [],
    riskLevel: "READ_ONLY",
    timeoutMs: 1000,
    retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
    idempotency: "IDEMPOTENT",
    sideEffect,
  } as ToolDescriptor;
}

/** A tool whose schema declares an array argument, so the schema branch runs. */
const batchTool = tool("batch", {
  path: { type: "string" },
  paths: { type: "array" },
  targets: { type: "array" },
  items: { type: "array" },
  batch: { type: "object" },
});

const readTool = tool("read", { path: { type: "string" } });

async function sandbox(): Promise<{ root: string; workspace: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nf-tool-paths-"));
  const workspace = path.join(root, "app");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  return { root, workspace };
}

function request(toolDescriptor: unknown, input: unknown): PolicyRequest {
  return { taskId: "t", tool: toolDescriptor, operation: "execute", input } as unknown as PolicyRequest;
}

/** Extracted AND denied: the candidate has to reach the real boundary check. */
function assertExtractedAndDenied(
  policy: TrustedProjectPolicy,
  toolDescriptor: unknown,
  input: unknown,
  escape: string,
  label: string,
): void {
  const candidates = extractToolPathCandidates(toolDescriptor as never, input);
  assert.ok(
    candidates.includes(escape),
    `candidate must be extracted: ${label}; got ${JSON.stringify(candidates)}`,
  );
  const decision = policy.evaluate(request(toolDescriptor, input));
  assert.equal(decision.decision, "DENY", `expected DENY at the boundary: ${label}`);
}

// ---------------------------------------------------------------------------
// The baseline: these already worked and must keep working.
// ---------------------------------------------------------------------------

test("1. a flat object argument is extracted and denied (baseline)", async () => {
  const { root, workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  const escape = path.join(root, "outside.txt");
  assertExtractedAndDenied(policy, readTool, { path: escape }, escape, "flat path");
});

test("2. a nested object argument is extracted and denied (baseline)", async () => {
  const { root, workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  const escape = path.join(root, "outside.txt");
  assertExtractedAndDenied(policy, batchTool, { batch: { path: escape } }, escape, "nested object");
});

// ---------------------------------------------------------------------------
// The gap: the same structure, wrapped in an array.
// ---------------------------------------------------------------------------

test("3. a path inside an array of objects is extracted and denied", async () => {
  const { root, workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  const escape = path.join(root, "outside.txt");
  assertExtractedAndDenied(policy, batchTool, { targets: [{ path: escape }] }, escape, "array of objects");
});

test("4. a path inside an array of objects under a non-path key is extracted and denied", async () => {
  const { root, workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  const escape = path.join(root, "outside.txt");
  assertExtractedAndDenied(policy, batchTool, { items: [{ path: escape }] }, escape, "array of objects, non-path key");
});

test("5. a path in an array of objects is found among ordinary siblings", async () => {
  const { root, workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  const escape = path.join(root, "outside.txt");
  assertExtractedAndDenied(
    policy,
    batchTool,
    {
      targets: [
        { path: path.join(workspace, "src", "a.ts"), label: "first" },
        { path: escape, label: "second" },
      ],
    },
    escape,
    "array of objects, second entry",
  );
});

test("6. an array of plain strings under a path key is still extracted (regression)", async () => {
  const { root, workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  const escape = path.join(root, "outside.txt");
  assertExtractedAndDenied(policy, batchTool, { paths: ["src/a.ts", escape] }, escape, "array of strings");
});

test("7. a path nested inside nested arrays is extracted and denied", async () => {
  const { root, workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  const escape = path.join(root, "outside.txt");
  assertExtractedAndDenied(policy, batchTool, { paths: [["src/a.ts", escape]] }, escape, "array of arrays");
});

test("8. a path nested several arrays deep under a path key is extracted", async () => {
  const { root, workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  const escape = path.join(root, "outside.txt");
  assertExtractedAndDenied(policy, batchTool, { paths: [[[escape]]] }, escape, "three nested arrays");
});

test("9. a traversal inside an array of objects is denied, not merely extracted", async () => {
  const { root, workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  const escape = PARENT + "escape.txt";
  assertExtractedAndDenied(policy, batchTool, { targets: [{ path: escape }] }, escape, "traversal in an array");
});

test("10. command text inside an array of objects is still scanned for paths", async () => {
  const { root, workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  const escape = path.join(root, "outside.txt");
  assertExtractedAndDenied(
    policy,
    batchTool,
    { targets: [{ command: "cat " + escape }] },
    escape,
    "command inside an array object",
  );
});

// ---------------------------------------------------------------------------
// Values that must NOT become candidates. Extraction may only ever add, never
// invent: ordinary work must keep working.
// ---------------------------------------------------------------------------

test("11. non-path values are not turned into candidates", async () => {
  const { workspace } = await sandbox();
  const candidates = extractToolPathCandidates(batchTool as never, {
    targets: [{ label: "just a label", count: 3, enabled: true, missing: null }],
    items: ["no slashes here", "still none"],
  });
  assert.deepEqual(candidates, [], "ordinary values must yield no candidates: " + JSON.stringify(candidates));

  const inside = extractToolPathCandidates(batchTool as never, { targets: [{ path: "src/a.ts" }] });
  assert.deepEqual(inside, ["src/a.ts"], "an in-bounds path is still a candidate");
});

test("12. a well-formed batch of in-bounds paths is allowed", async () => {
  const { workspace } = await sandbox();
  const policy = new TrustedProjectPolicy({ allowedRoots: [workspace] });
  const decision = policy.evaluate(
    request(batchTool, { targets: [{ path: path.join(workspace, "src", "a.ts") }, { path: path.join(workspace, "src", "b.ts") }] }),
  );
  assert.equal(decision.decision, "ALLOW", "ordinary batch work must keep working: " + JSON.stringify(decision));
});

// ---------------------------------------------------------------------------
// Malformed input must not throw and must not silently swallow the payload.
// ---------------------------------------------------------------------------

test("13. malformed structures do not throw and are handled deterministically", async () => {
  const { workspace } = await sandbox();
  const malformed: unknown[] = [
    { targets: null },
    { targets: undefined },
    { targets: [null, undefined, 42, true] },
    { targets: [] },
    { targets: [[], []] },
    { targets: [{}] },
    { targets: [{ path: null }] },
    { targets: [{ path: "" }] },
    { targets: [{ path: "   " }] },
    { targets: [{ path: 42 }] },
    { targets: [[[[["src/a.ts"]]]]] },
    null,
    undefined,
    "a bare string",
    42,
  ];

  for (const input of malformed) {
    const candidates = extractToolPathCandidates(batchTool as never, input);
    assert.ok(Array.isArray(candidates), "must always return an array: " + JSON.stringify(input));
    for (const candidate of candidates) {
      assert.equal(typeof candidate, "string");
      assert.notEqual(candidate.trim(), "", "a blank candidate is never useful");
    }
  }

  // An escape survives the malformed shapes around it.
  const escape = PARENT + "escape.txt";
  assert.ok(
    extractToolPathCandidates(batchTool as never, { targets: [null, { path: escape }, undefined] }).includes(escape),
    "a null sibling must not stop inspection of the rest of the array",
  );
});

test("14. deep nesting is bounded and terminates", async () => {
  const { workspace } = await sandbox();
  // Deeper than the extraction depth limit: the walk must stop, not recurse
  // without bound.
  let deep: unknown = "src/a.ts";
  for (let index = 0; index < 200; index += 1) deep = { level: deep };
  const started = Date.now();
  const candidates = extractToolPathCandidates(batchTool as never, deep);
  assert.ok(Date.now() - started < 2000, "extraction must terminate promptly on deep input");
  assert.ok(Array.isArray(candidates));

  // Depth is a hard bound, not a silent full walk: the same payload built
  // shallowly IS found, so the bound is the only difference.
  const escape = PARENT + "escape.txt";
  assert.ok(
    extractToolPathCandidates(batchTool as never, { a: { b: { path: escape } } }).includes(escape),
    "a path at a permitted depth is still found",
  );
  assert.ok(workspace.length > 0);
});
