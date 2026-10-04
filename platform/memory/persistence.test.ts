import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { MemoryStore } from "./store.ts";
import { reconcile, type LiveState } from "./reconcile.ts";

/**
 * CORRUPTION, PROVOKED THE WAY IT ACTUALLY HAPPENS.
 *
 * The in-memory store cannot be damaged from outside: it is one connection and
 * there is no second handle. **A real record is a file, and corruption is
 * something that happened to the file.** So this test opens a real one in a
 * temporary directory and writes a damaged row through a second connection --
 * which is the actual failure mode, rather than a reach-through into a private
 * field, which would have tested the test rather than the code.
 */

const TENANT = "acme";
const AGENT = "log-anomaly";
const COMPOSITE = `${TENANT}/${AGENT}`;
const FILE = "neurofebric.sqlite";

test("an unreadable stored document is CORRUPTION, reported separately", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nf-mem-"));
  const first = MemoryStore.open({ directory: dir });
  try {
    first.putSchema(TENANT, AGENT, "1.0.0", { id: AGENT, rules: [{ id: "r" }] });
    first.recordDecision({
      tenant: TENANT,
      agentId: COMPOSITE,
      verdict: { at: new Date().toISOString(), provider: "pega", records: 262, breached: 1, document: { column: "elapsed_time" } },
    });
  } finally {
    first.close();
  }

  // The damage, written by a second connection to the same file.
  const raw = new DatabaseSync(path.join(dir, FILE));
  raw.prepare("UPDATE schemas SET document = ? WHERE id = ?").run("{not json", AGENT);
  raw.close();

  const reopened = MemoryStore.open({ directory: dir });
  try {
    const live: LiveState = {
      providers: ["pega"],
      agentIds: [COMPOSITE],
      latest: { [COMPOSITE]: Date.now() },
      expectedVersion: reopened.version(),
      accepts: () => true,
    };
    const result = reconcile(reopened, TENANT, live);

    assert.equal(result.differences.length, 0, "corruption must NOT appear as a difference");
    assert.ok(result.corruptions.some((c) => /not readable JSON/.test(c.what)), `expected corruption, got ${JSON.stringify(result.corruptions)}`);
  } finally {
    reopened.close();
  }
});

test("the record survives being closed and reopened, and is still there", () => {
  // The whole promise of Phase 1 in one assertion: a restart is a colleague
  // coming back, not a stranger arriving.
  const dir = mkdtempSync(path.join(tmpdir(), "nf-mem-"));
  const first = MemoryStore.open({ directory: dir });
  try {
    first.putSchema(TENANT, AGENT, "1.0.0", { id: AGENT, rules: [{ id: "r" }] });
    first.recordDecision({
      tenant: TENANT,
      agentId: COMPOSITE,
      verdict: { at: new Date().toISOString(), provider: "pega", records: 262, breached: 1, document: {} },
      alert: { id: "a-1", severity: "critical", document: {} },
    });
  } finally {
    first.close();
  }

  const reopened = MemoryStore.open({ directory: dir });
  try {
    assert.equal(reopened.schemasFor(TENANT).length, 1, "the agent must have survived the restart");
    assert.equal(reopened.alertsFor(TENANT).length, 1, "the alert must have survived too -- it is the guarantee");
    assert.equal(reopened.verdictsFor(TENANT)[0]?.records, 262);
  } finally {
    reopened.close();
  }
});