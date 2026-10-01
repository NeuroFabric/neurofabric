import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { governedIngest } from "./ingest.ts";
import { makeTempWorkspace, writeFixture } from "../test-support/temp-workspace.ts";

/**
 * GOVERNED INGESTION — the dynamic entry point, tested through the kernel.
 *
 * The product takes a path from a command line, which is a completely different
 * trust situation from a path a test hardcodes. A test can be trusted to name a
 * file inside its own sandbox; a user can type anything, including
 * /etc/passwd or ../../.sh_history.
 *
 * So the path is NOT resolved and then checked afterwards. It goes through the
 * same kernel precheck every governed call goes through, and the refusal is the
 * KERNEL's, carrying the kernel's tier. A CLI that resolved the path itself and
 * validated its own output would be a second control plane wearing the costume
 * of the first.
 *
 * These tests therefore assert on the TIER, not merely on "it failed". A
 * boundary refusal that arrived as some other error would still not execute
 * anything, but it would be telling the user something false about why.
 */

const CSV = "_time,alertType,alert_code,logger_name,elapsed_time,threshold\n2026-09-30T12:00:00Z,performance,PEGA0001,logger-a,1200,1000\n";

test("I1 a file inside the workspace is admitted and read", async () => {
  const cwd = await makeTempWorkspace("nf-ingest-ok-");
  await writeFixture(cwd, "in.csv", CSV);
  const result = await governedIngest({ cwd, requested: "in.csv" });
  assert.equal(result.refused, false, `unexpected refusal: ${JSON.stringify(result)}`);
  assert.equal(result.rowCount, 1);
  assert.equal(result.problems.length, 0);
});

test("I2 a path OUTSIDE the workspace is refused by the kernel", async () => {
  // The canonical attack: an absolute path to something sensitive.
  const cwd = await makeTempWorkspace("nf-ingest-out-");
  const result = await governedIngest({ cwd, requested: path.join(os.tmpdir(), "etc-passwd-copy") });
  assert.equal(result.refused, true, "a path outside the workspace must be refused");
  assert.equal(result.tier, "SOFT_REFUSE", "a read outside the sandbox is a scope question, not a hazard");
  assert.ok((result.reason ?? "").length > 0, "and the refusal must say why");
});

test("I3 a TRAVERSAL out of the workspace is refused", async () => {
  // Defeating a naive startsWith check is the whole point of testing it.
  const cwd = await makeTempWorkspace("nf-ingest-trav-");
  await writeFixture(cwd, "in.csv", CSV);
  const result = await governedIngest({ cwd, requested: path.join("..", "..", "..", "outside.csv") });
  assert.equal(result.refused, true, "traversal must not escape the workspace");
  assert.equal(result.tier, "SOFT_REFUSE");
});

test("I4 a traversal that lands BACK INSIDE is allowed", async () => {
  // The refusal must be about the destination, not about the spelling. A control
  // that refuses any '..' would be refused by its users and disabled, which is
  // worse than one that checks where the path actually points.
  const cwd = await makeTempWorkspace("nf-ingest-back-");
  await writeFixture(cwd, "in.csv", CSV);
  const nested = path.join(cwd, "sub");
  await writeFixture(nested, "in.csv", CSV);
  const result = await governedIngest({ cwd, requested: path.join("sub", "..", "in.csv") });
  assert.equal(result.refused, false, `a path that resolves back inside is fine: ${JSON.stringify(result)}`);
});

test("I5 the refusal names the boundary, not the internals", async () => {
  const cwd = await makeTempWorkspace("nf-ingest-msg-");
  const result = await governedIngest({ cwd, requested: path.join(os.tmpdir(), "elsewhere.csv") });
  assert.equal(result.refused, true);
  assert.match(result.reason ?? "", /boundary|escapes|outside/i,
    "the user needs to know it was the workspace boundary, not a missing file");
});

test("I6 a missing file inside the workspace is NOT a policy refusal", async () => {
  // Conflating these two would teach the user to ignore refusals. A file that
  // is absent is an ordinary error; a file that is forbidden is a refusal.
  const cwd = await makeTempWorkspace("nf-ingest-missing-");
  const result = await governedIngest({ cwd, requested: "not-here.csv" });
  assert.equal(result.refused, true, "a missing file is still not readable");
  assert.notEqual(result.tier, "SOFT_REFUSE", "but it is an I/O failure, not a policy refusal");
});