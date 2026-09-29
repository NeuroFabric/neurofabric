/**
 * PROBE — D-025 open question. This file is TEMPORARY and is deleted or
 * converted in the session that resolves the question.
 *
 * D-025 removed a wall-clock assertion from test 14 of
 * `platform/core/tool-paths-recursion.test.ts` and replaced it with a
 * structural pin. It explicitly declined a stronger pin:
 *
 *   A stronger pin — `assert.deepEqual(candidates, [])` on the deep payload —
 *   was considered and deliberately not adopted. The extractor's depth
 *   behaviour on that payload was never verified, so strengthening the
 *   assertion would risk a red test resting on an unverified assumption.
 *
 * That is the open question. Is the result on the deep payload empty, or are
 * candidates returned?
 *
 * THIS PROBE WAS DELIBERATELY NOT RUN LOCALLY BEFORE PUSHING. Running it here
 * and then writing the assertion to match what came back would convert the
 * probe into a restatement of observed behaviour — which is precisely the
 * defect D-025 was raised to prevent. The assertion below is transcribed from
 * the recorded expectation in D-025, not from an execution. The pipeline is
 * the authorised run, and the answer is read from whether this lands on `main`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { extractToolPathCandidates } from "./index.ts";
import type { ToolDescriptor } from "./types.ts";

/** The same schema-bearing tool test 14 uses: not a shell tool, has properties. */
const batchTool = {
  name: "batch",
  version: "1",
  description: "batch",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      paths: { type: "array" },
      targets: { type: "array" },
      items: { type: "array" },
      batch: { type: "object" },
    },
  },
  outputSchema: { type: "object" },
  capabilities: [],
  permissions: [],
  riskLevel: "READ_ONLY",
  timeoutMs: 1000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, maxBackoffMs: 0 },
  idempotency: "IDEMPOTENT",
  sideEffect: "PURE",
} as ToolDescriptor;

test("PROBE D-025: the deep payload yields no path candidates", () => {
  // The D-025 payload, transcribed exactly from test 14: 200 levels of nested
  // objects around a single path-bearing string.
  let deep: unknown = "src/a.ts";
  for (let index = 0; index < 200; index += 1) deep = { level: deep };

  const candidates = extractToolPathCandidates(batchTool, deep);

  assert.deepEqual(
    candidates,
    [],
    "PROBE RESULT: the deep payload did NOT return an empty candidate list. " +
      "D-025 can now close as verified-empty ONLY if this is []; if it is not, " +
      "the recorded assumption was wrong and the pin must be written from this " +
      "actual value. Actual candidates (JSON): " +
      JSON.stringify(candidates) +
      " | length: " +
      (Array.isArray(candidates) ? String(candidates.length) : "not-an-array"),
  );
});
