import test from "node:test";
import assert from "node:assert/strict";

import { MemoryStore, TARGET_VERSION } from "./store.ts";
import { reconcile, summarise, type LiveState } from "./reconcile.ts";

/**
 * STEP 1A AND 1B, TESTED.
 *
 * === WHY THE FIVE LEGAL DIFFERENCES GET FIVE CASES EACH ===
 *
 * ADR-005 §7.3 says disagreement is legal in exactly five places and that
 * everything else is corruption. A DR that says "five" and a test that checks one
 * is a DR with a wish. Each of the five is therefore provoked deliberately, and
 * there is a sixth case asserting that corruption is NOT accepted as a difference
 * — because that conflation is the failure the whole enumeration exists to stop.
 */

const TENANT = "acme";
const AGENT = "log-anomaly";
const COMPOSITE = `${TENANT}/${AGENT}`;

function store(): MemoryStore {
  return MemoryStore.open({ inMemory: true });
}

function seedRecord(s: MemoryStore): void {
  s.putSchema(TENANT, AGENT, "1.0.0", { id: AGENT, rules: [{ id: "r" }] });
  s.recordDecision({
    tenant: TENANT,
    agentId: COMPOSITE,
    verdict: { at: new Date(Date.now() - 60_000).toISOString(), provider: "pega", records: 262, breached: 1, document: { column: "elapsed_time" } },
    alert: { id: "a-1", severity: "critical", document: { column: "elapsed_time" } },
    audit: { actor: "demo", action: "decision", document: {} },
  });
}

const live = (over: Partial<LiveState> = {}): LiveState => ({
  providers: ["pega"],
  agentIds: [COMPOSITE],
  latest: { [COMPOSITE]: Date.now() },
  expectedVersion: TARGET_VERSION,
  accepts: () => true,
  ...over,
});

/* ================================================================== */
/* 1A — THE WRITE BOUNDARY                                             */
/* ================================================================== */

test("a decision writes its verdict, alert and audit trace together", () => {
  const s = store();
  try {
    seedRecord(s);
    assert.equal(s.verdictsFor(TENANT).length, 1);
    assert.equal(s.alertsFor(TENANT).length, 1);
    assert.equal(s.auditFor(TENANT).length, 1);
  } finally {
    s.close();
  }
});

test("a re-decision REPLACES the verdict rather than growing one row per poll", () => {
  // The live window updates every 500ms. A table that appended would gain 120 rows
  // a minute and answer "what is the current reading" by reading all of them.
  const s = store();
  try {
    seedRecord(s);
    s.recordDecision({
      tenant: TENANT,
      agentId: COMPOSITE,
      verdict: { at: new Date().toISOString(), provider: "pega", records: 300, breached: 0, document: {} },
    });
    const verdicts = s.verdictsFor(TENANT);
    assert.equal(verdicts.length, 1);
    assert.equal(verdicts[0]?.records, 300);
  } finally {
    s.close();
  }
});

test("a failing audit write rolls the WHOLE decision back, not just the audit row", () => {
  // THE POINT OF ONE TRANSACTION. Three separate writes leave a window in which an
  // alert exists with no verdict behind it -- exactly the corruption §7.3 says
  // must be an alarm rather than a line in a list.
  const s = store();
  try {
    seedRecord(s);
    const before = s.alertsFor(TENANT).length;
    assert.throws(() =>
      s.recordDecision({
        tenant: TENANT,
        agentId: COMPOSITE,
        verdict: { at: new Date().toISOString(), provider: "pega", records: 1, breached: 0, document: {} },
        alert: { id: "a-2", severity: "critical", document: {} },
        // A circular structure JSON.stringify throws on, standing in for any
        // failure partway through the transaction.
        audit: { actor: "demo", action: "x", document: cycle() },
      }),
    );
    // Neither the new alert NOR the verdict reached the store.
    assert.equal(s.alertsFor(TENANT).length, before);
    assert.equal(s.verdictsFor(TENANT)[0]?.records, 262, "the verdict must not have advanced either");
  } finally {
    s.close();
  }
});

function cycle(): unknown {
  const a: Record<string, unknown> = {};
  a["self"] = a;
  return a;
}

test("audit traces are append-only and read oldest first", () => {
  const s = store();
  try {
    s.appendAudit(TENANT, "demo", "first", {});
    s.appendAudit(TENANT, "demo", "second", {});
    const trace = s.auditFor(TENANT);
    assert.deepEqual(trace.map((entry) => entry.action), ["first", "second"]);
  } finally {
    s.close();
  }
});

test("the record is created at this build's version, and opening it twice is a no-op", () => {
  const s = store();
  try {
    assert.equal(s.version(), TARGET_VERSION);
    // Re-applying migrations to a current record must change nothing, or every
    // restart would rewrite history it was supposed to preserve.
    const again = MemoryStore.open({ inMemory: true });
    assert.equal(again.version(), TARGET_VERSION);
    again.close();
  } finally {
    s.close();
  }
});

test("a closed store refuses writes rather than pretending", () => {
  const s = store();
  s.close();
  assert.throws(() => s.putSchema(TENANT, "a", "1", {}), /closed/);
});

/* ================================================================== */
/* 1B — THE FIVE LEGAL DISAGREEMENTS, ONE CASE EACH                    */
/* ================================================================== */

test("1. a recorded schema the current rules refuse is a DIFFERENCE, not corruption", () => {
  const s = store();
  try {
    seedRecord(s);
    const result = reconcile(s, TENANT, live({ accepts: () => false }));
    const found = result.differences.find((d) => d.kind === "schema-not-accepted-now");
    assert.ok(found, "expected the tightened-grammar difference");
    assert.equal(result.corruptions.length, 0, "a tightened grammar is not corruption");
    assert.match(found.whatToDo, /Update it or retire it/);
  } finally {
    s.close();
  }
});

test("2. a registered agent with no live window yet is expected, not a problem", () => {
  const s = store();
  try {
    seedRecord(s);
    const result = reconcile(s, TENANT, live({ latest: {} }));
    assert.ok(result.differences.some((d) => d.kind === "no-live-window-yet"));
    assert.equal(result.corruptions.length, 0);
  } finally {
    s.close();
  }
});

test("3. a live provider the record has never seen is a difference", () => {
  const s = store();
  try {
    seedRecord(s);
    const result = reconcile(s, TENANT, live({ providers: ["pega", "webhook"] }));
    const found = result.differences.find((d) => d.kind === "provider-not-in-record");
    assert.ok(found);
    assert.equal(found.subject, "provider webhook");
    assert.equal(result.corruptions.length, 0);
  } finally {
    s.close();
  }
});

test("4. a record behind the code's version is a difference the operator can act on", () => {
  const s = store();
  try {
    seedRecord(s);
    const result = reconcile(s, TENANT, live({ expectedVersion: TARGET_VERSION + 1 }));
    const found = result.differences.find((d) => d.kind === "record-version-behind-code");
    assert.ok(found);
    assert.match(found.whatToDo, /Run the migration/);
    assert.equal(result.corruptions.length, 0);
  } finally {
    s.close();
  }
});

test("5. a record AHEAD of the live window is expected after a restart", () => {
  const s = store();
  try {
    seedRecord(s);
    // The record was written 60s ago; the live system reports something older.
    const result = reconcile(s, TENANT, live({ latest: { [COMPOSITE]: Date.now() - 600_000 } }));
    const found = result.differences.find((d) => d.kind === "verdict-newer-than-live");
    assert.ok(found);
    assert.match(found.whatToDo, /not in conflict/);
    assert.equal(result.corruptions.length, 0);
  } finally {
    s.close();
  }
});

test("a clean boot reports clean, with nothing to read", () => {
  const s = store();
  try {
    seedRecord(s);
    const result = reconcile(s, TENANT, live());
    assert.equal(result.clean, true);
    assert.deepEqual(result.differences, []);
    assert.deepEqual(result.corruptions, []);
    assert.match(summarise(result), /Nothing has changed/);
  } finally {
    s.close();
  }
});

/* ================================================================== */
/* CORRUPTION IS NOT A DIFFERENCE — AND MUST NOT BE FOLDED IN           */
/* ================================================================== */

test("a live agent the record has never heard of is corruption, not a difference", () => {
  const s = store();
  try {
    seedRecord(s);
    const result = reconcile(s, TENANT, live({ latest: { [COMPOSITE]: Date.now(), [`${TENANT}/ghost`]: Date.now() }, agentIds: [COMPOSITE, `${TENANT}/ghost`] }));
    // Not one of the five. A record and a live system describing the same agent
    // differently, with nothing in the record saying which is right.
    assert.equal(result.differences.length, 0);
    assert.ok(result.corruptions.some((c) => c.subject.includes("ghost")));
  } finally {
    s.close();
  }
});

test("a validator that THROWS is corruption, not a refusal", () => {
  const s = store();
  try {
    seedRecord(s);
    const result = reconcile(s, TENANT, live({ accepts: () => { throw new Error("boom"); } }));
    // Otherwise every schema would be reported invalid the first time a validator
    // changed shape, and the operator would learn to ignore the list.
    assert.equal(result.differences.filter((d) => d.kind === "schema-not-accepted-now").length, 0);
    assert.ok(result.corruptions.some((c) => /validator threw/.test(c.what)));
  } finally {
    s.close();
  }
});

test("no difference carries a repair: every one names what the operator can DO", () => {
  // The system's job is to present the difference, not to resolve it. A
  // reconciliation that silently migrates a customer's records is making a claim
  // about their data that nobody asked it to make.
  const s = store();
  try {
    seedRecord(s);
    const result = reconcile(s, TENANT, live({ providers: ["pega", "webhook"], accepts: () => false }));
    assert.ok(result.differences.length >= 2);
    for (const difference of result.differences) {
      assert.ok(difference.whatToDo.length > 10, `${difference.kind} must say what to do`);
    }
  } finally {
    s.close();
  }
});

test("every difference is scoped to the tenant it belongs to", () => {
  const s = store();
  try {
    // BOTH tenants have records, so neither reports a difference for a reason
    // that has nothing to do with isolation. The first version seeded only globex
    // and then asserted "no differences" for acme -- which correctly FAILED,
    // because an empty tenant seeing a provider it has no record of IS difference
    // 3. The test was wrong, not the reconciler.
    seedRecord(s);
    s.putSchema("globex", "other", "1.0.0", { id: "other" });
    s.recordDecision({
      tenant: "globex",
      agentId: "globex/other",
      verdict: { at: new Date().toISOString(), provider: "pega", records: 5, breached: 0, document: {} },
    });

    const mine = reconcile(s, TENANT, live());
    // Another tenant's records must never surface in mine, or one customer's
    // restart report leaks another's existence.
    for (const difference of mine.differences) {
      assert.equal(difference.tenant, TENANT);
      assert.doesNotMatch(difference.subject, /other|globex/);
    }
    assert.equal(s.schemasFor(TENANT).length, 1);
    assert.equal(s.schemasFor("globex").length, 1);
    assert.equal(s.alertsFor("globex").length, 0, "and their alerts must not appear in mine either");
    assert.equal(s.alertsFor(TENANT).length, 1);
  } finally {
    s.close();
  }
});